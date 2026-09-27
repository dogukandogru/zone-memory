'use strict'

/**
 * SINYAL PLANI: giris, zarar durdur (SL), hedef (TP) ve sonuc.
 *
 * TANIM (DOLAR BAZLI, zaman dilimi basina):
 *   giris = sinyal barinin kapanisi (signal.price)
 *   SL    = giris -/+ slUsd   (AL'da asagida, SAT'ta yukarida)
 *   TP    = giris +/- tpUsd
 *   sonuc = sinyal barindan SONRAKI barlarda hangisi once vurulur:
 *           'sl' | 'tp' | 'open' (seri bitti, henuz vurulmadi) |
 *           'timeout' (planHorizonBars doldu, ikisi de vurulmadi)
 *   Ayni barda ikisi de vurulursa SL sayilir (bar ici sira bilinmez,
 *   kotu durum varsayilir).
 *
 * NEDEN DOLAR, NEDEN KUTU KENARI DEGIL: ilk surum SL'yi kutunun uzak
 * kenarina koyuyordu (+ ATR payi). Dokunus sinyalinde giris kutunun hemen
 * yaninda oldugu icin risk 5-6 dolar cikiyor ve ilk fitilde SL vuruluyordu;
 * kullanici ornek gosterdi (16.09 20:55 SAT: SL 5,5 dolar otede, sonra fiyat
 * 100 dolar dustu). Kullanicinin tanimi: "M1'de 10 dolar, M5'te 20, M15'te
 * 30; 4025'te aldik, 4015'e gelince SL". Mesafeler onsun o anki fiyatina
 * gore dolardir ve her zaman dilimi icin Ayarlar'dan ayri ayri degisir.
 *
 * Bu modul KARARA GIRMEZ: sinyal uretilip uretilmeyecegi baska yerde
 * belirlenir; burasi yalnizca plani ve sonucunu hesaplar.
 */

const series = require('../series')

/** Plan bicimi: eski (kutu kenari) planlari ayirt etmek icin. */
const PLAN_MODE = 'usd'

/**
 * Zaman dilimi basina varsayilan TP/SL (dolar). 1m, 5m, 15m kullanicinin
 * verdigi sayilar; digerleri ayni olcekle uzatildi. Hepsi Ayarlar'dan
 * degisir; TP varsayilan olarak SL'ye esit (1'e 1).
 */
const DEFAULT_PLAN_BY_TF = {
  '1m': { slUsd: 10, tpUsd: 10 },
  '5m': { slUsd: 20, tpUsd: 20 },
  '15m': { slUsd: 30, tpUsd: 30 },
  '30m': { slUsd: 40, tpUsd: 40 },
  '1h': { slUsd: 60, tpUsd: 60 },
  '4h': { slUsd: 100, tpUsd: 100 },
  '1d': { slUsd: 150, tpUsd: 150 },
}

/** Zaman diliminden bagimsiz varsayilanlar. */
const DEFAULT_PLAN_CFG = {
  planHorizonBars: 200,
}

function sayi (v, varsayilan) {
  const x = Number(v)
  return Number.isFinite(x) ? x : varsayilan
}

/**
 * Zaman dilimi icin etkin TP/SL mesafeleri: varsayilan + kullanici yamasi.
 * @param {string} tf
 * @param {object|null} [patchByTf] Ayarlardaki `planByTf` (yalnizca degisenler)
 * @returns {{slUsd:number, tpUsd:number}}
 */
function planAyariCoz (tf, patchByTf) {
  const taban = DEFAULT_PLAN_BY_TF[tf] || DEFAULT_PLAN_BY_TF['15m']
  const yama = patchByTf && typeof patchByTf === 'object' && patchByTf[tf] &&
    typeof patchByTf[tf] === 'object' ? patchByTf[tf] : {}
  const sl = sayi(yama.slUsd, taban.slUsd)
  const tp = sayi(yama.tpUsd, taban.tpUsd)
  return { slUsd: sl > 0 ? sl : taban.slUsd, tpUsd: tp > 0 ? tp : taban.tpUsd }
}

/**
 * Plan seviyelerini kurar.
 * @param {{price?:number, direction?:string, isSupport?:boolean}} signal
 * @param {{slUsd?:number, tpUsd?:number}} cfg
 * @returns {{entry:number, sl:number, tp:number, risk:number, rr:number}|null}
 */
