'use strict'

/**
 * OANDA VERI PAKETI
 * ============================================================================
 * NEDEN VAR
 *
 * Uygulama artik tek kaynakla calisiyor: OANDA. Ama mevcut kurulumlarin
 * deposu HistData (gecmis) + Binance PAXGUSDT (canli) ile kurulmustu. Ayari
 * degistirmek tek basina yetmez: depo oldugu yerde kalir ve yeni gelen OANDA
 * barlari ESKI deponun fiyat ve hacim olcegine UYDURULUR (loader.js, kaynak
 * degisimi vekil sayilir). Yani kutular yine eski akistan hesaplanirdi.
 *
 * Deponun OANDA'dan yeniden kurulmasi gerekiyor. Iki yol vardi:
 *
 *   OANDA'dan tek tek indirmek : olculdu, 1 dakikalik tam gecmis yaklasik
 *                                7 milyon mum ve BIR SAATTEN uzun suruyor.
 *                                Musterinin makinesinde kabul edilemez.
 *   Hazir dosyayi indirmek     : tek dosya, birkac dakika. Bu dosya.
 *
 * ZAMAN DILIMLERI
 * Yalnizca 1 dakikalik indirilir. 5m/15m/30m/1h/4h dosyalari zaten 1
 * dakikaliktan TURETILIYOR (loader.js), bu yuzden tek dosya hepsini OANDA
 * yapar. Kurulumdan sonra turetilmis dosyalar silinir ve kendiliginden
 * yeniden uretilir.
 *
 * GUVENLIK VE GERI DONUS
 *  - Indirilen dosya once gecici ada yazilir, SHA-256 dogrulanir ve okunabilir
 *    bir seri oldugu kanitlanir; ancak ondan sonra yerine gecer.
 *  - Eski depo SILINMEZ, `.oncekiKaynak` ekiyle durur.
 *  - Yarim kalan indirme bir sonraki acilista bastan baslar, bozuk dosya
 *    yerine gecmez.
 * ============================================================================
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const https = require('https')
const zlib = require('zlib')
const crypto = require('crypto')
const { pipeline } = require('stream/promises')
const { Transform } = require('stream')

const paths = require('./paths')

/**
 * Gereken paket surumu. Veri yenilendiginde ARTTIRILIR; kurulu makineler
 * isaretlerinde daha kucuk bir sayi gorunce paketi yeniden indirir.
 */
const GEREKLI_SURUM = 1

/** Paketin indirilecegi adres. Surum etiketi paket surumuyle birlikte artar. */
const PAKET_URL =
  'https://github.com/dogukandogru/zone-memory/releases/download/veri-v1/XAUUSD_1m_oanda_v1.bin.gz'

/**
 * Paketin SHA-256 ozeti (gzip'li halin degil, ACILMIS dosyanin).
 * Yayin betigi (scripts/publish-data.mjs) bu degeri yazdirir.
 */
const PAKET_SHA256 = 'b99e9ed4e4db66245546d5fb29b40a1935c199510aff3ef80736afaa881ca4b5'

/** Indirilen dosyada beklenen en az bar sayisi (kabaca dogruluk kontrolu). */
// Olculdu: paket 7.130.898 bar tasiyor (2006-03-19 -> 2026-09-23). Esik
// bunun altinda ama yarim inmis bir dosyayi eleyecek kadar yuksek.
const EN_AZ_BAR = 6500000

/** 1 dakikaliktan turetilen zaman dilimleri; kurulumdan sonra silinirler. */
const TURETILEN = ['5m', '15m', '30m', '1h', '4h']

/** Kurulum isaretinin yolu. */
function isaretYolu() {
  return path.join(paths.dataDir(), 'oanda-veri.json')
}

/**
 * Kurulu paket surumunu okur.
 * @returns {number} Kurulu degilse 0
 */
function kuruluSurum() {
  try {
    const ham = JSON.parse(fs.readFileSync(isaretYolu(), 'utf8'))
    const s = Number(ham && ham.surum)
    return Number.isFinite(s) ? s : 0
  } catch (err) {
    return 0
  }
}

/**
 * Paket indirilmeli mi.
 *
 * Adres veya ozet bos birakilmissa (gelistirme yapisi) HICBIR SEY yapilmaz:
 * dogrulanamayan bir dosyayi kullanicinin deposuna koymaktansa eski depoyla
 * devam etmek yeglenir.
 *
 * @returns {boolean}
 */
function gerekiyorMu() {
  if (!PAKET_URL || !PAKET_SHA256) return false
  return kuruluSurum() < GEREKLI_SURUM
}

/**
 * Adresi izler ve govdeyi dosyaya yazar (yonlendirmeleri takip eder).
 * @param {string} url
 * @param {string} hedef
 * @param {(indirilen:number, toplam:number)=>void} [ilerleme]
 * @param {number} [derinlik]
 * @returns {Promise<void>}
 */
