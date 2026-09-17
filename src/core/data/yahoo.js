'use strict'

// Yahoo Finance saglayicisi.
//
// Olculmus gercek: bu makineden `XAUUSD=X` sembolu HTTP 404 veriyor, ancak
// COMEX altin vadelisi `GC=F` HTTP 200 ile calisiyor. Bu yuzden sembol GC=F'dir
// ve fiyat spot XAUUSD DEGILDIR (isProxy: true). Vadeli ile spot arasindaki
// fark (contango/carry) loader.computeBasis ile duzeltilmelidir.
//
// Yahoo icin User-Agent basligi ZORUNLUDUR, gonderilmezse istek engellenir.
//
// Uyari: Yahoo bu uc noktada zaman zaman IP bazli hiz siniri uygular ve
// TUM isteklere HTTP 429 doner (bu makineden de goruldu). Bu gecici bir
// durumdur; asagida query1 ve query2 sunuculari sirayla denenir ve geri
// cekilmeli yeniden deneme yapilir. Kalici 429 aliniyorsa gecmis indirmek
// icin histdata, canli takip icin binance veya okx kullanilmalidir.

const { fromArrays, sanitize, resample, emptySeries } = require('../series')
const { httpJson, sleep, kaynakZamanDilimi, bildir } = require('./provider')

const ETIKET = 'Yahoo Finance'
const SEMBOL = 'GC%3DF' // GC=F, URL kodlanmis
const SUNUCULAR = [
  'https://query1.finance.yahoo.com/v8/finance/chart/',
  'https://query2.finance.yahoo.com/v8/finance/chart/',
]

/**
 * Yahoo aralik kodlari ve sinirlari.
 * maxSpanSec: tek istekte istenebilecek en genis pencere.
 * maxGeriSec: bugunden geriye en fazla ne kadar veri sunulur (0 = sinirsiz).
 */
const ARALIKLAR = {
  60: { kod: '1m', maxSpanSec: 7 * 86400, maxGeriSec: 29 * 86400 },
  300: { kod: '5m', maxSpanSec: 59 * 86400, maxGeriSec: 59 * 86400 },
  900: { kod: '15m', maxSpanSec: 59 * 86400, maxGeriSec: 59 * 86400 },
  1800: { kod: '30m', maxSpanSec: 59 * 86400, maxGeriSec: 59 * 86400 },
  3600: { kod: '60m', maxSpanSec: 729 * 86400, maxGeriSec: 729 * 86400 },
  86400: { kod: '1d', maxSpanSec: 3650 * 86400, maxGeriSec: 0 },
}
const DESTEKLI = [60, 300, 900, 1800, 3600, 86400]

/**
 * Tek bir Yahoo chart yanitini cozer ve satirlari cikti dizilerine ekler.
 * @param {any} govde
 * @param {{t:number[],o:number[],h:number[],l:number[],c:number[],v:number[]}} cikti
 * @param {number} from
 * @param {number} to
 * @returns {number} Eklenen satir sayisi
 */
function satirlariTopla(govde, cikti, from, to) {
  const chart = govde && govde.chart
  if (chart && chart.error) {
    const e = chart.error
    throw new Error(ETIKET + ': ' + (e.description || e.code || 'sunucu hatasi'))
  }
  const sonuc = chart && chart.result && chart.result[0]
  if (!sonuc) return 0
  const zaman = sonuc.timestamp
  const kotasyon =
    sonuc.indicators && sonuc.indicators.quote && sonuc.indicators.quote[0]
  if (!zaman || !kotasyon) return 0

  const o = kotasyon.open
  const h = kotasyon.high
  const l = kotasyon.low
  const c = kotasyon.close
  const v = kotasyon.volume

  let eklenen = 0
  for (let i = 0; i < zaman.length; i++) {
    const t = zaman[i]
    if (!Number.isFinite(t) || t < from || t > to) continue
    const kap = c ? c[i] : null
    if (kap === null || kap === undefined || !Number.isFinite(kap)) continue
    const ac = o && Number.isFinite(o[i]) ? o[i] : kap
    const yuk = h && Number.isFinite(h[i]) ? h[i] : kap
    const dus = l && Number.isFinite(l[i]) ? l[i] : kap
    const hac = v && Number.isFinite(v[i]) ? v[i] : 0
    cikti.t.push(t)
    cikti.o.push(ac)
    cikti.h.push(yuk)
    cikti.l.push(dus)
    cikti.c.push(kap)
    cikti.v.push(hac)
    eklenen++
  }
  return eklenen
}

