'use strict'

/**
 * Hafiza katmani (A6, sozlesme bolum 14).
 *
 * Gorev: indikatoru tarih boyunca calistirmak, uretilen ILK dokunuslari
 * etiketlemek, ozellik vektorlerini cikarmak ve hafiza kayitlarini (MemoryEvent)
 * uretmek. Etiketlenemeyen dokunuslar (ufku dolmayan, serinin sonuna yakin
 * olanlar) hafizaya girmez ama istatistiklerde sayilir.
 *
 * Sozlesme notlari:
 * - `extendMemory` artimli tarama icin seriyi bastan degil, son olayin
 *   epeyce oncesinden yeniden tarar. Yeniden taramada bolge kimlikleri (zoneId)
 *   ve dokunus kimlikleri (id) sifirdan numaralanir. Bu yuzden sozlesmede
 *   istenen "ayni zoneId + time" tekrar kontrolu tek basina yeterli degildir;
 *   asil koruma "hafizadaki son olay zamanindan SONRAKI olaylar" filtresidir.
 *   Iki kontrol de uygulanir, yeni olaylarin kimlikleri mevcut hafizanin
 *   ustune kaydirilarak tekillestirilir.
 * - Bir bolge yalnizca TEK bir ilk dokunus urettigi icin, hafizada zaten olayi
 *   olan bir bolgenin yeniden olay uretmesi mumkun degildir; kimlik kaydirmasi
 *   bu yuzden guvenlidir.
 */

const { runIndicator, DEFAULT_PARAMS } = require('../indicator/masterTouch')
const { labelTouch, DEFAULT_OUTCOME_CFG } = require('./outcome')
const { buildFeatures, CTX_NAMES, WINDOW_BARS } = require('./features')
const { sliceSeries, lastIndexAtOrBefore } = require('../series')
const { tfSeconds } = require('../tf')

/** Ozet tablolarinda her zaman gorunmesini istedigimiz seans adlari. */
const SESSION_NAMES = ['Asia', 'London', 'New York', 'Other']

/** ATR/EMA gibi ozyinelemeli hesaplarin oturmasi icin ek isinma payi. */
const EXTRA_WARMUP_BARS = 1000

/**
 * Ilerleme geri cagrisini [from, to] araligina olceklendirir ve ayni tamsayi
 * yuzdeyi tekrar tekrar yollamaz.
 * @param {Function|undefined} onProgress
 * @param {number} from
 * @param {number} to
 * @returns {Function|undefined}
 */
function scaleProgress (onProgress, from, to) {
  if (typeof onProgress !== 'function') return undefined
  let last = -1
  return function (pct, msg) {
    let p = typeof pct === 'number' && isFinite(pct) ? pct : 0
    if (p < 0) p = 0
    if (p > 100) p = 100
    const out = Math.round(from + (to - from) * (p / 100))
    if (out === last) return
    last = out
    onProgress(out, msg)
  }
}

/** Sayi degilse veya sonlu degilse varsayilani dondurur. */
function num (v, def) {
  return typeof v === 'number' && isFinite(v) ? v : def
}

/**
 * Tarih boyunca indikatoru calistirir, ilk dokunuslari etiketler,
 * ozellik vektorlerini cikarir ve hafiza kaydini uretir.
 *
 * Ilerleme dagilimi: indikator taramasi %0-60, etiketleme ve ozellik
 * cikarimi %60-100.
 *
 * @param {Object} s Series
 * @param {{tf:string, params:object, outcomeCfg:object}} cfg
 * @param {(pct:number,msg:string)=>void} [onProgress]
 * @returns {{tf:string, ctxNames:string[], events:Object[], zones:Object[], stats:object}}
 */
