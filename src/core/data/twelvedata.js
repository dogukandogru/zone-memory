'use strict'

// Twelve Data saglayicisi (XAU/USD spot).
//
// Olculmus gercek: API anahtari ZORUNLUDUR. Fiyat gercek spot XAUUSD'dir
// (isProxy: false), ancak forex/metal serilerinde HACIM GELMEZ, volume alani
// yoktur veya 0'dir. Indikatorun flow bileseni hacme bagli oldugundan bu
// kaynak tek basina ogrenme icin zayiftir; fiyat referansi olarak degerlidir.
//
// Sinirlar: tek istekte en fazla 5000 satir, ucretsiz planda dakikada 8 istek.
// Istekler arasina bekleme konur ve gelen "hiz siniri" yanitlari beklenerek
// yeniden denenir.

const { fromArrays, sanitize, resample, emptySeries } = require('../series')
const { httpJson, sleep, kaynakZamanDilimi, bildir } = require('./provider')

/** 429 yanitinda kac kez beklenip tekrar denenecegi. */
const MAX_HIZ_SINIRI_DENEMESI = 3

const ETIKET = 'Twelve Data'
const SEMBOL = 'XAU/USD'
const TEMEL = 'https://api.twelvedata.com/time_series'
const CIKTI_BOYU = 5000

/** Saniye -> Twelve Data aralik kodu. */
const ARALIKLAR = {
  60: '1min',
  300: '5min',
  900: '15min',
  1800: '30min',
  2700: '45min',
  3600: '1h',
  7200: '2h',
  14400: '4h',
  28800: '8h',
  86400: '1day',
}
const DESTEKLI = [60, 300, 900, 1800, 2700, 3600, 7200, 14400, 28800, 86400]

/** UNIX saniyeyi 'YYYY-MM-DD HH:MM:SS' (UTC) bicimine cevirir. */
function utcMetin(sn) {
  const d = new Date(sn * 1000)
  const iki = function (x) {
    return x < 10 ? '0' + x : String(x)
  }
  return (
    d.getUTCFullYear() +
    '-' + iki(d.getUTCMonth() + 1) +
    '-' + iki(d.getUTCDate()) +
    ' ' + iki(d.getUTCHours()) +
    ':' + iki(d.getUTCMinutes()) +
    ':' + iki(d.getUTCSeconds())
  )
}

/** 'YYYY-MM-DD HH:MM:SS' veya 'YYYY-MM-DD' metnini UNIX saniyeye cevirir. */
function zamanCoz(metin) {
  if (!metin) return NaN
  const s = String(metin).trim()
  const iso = s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z'
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN
}