/**
 * Chart uc noktasini query1, sonra query2 sunucusundan dener.
 * @param {string} sorgu '?' ile baslayan sorgu dizesi
 * @returns {Promise<any>}
 */
async function chartIste(sorgu) {
  let sonHata = null
  for (let i = 0; i < SUNUCULAR.length; i++) {
    try {
      return await httpJson(SUNUCULAR[i] + SEMBOL + sorgu, {
        label: ETIKET,
        timeoutMs: 30000,
        retries: 2,
        headers: {
          Referer: 'https://finance.yahoo.com/quote/GC%3DF',
          Origin: 'https://finance.yahoo.com',
        },
      })
    } catch (err) {
      sonHata = err
    }
  }
  if (sonHata && /429/.test(String(sonHata.message))) {
    throw new Error(
      ETIKET + ': istek hiz siniri (HTTP 429). Yahoo bu ag adresini gecici olarak ' +
        'kisitliyor. Gecmis icin histdata, canli icin binance veya okx kullanin.'
    )
  }
  throw sonHata || new Error(ETIKET + ': istek basarisiz oldu')
}

/**
 * @param {{tfSec:number, from:number, to:number, apiKey?:string,
 *          onProgress?:Function}} opts
 * @returns {Promise<import('../series').Series>}
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const tfSec = o.tfSec
  const secim = kaynakZamanDilimi(tfSec, DESTEKLI)
  const conf = ARALIKLAR[secim.kaynakSec]

  const simdi = Math.floor(Date.now() / 1000)
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : simdi
  let from = Number.isFinite(o.from) ? Math.floor(o.from) : to - 7 * 86400
  if (to > simdi) to = simdi

  // Yahoo'nun gecmis sinirina kirp.
  if (conf.maxGeriSec > 0) {
    const enEski = simdi - conf.maxGeriSec
    if (from < enEski) from = enEski
  }
  if (from >= to) return emptySeries()

  const cikti = { t: [], o: [], h: [], l: [], c: [], v: [] }
  const toplamSpan = to - from
  let pencereBas = from

  bildir(o.onProgress, 0, ETIKET + ': ' + conf.kod + ' mumlari indiriliyor')

  let tur = 0
  while (pencereBas < to) {
    let pencereSon = pencereBas + conf.maxSpanSec
    if (pencereSon > to) pencereSon = to

    const sorgu =
      '?interval=' + conf.kod +
      '&period1=' + pencereBas +
      '&period2=' + pencereSon +
      '&includePrePost=true&events=div%2Csplit&corsDomain=finance.yahoo.com'

    const govde = await chartIste(sorgu)
    satirlariTopla(govde, cikti, from, to)

    pencereBas = pencereSon
    tur++
    const pct = toplamSpan > 0 ? ((pencereBas - from) / toplamSpan) * 100 : 100
    bildir(
      o.onProgress,
      pct,
      ETIKET + ': ' + cikti.t.length + ' mum indirildi'
    )
    if (pencereBas < to) await sleep(250)
    if (tur > 5000) break // guvenlik freni
  }

  let seri = sanitize(fromArrays({
    time: cikti.t,
    open: cikti.o,
    high: cikti.h,
    low: cikti.l,
    close: cikti.c,
    volume: cikti.v,
  }))
  if (secim.yenidenOrnekle && seri.length > 0) seri = resample(seri, tfSec)
  bildir(o.onProgress, 100, ETIKET + ': ' + seri.length + ' mum hazir')
  return seri
}

module.exports = {
  id: 'yahoo',
  name: 'Yahoo Finance (GC=F)',
  needsKey: false,
  caps: ['history', 'live'],
  isProxy: true,
  note:
    'Anahtarsiz. COMEX altin vadelisi GC=F kullanir, spot XAUUSD ile fiyat farki vardir. ' +
    'Gercek hacim gelir. 1 dakikalik veri yalnizca son 30 gun, saatlik veri son 2 yil icin sunulur.',
  fetchCandles: fetchCandles,
}
