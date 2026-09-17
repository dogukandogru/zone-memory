'use strict'

// HistData.com saglayicisi: aylik tick zip'i indirir ve 1 dakikalik muma cevirir.
// Referans uygulama: /Users/dogukandogru/dev/indicator2/backend/app/services/histdata.py
//
// Olculmus gercekler:
//  - HistData bu makineden ERISILEBILIR (HTTP 200) ve XAUUSD icin tam gecmis
//    tick verisi verir, anahtar istemez.
//  - Dukascopy (datafeed.dukascopy.com) ERISILEMEZ: alan adi BTK engel
//    sunucusuna cozuluyor, dogrudan IP baglantisi da DPI seviyesinde dusuyor.
//    Bu yuzden Dukascopy saglayici olarak eklenmedi, HistData onun yerini alir.
//
// Neden hazir 1m dosyalari degil de tick dosyalari: HistData'nin hazir 1
// dakikalik bar dosyalarinda volume kolonu HEP 0'dir. Indikatorun flow hesabi
// hacme bagli oldugundan o dosyalar kullanilamaz. Tick dosyalarindan uretilen
// mumlarda hacim = dakikadaki TICK SAYISI'dir; TradingView XAUUSD hacmi de
// tick hacmidir, yani ayni cinstendir.
//
// Tick dosya bicimi (ASCII):  YYYYMMDD HHMMSSmmm,bid,ask,0
// Zaman dilimi SABIT UTC-5'tir, yaz saati UYGULANMAZ.
//
// Zip acmak icin harici bagimlilik yoktur: asagida zlib.inflateRawSync
// uzerine kurulu minimal bir ZIP okuyucu vardir.

const zlib = require('node:zlib')
const { sanitize, resample, emptySeries } = require('../series')
const { httpText, httpBuffer, sleep, bildir } = require('./provider')

const ETIKET = 'HistData'
const TEMEL = 'https://www.histdata.com'
const SAYFA_URL = TEMEL + '/download-free-forex-historical-data/?/ascii/tick-data-quotes/'
const POST_URL = TEMEL + '/get.php'
const TK_RE = /name="tk"\s+id="tk"\s+value="([^"]*)"/
// HistData ASCII verisi sabit UTC-5: UTC'ye cevirmek icin 5 saat EKLENIR.
const UTC_OFSET_SN = 5 * 3600

/* ------------------------------------------------------------------ */
/* Minimal ZIP okuyucu                                                 */
/* ------------------------------------------------------------------ */

const IMZA_EOCD = 0x06054b50 // merkezi dizin sonu
const IMZA_CD = 0x02014b50 // merkezi dizin girisi
const IMZA_YEREL = 0x04034b50 // yerel dosya basligi

/**
 * Merkezi dizinden dosya kayitlarini okur.
 * @param {Buffer} buf
 * @returns {Array<{ad:string, yontem:number, sikisikBoy:number, acikBoy:number, yerelOfs:number}>}
 */
function zipKayitlari(buf) {
  if (buf.length < 22) throw new Error(ETIKET + ': zip dosyasi cok kisa')

  // EOCD sondan basa aranir; zip yorumu en fazla 65535 bayt olabilir.
  let eocd = -1
  const alt = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= alt; i--) {
    if (buf.readUInt32LE(i) === IMZA_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(ETIKET + ': zip merkezi dizini bulunamadi (dosya bozuk)')

  const girisSayisi = buf.readUInt16LE(eocd + 10)
  let ofs = buf.readUInt32LE(eocd + 16)
  const kayitlar = []
  for (let i = 0; i < girisSayisi; i++) {
    if (ofs + 46 > buf.length || buf.readUInt32LE(ofs) !== IMZA_CD) break
    const yontem = buf.readUInt16LE(ofs + 10)
    const sikisikBoy = buf.readUInt32LE(ofs + 20)
    const acikBoy = buf.readUInt32LE(ofs + 24)
    const adBoy = buf.readUInt16LE(ofs + 28)
    const ekBoy = buf.readUInt16LE(ofs + 30)
    const yorumBoy = buf.readUInt16LE(ofs + 32)
    const yerelOfs = buf.readUInt32LE(ofs + 42)
    const ad = buf.toString('latin1', ofs + 46, ofs + 46 + adBoy)
    kayitlar.push({
      ad: ad,
      yontem: yontem,
      sikisikBoy: sikisikBoy,
      acikBoy: acikBoy,
      yerelOfs: yerelOfs,
    })
    ofs += 46 + adBoy + ekBoy + yorumBoy
  }
  return kayitlar
}

/**
 * Tek bir zip girisini acar. Yalnizca store (0) ve deflate (8) desteklenir,
 * HistData zip'leri deflate kullanir.
 * @param {Buffer} buf
 * @param {{yontem:number, sikisikBoy:number, acikBoy:number, yerelOfs:number, ad:string}} kayit
 * @returns {Buffer}
 */
function zipGirisiniAc(buf, kayit) {
  const o = kayit.yerelOfs
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== IMZA_YEREL) {
    throw new Error(ETIKET + ': zip yerel dosya basligi gecersiz (' + kayit.ad + ')')
  }
  const adBoy = buf.readUInt16LE(o + 26)
  const ekBoy = buf.readUInt16LE(o + 28)
  const bas = o + 30 + adBoy + ekBoy
  const son = bas + kayit.sikisikBoy
  if (son > buf.length) throw new Error(ETIKET + ': zip verisi eksik (' + kayit.ad + ')')
  const dilim = buf.subarray(bas, son)

  if (kayit.yontem === 0) return dilim
  if (kayit.yontem === 8) return zlib.inflateRawSync(dilim)
  throw new Error(
    ETIKET + ': desteklenmeyen zip sikistirma yontemi ' + kayit.yontem + ' (' + kayit.ad + ')'
  )
}

