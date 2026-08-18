'use strict'

// ============================================================================
// MASTER 1 TOUCH - Pine v6 indikatorunun JavaScript portu
// ----------------------------------------------------------------------------
// Kaynaklar:
//   /Users/dogukandogru/dev/indicator/indicator.pine                     (Pine v6)
//   /Users/dogukandogru/dev/indicator2/.../indicator/master_touch.py     (Python portu)
//
// Ozet mantik:
//   1. Pivot high/low barlarinda, o baradaki "flow" gucu yeterliyse ATR
//      genisliginde bir destek/direnc bolgesi acilir.
//   2. Her bolge yalnizca ILK dokunusunda skorlanir. Ikinci sans yoktur.
//   3. Kapanis bolgenin disinda breakConfirmBars kadar ART ARDA kalirsa bolge
//      kirilir; arada bir bar iceri donerse sayac sifirlanir.
//
// ----------------------------------------------------------------------------
// PINE'DAN BILEREK AYRILAN NOKTALAR
// ----------------------------------------------------------------------------
//  1. Footprint (orderflow): request.footprint() yalnizca TradingView icinde
//     calisir, elimizde orderflow verisi yok. Bu yuzden footprintOk HER ZAMAN
//     false kabul edilir, yani Pine'in "fpAvailable == false" dali islenir.
//     useFootprintScore varsayilan olarak kapali; acik olsaydi olcemedigimiz
//     bir kriter yuzunden her dokunus garanti 1 puan kaybederdi.
//  2. Pine'daki canUseChart (sembol XAU mu, zaman dilimi izinli mi) kontrolu
//     portlanmadi. Hangi seri ve zaman diliminin taranacagina ana uygulama
//     karar veriyor, indikator kendisine verileni isliyor.
//  3. box / label / table gibi gorsel nesneler uretilmiyor. Bolgeler ve
//     dokunuslar duz veri olarak donuyor, cizim isi renderer'in.
//  4. Pine bir barda yalnizca TEK sinyal yayinlar (buySignal / sellSignal
//     atamalari ust uste yazilir, sonuncusu kazanir). Bu port TUM ilk
//     dokunuslari dondurur ve Pine'in yayinlayacagi olanlari `qualified`
//     bayragiyla isaretler. Benzerlik motoru tum dokunuslari korpus olarak
//     kullandigi icin bu ayrim gerekli.
//  5. `strong` alani Python portundaki gibi `score >= strongNeeded` olarak
//     hesaplanir. Pine'da ek olarak `and qualified` sarti vardir; skor esigi
//     zaten qualified'in bir parcasi oldugu icin fark yalnizca seans kapisinin
//     kapatildigi barlarda ortaya cikar ve bu port Python ile ayni kalir.
//  6. Python portundaki "seri cok kisa ise bos don" erken cikisi
//     (len < max(emaSlowLen, 200) + lookback*2) buraya alinmadi. ATR(200)
//     isinmasi zaten NaN oldugu icin kisa seride bolge olusamaz; erken cikis
//     ise downstream modullerin ihtiyaci olan context dizilerini gizlerdi.
//  7. Bellek icin shift() dizileri ayrilmiyor: flowStrength[i-lookback],
//     dir[i-lookback], atr200[i-lookback] dogrudan indeksleniyor. Sonuc
//     np.roll + basi NaN ile birebir ayni.
//  8. atrBase (ATR'nin hareketli ortalamasi) NaN'a duyarli sekilde burada
//     hesaplaniyor: penceresinde tek bir NaN varsa sonuc NaN. Bu, pandas'in
//     min_periods davranisini birebir tasir ve ta.sma'nin NaN politikasindan
//     bagimsiz olmamizi saglar.
//  9. endTime, endBar seri sonunu asiyorsa son bar zamanina tfSec eklenerek
//     tahmin edilir (Pine'da kutu gelecege dogru uzatilabildigi icin).
// 10. `parts` nesnesi CONTRACTS.md'deki sekiz anahtari HER ZAMAN tasir;
//     kapali bir bilesenin degeri false olur (skora da girmez). Python portu
//     kapali bilesenin anahtarini hic yazmiyordu.
// ============================================================================