function planKur (signal, cfg) {
  if (!signal) return null
  const c = cfg || {}
  const entry = sayi(signal.price, NaN)
  const slUsd = sayi(c.slUsd, NaN)
  const tpUsd = sayi(c.tpUsd, NaN)
  if (!Number.isFinite(entry) || entry <= 0) return null
  if (!(slUsd > 0) || !(tpUsd > 0)) return null
  const yukari = signal.direction ? signal.direction !== 'SELL' : !!signal.isSupport
  const sl = yukari ? entry - slUsd : entry + slUsd
  const tp = yukari ? entry + tpUsd : entry - tpUsd
  return { entry: entry, sl: sl, tp: tp, risk: slUsd, rr: tpUsd / slUsd }
}

/**
 * Plani seride ileri dogru cozer.
 * @param {import('../series').Series} s
 * @param {number} startIdx Sinyal barinin indeksi (o bar DAHIL DEGIL)
 * @param {{sl:number, tp:number}} plan
 * @param {boolean} yukari AL ise true
 * @param {number} horizonBars En fazla kac bar bakilir
 * @returns {{result:'tp'|'sl'|'open'|'timeout', resolvedTime:number|null, bars:number}}
 */
function planCoz (s, startIdx, plan, yukari, horizonBars) {
  const n = s && Number.isFinite(s.length) ? s.length : 0
  const ufuk = Math.max(1, Math.floor(sayi(horizonBars, DEFAULT_PLAN_CFG.planHorizonBars)))
  const son = Math.min(n - 1, startIdx + ufuk)
  for (let i = startIdx + 1; i <= son; i++) {
    const hi = s.high[i]
    const lo = s.low[i]
    if (yukari) {
      if (lo <= plan.sl) return { result: 'sl', resolvedTime: s.time[i], bars: i - startIdx }
      if (hi >= plan.tp) return { result: 'tp', resolvedTime: s.time[i], bars: i - startIdx }
    } else {
      if (hi >= plan.sl) return { result: 'sl', resolvedTime: s.time[i], bars: i - startIdx }
      if (lo <= plan.tp) return { result: 'tp', resolvedTime: s.time[i], bars: i - startIdx }
    }
  }
  // Seri ufuktan ONCE bittiyse sonuc henuz belli degil: acik islem.
  if (startIdx + ufuk > n - 1) return { result: 'open', resolvedTime: null, bars: Math.max(0, n - 1 - startIdx) }
  return { result: 'timeout', resolvedTime: s.time[son], bars: ufuk }
}

/**
 * Sinyale plan ve sonucu takar (signal.plan). Seri yoksa ya da sinyal seride
 * bulunamazsa sonuc 'open' kalir.
 * @param {import('../series').Series|null} s
 * @param {object} signal
 * @param {{slUsd:number, tpUsd:number, planHorizonBars?:number}} cfg
 * @returns {object|null} takilan plan
 */
function sinyaliPlanla (s, signal, cfg) {
  const kurulan = planKur(signal, cfg)
  if (!kurulan) {
    signal.plan = null
    return null
  }
  const yukari = signal.direction ? signal.direction !== 'SELL' : !!signal.isSupport
  let cozum = { result: 'open', resolvedTime: null, bars: 0 }
  if (s && s.length > 0) {
    let idx = series.indexAtTime(s, sayi(signal.time, -1))
    if (!(idx >= 0)) idx = series.firstIndexAtOrAfter(s, sayi(signal.time, -1))
    if (idx >= 0 && idx < s.length) {
      const c = Object.assign({}, DEFAULT_PLAN_CFG, cfg || {})
      cozum = planCoz(s, idx, kurulan, yukari, c.planHorizonBars)
    }
  }
  signal.plan = {
    mode: PLAN_MODE,
    entry: kurulan.entry,
    sl: kurulan.sl,
    tp: kurulan.tp,
    rr: kurulan.rr,
    result: cozum.result,
    resolvedTime: cozum.resolvedTime,
    bars: cozum.bars,
  }
  return signal.plan
}

module.exports = {
  PLAN_MODE, DEFAULT_PLAN_BY_TF, DEFAULT_PLAN_CFG, planAyariCoz, planKur, planCoz, sinyaliPlanla,
}