function buildMemory (s, cfg, onProgress) {
  const conf = cfg || {}
  const tf = conf.tf || '15m'
  const tfSec = tfSeconds(tf)
  const params = Object.assign({}, DEFAULT_PARAMS, conf.params || {})
  const outcomeCfg = Object.assign({}, DEFAULT_OUTCOME_CFG, conf.outcomeCfg || {})

  const report = typeof onProgress === 'function' ? onProgress : null
  if (report) report(0, 'Indikator taramasi basliyor')

  const scan = runIndicator(s, params, tfSec, scaleProgress(onProgress, 0, 60))
  const touches = (scan && scan.touches) || []
  const zones = (scan && scan.zones) || []
  const ctx = (scan && scan.context) || null
  const scanStats = (scan && scan.stats) || {}

  const n = touches.length
  const events = []
  const scoreHist = []

  let qualified = 0
  let labeled = 0
  let respected = 0
  let broken = 0
  let timeout = 0
  let noFeatures = 0
  let noLabel = 0
  let sumMfe = 0
  let sumMae = 0

  const labelProgress = scaleProgress(onProgress, 60, 100)
  if (labelProgress) labelProgress(0, 'Dokunuslar etiketleniyor')

  for (let i = 0; i < n; i++) {
    const t = touches[i]
    if (!t) continue

    if (t.qualified) qualified++

    // Skor histogrami: indeks = skor degeri.
    const sc = Math.max(0, Math.round(num(t.score, 0)))
    while (scoreHist.length <= sc) scoreHist.push(0)
    scoreHist[sc]++

    // Dokunus barindaki ATR. Indikator zaten hesapladi, olmazsa baglamdan al.
    let atrAt = num(t.atr, NaN)
    if (!(atrAt > 0) && ctx && ctx.atr && t.bar >= 0 && t.bar < ctx.atr.length) {
      atrAt = ctx.atr[t.bar]
    }

    const features = ctx ? buildFeatures(s, t, ctx) : null
    const outcome = labelTouch(s, t, atrAt, outcomeCfg)

    if (!outcome) noLabel++
    if (!features) noFeatures++

    if (outcome) {
      labeled++
      if (outcome.outcome === 'respect') respected++
      else if (outcome.outcome === 'break') broken++
      else timeout++
      sumMfe += num(outcome.mfeAtr, 0)
      sumMae += num(outcome.maeAtr, 0)
    }

    // Ikisi de yoksa bu dokunus hafizaya girmez, yalnizca sayilir.
    if (features && outcome) {
      events.push(Object.assign({}, t, outcome, { features: features }))
    }

    if (labelProgress && ((i & 127) === 0 || i === n - 1)) {
      labelProgress(((i + 1) / n) * 100, 'Dokunuslar etiketleniyor')
    }
  }

  const stats = {
    bars: s && typeof s.length === 'number' ? s.length : 0,
    zonesCreated: num(scanStats.zonesCreated, zones.length),
    zonesMergedAway: num(scanStats.zonesMergedAway, 0),
    firstTouches: n,
    qualified: qualified,
    labeled: labeled,
    respected: respected,
    broken: broken,
    timeout: timeout,
    stored: events.length,
    noFeatures: noFeatures,
    noLabel: noLabel,
    avgMfeAtr: labeled > 0 ? sumMfe / labeled : 0,
    avgMaeAtr: labeled > 0 ? sumMae / labeled : 0,
    rawWinRate: labeled > 0 ? respected / labeled : 0,
    scoreHist: scoreHist,
    firstTime: events.length > 0 ? events[0].time : 0,
    lastTime: events.length > 0 ? events[events.length - 1].time : 0,
    indicator: scanStats,
  }

  if (report) report(100, 'Hafiza hazir: ' + events.length + ' kayit')

  return {
    tf: tf,
    ctxNames: CTX_NAMES.slice(),
    events: events,
    zones: zones,
    stats: stats,
  }
}

/**
 * Var olan hafizaya yeni barlardan gelen olaylari ekler (artimli tarama).
 *
 * Seri, hafizadaki son olayin zamanindan yeterince geriden baslatilarak
 * yeniden taranir (isinma payi: emaSlowLen + boxLengthBars + WINDOW_BARS +
 * 1000 bar). Sonra yalnizca son olay zamanindan SONRAKI olaylar eklenir.
 *
 * @param {Object} s Series (tum gecmis)
 * @param {{tf?:string, ctxNames?:string[], events:Object[]}} memory
 * @param {{tf:string, params:object, outcomeCfg:object}} cfg
 * @param {(pct:number,msg:string)=>void} [onProgress]
 * @returns {{tf:string, ctxNames:string[], events:Object[], zones:Object[], stats:object}}
 */
