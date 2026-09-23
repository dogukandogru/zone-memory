'use strict'

// ============================================================================
// OANDA v20 - XAU_USD (spot altin)
// ----------------------------------------------------------------------------
// NEDEN BU SAGLAYICI EKLENDI
//
// Kullanici kutulara TradingView'da OANDA:XAUUSD grafiginde bakiyor. Uygulama
// ise gecmiste HistData, canlida Binance PAXGUSDT (bir token, yani VEKIL)
// kullaniyordu. Olculdu (2026-05-29 ile 2026-08-31 arasi, 6004 bar, 15m):
//
//   depo  : kullanicinin grafigindeki kutularin %56,7'sini uretiyor
//   OANDA : %100'unu uretiyor (53 kutunun 53'u, kesinlik %98,1)
//
// Eksik kutularin %96,6'si HACIM KAPISINDA takiliyordu ve eksiklerin medyan
// hacim orani 1,79 idi (kapi 2,00). Yani sorun portta degil, hacmin hangi
// akistan sayildigindaydi. OANDA hacmi kullanicinin baktigi akisin kendisi
// oldugu icin kapi ayni barlarda aciliyor.
//
// AYRICA:
//  - Spot XAU_USD verir, vekil DEGILDIR. Basis duzeltmesi, hacim kantil
//    eslestirmesi ve vekil rejim korumasi bu kaynakta gereksizdir.
//  - Hacim TICK SAYISIDIR, yani HistData ve TradingView ile AYNI CINS.
//  - Gecmis 2006-03-19'a kadar gider (olculdu, M1 dahil tum granuleritelerde),
//    HistData arsivinden UC YIL daha derin.
//  - Deneme (practice) hesabi ucretsizdir ve veri icin yeterlidir.
//
// ----------------------------------------------------------------------------
// DIKKAT EDILEN NOKTALAR
// ----------------------------------------------------------------------------
//  1. KAPANMAMIS MUM ALINMAZ. OANDA son mumu `complete: false` ile doner.
//     Yarim bar depoya girerse indikator o barda yanlis hacim ve yanlis
//     kapanis gorur; bir sonraki cekimde bar degisir ve ayni olay iki farkli
//     sonuc uretir.
//  2. Anahtar YALNIZCA baslikta gider, URL'de DEGIL. URL'ler sunucu
//     gunluklerine ve tarayici gecmisine duser.
//  3. Deneme ve canli ortam AYRI adreslerdir ve anahtarlar birbirinde
//     calismaz. Yanlis ortamda 401 doner; hata mesaji bunu acikca soyler,
//     yoksa kullanici anahtarini gecersiz saniyor.
//  4. Sayfalama `from` + `count` ile yapilir. `to` ile birlikte kullanilmaz:
//     OANDA ucunu birlikte verince hata doner.
// ============================================================================

const { httpJson, kaynakZamanDilimi, bildir, sleep } = require('./provider')
const { fromArrays, sanitize, resample } = require('../series')

const ETIKET = 'OANDA'

/** Deneme ve canli ortam adresleri. */
const HOST_DENEME = 'https://api-fxpractice.oanda.com'
const HOST_CANLI = 'https://api-fxtrade.oanda.com'

/** Uygulama zaman dilimi (saniye) -> OANDA granuleritesi. */
const GRANULERITE = {
  60: 'M1',
  300: 'M5',
  900: 'M15',
  1800: 'M30',
  3600: 'H1',
  14400: 'H4',
}

/** Dogrudan desteklenen zaman dilimleri (saniye). */
const DESTEKLI = Object.keys(GRANULERITE).map(Number).sort((a, b) => a - b)

/** Tek istekte alinabilecek azami mum (OANDA siniri). */
const SAYFA = 5000

/** Sayfalar arasi bekleme. OANDA sinirlari genis, ama nazik davraniyoruz. */
const VARSAYILAN_BEKLEME_MS = 120

/** En eski veri (olculdu: 2006-03-19). Bundan oncesi bos doner. */
const EN_ESKI = Date.UTC(2006, 2, 19) / 1000

/** RFC3339 zamanini UNIX saniyeye cevirir. */
function zamanaCevir(s) {
  if (typeof s !== 'string') return NaN
  // OANDA nanosaniye verir ("2026-09-23T08:30:00.000000000Z"); Date bunu
  // ayristirabilir ama saniyeye kirpmak daha guvenli ve hizli.
  const ms = Date.parse(s.length > 20 ? s.slice(0, 19) + 'Z' : s)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN
}

