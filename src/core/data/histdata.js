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
//
// ZAMAN DILIMI: dosya saatleri sabit UTC-5 DEGILDIR, yaz saati uygulanir ve
// uygulanan kural 2019'da degismistir. Olculdu (depodaki seri ile Binance
// PAXGUSDT 1m getirilerinin gecikme taramasi ve ABD 08:30 ET veri aciklamasi
// dakikasi): 2018 ve oncesinde ABD (America/New_York) yaz saati tarihleri,
// 2019 ve sonrasinda AVRUPA yaz saati tarihleri kullanilmis. Sabit UTC-5
// varsayimi yilin 7-8 ayinda tum barlari 1 saat ileri kaydiriyordu.
// Sinir 2018-11-04 ile 2019-03-10 arasinda herhangi bir gun olabilir, cunku
// o aralikta iki kural da 5 saat verir.
//
// Zip acmak icin harici bagimlilik yoktur: asagida zlib.inflateRaw uzerine
// kurulu minimal bir ZIP okuyucu vardir. Acma ISI SENKRON DEGILDIR: 50 MB'lik
// aylik zip'i inflateRawSync ile acmak isciyi saniyelerce kilitliyor, bu sure
// boyunca canli tur ve bolge taramasi duruyordu.

const zlib = require('node:zlib')
const util = require('node:util')
const { sanitize, resample, emptySeries } = require('../series')
const { httpText, httpBuffer, sleep, bildir } = require('./provider')

const inflateRaw = util.promisify(zlib.inflateRaw)

const ETIKET = 'HistData'
const TEMEL = 'https://www.histdata.com'
const SAYFA_URL = TEMEL + '/download-free-forex-historical-data/?/ascii/tick-data-quotes/'
const POST_URL = TEMEL + '/get.php'
const TK_RE = /name="tk"\s+id="tk"\s+value="([^"]*)"/
// Kis saatinde (her iki kuralda da) dosya saati UTC-5'tir.
const KIS_OFSET_SN = 5 * 3600
const YAZ_OFSET_SN = 4 * 3600
// 2019'dan itibaren AB yaz saati kurali gecerli (bkz. yukaridaki not).
const AB_KURALI_ILK_YIL = 2019

/** Ayin verilen gun sayisini (1..7 = Pazartesi..Pazar) son gununu bulur. */
function ayinSonGunu(yil, ay, haftaninGunu) {
  // Ayin son gunu: bir sonraki ayin 0. gunu.
  const son = new Date(Date.UTC(yil, ay, 0))
  const fark = (son.getUTCDay() - haftaninGunu + 7) % 7
  return son.getUTCDate() - fark
}

/**
 * Dosya saatinin UTC ofsetini (saniye) verir. Donusum: UTC = dosya + ofset.
 *
 * 2018 ve oncesi: ABD kurali (Mart ikinci pazar 02:00 yerel - Kasim ilk pazar).
 * 2019 ve sonrasi: AB kurali (Mart son pazar - Ekim son pazar).
 * Gun bazinda calisir; gecis gunundeki saat dilimi kirilmasi tick'lerin bir
 * saatlik bir bolumunu etkiler, bu da hafta sonuna denk geldigi icin veri
 * icermez.
 *
 * @param {number} yil
 * @param {number} ay 1..12
 * @param {number} gun 1..31
 * @returns {number} saniye
 */
function dosyaOfsetiSn(yil, ay, gun) {
  let yazBaslangic
  let yazBitis
  if (yil >= AB_KURALI_ILK_YIL) {
    // AB: Mart son pazar, Ekim son pazar.
    yazBaslangic = { ay: 3, gun: ayinSonGunu(yil, 3, 0) }
    yazBitis = { ay: 10, gun: ayinSonGunu(yil, 10, 0) }
  } else {
    // ABD: Mart ikinci pazar, Kasim ilk pazar (2007'den beri).
    const martIlkPazar = 1 + ((7 - new Date(Date.UTC(yil, 2, 1)).getUTCDay()) % 7)
    yazBaslangic = { ay: 3, gun: martIlkPazar + 7 }
    yazBitis = { ay: 11, gun: 1 + ((7 - new Date(Date.UTC(yil, 10, 1)).getUTCDay()) % 7) }
  }
  const anahtar = ay * 100 + gun
  const bas = yazBaslangic.ay * 100 + yazBaslangic.gun
  const bit = yazBitis.ay * 100 + yazBitis.gun
  return anahtar >= bas && anahtar < bit ? YAZ_OFSET_SN : KIS_OFSET_SN
}

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
 * @returns {Promise<Buffer>}
 */