function extendMemory (s, memory, cfg, onProgress) {
  const base = (memory && Array.isArray(memory.events)) ? memory.events : []
  if (base.length === 0) return buildMemory(s, cfg, onProgress)
  if (!s || !s.length) {
    return {
      tf: (cfg && cfg.tf) || memory.tf || '15m',
      ctxNames: CTX_NAMES.slice(),
      events: base.slice(),
      zones: [],
      stats: { added: 0, baseCount: base.length, rescanFromBar: -1, rescanBars: 0 },
    }
  }

  const conf = cfg || {}
  const params = Object.assign({}, DEFAULT_PARAMS, conf.params || {})

  // Mevcut hafizanin en son olay zamani ve en buyuk kimlikleri.
  let lastTime = -Infinity
  let maxId = -1
  let maxZoneId = -1
  for (let i = 0; i < base.length; i++) {
    const e = base[i]
    const t = num(e.time, -Infinity)
    if (t > lastTime) lastTime = t
    const id = num(e.id, -1)
    if (id > maxId) maxId = id
    const zid = num(e.zoneId, -1)
    if (zid > maxZoneId) maxZoneId = zid
  }
  if (!isFinite(lastTime)) return buildMemory(s, cfg, onProgress)

  // Yeni bar yoksa is yok.
  if (s.time[s.length - 1] <= lastTime) {
    return {
      tf: conf.tf || memory.tf || '15m',
      ctxNames: CTX_NAMES.slice(),
      events: base.slice(),
      zones: [],
      stats: { added: 0, baseCount: base.length, rescanFromBar: -1, rescanBars: 0 },
    }
  }

  const warmup = Math.max(0, Math.round(
    num(params.emaSlowLen, 200) +
    num(params.boxLengthBars, 120) +
    WINDOW_BARS +
    EXTRA_WARMUP_BARS
  ))

  const anchor = lastIndexAtOrBefore(s, lastTime)
  const from = anchor < 0 ? 0 : Math.max(0, anchor - warmup)
  const sub = from === 0 ? s : sliceSeries(s, from, s.length)

  const scan = buildMemory(sub, cfg, onProgress)

  // Mevcut hafizadaki (zoneId, time) ciftleri: sozlesmenin istedigi tekrar kontrolu.
  const seen = new Set()
  for (let i = 0; i < base.length; i++) {
    seen.add(base[i].zoneId + '|' + base[i].time)
  }

  const zoneIdMap = new Map()
  let nextId = maxId + 1
  let nextZoneId = maxZoneId + 1
  const fresh = []

  for (let i = 0; i < scan.events.length; i++) {
    const e = scan.events[i]
    if (!(e.time > lastTime)) continue
    const key = e.zoneId + '|' + e.time
    if (seen.has(key)) continue
    seen.add(key)

    // Yeni taramanin kimlikleri sifirdan basladigi icin mevcut hafizanin
    // ustune kaydiriliyor; ayni bolgenin dokunuslari ayni kimlige duser.
    let mapped = zoneIdMap.get(e.zoneId)
    if (mapped === undefined) {
      mapped = nextZoneId++
      zoneIdMap.set(e.zoneId, mapped)
    }
    e.zoneId = mapped
    e.id = nextId++
    fresh.push(e)
  }

  const merged = base.slice()
  for (let i = 0; i < fresh.length; i++) merged.push(fresh[i])
  merged.sort(function (a, b) { return a.time - b.time })

  const stats = Object.assign({}, scan.stats, {
    added: fresh.length,
    baseCount: base.length,
    total: merged.length,
    rescanFromBar: from,
    rescanBars: sub.length,
    rescanFromTime: sub.length > 0 ? sub.time[0] : 0,
    lastKnownTime: lastTime,
  })

  return {
    tf: scan.tf,
    ctxNames: CTX_NAMES.slice(),
    events: merged,
    zones: scan.zones,
    stats: stats,
  }
}

/**
 * Bir olay listesi icin bos sayac nesnesi.
 * @returns {{total:number, success:number, fail:number, timeout:number, winRate:number}}
 */
function emptyBucket () {
  return { total: 0, success: 0, fail: 0, timeout: 0, winRate: 0 }
}

/** Bir sayaca tek olay isler. */
function pushBucket (b, ev) {
  b.total++
  if (ev.success === true || ev.outcome === 'respect') b.success++
  else if (ev.outcome === 'timeout') b.timeout++
  else b.fail++
}

/** Sayaclarin oranlarini kapatir. */
function closeBucket (b) {
  b.winRate = b.total > 0 ? b.success / b.total : 0
  return b
}

/**
 * Hafiza ozeti: toplam, etiketlenmis, basarili, basarisiz, timeout,
 * yon dagilimi, seans dagilimi, yillara gore kirilim, ortalama mfeAtr/maeAtr
 * ve ham basari orani.
 *
 * @param {{events:Object[]}|Object[]} memory
 * @returns {object}
 */