/**
 * Zip icindeki ilk .csv dosyasini acilmis halde dondurur.
 * @param {Buffer} buf
 * @returns {Buffer|null}
 */
function zipCsvOku(buf) {
  const kayitlar = zipKayitlari(buf)
  for (let i = 0; i < kayitlar.length; i++) {
    if (/\.csv$/i.test(kayitlar[i].ad)) return zipGirisiniAc(buf, kayitlar[i])
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Tick -> 1 dakikalik mum                                             */
/* ------------------------------------------------------------------ */

/** Buyuyen sutunsal mum tamponu. */
function tamponOlustur(kapasite) {
  const n = kapasite > 16 ? kapasite : 16
  return {
    n: 0,
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  }
}

function buyut(dizi, gerekli) {
  let cap = dizi.length * 2
  if (cap < gerekli) cap = gerekli
  const out = new Float64Array(cap)
  out.set(dizi)
  return out
}

function tamponaEkle(b, t, o, h, l, c, v) {
  if (b.n === b.time.length) {
    const gerekli = b.n + 1
    b.time = buyut(b.time, gerekli)
    b.open = buyut(b.open, gerekli)
    b.high = buyut(b.high, gerekli)
    b.low = buyut(b.low, gerekli)
    b.close = buyut(b.close, gerekli)
    b.volume = buyut(b.volume, gerekli)
  }
  const i = b.n
  b.time[i] = t
  b.open[i] = o
  b.high[i] = h
  b.low[i] = l
  b.close[i] = c
  b.volume[i] = v
  b.n = i + 1
}

/** Tampondan Series uretir (fazla kapasite kirpilir, kopyalanmaz). */
function tampondanSeri(b) {
  return {
    length: b.n,
    time: b.time.subarray(0, b.n),
    open: b.open.subarray(0, b.n),
    high: b.high.subarray(0, b.n),
    low: b.low.subarray(0, b.n),
    close: b.close.subarray(0, b.n),
    volume: b.volume.subarray(0, b.n),
  }
}

/**
 * Tick CSV tamponunu 1 dakikalik mumlara cevirir ve tampona yazar.
 *
 * Satirlar sabit genislikli oldugu icin alanlar dogrudan bayt indeksinden
 * okunur; bir ayda 15 milyon satir olabildiginden string uretilmez.
 * OHLC bid fiyatindan uretilir, volume dakikadaki tick sayisidir.
 * Bos dakikalar URETILMEZ: piyasanin kapali oldugu saatler gercek bosluktur.
 *
 * @param {Buffer} buf Acilmis CSV
 * @param {{n:number}} tampon
 * @param {number} from Alt zaman siniri (UNIX saniye, dahil)
 * @param {number} to Ust zaman siniri (UNIX saniye, dahil)
 */
function ticklerden1m(buf, tampon, from, to) {
  const n = buf.length
  let i = 0

  let gunAnahtar = -1
  let gunEpoch = 0

  let kova = -1
  let ac = 0
  let yuk = 0
  let dus = 0
  let kap = 0
  let sayi = 0

  while (i < n) {
    // Satir sonunu bul.
    let ls = i
    while (ls < n && buf[ls] !== 10) ls++
    let sonu = ls
    if (sonu > i && buf[sonu - 1] === 13) sonu--

    // En kisa gecerli satir: 18 karakterlik zaman + virgul + en az 1 basamak.
    if (sonu - i >= 20 && buf[i + 8] === 32 && buf[i + 18] === 44) {
      const yil =
        (buf[i] - 48) * 1000 + (buf[i + 1] - 48) * 100 + (buf[i + 2] - 48) * 10 + (buf[i + 3] - 48)
      const ay = (buf[i + 4] - 48) * 10 + (buf[i + 5] - 48)
      const gun = (buf[i + 6] - 48) * 10 + (buf[i + 7] - 48)
      const saat = (buf[i + 9] - 48) * 10 + (buf[i + 10] - 48)
      const dk = (buf[i + 11] - 48) * 10 + (buf[i + 12] - 48)
      const sn = (buf[i + 13] - 48) * 10 + (buf[i + 14] - 48)

      // Bid alani: 19. bayttan sonraki virgule kadar.
      let p = i + 19
      let isaret = 1
      if (buf[p] === 45) {
        isaret = -1
        p++
      }
      let tam = 0
      let basamak = 0
      while (p < sonu && buf[p] >= 48 && buf[p] <= 57) {
        tam = tam * 10 + (buf[p] - 48)
        p++
        basamak++
      }
      let bid = tam
      if (p < sonu && buf[p] === 46) {
        p++
        let kesir = 0
        let bol = 1
        while (p < sonu && buf[p] >= 48 && buf[p] <= 57) {
          kesir = kesir * 10 + (buf[p] - 48)
          bol *= 10
          p++
          basamak++
        }
        bid = tam + kesir / bol
      }
      bid *= isaret

      if (basamak > 0 && bid > 0 && ay >= 1 && ay <= 12 && gun >= 1 && gun <= 31) {
        // Gun basi epoch'u gun degisince bir kez hesaplanir; Date.UTC her tick
        // icin cagrilirsa milyonlarca satirda cok yavas kalir.
        const anahtar = yil * 10000 + ay * 100 + gun
        if (anahtar !== gunAnahtar) {
          gunAnahtar = anahtar
          gunEpoch = Date.UTC(yil, ay - 1, gun) / 1000 + UTC_OFSET_SN
        }
        const t = gunEpoch + saat * 3600 + dk * 60 + sn
        const yeniKova = t - (t % 60)

        if (yeniKova !== kova) {
          if (sayi > 0 && kova >= from && kova <= to) {
            tamponaEkle(tampon, kova, ac, yuk, dus, kap, sayi)
          }
          kova = yeniKova
          ac = bid
          yuk = bid
          dus = bid
          kap = bid
          sayi = 1
        } else {
          if (bid > yuk) yuk = bid
          if (bid < dus) dus = bid
          kap = bid
          sayi++
        }
      }
    }

    i = ls + 1
  }

  if (sayi > 0 && kova >= from && kova <= to) {
    tamponaEkle(tampon, kova, ac, yuk, dus, kap, sayi)
  }
}

/* ------------------------------------------------------------------ */
/* Indirme                                                             */
/* ------------------------------------------------------------------ */

/**
 * [from, to] araligindaki aylari listeler. Icinde bulunulan ay ve gelecek
 * aylar YAYINLANMADIGI icin listeye alinmaz.
 * @param {number} from UNIX saniye
 * @param {number} to UNIX saniye
 * @returns {Array<{yil:number, ay:number}>}
 */
function aylariListele(from, to) {
  const bas = new Date(from * 1000)
  const son = new Date(to * 1000)
  const simdi = new Date()
  const simdiAnahtar = simdi.getUTCFullYear() * 12 + simdi.getUTCMonth()

  let y = bas.getUTCFullYear()
  let m = bas.getUTCMonth() + 1
  const sonAnahtar = son.getUTCFullYear() * 12 + son.getUTCMonth()

  const liste = []
  while (y * 12 + (m - 1) <= sonAnahtar) {
    if (y * 12 + (m - 1) < simdiAnahtar) liste.push({ yil: y, ay: m })
    m++
    if (m > 12) {
      y++
      m = 1
    }
    if (liste.length > 2400) break // guvenlik freni (200 yil)
  }
  return liste
}

/**
 * Bir ayin tick zip'ini indirir. Ay yayinlanmamissa null doner.
 * @param {string} parite Ornek: 'xauusd'
 * @param {number} yil
 * @param {number} ay
 * @returns {Promise<Buffer|null>}
 */
async function ayZipiniIndir(parite, yil, ay) {
  const sayfa = SAYFA_URL + parite.toLowerCase() + '/' + yil + '/' + ay
  const html = await httpText(sayfa, { label: ETIKET, timeoutMs: 45000 })
  const m = TK_RE.exec(html)
  if (!m || !m[1]) return null // o ay icin veri yayinlanmamis

  const govde = new URLSearchParams({
    tk: m[1],
    date: String(yil),
    datemonth: String(yil) + (ay < 10 ? '0' + ay : String(ay)),
    platform: 'ASCII',
    timeframe: 'T',
    fxpair: parite.toUpperCase(),
  }).toString()

  const zip = await httpBuffer(POST_URL, {
    method: 'POST',
    body: govde,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: sayfa,
      Origin: TEMEL,
    },
    // Aylik tick zip'i 50 MB'a kadar cikabiliyor, cömert zaman asimi verilir.
    timeoutMs: 600000,
    retries: 2,
  })

  // Gecerli zip 'PK' ile baslar; aksi halde HistData hata sayfasi dondurmustur.
  if (!zip || zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4b) return null
  return zip
}

/**
 * @param {{tfSec:number, from:number, to:number, apiKey?:string,
 *          symbol?:string, onProgress?:Function}} opts
 * @returns {Promise<import('../series').Series>}
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const tfSec = o.tfSec
  if (!(tfSec > 0)) throw new Error(ETIKET + ': gecersiz zaman dilimi')
  const parite = (o.symbol ? String(o.symbol) : 'XAUUSD').replace(/[^A-Za-z]/g, '')

  const simdi = Math.floor(Date.now() / 1000)
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : simdi
  let from = Number.isFinite(o.from) ? Math.floor(o.from) : to - 365 * 86400
  if (to > simdi) to = simdi
  if (from >= to) return emptySeries()

  const aylar = aylariListele(from, to)
  if (aylar.length === 0) {
    // Yalnizca icinde bulunulan ay istendi; o ay henuz yayinlanmiyor.
    bildir(o.onProgress, 100, ETIKET + ': istenen aralikta yayinlanmis ay yok')
    return emptySeries()
  }

  // Bir ayda en fazla ~32000 dakikalik bar olur. Tampon buyudugu icin
  // baslangic kapasitesi olcusuz buyuk tutulmaz.
  const ilkKapasite = Math.min(aylar.length * 32000, 200000)
  const tampon = tamponOlustur(ilkKapasite)
  let atlanan = 0

  for (let i = 0; i < aylar.length; i++) {
    const a = aylar[i]
    const etiketAy = a.yil + '-' + (a.ay < 10 ? '0' + a.ay : a.ay)
    bildir(o.onProgress, (i / aylar.length) * 100, ETIKET + ': ' + etiketAy + ' indiriliyor')

    let zip = null
    try {
      zip = await ayZipiniIndir(parite, a.yil, a.ay)
    } catch (err) {
      throw new Error(ETIKET + ': ' + etiketAy + ' indirilemedi. ' + (err && err.message ? err.message : ''))
    }
    if (!zip) {
      atlanan++
      continue
    }

    bildir(o.onProgress, ((i + 0.5) / aylar.length) * 100, ETIKET + ': ' + etiketAy + ' isleniyor')
    const csv = zipCsvOku(zip)
    zip = null
    if (!csv) {
      atlanan++
      continue
    }
    ticklerden1m(csv, tampon, from, to)

    if (i + 1 < aylar.length) await sleep(400)
  }

  if (tampon.n === 0) {
    bildir(o.onProgress, 100, ETIKET + ': veri bulunamadi (' + atlanan + ' ay bos)')
    return emptySeries()
  }

  let seri = sanitize(tampondanSeri(tampon))
  if (tfSec !== 60 && seri.length > 0) seri = resample(seri, tfSec)
  bildir(o.onProgress, 100, ETIKET + ': ' + seri.length + ' mum hazir')
  return seri
}

module.exports = {
  id: 'histdata',
  name: 'HistData (XAUUSD tick)',
  needsKey: false,
  caps: ['history'],
  isProxy: false,
  note:
    'Anahtarsiz ve ucretsiz. Aylik tick dosyalarindan 1 dakikalik mum uretir, ' +
    'hacim dakikadaki tick sayisidir. Zaman dilimi sabit UTC-5 kabul edilir. ' +
    'Icinde bulunulan ay yayinlanmadigi icin en fazla gecen aya kadar veri gelir. ' +
    'Canli veri icin uygun degildir.',
  fetchCandles: fetchCandles,
  // Test ve betikler icin acilan ic yardimcilar:
  _zipCsvOku: zipCsvOku,
  _aylariListele: aylariListele,
  /**
   * Tick CSV tamponunu dogrudan 1 dakikalik Series'e cevirir.
   * @param {Buffer} csv
   * @param {number} [from]
   * @param {number} [to]
   * @returns {import('../series').Series}
   */
  _tickCsvden1m: function (csv, from, to) {
    const tampon = tamponOlustur(4096)
    ticklerden1m(
      csv,
      tampon,
      Number.isFinite(from) ? from : -Infinity,
      Number.isFinite(to) ? to : Infinity
    )
    return sanitize(tampondanSeri(tampon))
  },
}
