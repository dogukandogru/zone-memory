'use strict'

/**
 * Pine v6 "proje son versiyon 3" kutu mantiginin BAGIMSIZ referans uygulamasi.
 *
 * Kaynak: docs/pine/son_pro.pine (292 satir). Bu dosya YALNIZCA o Pine metnine
 * bakilarak yazildi; src/core/indicator/proZones.js'e bakilmadi. Amaci portun
 * dogrulugunu kanitlamak oldugu icin portla ortak kod paylasmaz. Ayri ayri test
 * edilen ta.js (atr/sma/stdev/pivot) fonksiyonlari kullanilir.
 *
 * Referans YALNIZCA kutu uretir. Gorsel (box/color/text/transp) hicbir sey
 * uretmez, Pine'in f_transp/f_text fonksiyonlari bilincli olarak atlanmistir.
 *
 * Pine satir eslesmesi (okurken yanina bakilacak satirlar):
 *   39-48   atr / volMA / bollinger
 *   76-77   pivotlar
 *   82-142  DIRENC blogu (birlestirme + yeni kutu)
 *   147-207 DESTEK blogu
 *   212-223 maxZones kirpmasi (array.shift => EN ESKI)
 *   228-292 kutu guncelleme dongusu (SONDAN BASA)
 */

const ta = require('../../src/core/ta')

/**
 * Pine input.* varsayilanlari (docs/pine/son_pro.pine 7-34).
 * @type {{
 *   showZones: boolean, useVolumeFilter: boolean, useBBFilter: boolean,
 *   pivotLen: number, atrLen: number, zoneAtrMult: number, mergeAtrMult: number,
 *   maxZones: number, maxAgeBars: number, touchCooldown: number,
 *   boxLengthBars: number, volumeLen: number, minVolRatio: number,
 *   minFlowToShow: number, bbLen: number, bbMult: number
 * }}
 */
const PINE_VARSAYILAN = {
  // Guncel indikatorde (docs/pine/bollinger_box.pine) kirilan kutu takipten
  // CIKMAZ, soluk cizilmeye ve uzamaya devam eder.
  showBrokenZones: true,
  // Moduller (Pine 7-9)
  showZones: true,
  useVolumeFilter: true,
  useBBFilter: true,
  // Bolge ayarlari (Pine 14-21)
  pivotLen: 5,
  atrLen: 14,
  zoneAtrMult: 0.35,
  mergeAtrMult: 0.55,
  maxZones: 24,
  maxAgeBars: 600,
  touchCooldown: 12,
  boxLengthBars: 100,
  // Volume ayarlari (Pine 26-28)
  volumeLen: 50,
  minVolRatio: 1.05,
  minFlowToShow: 6.0,
  // Bollinger (Pine 33-34)
  bbLen: 20,
  bbMult: 2.0,
}

/** @param {ArrayLike<number>} src */
function f64 (src) {
  return src instanceof Float64Array ? src : Float64Array.from(src)
}

/**
 * Pivot ESITLIK kurali 'esitDahil' secenegi.
 *
 * ta.js'in pivotHigh/pivotLow'u KESIN karsilastirma yapar: merkez bar cevresindeki
 * TUM barlardan kesinlikle buyuk (kucuk) olmak zorundadir, esitlikte pivot yoktur.
 * Bu fonksiyon alternatif kurali uygular: merkez bar iki yanindaki barlara ESIT
 * olabilir (v >= komsular / v <= komsular). Duzluk (plateau) bolgelerinde bu kural
 * birden fazla pivot uretir, kesin kural ise hicbirini uretmez.
 *
 * @param {Float64Array} src
 * @param {number} len sol = sag = len
 * @param {number} yon +1 pivot high, -1 pivot low
 * @returns {Float64Array} deger c+len indeksine yazilir (Pine ile ayni gecikme)
 */
function pivotEsitDahil (src, len, yon) {
  const n = src.length
  const out = new Float64Array(n)
  out.fill(NaN)
  const L = len | 0
  if (L < 0) return out

  for (let c = L; c < n - L; c++) {
    const v = src[c]
    if (Number.isNaN(v)) continue
    let ok = true
    for (let j = c - L; j <= c + L; j++) {
      if (j === c) continue
      const w = src[j]
      if (Number.isNaN(w)) { ok = false; break }
      // yon > 0: v >= w olmali. yon < 0: v <= w olmali.
      if (yon > 0 ? v < w : v > w) { ok = false; break }
    }
    if (ok) out[c + L] = v
  }
  return out
}