async function zipGirisiniAc(buf, kayit) {
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
  // Acma is parcaciginin havuzunda yapilir; senkron surum isciyi kilitliyordu.
  if (kayit.yontem === 8) return inflateRaw(dilim)
  throw new Error(
    ETIKET + ': desteklenmeyen zip sikistirma yontemi ' + kayit.yontem + ' (' + kayit.ad + ')'
  )
}

/**
 * Zip icindeki ilk .csv dosyasini acilmis halde dondurur.
 * @param {Buffer} buf
 * @returns {Promise<Buffer|null>}
 */
async function zipCsvOku(buf) {
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

// Geciken tick icin tamponun sonundan kac kova taranir. Gecikme olculdugu
// kadariyla birkac saniyedir, yani hedef kova hep en sondaki kovalardan
// biridir; tamponun tamamini taramak ayda 15 milyon satirda olcusuz maliyet
// olur.
const GERI_TARAMA_KOVA = 5

/**
 * Zamanda GERIYE giden (sira disi) bir tick'i tampondaki mevcut kovaya katar.
 *
 * Neden gerekli: HistData tick dosyalarinda ayni dakikanin bir kac satiri
 * bazen sonraki dakikadan SONRA gelir. Eskiden bu satir yeni bir kova
 * aciyordu; ayni zaman damgasi tampona iki kez giriyor ve sanitize son kaydi
 * tuttugu icin dakikanin gercek hacmi tek tick'e duyuyordu (olculdu: 14:30
 * barinda hacim 3 yerine 1).
 *
 * open ve close DEGISTIRILMEZ: ilk ve son fiyat dosyadaki sirayla belirlenir,
 * geciken satir hangi saniyeye ait oldugu bilinse de o siranin neresine
 * girdigini soyleyemez. high, low ve hacim ise siradan bagimsizdir.
 *
 * @param {{n:number}} b Tampon
 * @param {number} kova Kova baslangici (UNIX saniye)
 * @param {number} bid
 * @returns {boolean} Kova bulunup birlestirildiyse true
 */
function gecikenTickiKat(b, kova, bid) {
  const alt = b.n > GERI_TARAMA_KOVA ? b.n - GERI_TARAMA_KOVA : 0
  for (let i = b.n - 1; i >= alt; i--) {
    if (b.time[i] !== kova) continue
    if (bid > b.high[i]) b.high[i] = bid
    if (bid < b.low[i]) b.low[i] = bid
    b.volume[i] += 1
    return true
  }
  return false
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
 * @returns {number} Hicbir kovaya katilamayan sira disi tick sayisi
 */
function ticklerden1m(buf, tampon, from, to) {
  const n = buf.length
  let i = 0
  let siraDisi = 0

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
          gunEpoch = Date.UTC(yil, ay - 1, gun) / 1000 + dosyaOfsetiSn(yil, ay, gun)
        }
        const t = gunEpoch + saat * 3600 + dk * 60 + sn
        const yeniKova = t - (t % 60)

        if (yeniKova < kova) {
          // Zaman geriye gitti: acik kovayi kapatmak yerine geciken tick'i
          // tampondaki kovasina katariz (bkz. gecikenTickiKat).
          if (!gecikenTickiKat(tampon, yeniKova, bid)) siraDisi++
        } else if (yeniKova !== kova) {
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
  return siraDisi
}

/* ------------------------------------------------------------------ */
/* Indirme                                                             */
/* ------------------------------------------------------------------ */

// Depodaki son bar, ayin kapanisina bu kadar yaklastiysa ay TAM sayilir.
// 1 saat secildi cunku ayin son barindan sonra gelen tek eksik, kapanis
// oncesi bir kac dakikalik bosluk olabilir; bunun icin 40-50 MB'lik zip'i
// yeniden indirmek anlamsizdir.
const AY_TAM_ESIGI_SN = 3600

/**
 * Bir ayin tick dosyasinda BEKLENEN son veri anini (UTC saniye) verir.
 *
 * Spot altin haftasi Cuma 17:00 New York'ta kapanir ve Cumartesi kapalidir;
 * diger gunlerde islem gece yarisini asar. Dosya saatleri de New York'a esit
 * bir ofsette tutuldugu icin (bkz. dosyaOfsetiSn) esik dosya saatiyle kurulup
 * UTC'ye cevrilir:
 *  - Ayin son gunu Cuma ise veri o gun 17:00'de biter.
 *  - Cumartesi ise bir onceki Cuma 17:00'de biter.
 *  - Diger gunlerde (Pazar aksam acilisi dahil) takvim ayinin sonuna kadar surer.
 *
 * @param {number} yil
 * @param {number} ay 1..12
 * @returns {number} UNIX saniye
 */
function ayVeriSonuSn(yil, ay) {
  const sonGun = new Date(Date.UTC(yil, ay, 0)).getUTCDate()
  const haftaninGunu = new Date(Date.UTC(yil, ay - 1, sonGun)).getUTCDay()
  let gun = sonGun
  // 24. saat: islem gece yarisini astigi icin veri ayin sonuna kadar surer.
  let saat = 24
  if (haftaninGunu === 5) {
    saat = 17
  } else if (haftaninGunu === 6) {
    gun = sonGun - 1
    saat = 17
  }
  return Date.UTC(yil, ay - 1, gun) / 1000 + saat * 3600 + dosyaOfsetiSn(yil, ay, gun)
}

/**
 * [from, to] araligindaki aylari listeler. Icinde bulunulan ay ve gelecek
 * aylar YAYINLANMADIGI icin listeye alinmaz.
 *
 * `from` artimli guncellemede DEPODAKI SON BARIN zamanidir (loader eksik
 * araligi oradan baslatir). Son bar bir ayin kapanisina 1 saatten yakinsa o ay
 * TAM demektir ve listeye alinmaz: eskiden zaten tamamlanmis son ay her
 * senkronda bastan iniyordu, yani her tiklama bir aylik zip'i bosa indiriyordu.
 *
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
    const yayinlandi = y * 12 + (m - 1) < simdiAnahtar
    const eksikVar = ayVeriSonuSn(y, m) - from > AY_TAM_ESIGI_SN
    if (yayinlandi && eksikVar) liste.push({ yil: y, ay: m })
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

/** Tamponu teslime hazir seriye cevirir: son adim final donusle ayni olsun. */
function seriHazirla(tampon, tfSec) {
  let s = sanitize(tampondanSeri(tampon))
  if (tfSec !== 60 && s.length > 0) s = resample(s, tfSec)
  return s
}

/**
 * @param {{tfSec:number, from:number, to:number, apiKey?:string,
 *          symbol?:string, onProgress?:Function,
 *          onChunk?:(seri:import('../series').Series)=>Promise<void>|void,
 *          _ayZipiniIndir?:Function}} opts
 *   onChunk verilirse her AY islendikten sonra o ayin barlari cagirana teslim
 *   edilir ve tampon sifirlanir; donus degeri BOS seri olur. Verilmezse butun
 *   aylar biriktirilip tek seri olarak donulur (eski davranis).
 *   _ayZipiniIndir yalnizca testler icin indirme fonksiyonunu degistirir.
 * @returns {Promise<import('../series').Series>}
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const tfSec = o.tfSec
  if (!(tfSec > 0)) throw new Error(ETIKET + ': gecersiz zaman dilimi')
  const parite = (o.symbol ? String(o.symbol) : 'XAUUSD').replace(/[^A-Za-z]/g, '')
  const onChunk = typeof o.onChunk === 'function' ? o.onChunk : null
  const indir = typeof o._ayZipiniIndir === 'function' ? o._ayZipiniIndir : ayZipiniIndir

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
  // baslangic kapasitesi olcusuz buyuk tutulmaz. onChunk varken tampon her ay
  // bosaldigi icin tek ay kapasitesi yeter.
  const ilkKapasite = onChunk ? 32000 : Math.min(aylar.length * 32000, 200000)
  let tampon = tamponOlustur(ilkKapasite)
  let atlanan = 0
  let siraDisi = 0
  let teslimEdilen = 0
  // Sahte indirici ile sunucuya yuk binmedigi icin nezaket beklemesi atlanir.
  const beklemeMs = o._ayZipiniIndir ? 0 : 400

  for (let i = 0; i < aylar.length; i++) {
    const a = aylar[i]
    const etiketAy = a.yil + '-' + (a.ay < 10 ? '0' + a.ay : a.ay)
    bildir(o.onProgress, (i / aylar.length) * 100, ETIKET + ': ' + etiketAy + ' indiriliyor')

    let zip = null
    try {
      zip = await indir(parite, a.yil, a.ay)
    } catch (err) {
      throw new Error(ETIKET + ': ' + etiketAy + ' indirilemedi. ' + (err && err.message ? err.message : ''))
    }
    if (!zip) {
      atlanan++
      continue
    }

    bildir(o.onProgress, ((i + 0.5) / aylar.length) * 100, ETIKET + ': ' + etiketAy + ' isleniyor')
    const csv = await zipCsvOku(zip)
    zip = null
    if (!csv) {
      atlanan++
      continue
    }
    siraDisi += ticklerden1m(csv, tampon, from, to)

    // Ay ay teslim: 210 aylik bir indirmede tek ag hatasi her seyi
    // kaybettiriyordu, cunku barlar ancak en sonda donuyordu. Artik islenen ay
    // hemen cagirana (depoya) gecer.
    //
    // Parca sinirlari AY sinirlaridir; tfSec 60'tan buyukse ay sinirina denk
    // gelen kova iki parcaya bolunur ve depo ayni zaman damgasinda sonraki
    // parcayi tuttugu icin o tek kova eksik kalir. Ust zaman dilimleri zaten
    // 1 dakikalik dosyadan turetildigi icin (loader.rebuildDerived) kabul edilir.
    if (onChunk && tampon.n > 0) {
      const parca = seriHazirla(tampon, tfSec)
      teslimEdilen += parca.length
      await onChunk(parca)
      // Tampon SIFIRLANMAZ, yenisi kurulur: tampondanSeri tamponun kendi
      // dizilerini paylasir, ayni tampon yeniden kullanilsa teslim edilen
      // parcanin uzerine sonraki ayin verisi yazilirdi.
      tampon = tamponOlustur(ilkKapasite)
    }

    if (beklemeMs > 0 && i + 1 < aylar.length) await sleep(beklemeMs)
  }

  const siraDisiNot = siraDisi > 0 ? ' (' + siraDisi + ' sira disi tick birlestirilemedi)' : ''

  if (onChunk) {
    bildir(
      o.onProgress,
      100,
      ETIKET + ': ' + teslimEdilen + ' mum ay ay teslim edildi' + siraDisiNot
    )
    return emptySeries()
  }

  if (tampon.n === 0) {
    bildir(o.onProgress, 100, ETIKET + ': veri bulunamadi (' + atlanan + ' ay bos)')
    return emptySeries()
  }

  const seri = seriHazirla(tampon, tfSec)
  bildir(o.onProgress, 100, ETIKET + ': ' + seri.length + ' mum hazir' + siraDisiNot)
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
    'hacim dakikadaki tick sayisidir. Dosya saatleri yaz saatine gore cevrilir ' +
    '(2018 ve oncesi ABD, 2019 ve sonrasi Avrupa kurali). ' +
    'Icinde bulunulan ay yayinlanmadigi icin en fazla gecen aya kadar veri gelir. ' +
    'Canli veri icin uygun degildir.',
  fetchCandles: fetchCandles,
  // Test ve betikler icin acilan ic yardimcilar:
  _zipCsvOku: zipCsvOku,
  _aylariListele: aylariListele,
  _ayVeriSonuSn: ayVeriSonuSn,
  _dosyaOfsetiSn: dosyaOfsetiSn,
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