/**
 * @param {{tfSec:number, from:number, to:number, apiKey?:string,
 *          onProgress?:Function}} opts
 * @returns {Promise<import('../series').Series>}
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const apiKey = o.apiKey ? String(o.apiKey).trim() : ''
  if (!apiKey) {
    throw new Error(
      ETIKET + ': API anahtari gerekli. Ayarlar sekmesinden twelvedata anahtarini girin.'
    )
  }

  const secim = kaynakZamanDilimi(o.tfSec, DESTEKLI)
  const kaynakSec = secim.kaynakSec
  const kod = ARALIKLAR[kaynakSec]

  const simdi = Math.floor(Date.now() / 1000)
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : simdi
  let from = Number.isFinite(o.from) ? Math.floor(o.from) : to - 7 * 86400
  if (to > simdi) to = simdi
  if (from >= to) return emptySeries()

  const t = []
  const ac = []
  const yuk = []
  const dus = []
  const kap = []
  const hac = []

  let imlec = from
  let tur = 0
  // Hacimli bar sayaci: forex/metal serilerinde hacim hic gelmeyebilir ve o
  // donemde indikatorun hacim kapisi hic acilmaz (yani kutu olusmaz).
  let hacimliBar = 0
  // Hiz siniri denemesi: gunluk kota dolduysa beklemek acmaz.
  let hizSiniriDenemesi = 0
  bildir(o.onProgress, 0, ETIKET + ': ' + kod + ' mumlari indiriliyor')

  while (imlec <= to) {
    const url =
      TEMEL +
      '?symbol=' + encodeURIComponent(SEMBOL) +
      '&interval=' + kod +
      '&start_date=' + encodeURIComponent(utcMetin(imlec)) +
      '&end_date=' + encodeURIComponent(utcMetin(to)) +
      '&outputsize=' + CIKTI_BOYU +
      '&order=ASC&timezone=UTC&format=JSON'

    // ANAHTAR URL'DE DEGIL BASLIKTA. URL'deki anahtar vekil sunucu
    // gunluklerine, tarayici gecmisine ve hata mesajlarina dusebilir.
    const govde = await httpJson(url, {
      label: ETIKET,
      timeoutMs: 45000,
      headers: { Authorization: 'apikey ' + apiKey },
    })

    if (govde && govde.status === 'error') {
      const kodu = +govde.code
      if (kodu === 429) {
        // Dakikalik istek kotasi doldu. Sonsuza kadar beklemek arayuzu
        // kilitliyordu: gunluk kota dolduysa bekleyerek acilmaz. Uc denemeden
        // sonra anlasilir bir hata verilir.
        hizSiniriDenemesi++
        if (hizSiniriDenemesi > MAX_HIZ_SINIRI_DENEMESI) {
          throw new Error(
            ETIKET + ': dakika veya gunluk kredi kotasi doldu (' +
            MAX_HIZ_SINIRI_DENEMESI + ' deneme sonunda). Daha sonra tekrar deneyin ' +
            'ya da baska bir kaynak secin.'
          )
        }
        bildir(o.onProgress, 0, ETIKET + ': hiz siniri, 65 saniye bekleniyor (' +
          hizSiniriDenemesi + '/' + MAX_HIZ_SINIRI_DENEMESI + ')')
        await sleep(65000)
        continue
      }
      if (kodu === 400 && /no data/i.test(String(govde.message || ''))) break
      throw new Error(ETIKET + ': ' + (govde.message || 'sunucu hatasi') + ' (kod ' + govde.code + ')')
    }

    const satirlar = govde && govde.values
    if (!Array.isArray(satirlar) || satirlar.length === 0) break

    let sonZaman = imlec
    for (let i = 0; i < satirlar.length; i++) {
      const r = satirlar[i]
      const sn = zamanCoz(r.datetime)
      if (!Number.isFinite(sn)) continue
      if (sn > sonZaman) sonZaman = sn
      if (sn < from || sn > to) continue
      const c = +r.close
      if (!Number.isFinite(c)) continue
      t.push(sn)
      ac.push(+r.open)
      yuk.push(+r.high)
      dus.push(+r.low)
      kap.push(c)
      // Forex/metal serilerinde hacim gelmez; gelmezse 0 yazilir.
      const v = r.volume === undefined || r.volume === null ? 0 : +r.volume
      const hacim = Number.isFinite(v) ? v : 0
      if (hacim > 0) hacimliBar++
      hac.push(hacim)
    }

    if (satirlar.length < CIKTI_BOYU) break
    const sonraki = sonZaman + kaynakSec
    if (sonraki <= imlec) break // ilerleme yok
    imlec = sonraki

    tur++
    const pct = to > from ? ((imlec - from) / (to - from)) * 100 : 100
    bildir(o.onProgress, pct, ETIKET + ': ' + t.length + ' mum indirildi')
    if (imlec <= to) await sleep(600)
    if (tur > 20000) break // guvenlik freni
  }

  let seri = sanitize(fromArrays({
    time: t,
    open: ac,
    high: yuk,
    low: dus,
    close: kap,
    volume: hac,
  }))
  if (secim.yenidenOrnekle && seri.length > 0) seri = resample(seri, o.tfSec)
  // HACIM YOKSA KUTU DA YOKTUR. Indikatorun kutu kapisi hacim patlamasina
  // bakar (`vR = hacim / SMA(hacim)`); hacim hep 0 gelirse bu kapi hic
  // acilmaz ve o donemde tek bir bolge bile olusmaz. Cagiran taraf bunu
  // kullaniciya soylesin diye seriye isaret konur.
  if (seri.length > 0 && hacimliBar === 0) {
    Object.defineProperty(seri, 'hacimYok', { value: true, enumerable: false })
  }
  bildir(o.onProgress, 100, ETIKET + ': ' + seri.length + ' mum hazir' +
    (seri.length > 0 && hacimliBar === 0 ? ' (hacim gelmedi, bu donemde kutu olusmaz)' : ''))
  return seri
}

module.exports = {
  id: 'twelvedata',
  name: 'Twelve Data (XAU/USD)',
  needsKey: true,
  caps: ['history', 'live'],
  isProxy: false,
  note:
    'API anahtari gerekir. Gercek spot XAUUSD fiyati verir, ancak forex serilerinde ' +
    'HACIM GELMEZ (volume 0). Ucretsiz planda dakikada 8 istek siniri vardir.',
  fetchCandles: fetchCandles,
}
