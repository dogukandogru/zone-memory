'use strict'

// Binance saglayicisi (PAXGUSDT).
//
// Olculmus gercek: https://api.binance.com/api/v3/klines?symbol=PAXGUSDT
// anahtarsiz HTTP 200 doner. PAXG bir onsluk altina karsilik gelen bir token
// oldugu icin fiyat XAUUSD'ye yakindir ama AYNISI DEGILDIR (isProxy: true).
// Hafta sonu da islem gorur, spot altin piyasasinin kapali oldugu saatlerde
// veri uretir; bu bir avantaj degil, farkli bir piyasadir.
//
// Sinirlar: tek istekte en fazla 1000 mum, 1200 agirlik/dakika. Istekler
// arasina kucuk bekleme konur.

const { fromArrays, sanitize, resample, emptySeries } = require('../series')
const { httpJson, sleep, kaynakZamanDilimi, bildir } = require('./provider')

const ETIKET = 'Binance'
const SEMBOL = 'PAXGUSDT'
const TEMEL = 'https://api.binance.com/api/v3/klines'
const LIMIT = 1000

/** Saniye -> Binance aralik kodu. */
const ARALIKLAR = {
  60: '1m',
  180: '3m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '1h',
  7200: '2h',
  14400: '4h',
  21600: '6h',
  28800: '8h',
  43200: '12h',
  86400: '1d',
}
const DESTEKLI = [60, 180, 300, 900, 1800, 3600, 7200, 14400, 21600, 28800, 43200, 86400]

/**
 * @param {{tfSec:number, from:number, to:number, apiKey?:string,
 *          onProgress?:Function}} opts
 * @returns {Promise<import('../series').Series>}
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const secim = kaynakZamanDilimi(o.tfSec, DESTEKLI)
  const kaynakSec = secim.kaynakSec
  const kod = ARALIKLAR[kaynakSec]

  const simdi = Math.floor(Date.now() / 1000)
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : simdi
  let from = Number.isFinite(o.from) ? Math.floor(o.from) : to - 7 * 86400
  if (to > simdi) to = simdi
  if (from >= to) return emptySeries()

  const tfMs = kaynakSec * 1000
  const toMs = to * 1000
  const fromMs = from * 1000

  const t = []
  const ac = []
  const yuk = []
  const dus = []
  const kap = []
  const hac = []

  let imlec = fromMs
  let tur = 0
  bildir(o.onProgress, 0, ETIKET + ': ' + kod + ' mumlari indiriliyor')

  while (imlec <= toMs) {
    const url =
      TEMEL +
      '?symbol=' + SEMBOL +
      '&interval=' + kod +
      '&startTime=' + imlec +
      '&endTime=' + toMs +
      '&limit=' + LIMIT

    const veri = await httpJson(url, { label: ETIKET, timeoutMs: 30000 })
    if (veri && veri.code !== undefined && veri.msg) {
      throw new Error(ETIKET + ': ' + veri.msg + ' (kod ' + veri.code + ')')
    }
    if (!Array.isArray(veri) || veri.length === 0) break

    let sonAcilis = imlec
    for (let i = 0; i < veri.length; i++) {
      const satir = veri[i]
      const acilisMs = +satir[0]
      if (!Number.isFinite(acilisMs)) continue
      if (acilisMs > sonAcilis) sonAcilis = acilisMs
      const sn = Math.floor(acilisMs / 1000)
      if (sn < from || sn > to) continue
      // Acik (kapanmamis) bar atlanir: depoya yarim OHLCV yazilirsa kalici
      // olur, cunku sonraki cekimler ayni zaman damgasini atlar.
      if (sn + kaynakSec > Math.floor(Date.now() / 1000)) continue
      t.push(sn)
      ac.push(+satir[1])
      yuk.push(+satir[2])
      dus.push(+satir[3])
      kap.push(+satir[4])
      hac.push(+satir[5])
    }

    const sonraki = sonAcilis + tfMs
    if (sonraki <= imlec) break // ilerleme yoksa sonsuz donguye girme
    imlec = sonraki

    tur++
    const pct = toMs > fromMs ? ((imlec - fromMs) / (toMs - fromMs)) * 100 : 100
    bildir(o.onProgress, pct, ETIKET + ': ' + t.length + ' mum indirildi')
    if (imlec <= toMs) await sleep(120)
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
  bildir(o.onProgress, 100, ETIKET + ': ' + seri.length + ' mum hazir')
  return seri
}

module.exports = {
  id: 'binance',
  name: 'Binance (PAXGUSDT)',
  needsKey: false,
  caps: ['history', 'live'],
  isProxy: true,
  note:
    'Anahtarsiz ve gercek zamanli. PAXG token fiyatidir, spot XAUUSD ile kucuk bir fark tasir. ' +
    'Hafta sonu da islem gordugu icin spot altinda olmayan barlar uretir.',
  fetchCandles: fetchCandles,
}