const { sma, ema, atr, rsi, rollingMax, rollingMin, pivotHigh, pivotLow, clamp } = require('../ta')
const { SESSIONS, sessionIndexArray, localHourArray, localDowArray } = require('../session')
const { resample } = require('../series')
const { tfSeconds } = require('../tf')

/** Pine'daki input() alanlarinin birebir karsiligi (ayni varsayilanlar). */
const DEFAULT_PARAMS = {
  minScoreForSignal: 5, strongScoreLevel: 6,
  lookback: 10, boxWidthAtr: 1.0, maxZoneHistory: 50,
  breakConfirmBars: 5, boxLengthBars: 120, mergeNearAtr: 0.8,
  flowLen: 10, minFlowStrength: 1.5, flowBonusMult: 1.25,
  useFootprintScore: false, hardFootprintGate: false, allowNoFootprintData: true,
  useHtfTrend: true, trendTf: '15m', emaFastLen: 50, emaSlowLen: 200,
  useVolatility: true, atrLen: 14, atrBaseLen: 50,
  minAtrRatio: 0.70, maxAtrRatio: 2.50,
  useLiquiditySweep: true, sweepLookback: 20,
  useRejection: true, wickMinRatio: 0.35,
  useMss: true, mssLen: 5,
  useFvg: false, fvgLookback: 8,
  sessionTz: 'Europe/Istanbul', useSessionScore: true, hardSessionGate: true,
  useAsia: false, useLondon: true, useNewYork: true, useOther: false,
  mintick: 0.01,
}

/** Trend zaman dilimi cozulemezse Python portundaki gibi 15 dakikaya duser. */
const TREND_TF_FALLBACK_SEC = 900

/**
 * NaN'a duyarli hareket ortalama: pencere dolu DEGILSE veya icinde tek bir NaN
 * varsa sonuc NaN olur. pandas rolling(min_periods=len).mean() karsiligi.
 * @param {Float64Array} src
 * @param {number} len
 * @returns {Float64Array}
 */
function rollingMeanStrict (src, len) {
  const n = src.length
  const out = new Float64Array(n)
  out.fill(NaN)
  const w = len | 0
  if (w <= 0 || n < w) return out
  let sum = 0
  let nanCount = 0
  for (let i = 0; i < n; i++) {
    const v = src[i]
    if (v !== v) nanCount++
    else sum += v
    if (i >= w) {
      const old = src[i - w]
      if (old !== old) nanCount--
      else sum -= old
    }
    if (i >= w - 1 && nanCount === 0) out[i] = sum / w
  }
  return out
}

/**
 * Bos sonuc iskeleti. Uzunlugu 0 olan seride bile sozlesmedeki tum alanlar
 * dolu olsun diye kullanilir.
 * @param {number} n
 */
function emptyContext (n) {
  const f = () => { const a = new Float64Array(n); a.fill(NaN); return a }
  return {
    atr: f(), atr200: f(), rsi: f(), sma20: f(), sma50: f(), flowStrength: new Float64Array(n),
    bullTrend: new Uint8Array(n), bearTrend: new Uint8Array(n),
    sessionIdx: new Uint8Array(n), localHour: new Uint8Array(n), localDow: new Uint8Array(n),
  }
}

/**
 * request.security(..., trendTF, lookahead_off) karsiligi.
 * Trend zaman dilimi grafik zaman diliminden BUYUKSE seri o dilime yeniden
 * orneklenir, EMA'lar orada hesaplanir ve degerler HTF bari KAPANDIKTAN sonra
 * gecerli olacak sekilde ileri doldurulur. Boylece bir grafik bari asla
 * kapanmamis bir HTF barini goremez (lookahead yok).
 *
 * @param {object} s        Series
 * @param {object} p        Birlesitirilmis parametreler
 * @param {number} tfSec    Grafik zaman dilimi (saniye)
 * @param {Uint8Array} bullTrend  Cikti (yerinde doldurulur)
 * @param {Uint8Array} bearTrend  Cikti (yerinde doldurulur)
 */