function indir(url, hedef, ilerleme, derinlik) {
  const kalan = typeof derinlik === 'number' ? derinlik : 5
  return new Promise((coz, reddet) => {
    if (kalan <= 0) {
      reddet(new Error('Cok fazla yonlendirme'))
      return
    }
    const istek = https.get(url, { headers: { 'User-Agent': 'ZoneMemory' } }, (yanit) => {
      const kod = yanit.statusCode || 0
      if (kod >= 300 && kod < 400 && yanit.headers.location) {
        yanit.resume()
        indir(yanit.headers.location, hedef, ilerleme, kalan - 1).then(coz, reddet)
        return
      }
      if (kod !== 200) {
        yanit.resume()
        reddet(new Error('Veri paketi indirilemedi, sunucu ' + kod + ' dondu.'))
        return
      }
      const toplam = Number(yanit.headers['content-length']) || 0
      let alinan = 0
      // ILERLEME SAYACI BORUNUN ICINDE.
      //
      // `yanit.on('data', ...)` ile saymak akisi hemen "akan" kipe gecirir;
      // pipeline baglanana kadar gelen parcalar dusebilirdi. Sayim bu yuzden
      // borunun bir halkasi olarak yapiliyor.
      const sayac = new Transform({
        transform(parca, kodlama, geri) {
          alinan += parca.length
          if (ilerleme) ilerleme(alinan, toplam)
          geri(null, parca)
        },
      })
      // GZIP ACMA AKISTA: 326 MB'lik dosya bellege alinmaz.
      pipeline(yanit, sayac, zlib.createGunzip(), fs.createWriteStream(hedef)).then(coz, reddet)
    })
    istek.on('error', reddet)
    // Aga baglanamayan bir istek sonsuza kadar asili kalmamali.
    istek.setTimeout(120000, () => {
      istek.destroy(new Error('Veri paketi indirilirken baglanti zaman asimina ugradi.'))
    })
  })
}

/**
 * Dosyanin SHA-256 ozetini hesaplar.
 * @param {string} dosya
 * @returns {Promise<string>}
 */
async function ozet(dosya) {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(dosya), h)
  return h.digest('hex')
}

/** Dosyayi sessizce siler. */
async function sessizSil(dosya) {
  try {
    await fsp.unlink(dosya)
  } catch (err) {
    // Yoksa sorun degil.
  }
}

/**
 * Paketi indirir, dogrular ve yerine koyar.
 *
 * @param {{onProgress?:(pct:number, mesaj:string)=>void}} [opts]
 * @returns {Promise<{kuruldu:boolean, bar?:number, sebep?:string}>}
 */
async function kur(opts) {
  const o = opts || {}
  const bildir = (pct, mesaj) => {
    if (typeof o.onProgress === 'function') o.onProgress(pct, mesaj)
  }
  if (!gerekiyorMu()) return { kuruldu: false, sebep: 'gerekmiyor' }

  const dataDir = paths.dataDir()
  await fsp.mkdir(dataDir, { recursive: true })
  const hedef = paths.candlePath('1m')
  const gecici = hedef + '.indiriliyor'

  // Yarim kalmis bir deneme varsa bastan baslanir.
  await sessizSil(gecici)

  bildir(0, 'Altın verisi indiriliyor')
  await indir(PAKET_URL, gecici, (alinan, toplam) => {
    const pct = toplam > 0 ? Math.min(95, (alinan / toplam) * 95) : 0
    const mb = (alinan / 1048576).toFixed(0)
    bildir(pct, 'Altın verisi indiriliyor, ' + mb + ' MB')
  })

  // DOGRULAMA 1: dosya gercekten bekledigimiz dosya mi.
  bildir(96, 'Veri doğrulanıyor')
  const bulunan = await ozet(gecici)
  if (bulunan !== PAKET_SHA256) {
    await sessizSil(gecici)
    throw new Error('Veri paketi bozuk geldi (özet tutmuyor), eski veri korundu.')
  }

  return await yerineKoy(gecici, { onProgress: o.onProgress })
}

/**
 * Indirilmis ve OZETI DOGRULANMIS dosyayi deponun yerine koyar.
 *
 * Indirmeden ayri durmasi kasitli: asil riskli adimlar burada ve boylece
 * gercek dosyalarla test edilebiliyor.
 *
 * @param {string} gecici Yerine konacak dosyanin yolu
 * @param {{onProgress?:Function, enAzBar?:number}} [opts]
 * @returns {Promise<{kuruldu:boolean, bar:number}>}
 */
