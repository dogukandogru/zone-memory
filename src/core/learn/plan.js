'use strict'

/**
 * SINYAL PLANI: giris, zarar durdur (SL), hedef (TP) ve sonuc.
 *
 * Kullanici istedi: "sinyal verdiginde tp ve sl nerede oldugunu ve islem
 * sonuclanirken tp mi olmus yoksa sl mi onu ekleyelim; 1'e 1 yapabiliriz ilk
 * basta, ayarlardan degistirdigimizde ona gore guncellensin".
 *
 * TANIM (tek yer, tarama ve canli ayni kodu kullanir): bkz. planKur; sonuc
 * sinyal barindan SONRAKI barlarda hangisi once vurulur: 'sl' | 'tp' | 'open'
 * (seri bitti) | 'timeout' (planHorizonBars doldu). Ayni barda ikisi de
 * vurulursa SL sayilir (bar ici sira bilinmez, kotu durum varsayilir).
 *
 * Bu modul KARARA GIRMEZ: sinyal uretilip uretilmeyecegi baska yerde
 * belirlenir; burasi yalnizca plani ve sonucunu hesaplar.
 */

const series = require('../series')

/** Plan bicimi: eski (kutu kenari / dolar) planlari ayirt etmek icin. */
const PLAN_MODE = 'atr'

/** Varsayilanlar; signal.js DEFAULT_SIGNAL_CFG ile ayni degerler. */
const DEFAULT_PLAN_CFG = {
  slAtr: 1.0,
  tpAtr: 1.0,
  planHorizonBars: 200,
}

function sayi (v, varsayilan) {
  const x = Number(v)
  return Number.isFinite(x) ? x : varsayilan
}

/**
 * Plan seviyelerini kurar: ATR cinsinden SL ve TP mesafesi.
 *
 * Kullanici istedi: "ATR'ye gore TP ve ATR'ye gore SL ayarlayabilmeliyim".
 *   giris = sinyal barinin kapanisi
 *   SL    = giris -/+ slAtr * ATR   (AL'da asagida, SAT'ta yukarida)
 *   TP    = giris +/- tpAtr * ATR
 * ATR olayin oldugu bardaki 14 barlik ortalama gercek araliktir (signal.atr),
 * yani mesafe piyasanin o anki oynakligiyla olcekli: 2011'de de 2026'da da
 * "1 ATR" ayni anlama gelir. Onceki tanim (kutunun uzak kenari + pay, TP =
 * risk x oran) kaldirildi: dokunusta risk 5-6 dolara dusup ilk fitilde SL
 * vuruluyordu ve iki mesafe ayri ayri ayarlanamiyordu.
 *
 * @param {{price?:number, atr?:number, direction?:string, isSupport?:boolean}} signal
 * @param {{slAtr?:number, tpAtr?:number}} [cfg]
 * @returns {{entry:number, sl:number, tp:number, risk:number, rr:number}|null}
 *          Giris ya da ATR yoksa null
 */
function planKur (signal, cfg) {
  if (!signal) return null
  const c = Object.assign({}, DEFAULT_PLAN_CFG, cfg || {})
  const entry = sayi(signal.price, NaN)
  const atr = sayi(signal.atr, NaN)
  if (!Number.isFinite(entry) || entry <= 0) return null
  if (!(atr > 0)) return null
  const slAtr = sayi(c.slAtr, DEFAULT_PLAN_CFG.slAtr)
  const tpAtr = sayi(c.tpAtr, DEFAULT_PLAN_CFG.tpAtr)
  if (!(slAtr > 0) || !(tpAtr > 0)) return null
  const yukari = signal.direction ? signal.direction !== 'SELL' : !!signal.isSupport
  const risk = slAtr * atr
  const sl = yukari ? entry - risk : entry + risk
  const tp = yukari ? entry + tpAtr * atr : entry - tpAtr * atr
  return { entry: entry, sl: sl, tp: tp, risk: risk, rr: tpAtr / slAtr }
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
 * @param {{slAtr?:number, tpAtr?:number, planHorizonBars?:number}} [cfg]
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

module.exports = { PLAN_MODE, DEFAULT_PLAN_CFG, planKur, planCoz, sinyaliPlanla }