function fillHtfTrend (s, p, tfSec, bullTrend, bearTrend) {
  const n = s.length
  let trendSec
  try {
    trendSec = tfSeconds(p.trendTf)
  } catch (err) {
    trendSec = TREND_TF_FALLBACK_SEC
  }

  if (!(trendSec > tfSec)) {
    // Trend dilimi grafikten kucuk veya esit: seri oldugu gibi kullanilir.
    const close = s.close
    const fast = ema(close, p.emaFastLen)
    const slow = ema(close, p.emaSlowLen)
    for (let i = 0; i < n; i++) {
      const c = close[i]
      const f = fast[i]
      const sl = slow[i]
      bullTrend[i] = (c > f && f > sl) ? 1 : 0
      bearTrend[i] = (c < f && f < sl) ? 1 : 0
    }
    return
  }

  const htf = resample(s, trendSec)
  const hn = htf.length
  if (hn === 0) return
  const hClose = htf.close
  const hTime = htf.time
  const hFast = ema(hClose, p.emaFastLen)
  const hSlow = ema(hClose, p.emaSlowLen)

  // Zamanlar artan oldugu icin tek yonlu isaretci yeter (O(n + hn)).
  const time = s.time
  let k = 0
  let j = -1
  for (let i = 0; i < n; i++) {
    const t = time[i]
    while (k < hn && hTime[k] + trendSec <= t) { j = k; k++ }
    if (j < 0) continue
    const c = hClose[j]
    const f = hFast[j]
    const sl = hSlow[j]
    bullTrend[i] = (c > f && f > sl) ? 1 : 0
    bearTrend[i] = (c < f && f < sl) ? 1 : 0
  }
}

/**
 * Indikatoru bastan sona calistirir.
 *
 * @param {object} s        Series (time/open/high/low/close/volume + length)
 * @param {object} [params] DEFAULT_PARAMS uzerine yazilir
 * @param {number} tfSec    Serinin zaman dilimi (saniye)
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @returns {{zones: Array, touches: Array, context: object, stats: object}}
 */