async function yerineKoy(gecici, opts) {
  const o = opts || {}
  const bildir = (pct, mesaj) => {
    if (typeof o.onProgress === 'function') o.onProgress(pct, mesaj)
  }
  const enAzBar = Number.isFinite(o.enAzBar) ? o.enAzBar : EN_AZ_BAR
  const dataDir = paths.dataDir()
  const hedef = paths.candlePath('1m')

  // DOGRULAMA: okunabilir bir mum deposu mu ve makul uzunlukta mi.
  const binstore = require('../core/store/binstore')
  let durum = null
  try {
    durum = await binstore.statSeries(gecici)
  } catch (err) {
    durum = null
  }
  if (!durum || !(durum.count >= enAzBar)) {
    await sessizSil(gecici)
    throw new Error('Veri paketi okunamadı veya beklenenden kısa, eski veri korundu.')
  }

  // ESKI DEPO SILINMEZ. Geri donus gerekirse diye yerinde birakilir.
  bildir(97, 'Yeni veri yerine konuyor')
  try {
    await fsp.rename(hedef, hedef + '.oncekiKaynak')
  } catch (err) {
    // Depo yoksa (temiz kurulum) tasinacak bir sey de yoktur.
  }
  await fsp.rename(gecici, hedef)

  // 1 dakikaligin kuyruk dosyasi, kaynak kaydi ve yaz saati isareti ESKI
  // depoya aitti. Kaynak kaydi kalsaydi yeni barlar "kaynak degisti" sayilip
  // ESKI olcege uydurulurdu; yaz saati isareti ise artik baska bir dosyayi
  // anlatiyor olurdu (OANDA zamanlari zaten UTC gelir, duzeltme gerekmez).
  await sessizSil(hedef + '.tail.bin')
  await sessizSil(path.join(dataDir, 'XAUUSD_1m.proxy.json'))
  await sessizSil(path.join(dataDir, 'XAUUSD_1m.dst.json'))

  // TURETILMIS DOSYALAR: 1 dakikaliktan yeniden uretilecekler.
  bildir(98, 'Zaman dilimleri yenileniyor')
  for (const tf of TURETILEN) {
    const yol = paths.candlePath(tf)
    await sessizSil(yol)
    await sessizSil(yol + '.meta.json')
    await sessizSil(yol + '.tail.bin')
    await sessizSil(path.join(dataDir, 'XAUUSD_' + tf + '.proxy.json'))
  }

  // HAFIZA DA GECERSIZ, ama kendiliginden anlasilmiyor.
  //
  // Arayuz "hafiza guncel mi" sorusunu IKI olcutle cevapliyor: kuruldugu
  // zaman deponun son barina yakin mi (`hafizaGeride`) ve ozellik vektoru
  // uzunlugu guncel mi (`memoryCurrent`). Ikisi de VERININ DEGISTIGINI
  // gormez: eski hafiza HistData olaylarindan kurulmustur ama zamani yeni
  // deponun son barina yakin oldugu icin GUNCEL GORUNUR ve yeniden tarama
  // hic calismaz. O yuzden hafiza kenara alinir; boylece "hafiza yok" yoluna
  // dusulur ve tarama kesin calisir.
  //
  // Silinmez, `.oncekiKaynak` ekiyle durur.
  bildir(99, 'Hafıza yenileniyor')
  const HAFIZA_EKLERI = ['.json', '.vec', '.meta.json', '.protos.json',
    '.zones.json', '.cands.bin']
  for (const tf of ['1m'].concat(TURETILEN)) {
    const taban = paths.memoryPath(tf)
    for (const ek of HAFIZA_EKLERI) {
      try {
        await fsp.rename(taban + ek, taban + ek + '.oncekiKaynak')
      } catch (err) {
        // Dosya yoksa sorun degil.
      }
    }
  }

  // OLCUMLER GECERSIZ. Ayar izi bunu yakalayamaz (ayar degismedi, VERI
  // degisti), bu yuzden her zaman dilimine isaret birakilir; tarama isareti
  // gorunce sinyal listesini yedekler ve arayuz testi yeniden calistirir.
  for (const tf of ['1m'].concat(TURETILEN)) {
    try {
      await fsp.writeFile(paths.olcumYenilePath(tf),
        JSON.stringify({ sebep: 'oanda-veri-paketi', surum: GEREKLI_SURUM }) + '\n')
    } catch (err) {
      // Yazilamazsa olcum eski kalir; veri yine de dogru.
    }
  }

  await fsp.writeFile(isaretYolu(), JSON.stringify({
    surum: GEREKLI_SURUM,
    kaynak: 'oanda',
    bar: durum.count,
    ilkBar: durum.firstTime,
    sonBar: durum.lastTime,
    kuruldu: Math.floor(Date.now() / 1000),
  }, null, 2) + '\n')

  bildir(100, 'Altın verisi hazır')
  return { kuruldu: true, bar: durum.count }
}

module.exports = {
  GEREKLI_SURUM,
  PAKET_URL,
  PAKET_SHA256,
  EN_AZ_BAR,
  TURETILEN,
  isaretYolu,
  kuruluSurum,
  gerekiyorMu,
  kur,
  yerineKoy,
}