/** UNIX saniyeyi OANDA'nin bekledigi RFC3339 bicimine cevirir. */
function zamanMetni(sn) {
  return new Date(sn * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
}

/**
 * Mumlari indirir.
 *
 * @param {{tfSec:number, from?:number, to?:number, apiKey?:string,
 *          live?:boolean, pollMs?:number, onProgress?:Function}} opts
 * @returns {Promise<object>} series
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const apiKey = o.apiKey ? String(o.apiKey).trim() : ''
  if (!apiKey) {
    throw new Error(
      ETIKET + ': API anahtari gerekli. Ayarlar sekmesinden oanda anahtarini girin. ' +
      'Ucretsiz deneme hesabi yeterlidir.'
    )
  }

  // `live: true` canli (fxtrade) hesabi demektir. Varsayilan DENEME, cunku
  // ucretsiz hesap oradadir ve veri icin farki yoktur.
  const host = o.live === true ? HOST_CANLI : HOST_DENEME

  const secim = kaynakZamanDilimi(o.tfSec, DESTEKLI)
  const kaynakSec = secim.kaynakSec
  const gran = GRANULERITE[kaynakSec]
  if (!gran) throw new Error(ETIKET + ': desteklenmeyen zaman dilimi (' + kaynakSec + ' sn)')

  const simdi = Math.floor(Date.now() / 1000)
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : simdi
  let from = Number.isFinite(o.from) ? Math.floor(o.from) : to - 7 * 86400
  if (to > simdi) to = simdi
  if (from < EN_ESKI) from = EN_ESKI
  if (from >= to) return fromArrays({ time: [], open: [], high: [], low: [], close: [], volume: [] })

  const t = []
  const ac = []
  const yuk = []
  const dus = []
  const kap = []
  const hac = []

  const bekleme = Number.isFinite(o.pollMs) && o.pollMs >= 0 ? o.pollMs : VARSAYILAN_BEKLEME_MS
  let imlec = from
  let tur = 0

  while (imlec < to) {
    const url = host + '/v3/instruments/XAU_USD/candles' +
      '?price=M&granularity=' + gran +
      '&count=' + SAYFA +
      '&from=' + encodeURIComponent(zamanMetni(imlec))

    let govde = null
    try {
      govde = await httpJson(url, {
        // ANAHTAR BASLIKTA. URL'ye konsa sunucu gunluklerine duserdi.
        headers: { Authorization: 'Bearer ' + apiKey },
        label: ETIKET,
      })
    } catch (err) {
      const m = String(err && err.message ? err.message : err)
      if (m.indexOf('401') >= 0 || m.indexOf('403') >= 0) {
        throw new Error(
          ETIKET + ': anahtar kabul edilmedi. Deneme hesabi anahtari CANLI adreste, ' +
          'canli hesap anahtari DENEME adresinde calismaz. Su an ' +
          (o.live === true ? 'canli' : 'deneme') + ' ortami deneniyor.'
        )
      }
      throw err
    }

    const mumlar = govde && Array.isArray(govde.candles) ? govde.candles : []
    if (mumlar.length === 0) break

    let sonSn = -1
    let eklenen = 0
    for (let i = 0; i < mumlar.length; i++) {
      const c = mumlar[i]
      if (!c) continue
      const sn = zamanaCevir(c.time)
      if (!Number.isFinite(sn)) continue
      if (sn > sonSn) sonSn = sn
      // KAPANMAMIS MUM ALINMAZ (bkz. dosya basi, 1. madde).
      if (c.complete !== true) continue
      if (sn < from || sn > to) continue
      const m = c.mid
      if (!m) continue
      const kapanis = +m.c
      if (!Number.isFinite(kapanis)) continue
      t.push(sn)
      ac.push(+m.o)
      yuk.push(+m.h)
      dus.push(+m.l)
      kap.push(kapanis)
      // OANDA'da `volume` bu mumdaki tick (fiyat guncellemesi) sayisidir.
      hac.push(Number.isFinite(+c.volume) ? +c.volume : 0)
      eklenen++
    }

    // Sayfanin son mumu imleci ilerletir. Ilerleme olmazsa sonsuz dongu olur.
    const sonraki = (sonSn > 0 ? sonSn : imlec) + kaynakSec
    if (sonraki <= imlec) break
    imlec = sonraki

    tur++
    const pct = to > from ? ((imlec - from) / (to - from)) * 100 : 100
    bildir(o.onProgress, pct, ETIKET + ': ' + t.length + ' mum indirildi')

    // Tam sayfa gelmediyse veri bitmistir.
    if (mumlar.length < SAYFA) break
    if (eklenen === 0 && mumlar.length < SAYFA) break
    if (tur > 20000) break // guvenlik freni
    if (bekleme > 0) await sleep(bekleme)
  }

  let seri = sanitize(fromArrays({
    time: t, open: ac, high: yuk, low: dus, close: kap, volume: hac,
  }))
  if (secim.yenidenOrnekle && seri.length > 0) seri = resample(seri, o.tfSec)
  bildir(o.onProgress, 100, ETIKET + ': ' + seri.length + ' mum hazir')
  return seri
}

module.exports = {
  id: 'oanda',
  name: 'OANDA (XAU_USD spot)',
  needsKey: true,
  caps: ['history', 'live'],
  isProxy: false,
  note:
    'Ucretsiz deneme hesabi anahtari yeterlidir. Spot XAU_USD ve tick sayisina ' +
    'dayali hacim verir, yani TradingView OANDA grafigiyle ayni akistir. Gecmis ' +
    '2006-03-19\'a kadar gider. Olculdu: kullanicinin grafigindeki kutularin ' +
    '%100\'unu uretir (depo ayni donemde %56,7).',
  fetchCandles: fetchCandles,
  // Test icin.
  _zamanaCevir: zamanaCevir,
  _zamanMetni: zamanMetni,
  _GRANULERITE: GRANULERITE,
  EN_ESKI: EN_ESKI,
}