/**
 * Pine kutu mantiginin referans uygulamasi.
 *
 * @param {{ high: ArrayLike<number>, low: ArrayLike<number>, close: ArrayLike<number>, volume: ArrayLike<number> }} bars
 * @param {Partial<typeof PINE_VARSAYILAN>} [params] Pine input karsiliklari
 * @param {{ pivotEsitlik?: 'kesin' | 'esitDahil' }} [opts]
 *   pivotEsitlik varsayilani 'kesin' (ta.js'in bugunku davranisi).
 * @returns {{
 *   zones: Array<{
 *     id: number, isSupport: boolean, top: number, bot: number, score: number,
 *     bornBar: number, brokenBar: number | null, endBar: number,
 *     touchCount: number, touchBars: number[], mergeBars: number[],
 *     expiredBar: number | null, trimmedBar: number | null, active: boolean
 *   }>,
 *   params: typeof PINE_VARSAYILAN,
 *   pivotEsitlik: 'kesin' | 'esitDahil'
 * }}
 */
function pineRef (bars, params, opts) {
  const p = Object.assign({}, PINE_VARSAYILAN, params || {})
  const pivotEsitlik = (opts && opts.pivotEsitlik) || 'kesin'
  if (pivotEsitlik !== 'kesin' && pivotEsitlik !== 'esitDahil') {
    throw new Error(`pineRef: bilinmeyen pivotEsitlik: ${pivotEsitlik}`)
  }

  const high = f64(bars.high)
  const low = f64(bars.low)
  const close = f64(bars.close)
  const volume = f64(bars.volume)
  const n = close.length

  const L = p.pivotLen | 0

  // Pine 39-48: ANA HESAPLAMALAR + BOLLINGER
  const atr = ta.atr(high, low, close, p.atrLen)
  const volMA = ta.sma(volume, p.volumeLen)
  const bbBasis = ta.sma(close, p.bbLen)
  const bbSd = ta.stdev(close, p.bbLen)

  // Pine 76-77: PIVOTLAR (ph/pl degeri bar_index'e yazilir, merkez bar_index - pivotLen)
  const ph = pivotEsitlik === 'kesin'
    ? ta.pivotHigh(high, L, L)
    : pivotEsitDahil(high, L, +1)
  const pl = pivotEsitlik === 'kesin'
    ? ta.pivotLow(low, L, L)
    : pivotEsitDahil(low, L, -1)

  /** @type {ReturnType<typeof pineRef>['zones']} */
  const zones = []
  // Pine'in zones/zTop/... dizilerinin karsiligi: takip edilen kutularin
  // zones[] icindeki indeksleri, DOGUM sirasinda. array.shift EN ESKIyi atar.
  /** @type {number[]} */
  const takip = []

  for (let i = 0; i < n; i++) {
    const gec = i - L
    // Pine'de `atr` (ONTEKSIZ) O BARIN atr'sidir: birlestirme mesafesi (100/165)
    // ve kirilma esigi (267-268) bunu kullanir.
    const atrNow = atr[i]
    // atr[pivotLen] ise kutu kalinligi ve skor icin kullanilir (83/148).
    const atrPast = gec >= 0 ? atr[gec] : NaN

    // Pine 86-88 / 151-153: skor girdileri pivot barindan (pivotLen geri) okunur.
    let score = NaN
    let vR = NaN
    if (gec >= 0) {
      const vma = volMA[gec]
      const vDen = (!Number.isNaN(vma) && vma > 0) ? vma : volume[gec]
      vR = vDen > 0 ? volume[gec] / vDen : 1.0
      score = Math.min(10.0, Math.max(1.0, vR * 3.0))
    }
    const volOK = !p.useVolumeFilter || (vR >= p.minVolRatio && score >= p.minFlowToShow)

    // --- Pine 82-142: DIRENC / SELL LIQUIDITY ---
    if (!Number.isNaN(ph[i]) && !Number.isNaN(atrPast)) {
      const pivot = ph[i]
      const zH = atrPast * p.zoneAtrMult
      const top = pivot + zH
      const bot = pivot - zH * 0.25

      const bbUpPast = gec >= 0 ? bbBasis[gec] + p.bbMult * bbSd[gec] : NaN
      const bbSellOK = !p.useBBFilter || (!Number.isNaN(bbUpPast) && pivot >= bbUpPast)

      if (volOK && bbSellOK) {
        // Pine 96-118: dongu BREAK ETMEZ, kosula uyan BUTUN kutulara birlesir.
        let merged = false
        for (let t = 0; t < takip.length; t++) {
          const z = zones[takip[t]]
          const sameSide = !z.isSupport
          const midOld = (z.top + z.bot) / 2.0
          // NaN karsilastirmasi false doner, Pine'in na davranisiyla ayni.
          const nearZone = Math.abs(pivot - midOld) <= atrNow * p.mergeAtrMult
          if (sameSide && nearZone) {
            z.score = Math.min(10.0, z.score + score * 0.25)
            z.top = Math.max(z.top, top)
            z.bot = Math.min(z.bot, bot)
            // Pine 146: array.set(zBroken, j, false). Kirilmis kutuya yeni
            // pivot birlesirse kutu DIRILIR. Kirilan kutular artik listede
            // kaldigi icin bu gercekten olabilen bir durumdur.
            z.broken = false
            z.brokenBar = null
            z.mergeBars.push(i)
            merged = true
          }
        }

        if (!merged) {
          // Pine 120-142: yeni kutu. born = left = bar_index - pivotLen.
          zones.push({
            id: zones.length,
            isSupport: false,
            top,
            bot,
            score,
            bornBar: i - L,
            brokenBar: null,
            endBar: i, // box.new right = bar_index (123-126)
            touchCount: 0,
            touchBars: [],
            mergeBars: [],
            expiredBar: null,
            trimmedBar: null,
            active: true,
            lastTouch: null,
            broken: false,
          })
          takip.push(zones.length - 1)
        }
      }
    }

    // --- Pine 147-207: DESTEK / BUY LIQUIDITY ---
    if (!Number.isNaN(pl[i]) && !Number.isNaN(atrPast)) {
      const pivot = pl[i]
      const zH = atrPast * p.zoneAtrMult
      const top = pivot + zH * 0.25
      const bot = pivot - zH

      const bbLowPast = gec >= 0 ? bbBasis[gec] - p.bbMult * bbSd[gec] : NaN
      const bbBuyOK = !p.useBBFilter || (!Number.isNaN(bbLowPast) && pivot <= bbLowPast)

      if (volOK && bbBuyOK) {
        let merged = false
        for (let t = 0; t < takip.length; t++) {
          const z = zones[takip[t]]
          const sameSide = z.isSupport
          const midOld = (z.top + z.bot) / 2.0
          const nearZone = Math.abs(pivot - midOld) <= atrNow * p.mergeAtrMult
          if (sameSide && nearZone) {
            z.score = Math.min(10.0, z.score + score * 0.25)
            z.top = Math.max(z.top, top)
            z.bot = Math.min(z.bot, bot)
            // Pine 146: kirilmis kutu birlesmeyle DIRILIR.
            z.broken = false
            z.brokenBar = null
            z.mergeBars.push(i)
            merged = true
          }
        }

        if (!merged) {
          zones.push({
            id: zones.length,
            isSupport: true,
            top,
            bot,
            score,
            bornBar: i - L,
            brokenBar: null,
            endBar: i,
            touchCount: 0,
            touchBars: [],
            mergeBars: [],
            expiredBar: null,
            trimmedBar: null,
            active: true,
            lastTouch: null,
            broken: false,
          })
          takip.push(zones.length - 1)
        }
      }
    }

    // --- Pine 212-223: FAZLA BOLGE TEMIZLEME (EN ESKIyi takipten cikarir) ---
    while (takip.length > p.maxZones) {
      const z = zones[takip.shift()]
      z.endBar = Math.min(i, z.bornBar + p.boxLengthBars) // Pine 216
      z.trimmedBar = i
      z.active = false
    }

    // --- Pine 228-292: BOLGELERI GUNCELLEME (SONDAN BASA) ---
    // Bu dongu O BARDA dogan kutuyu da isler: yeni kutu dogdugu barda
    // dokunulabilir ve kirilabilir.
    for (let t = takip.length - 1; t >= 0; t--) {
      const z = zones[takip[t]]

      // Pine 241: tooOld
      if (i - z.bornBar > p.maxAgeBars) {
        z.endBar = Math.min(i, z.bornBar + p.boxLengthBars) // Pine 244
        z.expiredBar = i
        z.active = false
        takip.splice(t, 1)
        continue
      }

      // Pine 255-256: rightEdge
      z.endBar = Math.min(i, z.bornBar + p.boxLengthBars)

      // Pine 258-265: dokunus
      const touched = low[i] <= z.top && high[i] >= z.bot
      const canAddTouch = z.lastTouch === null || i - z.lastTouch >= p.touchCooldown
      if (touched && canAddTouch && !z.broken) {
        z.score = Math.min(10.0, z.score + 0.35)
        z.lastTouch = i
        z.touchCount += 1
        z.touchBars.push(i)
      }

      // Pine 304-308: kirilma. atr O BARIN atr'si.
      const breakSupport = z.isSupport && close[i] < z.bot - atrNow * 0.15
      const breakResist = !z.isSupport && close[i] > z.top + atrNow * 0.15
      const yeniKirilma = !z.broken && (breakSupport || breakResist)
      if (yeniKirilma) {
        z.broken = true
        z.brokenBar = i
      }

      // Pine 315-330: kutu YALNIZCA showBrokenZones kapaliyken silinir.
      // Acikken (varsayilan) listede kalir; ustteki `rightEdge` satiri her
      // barda calismaya devam ettigi icin kutu `born + boxLengthBars`a kadar
      // UZAR. Eski surumde burada takipten cikiyordu ve cizim kirilma
      // barinda kesiliyordu.
      if (z.broken && p.showBrokenZones === false) {
        z.endBar = Math.min(i, z.bornBar + p.boxLengthBars)
        z.active = false
        takip.splice(t, 1)
      }
    }
  }

  return { zones, params: p, pivotEsitlik }
}

module.exports = { pineRef, PINE_VARSAYILAN, pivotEsitDahil }