function runIndicator (s, params, tfSec, onProgress) {
  const p = Object.assign({}, DEFAULT_PARAMS, params || {})
  const n = s ? (s.length | 0) : 0
  const step = tfSec > 0 ? tfSec : 60

  // Ilerleme bildirimi: yuzde artmadikca ve 100 cagriyi gectikten sonra susar.
  let lastPct = -1
  let emitted = 0
  const report = (pct, msg) => {
    if (typeof onProgress !== 'function') return
    const v = pct < 0 ? 0 : (pct > 100 ? 100 : (pct | 0))
    if (v <= lastPct || emitted >= 100) return
    lastPct = v
    emitted++
    onProgress(v, msg)
  }

  const stats = {
    bars: n, zonesCreated: 0, zonesMergedAway: 0,
    firstTouches: 0, qualified: 0, gateBlockedSession: 0, scoreHist: {},
  }

  if (n === 0) {
    return { zones: [], touches: [], context: emptyContext(0), stats }
  }

  const open = s.open
  const high = s.high
  const low = s.low
  const close = s.close
  const volume = s.volume
  const time = s.time

  const lookback = p.lookback | 0
  const mintick = p.mintick > 0 ? p.mintick : 1e-9

  report(1, 'Akis (flow) hesaplaniyor')

  // --- Flow --------------------------------------------------------------
  // body = |close-open|, range = max(high-low, mintick), dir = sign(close-open)
  // flowProxy = volume * bodyRatio * dir
  const dir = new Int8Array(n)          // -1 / 0 / 1, bellek icin Int8
  const absFlow = new Float64Array(n)   // |flowProxy|
  for (let i = 0; i < n; i++) {
    const o = open[i]
    const c = close[i]
    const d = c > o ? 1 : (c < o ? -1 : 0)
    dir[i] = d
    let rng = high[i] - low[i]
    if (!(rng > mintick)) rng = mintick
    const bodyRatio = (c > o ? c - o : o - c) / rng
    absFlow[i] = d === 0 ? 0 : volume[i] * bodyRatio
  }
  const flowAvg = rollingMeanStrict(absFlow, p.flowLen | 0)
  const flowStrength = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = flowAvg[i]
    flowStrength[i] = (a !== a || a === 0) ? 0 : absFlow[i] / a
  }

  report(6, 'ATR ve oynaklik hesaplaniyor')

  // --- Volatilite --------------------------------------------------------
  const atrNow = atr(high, low, close, p.atrLen | 0)
  const atrBase = rollingMeanStrict(atrNow, p.atrBaseLen | 0)
  const volOk = new Uint8Array(n)
  const minRatio = p.minAtrRatio
  const maxRatio = p.maxAtrRatio
  for (let i = 0; i < n; i++) {
    const ab = atrBase[i]
    const ratio = (ab !== ab || ab === 0) ? 1.0 : atrNow[i] / ab
    volOk[i] = (ratio >= minRatio && ratio <= maxRatio) ? 1 : 0
  }
  const atr200 = atr(high, low, close, 200)

  report(11, 'Ust zaman dilimi trendi hesaplaniyor')

  // --- HTF trend ---------------------------------------------------------
  const bullTrend = new Uint8Array(n)
  const bearTrend = new Uint8Array(n)
  if (p.useHtfTrend) fillHtfTrend(s, p, step, bullTrend, bearTrend)

  report(14, 'Sweep / rejection / MSS hesaplaniyor')

  // --- Sweep / rejection / MSS / FVG -------------------------------------
  // priorLow/priorHigh: low[1] ve high[1] uzerinden pencere, yani [i-len, i-1].
  const bullSweep = new Uint8Array(n)
  const bearSweep = new Uint8Array(n)
  {
    const swLen = p.sweepLookback | 0
    const loRun = rollingMin(low, swLen)
    const hiRun = rollingMax(high, swLen)
    for (let i = 1; i < n; i++) {
      const pl = loRun[i - 1]
      const ph = hiRun[i - 1]
      const c = close[i]
      bullSweep[i] = (low[i] < pl && c > pl) ? 1 : 0
      bearSweep[i] = (high[i] > ph && c < ph) ? 1 : 0
    }
  }

  const bullReject = new Uint8Array(n)
  const bearReject = new Uint8Array(n)
  {
    const wickMin = p.wickMinRatio
    for (let i = 0; i < n; i++) {
      const o = open[i]
      const c = close[i]
      const h = high[i]
      const l = low[i]
      let rng = h - l
      if (!(rng > mintick)) rng = mintick
      const bodyLow = o < c ? o : c
      const bodyHigh = o > c ? o : c
      bullReject[i] = ((bodyLow - l) / rng >= wickMin && c > o) ? 1 : 0
      bearReject[i] = ((h - bodyHigh) / rng >= wickMin && c < o) ? 1 : 0
    }
  }

  const bullMss = new Uint8Array(n)
  const bearMss = new Uint8Array(n)
  {
    const mLen = p.mssLen | 0
    const hiRun = rollingMax(high, mLen)
    const loRun = rollingMin(low, mLen)
    for (let i = 1; i < n; i++) {
      const c = close[i]
      bullMss[i] = c > hiRun[i - 1] ? 1 : 0
      bearMss[i] = c < loRun[i - 1] ? 1 : 0
    }
  }

  const bullFvg = new Uint8Array(n)
  const bearFvg = new Uint8Array(n)
  if (p.useFvg) {
    const fLen = Math.max(1, p.fvgLookback | 0)
    const gapBull = new Uint8Array(n)
    const gapBear = new Uint8Array(n)
    for (let i = 2; i < n; i++) {
      if (low[i] > high[i - 2]) gapBull[i] = 1
      if (high[i] < low[i - 2]) gapBear[i] = 1
    }
    let cb = 0
    let cr = 0
    for (let i = 0; i < n; i++) {
      cb += gapBull[i]
      cr += gapBear[i]
      if (i >= fLen) { cb -= gapBull[i - fLen]; cr -= gapBear[i - fLen] }
      bullFvg[i] = cb > 0 ? 1 : 0
      bearFvg[i] = cr > 0 ? 1 : 0
    }
  }

  report(20, 'Seanslar cozumleniyor')

  // --- Seanslar ----------------------------------------------------------
  const sessionIdx = sessionIndexArray(time, p.sessionTz)
  const localHour = localHourArray(time, p.sessionTz)
  const localDow = localDowArray(time, p.sessionTz)
  const allowedMap = {
    Asia: !!p.useAsia,
    London: !!p.useLondon,
    'New York': !!p.useNewYork,
    Other: !!p.useOther,
  }
  const allowedBySession = new Uint8Array(SESSIONS.length)
  for (let i = 0; i < SESSIONS.length; i++) {
    allowedBySession[i] = allowedMap[SESSIONS[i]] ? 1 : 0
  }

  report(22, 'Pivotlar araniyor')

  // --- Pivotlar ----------------------------------------------------------
  const pivHigh = pivotHigh(high, lookback, lookback)
  const pivLow = pivotLow(low, lookback, lookback)

  // Baglam dizileri (ozellik cikarimi bunlari yeniden hesaplamasin diye).
  const rsi14 = rsi(close, 14)
  const sma20 = sma(close, 20)
  const sma50 = sma(close, 50)

  // Footprint verisi yok: Pine'in "fpAvailable == false" dali.
  const footprintOk = false
  const footprintGateOk = !p.hardFootprintGate || footprintOk || !!p.allowNoFootprintData

  // --- Aktif bolge halkasi ------------------------------------------------
  // Aktif liste en fazla maxZoneHistory uzunlugunda oldugu icin dogrusal tarama
  // yeterli. Nesne yerine paralel tipli diziler kullaniliyor; Zone/Touch
  // nesneleri yalnizca CIKTI icin uretiliyor.
  const maxZones = Math.max(0, p.maxZoneHistory | 0)
  const cap = Math.max(1, maxZones) + 2
  const zIsSupport = new Uint8Array(cap)
  const zTop = new Float64Array(cap)
  const zBottom = new Float64Array(cap)
  const zCreatedBar = new Int32Array(cap)
  const zEndBar = new Int32Array(cap)
  const zBroken = new Uint8Array(cap)
  const zBrokenBar = new Int32Array(cap)
  const zBreakCount = new Int32Array(cap)
  const zTouchCount = new Int32Array(cap)
  const zWasTouching = new Uint8Array(cap)
  const zFlow = new Float64Array(cap)
  const zId = new Int32Array(cap)
  let head = 0
  let liveCount = 0

  const zones = []
  const touches = []
  let nextZoneId = 0
  let nextTouchId = 0

  const lastTime = time[n - 1]
  /** endBar seri disina tasarsa zamani zaman dilimi adimiyla tahmin et. */
  const barTime = (bar) => (bar < n ? time[bar] : lastTime + (bar - (n - 1)) * step)

  /** Halkadan dusen veya sonda kalan bolgeyi cikti nesnesine cevirir. */
  const emitZone = (slot) => {
    const createdBar = zCreatedBar[slot]
    const pivotBar = createdBar - lookback
    const endBar = zEndBar[slot]
    const broken = zBroken[slot] === 1
    zones.push({
      id: zId[slot],
      isSupport: zIsSupport[slot] === 1,
      top: zTop[slot],
      bottom: zBottom[slot],
      createdBar,
      createdTime: time[createdBar],
      pivotBar,
      pivotTime: pivotBar >= 0 ? time[pivotBar] : time[0],
      endBar,
      endTime: barTime(endBar),
      flow: zFlow[slot],
      broken,
      brokenBar: broken ? zBrokenBar[slot] : -1,
      touchCount: zTouchCount[slot],
    })
  }

  // Skor histogrami: en fazla 9 bilesen oldugu icin kucuk sayac dizisi yeter.
  const scoreCounts = new Int32Array(16)

  const minFlow = p.minFlowStrength
  const flowNeeded = p.minFlowStrength * p.flowBonusMult
  const boxWidthAtr = p.boxWidthAtr
  const mergeNearAtr = p.mergeNearAtr
  const boxLengthBars = p.boxLengthBars | 0
  const breakConfirmBars = p.breakConfirmBars | 0
  const hardSessionGate = !!p.hardSessionGate

  // Ilerleme en fazla 75 kez daha bildirilir (toplamda 100 cagriyi asmaz).
  const progressStep = Math.max(1, Math.floor(n / 75))
  let nextReportBar = 0

  // ------------------------------------------------------------------------
  // ANA DONGU - sira Python portundaki compute() ile birebir aynidir:
  //   1) once bolge olustur (destek, sonra direnc), sonra listeyi kirp
  //   2) sonra dokunus / kirilma dongusunu isle
  // ------------------------------------------------------------------------
  for (let i = 0; i < n; i++) {
    if (i >= nextReportBar) {
      nextReportBar = i + progressStep
      report(25 + (i / n) * 75, 'Bolgeler ve dokunuslar taraniyor')
    }

    // ---- 1) Yeni bolge olustur -------------------------------------------
    if (i >= lookback) {
      const pi = i - lookback
      const pivotAtrRaw = atr200[pi]
      const pivotFlow = flowStrength[pi]
      const pivotDir = dir[pi]
      const width = pivotAtrRaw * boxWidthAtr

      if (width === width && pivotFlow >= minFlow) {
        // Destek once, sonra direnc (Python: for is_support in (True, False)).
        for (let side = 0; side < 2; side++) {
          const isSupport = side === 0
          const pv = isSupport ? pivLow[i] : pivHigh[i]
          if (pv !== pv) continue
          if (isSupport ? !(pivotDir > 0) : !(pivotDir < 0)) continue

          const top = isSupport ? pv : pv + width
          const bottom = isSupport ? pv - width : pv
          const newMid = (top + bottom) / 2.0

          // Yakin bolge eleme: ayni yonde ve orta noktasi cok yakin bir AKTIF
          // bolge varsa yeni bolge acilmaz.
          let tooNear = false
          if (mergeNearAtr > 0) {
            const limit = pivotAtrRaw * mergeNearAtr
            let slot = head
            const wantSupport = isSupport ? 1 : 0
            for (let q = 0; q < liveCount; q++) {
              if (zIsSupport[slot] === wantSupport) {
                const mid = (zTop[slot] + zBottom[slot]) / 2.0
                const d = mid - newMid
                if ((d < 0 ? -d : d) <= limit) { tooNear = true; break }
              }
              slot++
              if (slot === cap) slot = 0
            }
          }
          if (tooNear) { stats.zonesMergedAway++; continue }

          stats.zonesCreated++
          let slot = head + liveCount
          if (slot >= cap) slot -= cap
          zIsSupport[slot] = isSupport ? 1 : 0
          zTop[slot] = top
          zBottom[slot] = bottom
          zCreatedBar[slot] = i
          zEndBar[slot] = i + boxLengthBars
          zBroken[slot] = 0
          zBrokenBar[slot] = -1
          zBreakCount[slot] = 0
          zTouchCount[slot] = 0
          zWasTouching[slot] = 0
          zFlow[slot] = pivotFlow
          zId[slot] = nextZoneId++
          liveCount++
        }
      }
    }

    // Aktif liste kirpma: en eskiden atilir, atilan bolge cikti listesine gecer.
    while (liveCount > maxZones) {
      emitZone(head)
      head++
      if (head === cap) head = 0
      liveCount--
    }

    // ---- 2) Kirilma + ilk dokunus ----------------------------------------
    const closeI = close[i]
    const highI = high[i]
    const lowI = low[i]
    let slot = head
    for (let q = 0; q < liveCount; q++) {
      const isSupport = zIsSupport[slot] === 1
      const top = zTop[slot]
      const bottom = zBottom[slot]
      const zoneAlive = i <= zEndBar[slot]

      if (zoneAlive && zBroken[slot] === 0) {
        const breakNow = isSupport ? (closeI < bottom) : (closeI > top)
        const bc = breakNow ? zBreakCount[slot] + 1 : 0
        zBreakCount[slot] = bc
        if (bc >= breakConfirmBars) {
          zBroken[slot] = 1
          zBrokenBar[slot] = i
        }
      }

      const touchNow = zoneAlive && zBroken[slot] === 0 &&
        i >= zCreatedBar[slot] && lowI <= top && highI >= bottom

      if (touchNow && zWasTouching[slot] === 0 && zTouchCount[slot] === 0) {
        zTouchCount[slot] = 1
        stats.firstTouches++

        const trendOk = (isSupport ? bullTrend[i] : bearTrend[i]) === 1
        const sweepOk = (isSupport ? bullSweep[i] : bearSweep[i]) === 1
        const rejectOk = (isSupport ? bullReject[i] : bearReject[i]) === 1
        const mssOk = (isSupport ? bullMss[i] : bearMss[i]) === 1
        const fvgOk = (isSupport ? bullFvg[i] : bearFvg[i]) === 1
        const volatilityOk = volOk[i] === 1
        const sIdx = sessionIdx[i]
        const sessionAllowed = allowedBySession[sIdx] === 1
        const zoneFlow = zFlow[slot]
        const flowOk = zoneFlow >= flowNeeded

        // Skor: bilesen sirasi Pine ve Python portuyla ayni.
        let score = 0
        let maxScore = 1
        if (flowOk) score++
        if (p.useFootprintScore) { maxScore++; if (footprintOk) score++ }
        if (p.useHtfTrend) { maxScore++; if (trendOk) score++ }
        if (p.useVolatility) { maxScore++; if (volatilityOk) score++ }
        if (p.useSessionScore) { maxScore++; if (sessionAllowed) score++ }
        if (p.useLiquiditySweep) { maxScore++; if (sweepOk) score++ }
        if (p.useRejection) { maxScore++; if (rejectOk) score++ }
        if (p.useMss) { maxScore++; if (mssOk) score++ }
        if (p.useFvg) { maxScore++; if (fvgOk) score++ }

        const needed = p.minScoreForSignal < maxScore ? p.minScoreForSignal : maxScore
        const strongNeeded = p.strongScoreLevel < maxScore ? p.strongScoreLevel : maxScore
        const sessionGateOk = !hardSessionGate || sessionAllowed
        const qualified = score >= needed && sessionGateOk && footprintGateOk

        if (score >= 0 && score < scoreCounts.length) scoreCounts[score]++
        if (score >= needed && !sessionGateOk) stats.gateBlockedSession++
        if (qualified) stats.qualified++

        // Bolgeye ne kadar girildi (0..1).
        const height = top - bottom
        let penetration = 0
        if (height > 0) {
          penetration = isSupport
            ? (top - (lowI < top ? lowI : top)) / height
            : ((highI > bottom ? highI : bottom) - bottom) / height
          penetration = clamp(penetration, 0, 1)
        }

        const parts = {
          flow: flowOk,
          trend: p.useHtfTrend ? trendOk : false,
          volatility: p.useVolatility ? volatilityOk : false,
          session: p.useSessionScore ? sessionAllowed : false,
          sweep: p.useLiquiditySweep ? sweepOk : false,
          rejection: p.useRejection ? rejectOk : false,
          mss: p.useMss ? mssOk : false,
          fvg: p.useFvg ? fvgOk : false,
        }
        if (p.useFootprintScore) parts.footprint = footprintOk

        touches.push({
          id: nextTouchId++,
          zoneId: zId[slot],
          isSupport,
          direction: isSupport ? 'BUY' : 'SELL',
          bar: i,
          time: time[i],
          price: closeI,
          zoneTop: top,
          zoneBottom: bottom,
          zoneFlow,
          zoneAgeBars: i - zCreatedBar[slot],
          penetration,
          atr: atrNow[i],
          score,
          maxScore,
          qualified,
          strong: score >= strongNeeded,
          session: SESSIONS[sIdx],
          parts,
        })
      }

      zWasTouching[slot] = touchNow ? 1 : 0
      slot++
      if (slot === cap) slot = 0
    }
  }

  // Halkada kalan bolgeleri son durumlariyla ciktiya al (olusum sirasi korunur).
  {
    let slot = head
    for (let q = 0; q < liveCount; q++) {
      emitZone(slot)
      slot++
      if (slot === cap) slot = 0
    }
  }

  for (let k = 0; k < scoreCounts.length; k++) {
    if (scoreCounts[k] > 0) stats.scoreHist[k] = scoreCounts[k]
  }

  report(100, 'Tarama tamamlandi')

  return {
    zones,
    touches,
    context: {
      atr: atrNow,
      atr200,
      rsi: rsi14,
      sma20,
      sma50,
      flowStrength,
      bullTrend,
      bearTrend,
      sessionIdx,
      localHour,
      localDow,
    },
    stats,
  }
}

module.exports = { DEFAULT_PARAMS, runIndicator }
