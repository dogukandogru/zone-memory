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

/** Plan kipleri: 'kutu' (SL kutu kenari, varsayilan) ve 'atr' (sabit ATR). */
const PLAN_KIPLERI = ['kutu', 'atr']

/** Varsayilanlar; signal.js DEFAULT_SIGNAL_CFG ile ayni degerler. */
const DEFAULT_PLAN_CFG = {
  planMode: 'kutu',
  tpRr: 1.0,
  breakBufferAtr: 0.25,
  slAtr: 1.0,
  tpAtr: 1.0,
  planHorizonBars: 200,
}

/** Gecersiz kip verilirse varsayilan. */
function planKipi (cfg) {
  const m = cfg && typeof cfg.planMode === 'string' ? cfg.planMode : ''
  return PLAN_KIPLERI.indexOf(m) >= 0 ? m : DEFAULT_PLAN_CFG.planMode
}

function sayi (v, varsayilan) {
  const x = Number(v)
  return Number.isFinite(x) ? x : varsayilan
}

/**
 * Plan seviyelerini kurar.
 *
 * KIP 'kutu' (varsayilan): SL = kutunun UZAK kenari -/+ breakBufferAtr * ATR,
 *   risk = |giris - SL|, TP = giris +/- tpRr * risk.
 * KIP 'atr': SL = giris -/+ slAtr * ATR, TP = giris +/- tpAtr * ATR.
 *
 * NEDEN KUTU KENARI VARSAYILAN. Olculdu (5m 34 bin olay, 15m 8,5 bin; egitim
 * 2023 oncesi, test sonrasi): kapanistan +-1 ATR tanimiyla HICBIR ozellik ve
 * benzerlik komsusu sonucu ayirt etmiyor (AUC 0,50, hepsi). SL kutu kenarina
 * baglaninca ayni ozellikler AUC 0,60 / 0,62 veriyor: en kotu %20 dilim %20-24
 * TP, en iyi dilim %49-53. Bilgi girisin kutu kenarina uzakliginda: riske
 * taban konunca (en az 0,5 ya da 1 ATR) bilgi yine kayboluyor. Dokunusta
 * fiyat uzak kenara yapismissa (risk < 0,5 ATR) 10'da 8 SL: bu sinyaller
 * alinmamali, SL uzaklastirilmamali. Sabit ATR kipi istege bagli kaldi.
 *
 * @param {{price?:number, atr?:number, direction?:string, isSupport?:boolean,
 *          zoneTop?:number, zoneBottom?:number}} signal
 * @param {{planMode?:string, tpRr?:number, breakBufferAtr?:number,
 *          slAtr?:number, tpAtr?:number}} [cfg]
 * @returns {{mode:string, entry:number, sl:number, tp:number, risk:number, rr:number}|null}
 *          Giris, ATR ya da (kutu kipinde) kutu kenari yoksa null
 */
function planKur (signal, cfg) {
  if (!signal) return null
  const c = Object.assign({}, DEFAULT_PLAN_CFG, cfg || {})
  const entry = sayi(signal.price, NaN)
  const atr = sayi(signal.atr, NaN)
  if (!Number.isFinite(entry) || entry <= 0) return null
  if (!(atr > 0)) return null
  const yukari = signal.direction ? signal.direction !== 'SELL' : !!signal.isSupport
  const kip = planKipi(c)
  if (kip === 'atr') {
    const slAtr = sayi(c.slAtr, DEFAULT_PLAN_CFG.slAtr)
    const tpAtr = sayi(c.tpAtr, DEFAULT_PLAN_CFG.tpAtr)
    if (!(slAtr > 0) || !(tpAtr > 0)) return null
    const risk = slAtr * atr
    return {
      mode: 'atr',
      entry: entry,
      sl: yukari ? entry - risk : entry + risk,
      tp: yukari ? entry + tpAtr * atr : entry - tpAtr * atr,
      risk: risk,
      rr: tpAtr / slAtr,
    }
  }
  const uzakKenar = sayi(yukari ? signal.zoneBottom : signal.zoneTop, NaN)
  if (!Number.isFinite(uzakKenar)) return null
  const pay = Math.max(0, sayi(c.breakBufferAtr, DEFAULT_PLAN_CFG.breakBufferAtr)) * atr
  const rr = sayi(c.tpRr, DEFAULT_PLAN_CFG.tpRr)
  if (!(rr > 0)) return null
  const sl = yukari ? uzakKenar - pay : uzakKenar + pay
  const risk = Math.abs(entry - sl)
  // Giris SL'nin yanlis tarafindaysa (kutu coktan kirilmis) plan kurulamaz.
  if (!(risk > 0) || (yukari ? entry <= sl : entry >= sl)) return null
  return {
    mode: 'kutu',
    entry: entry,
    sl: sl,
    tp: yukari ? entry + rr * risk : entry - rr * risk,
    risk: risk,
    rr: rr,
  }
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
    mode: kurulan.mode,
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

/**
 * Planin odul/risk orani (TP mesafesi / SL mesafesi) ve basa bas TP olasiligi.
 * Kutu kipinde oran = tpRr; ATR kipinde tpAtr / slAtr.
 * @param {Object} [cfg]
 * @returns {{rr:number, basaBas:number}} basaBas 0..1 (1 / (1 + rr))
 */
function basaBas (cfg) {
  const c = Object.assign({}, DEFAULT_PLAN_CFG, cfg || {})
  const rr = planKipi(c) === 'atr'
    ? sayi(c.tpAtr, DEFAULT_PLAN_CFG.tpAtr) / Math.max(1e-9, sayi(c.slAtr, DEFAULT_PLAN_CFG.slAtr))
    : sayi(c.tpRr, DEFAULT_PLAN_CFG.tpRr)
  const r = rr > 0 ? rr : 1
  return { rr: r, basaBas: 1 / (1 + r) }
}

/**
 * Zayif sinyal esigi (yuzde). Ayar 1'e 1 plan icin verilir (basa bas %50);
 * hedef orani degisince esik basa bas noktasiyla birlikte kayar, yoksa 1,5
 * oranda sinyallerin %80'i zayif gorunur (goruldu: 25 binde 20 bin).
 * @param {number} minConfidence 1'e 1 icin esik (yuzde)
 * @param {Object} [cfg]
 * @returns {number} Etkin esik (yuzde), 0 = kapali
 */
function zayifEsigi (minConfidence, cfg) {
  const m = sayi(minConfidence, 0)
  if (!(m > 0)) return 0
  return Math.max(0, m - 50 + 100 * basaBas(cfg).basaBas)
}

module.exports = { PLAN_KIPLERI, DEFAULT_PLAN_CFG, planKipi, planKur, planCoz, sinyaliPlanla, basaBas, zayifEsigi }