function summarize (memory) {
  const events = Array.isArray(memory)
    ? memory
    : ((memory && Array.isArray(memory.events)) ? memory.events : [])

  // Yil hesabi icin aralik onbellegi: 6 milyon barlik veri icin Date nesnesi
  // basina bir kez kurulur, ayni yildaki olaylar onbellekten okunur.
  let cacheYear = 0
  let cacheStart = 0
  let cacheEnd = -1
  function yearOf (t) {
    if (t >= cacheStart && t < cacheEnd) return cacheYear
    const y = new Date(t * 1000).getUTCFullYear()
    cacheYear = y
    cacheStart = Date.UTC(y, 0, 1) / 1000
    cacheEnd = Date.UTC(y + 1, 0, 1) / 1000
    return y
  }

  const byDirection = { BUY: emptyBucket(), SELL: emptyBucket() }
  const bySession = {}
  for (let i = 0; i < SESSION_NAMES.length; i++) bySession[SESSION_NAMES[i]] = emptyBucket()
  const yearMap = new Map()

  let labeled = 0
  let success = 0
  let fail = 0
  let timeout = 0
  let sumMfe = 0
  let sumMae = 0
  let firstTime = 0
  let lastTime = 0

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!ev) continue
    const t = num(ev.time, 0)
    if (firstTime === 0 || t < firstTime) firstTime = t
    if (t > lastTime) lastTime = t

    const isLabeled = typeof ev.outcome === 'string' || typeof ev.success === 'boolean'
    if (!isLabeled) continue
    labeled++

    if (ev.success === true || ev.outcome === 'respect') success++
    else if (ev.outcome === 'timeout') timeout++
    else fail++

    sumMfe += num(ev.mfeAtr, 0)
    sumMae += num(ev.maeAtr, 0)

    const dir = ev.direction === 'SELL' ? 'SELL' : 'BUY'
    pushBucket(byDirection[dir], ev)

    const ses = typeof ev.session === 'string' && ev.session ? ev.session : 'Other'
    if (!bySession[ses]) bySession[ses] = emptyBucket()
    pushBucket(bySession[ses], ev)

    const y = yearOf(t)
    let yb = yearMap.get(y)
    if (!yb) {
      yb = { year: y, total: 0, success: 0, fail: 0, timeout: 0, winRate: 0, sumMfe: 0, sumMae: 0, avgMfeAtr: 0, avgMaeAtr: 0 }
      yearMap.set(y, yb)
    }
    yb.total++
    if (ev.success === true || ev.outcome === 'respect') yb.success++
    else if (ev.outcome === 'timeout') yb.timeout++
    else yb.fail++
    yb.sumMfe += num(ev.mfeAtr, 0)
    yb.sumMae += num(ev.maeAtr, 0)
  }

  closeBucket(byDirection.BUY)
  closeBucket(byDirection.SELL)
  const sessionKeys = Object.keys(bySession)
  for (let i = 0; i < sessionKeys.length; i++) closeBucket(bySession[sessionKeys[i]])

  const byYear = []
  const years = Array.from(yearMap.keys()).sort(function (a, b) { return a - b })
  for (let i = 0; i < years.length; i++) {
    const yb = yearMap.get(years[i])
    yb.winRate = yb.total > 0 ? yb.success / yb.total : 0
    yb.avgMfeAtr = yb.total > 0 ? yb.sumMfe / yb.total : 0
    yb.avgMaeAtr = yb.total > 0 ? yb.sumMae / yb.total : 0
    delete yb.sumMfe
    delete yb.sumMae
    byYear.push(yb)
  }

  return {
    tf: (memory && memory.tf) || null,
    total: events.length,
    labeled: labeled,
    success: success,
    fail: fail,
    timeout: timeout,
    winRate: labeled > 0 ? success / labeled : 0,
    rawWinRate: labeled > 0 ? success / labeled : 0,
    avgMfeAtr: labeled > 0 ? sumMfe / labeled : 0,
    avgMaeAtr: labeled > 0 ? sumMae / labeled : 0,
    firstTime: firstTime,
    lastTime: lastTime,
    byDirection: byDirection,
    bySession: bySession,
    byYear: byYear,
  }
}

module.exports = {
  buildMemory,
  extendMemory,
  summarize,
}
