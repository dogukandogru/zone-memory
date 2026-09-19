'use strict'

/**
 * Motor iscisi. Tum agir isler burada calisir: veri okuma, indikator taramasi,
 * hafiza kurma, benzerlik, prototip, geriye test ve canli kontrol.
 *
 * Ana iplikle protokol (bkz. src/main/engine.js):
 *   gelen : {id, cmd, payload}
 *   giden : {type:'result'|'error'|'progress'|'log', id, ...}
 *
 * Onbellek: acik seri ve hafiza bellekte tutulur, ayni zaman dilimi tekrar
 * istendiginde diskten okunmaz. 1m serisi 6 milyon bar (~300 MB) olabildigi
 * icin ayni anda yalnizca TEK zaman diliminin serisi bellekte tutulur ve
 * dilimleme her yerde `subarray` ile yapilir, kopyalanmaz.
 */

const fs = require('fs')
const fsp = fs.promises
const { parentPort, workerData } = require('worker_threads')

// Veri klasorunu ana iplikten devral (isci ipliginde Electron `app` yoktur).
if (workerData && workerData.dataDir) process.env.ZONE_MEMORY_DATA_DIR = workerData.dataDir
if (workerData && workerData.userDataDir) process.env.ZONE_MEMORY_USER_DIR = workerData.userDataDir

const paths = require('../paths')

/** 2100-01-01, "sonsuz" ust zaman siniri yerine kullanilir. */
const MAX_TIME = 4102444800
/** Canli kontrolde indikatorun kosturuldugu kuyruk pencere uzunlugu. */
const DEFAULT_TAIL_BARS = 4000

// ---------------------------------------------------------------------------
// Cekirdek modul yukleyici (tembel)
// ---------------------------------------------------------------------------

const coreCache = new Map()

/**
 * `src/core` altindaki bir modulu tembel yukler.
 * @param {string} rel 'series', 'store/binstore', 'learn/memory' gibi
 */
function core(rel) {
  const hit = coreCache.get(rel)
  if (hit) return hit
  let mod
  try {
    mod = require('../../core/' + rel)
  } catch (err) {
    throw new Error('Cekirdek modul yuklenemedi: core/' + rel + ' (' + (err && err.message ? err.message : String(err)) + ')')
  }
  coreCache.set(rel, mod)
  return mod
}

// ---------------------------------------------------------------------------
// Onbellekler
// ---------------------------------------------------------------------------

let seriesCache = { tf: null, series: null }
let memoryCache = { tf: null, memory: null }
let zonesCache = { tf: null, zones: null }
let protoCache = { tf: null, protos: null }
let signalCache = { tf: null, signals: null }
/** Canli barlarin diske yazilamadigi durum kullaniciya bir kez bildirilir. */
let liveStoreWarned = false

/** Verilen zaman diliminin (veya hepsinin) onbellegini bosaltir. */
function clearCache(tf) {
  if (!tf || seriesCache.tf === tf) seriesCache = { tf: null, series: null }
  if (!tf || memoryCache.tf === tf) memoryCache = { tf: null, memory: null }
  if (!tf || zonesCache.tf === tf) zonesCache = { tf: null, zones: null }
  if (!tf || protoCache.tf === tf) protoCache = { tf: null, protos: null }
  if (!tf || signalCache.tf === tf) signalCache = { tf: null, signals: null }
}

// ---------------------------------------------------------------------------
// Kucuk yardimcilar
// ---------------------------------------------------------------------------

function num(v, def) {
  return typeof v === 'number' && isFinite(v) ? v : (def || 0)
}

function clampInt(v, lo, hi, def) {
  const n = Math.floor(num(v, def))
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/** JSON dosyasini atomik yazar (once .tmp, sonra rename). */
async function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8')
  await fsp.rename(tmp, file)
}

/** JSON dosyasini okur, yoksa veya bozuksa null doner. */
async function readJson(file) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (err) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    return null
  }
}

/**
 * Yapi damgasini (src/build-info.json) bir kez okur, sonuc onbellege alinir.
 *
 * Neden: bir olcumun hangi kodla alindigi izlenemiyordu. Tarama ve geriye test
 * ciktilarina commit ile kaynak ozeti yazilirsa eski bir olcum yeni koda
 * bakilarak yorumlanmaz. Damga dosyasi gelistirmede olmayabilir, o zaman
 * alanlar null kalir; olcum bu yuzden basarisiz olmaz.
 * @returns {{buildCommit:string|null, buildSrcHash:string|null}}
 */
let buildInfoCache = null
function buildDamgasi() {
  if (buildInfoCache) return buildInfoCache
  let bilgi = null
  try {
    bilgi = require('../../build-info.json')
  } catch (err) {
    bilgi = null
  }
  buildInfoCache = {
    buildCommit: bilgi && bilgi.commit ? String(bilgi.commit) : null,
    buildSrcHash: bilgi && bilgi.srcHash ? String(bilgi.srcHash) : null,
  }
  return buildInfoCache
}

/**
 * Eski yuk bicimi icin geri uyum: bir donem `outcomeCfg` ve `signalCfg`
 * dogrudan yukun icinde geliyordu. Artik kullanicinin YAMASI gonderilir ve
 * hazir ayar katmani arada calisir; eski bicim gelirse yama olarak kabul
 * edilir, boylece surum farkinda sessizce varsayilana dusmez.
 * @param {object} payload
 * @returns {object}
 */
function cfgPatchGeriUyum(payload) {
  const yama = {}
  if (payload && payload.outcomeCfg && typeof payload.outcomeCfg === 'object') {
    yama.outcomeCfg = payload.outcomeCfg
  }
  if (payload && payload.signalCfg && typeof payload.signalCfg === 'object') {
    yama.signalCfg = payload.signalCfg
  }
  return yama
}

/**
 * Bir hafizanin hangi ayarla kuruldugunu gosteren iz. Tarama bu izi hafiza
 * dosyasina yazar; canli ve test bunu etkin ayarin iziyle karsilastirir.
 * @param {object} indicatorParams
 * @param {object} outcomeCfg
 * @param {string[]} ctxNames
 */
function ayarIzi(indicatorParams, outcomeCfg, ctxNames) {
  return core('store/memstore').cfgHash({
    indicatorParams: indicatorParams || null,
    outcomeCfg: outcomeCfg || null,
    ctxNames: Array.isArray(ctxNames) ? ctxNames : null,
  })
}

/**
 * KANIT DURUMU
 * Bir sinyal turu icin son olcumun ne dedigi: net beklentinin R cinsinden
 * %95 araligi sifirin ustundeyse "kanitli", nokta tahmin pozitif ama aralik
 * sifiri iceriyorsa "zayif", diger durumlarda "kanitlanmadi".
 *
 * Neden gerekli: olcum hicbir zaman diliminde kanitlanmis katma deger
 * gostermiyor, ama canli sinyal kartinda bu hic gorunmuyordu; her sinyal
 * ayni guvenle yayinlaniyordu.
 * @param {object} summary runBacktest ozeti
 * @returns {Object<string,{n:number, netR:number|null, netRLo:number|null,
 *   netRHi:number|null, liftPts:number|null, status:string}>}
 */
function kanitDurumu(summary) {
  const cikti = {}
  const turler = summary && Array.isArray(summary.byKind) ? summary.byKind : []
  for (const k of turler) {
    const ci = k.expectancyRCI
    const netR = ci && Number.isFinite(ci.mean) ? ci.mean : null
    const lo = ci && Number.isFinite(ci.lo) ? ci.lo : null
    const hi = ci && Number.isFinite(ci.hi) ? ci.hi : null
    let durum = 'kanitlanmadi'
    if (k.fired > 0 && lo !== null && lo > 0) durum = 'kanitli'
    else if (k.fired > 0 && netR !== null && netR > 0) durum = 'zayif'
    cikti[k.kind] = {
      n: k.fired,
      netR: netR,
      netRLo: lo,
      netRHi: hi,
      liftPts: Number.isFinite(k.edgePts) ? k.edgePts : null,
      status: durum,
    }
  }
  return cikti
}

/** Dosya var mi. */
async function fileExists(file) {
  try {
    await fsp.access(file, fs.constants.R_OK)
    return true
  } catch (err) {
    return false
  }
}

/** Zaman dilimi dogrulamasi, gecersizse anlasilir Turkce hata firlatir. */
function requireTf(tf) {
  const tfmod = core('tf')
  if (!tf || !tfmod.TF_SECONDS[tf]) {
    throw new Error('Gecersiz zaman dilimi: ' + String(tf))
  }
  return tf
}

/**
 * Hafiza olayindan arayuz icin hafif ozet cikarir (features HARIC).
 * @param {object} e
 */
function lightEvent(e) {
  return {
    id: e.id,
    zoneId: e.zoneId,
    // Olay turu: 'form' kutunun dogdugu an, 'touch' fiyatin geri donup
    // dokundugu an. Eski hafiza dosyalarinda yoktur, o kayitlar dokunustur.
    kind: e.kind === 'form' ? 'form' : 'touch',
    isSupport: !!e.isSupport,
    direction: e.direction,
    bar: e.bar,
    time: e.time,
    price: e.price,
    zoneTop: e.zoneTop,
    zoneBottom: e.zoneBottom,
    zoneFlow: e.zoneFlow,
    zoneAgeBars: e.zoneAgeBars,
    penetration: e.penetration,
    entryDistAtr: e.entryDistAtr !== undefined ? e.entryDistAtr : null,
    bbDistAtr: e.bbDistAtr !== undefined ? e.bbDistAtr : null,
    volRatio: e.volRatio !== undefined ? e.volRatio : null,
    atr: e.atr,
    score: e.score,
    maxScore: e.maxScore,
    qualified: !!e.qualified,
    strong: !!e.strong,
    session: e.session,
    parts: e.parts || null,
    outcome: e.outcome !== undefined ? e.outcome : null,
    success: e.success !== undefined ? !!e.success : null,
    mfeAtr: e.mfeAtr !== undefined ? e.mfeAtr : null,
    maeAtr: e.maeAtr !== undefined ? e.maeAtr : null,
    fwdReturnPct: e.fwdReturnPct !== undefined ? e.fwdReturnPct : null,
    barsToOutcome: e.barsToOutcome !== undefined ? e.barsToOutcome : null,
  }
}

/** Prototipleri JSON'a yazilabilir hale getirir (Float32Array -> dizi). */
function protosToJson(protos) {
  if (!Array.isArray(protos)) return []
  return protos.map((p) => ({
    id: p.id,
    size: p.size,
    winRate: p.winRate,
    avgMfeAtr: p.avgMfeAtr,
    avgMaeAtr: p.avgMaeAtr,
    label: p.label,
    memberIds: Array.isArray(p.memberIds) ? p.memberIds : Array.from(p.memberIds || []),
    centroid: Array.from(p.centroid || []),
  }))
}

/** JSON'dan okunan prototiplerde centroid'i tipli diziye geri cevirir. */
function protosFromJson(list) {
  if (!Array.isArray(list)) return []
  return list.map((p) => {
    const out = Object.assign({}, p)
    out.centroid = Float32Array.from(p.centroid || [])
    return out
  })
}

/** Sermaye egrisini arayuz icin en fazla `maxPoints` noktaya seyreltir. */
function thinCurve(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || []
  const step = points.length / maxPoints
  const out = []
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)])
  const last = points[points.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** Gelen ham nesneyi gecerli bir Series haline getirir. */
function toSeries(raw) {
  const seriesMod = core('series')
  if (!raw) return seriesMod.emptySeries()
  if (raw.time instanceof Float64Array && typeof raw.length === 'number') return raw
  if (Array.isArray(raw)) {
    // [{time,open,...}] bicimi
    const n = raw.length
    const cols = { time: [], open: [], high: [], low: [], close: [], volume: [] }
    for (let i = 0; i < n; i++) {
      const b = raw[i]
      cols.time.push(b.time)
      cols.open.push(b.open)
      cols.high.push(b.high)
      cols.low.push(b.low)
      cols.close.push(b.close)
      cols.volume.push(num(b.volume, 0))
    }
    return seriesMod.fromArrays(cols)
  }
  return seriesMod.fromArrays({
    time: raw.time || [],
    open: raw.open || [],
    high: raw.high || [],
    low: raw.low || [],
    close: raw.close || [],
    volume: raw.volume || [],
  })
}

// ---------------------------------------------------------------------------
// Veri erisimi
// ---------------------------------------------------------------------------

/** Depodan (gerekirse yeniden ornekleyerek) tam seriyi okur. */
async function loadSeriesFromStore(tf) {
  const dir = paths.dataDir()
  const seriesMod = core('series')

  try {
    const loader = core('data/loader')
    if (loader && typeof loader.loadSeries === 'function') {
      const s = await loader.loadSeries({ dataDir: dir, tf: tf, from: 0, to: MAX_TIME })
      if (s && s.length > 0) return s
    }
  } catch (err) {
    // Yukleyici yoksa veya hata verdiyse dogrudan depoya bakariz.
  }

  const binstore = core('store/binstore')
  const direct = await binstore.readSeries(paths.candlePath(tf))
  if (direct && direct.length > 0) return direct

  if (tf !== '1m') {
    const base = await binstore.readSeries(paths.candlePath('1m'))
    if (base && base.length > 0) return seriesMod.resample(base, core('tf').tfSeconds(tf))
  }
  return seriesMod.emptySeries()
}

/** Seriyi onbellekten verir, yoksa yukler. */
async function getSeries(tf, force) {
  if (!force && seriesCache.tf === tf && seriesCache.series) return seriesCache.series
  // Bellegi sismemesi icin onceki seriyi birak.
  seriesCache = { tf: null, series: null }
  const s = await loadSeriesFromStore(tf)
  seriesCache = { tf: tf, series: s }
  return s
}

/**
 * Hafizayi onbellekten verir, yoksa diskten okur (yoksa null).
 *
 * Baglam vektorunun boyutlari indikatore baglidir (features.CTX_NAMES). Eski
 * bir indikator surumuyle uretilmis hafiza dosyasi kendi icinde tutarlidir,
 * bu yuzden memstore onu sorunsuz okur, ama boyutlari uyusmadigi icin yeni
 * olaylarla KARSILASTIRILAMAZ. Sessizce yanlis benzerlik uretmektense burada
 * durup yeniden tarama istiyoruz.
 */
async function getMemory(tf, force) {
  if (!force && memoryCache.tf === tf && memoryCache.memory) return memoryCache.memory
  const memstore = core('store/memstore')
  const mem = await memstore.loadMemory(paths.memoryPath(tf))
  if (mem && Array.isArray(mem.ctxNames) && mem.ctxNames.length > 0) {
    const guncel = core('learn/features').CTX_NAMES
    if (mem.ctxNames.length !== guncel.length) {
      throw new Error(
        'Bu zaman diliminin hafizasi eski indikator surumunden kalma (baglam ' +
        mem.ctxNames.length + ' boyut, simdi ' + guncel.length +
        '). "Geçmişi Tara" ile yeniden olusturun.'
      )
    }
  }
  memoryCache = { tf: tf, memory: mem }
  return mem
}

/** Hafiza yoksa anlasilir hata firlatir. */
async function requireMemory(tf, force) {
  const mem = await getMemory(tf, force)
  if (!mem || !mem.events || mem.events.length === 0) {
    throw new Error('Bu zaman dilimi icin hafiza yok. Once "Geçmişi Tara" calistirin.')
  }
  return mem
}

/** Kayitli bolgeleri verir. */
async function getZones(tf, force) {
  if (!force && zonesCache.tf === tf && zonesCache.zones) return zonesCache.zones
  const data = await readJson(paths.zonesPath(tf))
  const zones = Array.isArray(data) ? data : (data && Array.isArray(data.zones) ? data.zones : [])
  zonesCache = { tf: tf, zones: zones }
  return zones
}

/** Kayitli prototipleri verir (centroid Float32Array). */
async function getProtos(tf, force) {
  if (!force && protoCache.tf === tf && protoCache.protos) return protoCache.protos
  const data = await readJson(paths.protosPath(tf))
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.prototypes) ? data.prototypes : [])
  const protos = protosFromJson(list)
  protoCache = { tf: tf, protos: protos }
  return protos
}

/** Kayitli gecmis sinyalleri verir. */
async function getSignals(tf, force) {
  if (!force && signalCache.tf === tf && signalCache.signals) return signalCache.signals
  const data = await readJson(paths.signalsPath(tf))
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.signals) ? data.signals : [])
  signalCache = { tf: tf, signals: list }
  return list
}

// ---------------------------------------------------------------------------
// Canli sinyal gunlugu (JSON Lines)
// ---------------------------------------------------------------------------
//
// Canli uretilen sinyaller hicbir yere kaydedilmiyordu: yenileme, zaman dilimi
// degisimi veya yeniden baslatma hepsini siliyordu ve canli performans Test
// sekmesindeki olcumle hic karsilastirilamiyordu. Artik her canli olay bir
// satir olarak `<hafiza>.live.jsonl` dosyasina yazilir, ufku dolunca da sonucu
// ikinci bir satirla eklenir. Satir tipleri:
//   {type:'event',   key, tf, time, fetchedAt, ageBars, providerId, isProxy,
//                    basis, volScale, cfgHash, touch, signal}
//   {type:'outcome', key, outcome, win, realizedR, pnlAtr, barsToOutcome}
// Dosyaya YALNIZCA ekleme yapilir; tarama ve hafiza silme ona dokunmaz.

/** Gunluk yazilamadigi durum kullaniciya bir kez bildirilir. */
let liveLogWarned = false

/**
 * Gunluge tek satir ekler. Yazilamazsa canli dongu DURMAZ, kayit tutmak
 * sinyal uretmekten daha az onemlidir.
 * @param {string} tf
 * @param {object} satir
 * @param {string[]} [logs] Uyari buraya yazilir
 * @returns {Promise<boolean>}
 */
async function liveLogEkle(tf, satir, logs) {
  const yol = paths.liveLogPath(tf)
  const metin = JSON.stringify(satir) + '\n'
  try {
    await fsp.appendFile(yol, metin, 'utf8')
    return true
  } catch (err) {
    // Klasor henuz yoksa bir kez olusturup tekrar deneriz.
    try {
      await fsp.mkdir(paths.dataDir(), { recursive: true })
      await fsp.appendFile(yol, metin, 'utf8')
      return true
    } catch (err2) {
      if (!liveLogWarned) {
        liveLogWarned = true
        if (Array.isArray(logs)) {
          logs.push('Canli sinyal gunlugu yazilamadi: ' + (err2 && err2.message ? err2.message : String(err2)))
        }
      }
      return false
    }
  }
}

/**
 * Gunlugu okur ve olay satirlariyla sonuc satirlarini birlestirir.
 * Yarim yazilmis bir satir dosyanin tamamini bozmaz, yalnizca o satir atlanir.
 * @param {string} tf
 * @returns {Promise<{records:Array<object>}>}
 */
async function liveLogOku(tf) {
  let ham
  try {
    ham = await fsp.readFile(paths.liveLogPath(tf), 'utf8')
  } catch (err) {
    return { records: [] }
  }
  const records = []
  const byKey = new Map()
  const satirlar = ham.split('\n')
  for (let i = 0; i < satirlar.length; i++) {
    const s = satirlar[i].trim()
    if (!s) continue
    let obj = null
    try {
      obj = JSON.parse(s)
    } catch (err) {
      continue
    }
    if (!obj || typeof obj !== 'object') continue
    const key = String(obj.key === undefined || obj.key === null ? '' : obj.key)
    if (obj.type === 'outcome') {
      const rec = byKey.get(key)
      if (!rec) continue
      rec.labeled = true
      rec.outcome = obj.outcome || null
      rec.win = obj.win === undefined ? null : !!obj.win
      rec.realizedR = typeof obj.realizedR === 'number' ? obj.realizedR : null
      rec.pnlAtr = typeof obj.pnlAtr === 'number' ? obj.pnlAtr : null
      rec.barsToOutcome = typeof obj.barsToOutcome === 'number' ? obj.barsToOutcome : null
      continue
    }
    if (obj.type !== 'event') continue
    // Ayni olay iki kez yazildiysa (onceki surumun kalintisi) bir kez sayilir.
    if (byKey.has(key)) continue
    const rec = {
      key: key,
      tf: obj.tf || null,
      time: num(obj.time, 0),
      fetchedAt: num(obj.fetchedAt, 0),
      ageBars: typeof obj.ageBars === 'number' ? obj.ageBars : null,
      providerId: obj.providerId || null,
      isProxy: !!obj.isProxy,
      basis: typeof obj.basis === 'number' ? obj.basis : null,
      volScale: typeof obj.volScale === 'number' ? obj.volScale : null,
      cfgHash: obj.cfgHash || null,
      touch: obj.touch || null,
      signal: obj.signal || null,
      labeled: false,
      outcome: null,
      win: null,
      realizedR: null,
      pnlAtr: null,
      barsToOutcome: null,
    }
    byKey.set(key, rec)
    records.push(rec)
  }
  return { records: records }
}

/** Sinyalin gunluge yazilan ozeti (topMatches gibi agir alanlar yazilmaz). */
function signalOzeti(sig) {
  if (!sig) return null
  return {
    fired: !!sig.fired,
    direction: sig.direction || null,
    kind: sig.kind === 'form' ? 'form' : 'touch',
    winRate: num(sig.winRate, 0),
    matchCount: num(sig.matchCount, 0),
    confidence: num(sig.confidence, 0),
    expectancy: num(sig.expectancy, 0),
    entry: num(sig.entry, 0),
    tp1: num(sig.tp1, 0),
    sl: num(sig.sl, 0),
    rr: num(sig.rr, 0),
    atr: num(sig.atr, 0),
    stale: !!sig.stale,
  }
}

/**
 * Ufku dolmus ve henuz etiketlenmemis kayitlarin sonucunu hesaplar, her biri
 * icin gunluge bir 'outcome' satiri ekler.
 *
 * Etiket `learn/outcome.labelTouch`, kazanc `learn/backtest.tradeResult` ile
 * hesaplanir: canli gunlukteki rakam ile Test sekmesindeki rakam AYNI tanimdan
 * gelmek zorunda, aksi halde ikisi karsilastirilamaz.
 *
 * @param {string} tf
 * @param {object} s Depodaki seri (yalnizca kapanmis barlar)
 * @param {number} tfSec
 * @param {object} outcomeCfg Hafizanin etiketlendigi tanim (planOutcomeCfg)
 * @param {string[]} [logs]
 * @returns {Promise<number>} Yazilan sonuc satiri sayisi
 */
async function liveLogEtiketle(tf, s, tfSec, outcomeCfg, logs, maliyetAyari) {
  if (!s || s.length === 0) return 0
  const okunan = await liveLogOku(tf)
  const records = okunan.records
  if (records.length === 0) return 0

  const seriesMod = core('series')
  const outcomeMod = core('learn/outcome')
  const bt = core('learn/backtest')
  const cfg = Object.assign({}, outcomeMod.DEFAULT_OUTCOME_CFG, outcomeCfg || {})
  const horizon = clampInt(cfg.horizonBars, 1, 100000, outcomeMod.DEFAULT_OUTCOME_CFG.horizonBars)
  const sonBar = s.time[s.length - 1]
  // Maliyet, kullanicinin ayarindan gelir; boylece canli gunluk ile Test
  // sekmesi AYNI maliyetle olculur ve iki rakam karsilastirilabilir kalir.
  const costCfg = {
    costPct: Number.isFinite(maliyetAyari && maliyetAyari.costPct)
      ? maliyetAyari.costPct
      : num(bt.DEFAULT_BACKTEST_CFG.costPct, 0),
    costUsd: Number.isFinite(maliyetAyari && maliyetAyari.costUsd)
      ? maliyetAyari.costUsd
      : num(bt.DEFAULT_BACKTEST_CFG.costUsd, 0),
    slippageAtr: Number.isFinite(maliyetAyari && maliyetAyari.slippageAtr)
      ? maliyetAyari.slippageAtr
      : 0,
  }

  let yazilan = 0
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec.labeled) continue
    const zaman = num(rec.time, 0)
    if (!(zaman > 0)) continue
    // Ufuk henuz dolmadi: sonraki tiklarda yeniden denenir.
    if (zaman + horizon * tfSec > sonBar) continue

    // Olayin GUNCEL seri icindeki bar indeksi. Gunluge yazilan `bar` alani
    // canli kuyruk penceresine aittir, depodaki seride baska bir indekstir.
    const idx = seriesMod.lastIndexAtOrBefore(s, zaman)
    if (idx < 0) continue
    const olay = Object.assign({}, rec.touch || {}, { bar: idx, time: zaman })
    const atr = num(olay.atr, 0)
    if (!(atr > 0)) continue

    let sonuc = null
    try {
      sonuc = outcomeMod.labelTouch(s, olay, atr, cfg)
    } catch (err) {
      sonuc = null
    }
    if (!sonuc) continue

    // Kazanc kurali testle AYNI fonksiyondan gelir, ayri bir kopya yazilmaz.
    let pnlAtr = null
    let win = null
    const sig = rec.signal
    if (sig && Number.isFinite(sig.entry) && Number.isFinite(sig.tp1) && Number.isFinite(sig.sl) &&
      sig.entry !== sig.sl) {
      const islem = bt.tradeResult(Object.assign({}, olay, sonuc), {
        entry: sig.entry, tp1: sig.tp1, sl: sig.sl,
      }, costCfg)
      if (islem && islem.ok) {
        pnlAtr = islem.pnlAtr
        win = !!islem.win
      }
    }

    const eklendi = await liveLogEkle(tf, {
      type: 'outcome',
      key: rec.key,
      outcome: sonuc.outcome,
      win: win,
      realizedR: num(sonuc.realizedR, 0),
      pnlAtr: pnlAtr,
      barsToOutcome: num(sonuc.barsToOutcome, -1),
    }, logs)
    if (eklendi) yazilan++
  }
  return yazilan
}

// ---------------------------------------------------------------------------
// Komutlar
// ---------------------------------------------------------------------------

const handlers = {}

/** Veri ve hafiza durumu. */
/**
 * Veri saglik raporu: ic bosluklar, aylik kapsama, hafta sonu ve sifir
 * hacimli barlar, hacim rejimi kirilmalari. Depoda gecmiste kalici bosluklar
 * oldugu icin (2023-02..07'de yaklasik 479 saat) bu rapor olculebilir olmali.
 * Yuk: {tf, minGapMinutes}
 */
handlers['data:doctor'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const tfSec = core('tf').tfSeconds(tf)
  const s = await getSeries(tf, false)
  if (!s || s.length === 0) {
    return { tf: tf, bars: 0, gaps: [], monthly: [], message: 'Depoda bu zaman dilimi icin veri yok.' }
  }
  const rapor = core('data/doctor').veriDoktoru(s, tfSec, {
    minGapMinutes: num(payload.minGapMinutes, 30),
  })
  return Object.assign({ tf: tf }, rapor)
}

handlers['data:status'] = async function (payload) {
  const tfmod = core('tf')
  const binstore = core('store/binstore')
  let memstore = null
  try {
    memstore = core('store/memstore')
  } catch (err) {
    memstore = null
  }

  // Guncel baglam vektoru uzunlugu: hafizanin eski surumden kalip kalmadigini
  // anlamak icin karsilastirma olcusu.
  let guncelCtxLen = 0
  try {
    guncelCtxLen = core('learn/features').CTX_NAMES.length
  } catch (err) {
    guncelCtxLen = 0
  }

  const list = []
  const byTf = {}
  for (const tf of tfmod.TF_LIST) {
    let st = null
    try {
      st = await binstore.statSeries(paths.candlePath(tf))
    } catch (err) {
      st = null
    }
    let mem = null
    if (memstore) {
      try {
        mem = await memstore.statMemory(paths.memoryPath(tf))
      } catch (err) {
        mem = null
      }
    }
    const row = {
      tf: tf,
      label: tfmod.tfLabel(tf),
      count: st ? st.count : 0,
      firstTime: st ? st.firstTime : null,
      lastTime: st ? st.lastTime : null,
      hasData: !!(st && st.count > 0),
      memoryCount: mem ? mem.count : 0,
      memoryFirstTime: mem ? mem.firstTime : null,
      memoryLastTime: mem ? mem.lastTime : null,
      hasMemory: !!(mem && mem.count > 0),
      memoryCtxLen: mem ? num(mem.ctxLen, 0) : 0,
      memoryBuiltToTime: mem ? num(mem.builtToTime, 0) : 0,
      // Hafiza guncel indikator surumuyle mi uretilmis. false ise arayuz
      // yeniden tarama ister; okumaya kalkarsa zaten hata alir.
      memoryCurrent: !!(mem && mem.count > 0 && num(mem.ctxLen, 0) === guncelCtxLen),
      // Hafiza hangi ayarla kuruldu ve etkin ayarla uyusuyor mu.
      // Uyusmuyorsa canli sinyal uretilmez ve test sonucu eski etiketlere
      // aittir; arayuz yeniden tarama onerir. null: iz bilinmiyor (eski dosya).
      memoryCfgHash: mem && mem.cfgHash ? mem.cfgHash : null,
      memoryCfgMatch: mem && mem.cfgHash
        ? mem.cfgHash === ayarIzi(mem.indicatorParams || null,
          core('learn/presets').resolveCfg(tf, payload && payload.cfgPatch ? payload.cfgPatch : {}, null).outcomeCfg,
          mem.ctxNames)
        : null,
      memoryBuiltAt: mem && mem.builtAt ? mem.builtAt : null,
      memoryBuildCommit: mem && mem.buildCommit ? mem.buildCommit : null,
      hasZones: await fileExists(paths.zonesPath(tf)),
      hasPrototypes: await fileExists(paths.protosPath(tf)),
      hasSignals: await fileExists(paths.signalsPath(tf)),
      hasBacktest: await fileExists(paths.backtestPath(tf)),
    }
    list.push(row)
    byTf[tf] = row
  }
  return { dataDir: paths.dataDir(), tfs: list, byTf: byTf }
}

/** Grafik icin mum listesi. */
handlers['data:candles'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const seriesMod = core('series')
  const s = await getSeries(tf, false)
  if (!s || s.length === 0) {
    return { tf: tf, bars: [], total: 0, firstTime: null, lastTime: null }
  }

  let a = 0
  let b = s.length
  if (num(payload.from, 0) > 0) {
    const i = seriesMod.firstIndexAtOrAfter(s, payload.from)
    a = i < 0 ? s.length : i
  }
  if (num(payload.to, 0) > 0) {
    const j = seriesMod.lastIndexAtOrBefore(s, payload.to)
    b = j < 0 ? 0 : j + 1
  }
  if (b < a) b = a

  const limit = clampInt(payload.limit, 1, 200000, 3000)
  if (b - a > limit) a = b - limit

  return {
    tf: tf,
    bars: seriesMod.toBars(s, a, b),
    total: s.length,
    firstTime: s.time[0],
    lastTime: s.time[s.length - 1],
  }
}

/** Saglayicidan gecmis indirip depoya ekler. */
/**
 * Turetilen zaman dilimleri: 1m guncellendikten sonra yeniden uretilir.
 * Liste core/tf.js icinde tutulur, aktarim betigi de ayni listeyi kullanir.
 */
const { TURETILEN_TF } = core('tf')

handlers['data:sync'] = async function (payload, ctx) {
  const tf = requireTf(payload.tf)
  const loader = core('data/loader')
  const binstore = core('store/binstore')
  const seriesMod = core('series')
  const { tfSeconds } = core('tf')

  // Guncelleme her zaman TABAN seri (1m) uzerinden yapilir, sonra ust zaman
  // dilimleri ondan yeniden uretilir. Yalnizca secili dilimi guncellemek
  // digerlerini geride birakir ve ayni sembolun zaman dilimleri birbirini
  // tutmaz hale gelir.
  let baseStat = null
  try {
    baseStat = await binstore.statSeries(paths.candlePath('1m'))
  } catch (err) {
    baseStat = null
  }
  const tabanVar = !!(baseStat && baseStat.count > 0)
  const hedefTf = tabanVar ? '1m' : tf

  // Fiyat kaydirmasi hesabi icin depodaki seri gerekir; onbellekte varsa
  // 290 MB'lik dosyayi yeniden okumayiz.
  const onbellek = seriesCache.tf === hedefTf && seriesCache.series ? seriesCache.series : null

  const res = await loader.syncHistory({
    dataDir: paths.dataDir(),
    tf: hedefTf,
    providerId: payload.providerId,
    apiKey: payload.apiKey || '',
    // `from` YALNIZCA acikca verilirse gecer. Onceden 0 gonderiliyordu ve
    // syncHistory bunu "1970'ten depo basina kadar indir" diye anliyordu:
    // tek tiklamada 471 bos HistData istegi olculdu.
    from: Number.isFinite(payload.from) ? Math.floor(payload.from) : undefined,
    to: Number.isFinite(payload.to) ? Math.floor(payload.to) : undefined,
    storedSeries: onbellek,
    onProgress: (pct, msg) => ctx.progress(num(pct, 0) * 0.75, msg),
  })

  // Taban degistiyse ust zaman dilimlerini yeniden uret.
  const uretilen = []
  if (hedefTf === '1m' && res && res.added > 0) {
    const taban = await binstore.readSeries(paths.candlePath('1m'))
    if (taban && taban.length > 0) {
      for (let i = 0; i < TURETILEN_TF.length; i++) {
        const ust = TURETILEN_TF[i]
        ctx.progress(75 + (i / TURETILEN_TF.length) * 24, ust + ' yeniden uretiliyor')
        const s = seriesMod.resample(taban, tfSeconds(ust))
        await binstore.writeSeries(paths.candlePath(ust), s)
        uretilen.push({ tf: ust, count: s.length })
      }
    }
  }

  clearCache(null)
  ctx.progress(100, 'Veri guncellendi')
  return Object.assign({ added: 0 }, res, { syncedTf: hedefTf, derived: uretilen })
}

/**
 * Disaridan mum dosyasi alir. Desteklenen bicimler:
 *  - ZMEM ikili dosyasi (binstore)
 *  - CSV: time,open,high,low,close,volume (baslik satiri isteğe bagli)
 */
handlers['data:import'] = async function (payload, ctx) {
  const tf = requireTf(payload.tf)
  const file = String(payload.filePath || '')
  if (!file) throw new Error('Iceri aktarilacak dosya yolu verilmedi.')
  if (!(await fileExists(file))) throw new Error('Dosya bulunamadi: ' + file)

  const binstore = core('store/binstore')
  const seriesMod = core('series')
  let incoming = null

  if (file.toLowerCase().endsWith('.bin')) {
    incoming = await binstore.readSeries(file)
    if (!incoming) throw new Error('Ikili dosya okunamadi: ' + file)
  } else {
    ctx.progress(5, 'CSV okunuyor')
    const text = await fsp.readFile(file, 'utf8')
    const lines = text.split('\n')
    const cols = { time: [], open: [], high: [], low: [], close: [], volume: [] }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const p = line.split(',')
      if (p.length < 5) continue
      let t = Number(p[0])
      if (!isFinite(t)) {
        const parsed = Date.parse(p[0])
        if (!isFinite(parsed)) continue
        t = Math.floor(parsed / 1000)
      }
      if (t > 1e11) t = Math.floor(t / 1000) // milisaniye geldiyse saniyeye cevir
      const o = Number(p[1]); const h = Number(p[2]); const l = Number(p[3]); const c = Number(p[4])
      if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue
      cols.time.push(t)
      cols.open.push(o)
      cols.high.push(h)
      cols.low.push(l)
      cols.close.push(c)
      cols.volume.push(p.length > 5 ? num(Number(p[5]), 0) : 0)
      if ((i & 65535) === 0) ctx.progress(5 + 60 * (i / lines.length), 'CSV ayristiriliyor')
    }
    incoming = seriesMod.fromArrays(cols)
  }

  ctx.progress(75, 'Depoya yaziliyor')
  const res = await binstore.appendSeries(paths.candlePath(tf), incoming)
  clearCache(tf)
  if (tf === '1m') clearCache(null)
  ctx.progress(100, 'Tamamlandi')
  return { tf: tf, added: res ? res.added : 0, total: res ? res.total : 0 }
}

/** Gecmisi tarar, hafizayi, bolgeleri ve prototipleri diske yazar. */
handlers['engine:scan'] = async function (payload, ctx) {
  const tf = requireTf(payload.tf)
  const force = !!payload.force
  ctx.progress(0, 'Mumlar okunuyor')
  const s = await getSeries(tf, force)
  if (!s || s.length < 200) {
    throw new Error('Tarama icin yeterli mum yok (' + (s ? s.length : 0) + ' bar). Once veri indirin.')
  }

  const memoryMod = core('learn/memory')
  const memstore = core('store/memstore')

  // Tarama, test ve canli AYNI birlestirmeyi kullanir: cekirdek varsayilani,
  // zaman dilimine ait hazir ayar, sonra kullanicinin yamasi
  // (bkz. core/learn/presets.js resolveCfg).
  const uygulanan = core('learn/presets').resolveCfg(tf, payload.cfgPatch || cfgPatchGeriUyum(payload), null)
  const params = Object.assign({}, payload.params || {})

  ctx.progress(2, 'Indikator calisiyor')
  const built = memoryMod.buildMemory(
    s,
    { tf: tf, params: params, outcomeCfg: uygulanan.outcomeCfg },
    (pct, msg) => ctx.progress(2 + num(pct, 0) * 0.78, msg)
  )

  const events = built.events || []
  const zones = built.zones || []
  // Ayar izi: hem hafiza meta'sina yazilir hem eski olcumlerin gecerli olup
  // olmadigini belirler (tek yerde hesaplanir).
  const yeniIz = ayarIzi(params, uygulanan.outcomeCfg, built.ctxNames)

  ctx.progress(82, 'Hafiza diske yaziliyor')
  await memstore.saveMemory(paths.memoryPath(tf), {
    tf: tf,
    ctxNames: built.ctxNames,
    events: events,
    // Hangi bara kadar taradigimiz. Arayuz bunu deponun son bariyla
    // karsilastirip hafizanin geride kalip kalmadigini anlar.
    builtToTime: s.length > 0 ? s.time[s.length - 1] : 0,
    // Bu hafizayi ureten kod. Indikator degistikce eski hafizalar anlamini
    // yitiriyor, damga olmadan hangisinin hangi kodla kuruldugu bilinmiyordu.
    buildCommit: buildDamgasi().buildCommit,
    buildSrcHash: buildDamgasi().buildSrcHash,
    // AYAR IZI: hangi indikator ayari ve hangi etiket tanimiyla kuruldu.
    // Canli ve test bunu etkin ayarla karsilastirir; uyusmazsa uyarir.
    indicatorParams: params,
    outcomeCfg: uygulanan.outcomeCfg,
    featureVersion: core('learn/features').FEATURE_VERSION,
    cfgHash: yeniIz,
  })

  ctx.progress(88, 'Bolgeler kaydediliyor')
  await writeJsonAtomic(paths.zonesPath(tf), zones)

  ctx.progress(91, 'Prototipler cikariliyor')
  let protos = []
  try {
    protos = core('learn/cluster').buildPrototypes({ events: events }, {}) || []
  } catch (err) {
    protos = []
    log('Prototipler hesaplanamadi: ' + (err && err.message ? err.message : String(err)))
  }
  await writeJsonAtomic(paths.protosPath(tf), protosToJson(protos))

  // Onbellekleri tazele, eski sinyaller artik gecersiz.
  // Onbellege ayar izi de konur; aksi halde taramadan hemen sonra yapilan
  // test ve canli kontrol "iz bilinmiyor" sayip uyumu dogrulayamiyordu.
  memoryCache = {
    tf: tf,
    memory: {
      tf: tf,
      ctxNames: built.ctxNames,
      events: events,
      meta: {
        builtToTime: s.length > 0 ? s.time[s.length - 1] : 0,
        cfgHash: yeniIz,
        indicatorParams: params,
        outcomeCfg: uygulanan.outcomeCfg,
        featureVersion: core('learn/features').FEATURE_VERSION,
        builtAt: new Date().toISOString(),
        buildCommit: buildDamgasi().buildCommit,
        buildSrcHash: buildDamgasi().buildSrcHash,
      },
    },
  }
  zonesCache = { tf: tf, zones: zones }
  protoCache = { tf: tf, protos: protos }
  // Hafiza degisti: aday onbellegi artik gecersiz.
  try {
    await fsp.unlink(paths.candCachePath(tf))
  } catch (err) {
    // Onbellek yoksa sorun degil.
  }

  // Test sinyalleri ve son test ozeti YALNIZCA ayar izi degistiyse silinir.
  // Onceden her taramada siliniyordu: canli akis depoya bar ekledikce
  // otomatik tarama basliyor ve kullanicinin olcumu sessizce kayboluyordu.
  const sonTest = await readJson(paths.backtestPath(tf))
  const eskiIz = sonTest && sonTest.cfgHash ? String(sonTest.cfgHash) : null
  if (eskiIz && eskiIz !== yeniIz) {
    signalCache = { tf: tf, signals: [] }
    for (const dosya of [paths.signalsPath(tf), paths.backtestPath(tf)]) {
      try {
        await fsp.unlink(dosya)
      } catch (err) {
        // Dosya yoksa sorun degil.
      }
    }
    log('Ayarlar degistigi icin eski test sinyalleri ve ozeti silindi.')
  } else {
    signalCache = { tf: null, signals: null }
  }

  ctx.progress(97, 'Ozet hazirlaniyor')
  let summary = null
  try {
    summary = memoryMod.summarize({ tf: tf, ctxNames: built.ctxNames, events: events })
  } catch (err) {
    summary = null
  }

  ctx.progress(100, 'Tarama tamamlandi')
  return {
    tf: tf,
    bars: s.length,
    firstTime: s.time[0],
    lastTime: s.time[s.length - 1],
    events: events.length,
    zones: zones.length,
    prototypes: protos.length,
    stats: built.stats || null,
    summary: summary,
  }
}

/** Zaman araligina dusen bolgeler (en fazla 2000, fazlaysa en yeniler). */
handlers['engine:zones'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const zones = await getZones(tf, false)
  const from = num(payload.from, 0)
  const to = num(payload.to, MAX_TIME)

  const out = []
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i]
    const zStart = num(z.createdTime, 0)
    const zEnd = num(z.endTime, zStart)
    if (zEnd < from || zStart > to) continue
    out.push(z)
  }
  const total = out.length
  const capped = total > 2000 ? out.slice(total - 2000) : out
  return { tf: tf, zones: capped, total: total, truncated: total > capped.length }
}

/** Hafiza olaylarinin hafif ozeti (features haric). */
handlers['engine:touches'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const mem = await getMemory(tf, false)
  if (!mem || !mem.events) return { tf: tf, touches: [], total: 0, truncated: false }

  const from = num(payload.from, 0)
  const to = num(payload.to, MAX_TIME)
  const limit = clampInt(payload.limit, 1, 20000, 5000)

  const evs = mem.events
  const picked = []
  for (let i = 0; i < evs.length; i++) {
    const t = num(evs[i].time, 0)
    if (t < from || t > to) continue
    picked.push(evs[i])
  }
  const total = picked.length
  const slice = total > limit ? picked.slice(total - limit) : picked
  return {
    tf: tf,
    touches: slice.map(lightEvent),
    total: total,
    truncated: total > slice.length,
  }
}

/** Gecmis icin uretilmis sinyaller (geriye testte olusur). */
handlers['engine:signals'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const all = await getSignals(tf, false)
  const from = num(payload.from, 0)
  const to = num(payload.to, MAX_TIME)
  const limit = clampInt(payload.limit, 1, 20000, 2000)

  const picked = []
  for (let i = 0; i < all.length; i++) {
    const t = num(all[i].time, 0)
    if (t < from || t > to) continue
    picked.push(all[i])
  }
  const total = picked.length
  const slice = total > limit ? picked.slice(total - limit) : picked
  return { tf: tf, signals: slice, total: total, truncated: total > slice.length }
}

/** Yuruyen ileri test. Uretilen sinyalleri diske yazar. */
handlers['engine:backtest'] = async function (payload, ctx) {
  const tf = requireTf(payload.tf)

  // YUK BICIMI: esikler ve isinma `payload.cfg` icinde gelir. Bir donem
  // renderer bunlari UST DUZEYDE gonderiyordu, isci ise payload.cfg okuyordu:
  // Test sekmesi kullanicinin esiklerini degil hazir ayari olcuyor ve bu
  // hicbir yerde gorunmuyordu. Yanlis bicim artik sessizce yok sayilmaz.
  if (!payload.cfg && (payload.signalCfg || payload.outcomeCfg || payload.warmupEvents !== undefined)) {
    throw new Error(
      'engine:backtest yuk bicimi degisti: esikler ve isinma ' +
      '{ cfg: { warmupEvents, cfgPatch } } icinde gonderilmeli.'
    )
  }

  const mem = await requireMemory(tf, false)
  const protos = await getProtos(tf, false)
  const bt = core('learn/backtest')

  // Tarama, test ve canli AYNI birlestirmeyi kullanir. Plan geometrisi
  // hafizanin etiketlendigi outcomeCfg'den gelir: "bolge tuttu" ile "TP1
  // vuruldu" ayni olay olmak zorunda.
  const gelen = payload.cfg || {}
  const memMeta = mem.meta || null
  const uygulanan = core('learn/presets').resolveCfg(tf, gelen.cfgPatch || cfgPatchGeriUyum(gelen), memMeta)
  // Maliyet ve isinma ayari kullanicinin backtestCfg yamasindan gelir; tek
  // kaynak budur (Ayarlar > Islem maliyeti ve olcum).
  const bcfg = (gelen.cfgPatch && gelen.cfgPatch.backtestCfg) || {}
  const cfg = Object.assign({}, gelen, {
    signalCfg: uygulanan.signalCfg,
    outcomeCfg: uygulanan.planOutcomeCfg,
  })
  if (Number.isFinite(bcfg.costPct)) cfg.costPct = bcfg.costPct
  if (Number.isFinite(bcfg.costUsd)) cfg.costUsd = bcfg.costUsd
  if (Number.isFinite(bcfg.slippageAtr)) cfg.slippageAtr = bcfg.slippageAtr
  if (Number.isFinite(bcfg.warmupPerBucket)) cfg.warmupPerBucket = bcfg.warmupPerBucket
  delete cfg.cfgPatch

  // Etkin ayar ile hafizanin izi uyusuyor mu? Uyusmuyorsa olcum eski
  // etiketlerle yeni esikleri karistirir; uyari ozete yazilir.
  const hafizaIz = memMeta && memMeta.cfgHash ? memMeta.cfgHash : null
  // Etkin iz, KULLANICININ cozulmus ayarindan hesaplanir (plan hafizadan
  // gelse bile). Boylece "ayari degistirdim ama yeniden taramadim" durumu
  // gorunur hale gelir. Indikator ayari test yukunde gelmez, hafizadaki
  // kullanilir; indikator degisikligi taramada zaten yeni iz uretir.
  const etkinIz = ayarIzi(
    memMeta && memMeta.indicatorParams ? memMeta.indicatorParams : null,
    uygulanan.outcomeCfg,
    mem.ctxNames
  )
  const izUyum = hafizaIz ? hafizaIz === etkinIz : null

  // ADAY ONBELLEGI: komsular esikten bagimsizdir, bir kez hesaplanip diske
  // yazilir. Ikinci kosudan itibaren test saniyeler icinde biter (olculdu:
  // 1m hafizada 168 sn yerine yaklasik 1,7 sn).
  const candcache = core('learn/candcache')
  const onbellekYolu = paths.candCachePath(tf)
  const anahtar = candcache.cacheKey(mem, cfg)
  let cache = null
  try {
    const ham = await fsp.readFile(onbellekYolu)
    const cozulen = candcache.deserialize(ham)
    if (cozulen && cozulen.key === anahtar) cache = cozulen
  } catch (err) {
    cache = null
  }
  if (!cache) {
    ctx.progress(1, 'Komsular hesaplaniyor (ilk kosu)')
    cache = candcache.buildCandidates(mem, cfg, (pct, msg) => ctx.progress(num(pct, 0) * 0.6, msg))
    try {
      const tmp = onbellekYolu + '.tmp'
      await fsp.writeFile(tmp, candcache.serialize(cache))
      await fsp.rename(tmp, onbellekYolu)
    } catch (err) {
      log('Aday onbellegi yazilamadi: ' + (err && err.message ? err.message : String(err)))
    }
  }

  ctx.progress(62, 'Geriye test basliyor')
  const res = bt.runBacktestFromCache(mem, cache, protos, cfg,
    (pct, msg) => ctx.progress(62 + num(pct, 0) * 0.3, msg))

  const trades = res && Array.isArray(res.trades) ? res.trades : []
  ctx.progress(94, 'Sinyaller kaydediliyor')
  const signals = tradesToSignals(trades, mem)
  await writeJsonAtomic(paths.signalsPath(tf), signals)
  signalCache = { tf: tf, signals: signals }

  const tradeLimit = clampInt(payload.tradeLimit, 100, 20000, 3000)
  const shownTrades = trades.length > tradeLimit ? trades.slice(trades.length - tradeLimit) : trades

  // Ozete testi ureten kodun damgasi eklenir: README'deki eski olcumlerin
  // hangi indikatorle alindigi bilinmedigi icin yanlis karara goturuyordu.
  const damga = buildDamgasi()
  const ozet = res && res.summary
    ? Object.assign({}, res.summary, {
      buildCommit: damga.buildCommit,
      buildSrcHash: damga.buildSrcHash,
    })
    : null

  // Olcum diske yazilir: "hangi ayarla ne olculdu" bilgisi uygulama kapaninca
  // kaybolmasin ve otomatik tarama gereksiz yere silmesin (bkz. engine:scan).
  const kanit = kanitDurumu(ozet)
  const kullanilanAyar = {
    signalCfg: uygulanan.signalCfg,
    outcomeCfg: uygulanan.planOutcomeCfg,
    warmupEvents: num(cfg.warmupEvents, null),
    sources: uygulanan.sources,
  }
  const hafizaOzeti = memMeta ? {
    builtToTime: memMeta.builtToTime || 0,
    builtAt: memMeta.builtAt || null,
    cfgHash: hafizaIz,
    buildCommit: memMeta.buildCommit || null,
  } : null
  try {
    await writeJsonAtomic(paths.backtestPath(tf), {
      tf: tf,
      zaman: new Date().toISOString(),
      cfgHash: hafizaIz || etkinIz,
      usedCfg: kullanilanAyar,
      memory: hafizaOzeti,
      cfgMatch: izUyum,
      // Tur basina kanit durumu: canli sinyal karti bunu rozet olarak
      // gosterir ve kanitlanmamis turleri one cikarmaz.
      evidence: kanit,
      summary: ozet,
      byYear: res && Array.isArray(res.byYear) ? res.byYear : [],
      equity: thinCurve(res ? res.equity : [], 3000),
      buildCommit: damga.buildCommit,
      buildSrcHash: damga.buildSrcHash,
    })
  } catch (err) {
    log('Test ozeti diske yazilamadi: ' + (err && err.message ? err.message : String(err)))
  }

  ctx.progress(100, 'Test tamamlandi')
  return {
    tf: tf,
    usedCfg: kullanilanAyar,
    memory: hafizaOzeti,
    cfgMatch: izUyum,
    evidence: kanit,
    summary: ozet,
    byYear: res && Array.isArray(res.byYear) ? res.byYear : [],
    equity: thinCurve(res ? res.equity : [], 3000),
    trades: shownTrades,
    tradeCount: trades.length,
    signalCount: signals.length,
  }
}

/**
 * Diske yazilmis son test ozetini dondurur. Arayuz zaman dilimi yuklenirken
 * bunu okur; boylece olcum uygulama kapandiktan sonra da elde kalir.
 */
handlers['engine:backtest-last'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const kayit = await readJson(paths.backtestPath(tf))
  if (!kayit) return { tf: tf, found: false }
  // Hafizanin izi degistiyse bu ozet artik gecerli degil.
  const mem = await getMemory(tf, false)
  const hafizaIz = mem && mem.meta && mem.meta.cfgHash ? mem.meta.cfgHash : null
  const gecerli = !hafizaIz || !kayit.cfgHash ? null : hafizaIz === kayit.cfgHash
  return Object.assign({ tf: tf, found: true, stillValid: gecerli }, kayit)
}

/** Kayitli prototipler. */
handlers['engine:prototypes'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const protos = await getProtos(tf, false)
  return { tf: tf, prototypes: protosToJson(protos), count: protos.length }
}

/** Hafiza ozeti. */
handlers['engine:memory-summary'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const mem = await getMemory(tf, false)
  if (!mem || !mem.events || mem.events.length === 0) {
    return { tf: tf, summary: null, count: 0 }
  }
  const summary = core('learn/memory').summarize(mem)
  return { tf: tf, summary: summary, count: mem.events.length }
}

/** Onbellekleri bosaltir. */
handlers['engine:clear-cache'] = async function (payload) {
  clearCache(payload && payload.tf ? payload.tf : null)
  return { ok: true }
}

/**
 * Bir zaman diliminin hafizasini diskten siler ve onbellegi bosaltir.
 * Parametre degisikliginden sonra hafiza gecersiz kaldigi icin arayuzdeki
 * "Hafizayi Sil" dugmesi bunu cagirir; ardindan yeniden tarama gerekir.
 */
handlers['engine:memory-delete'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const memstore = core('store/memstore')
  const taban = paths.memoryPath(tf)
  const silindi = await memstore.deleteMemory(taban)

  // Tarama sirasinda yazilan yan dosyalar da temizlenir.
  const fs = require('node:fs/promises')
  for (const ek of ['.zones.json', '.protos.json', '.signals.json']) {
    try {
      await fs.unlink(taban + ek)
    } catch (err) {
      // Dosya yoksa sorun degil.
    }
  }
  clearCache(tf)
  return { tf: tf, deleted: silindi === true || silindi === undefined }
}

/**
 * Canli dongunun tek adimi. live.js saglayicidan cektigi barlari buraya
 * yollar; fiyat kaydirmasi, depoya ekleme, indikator kontrolu ve sinyal
 * uretimi burada yapilir (buyuk seri ana iplige asla kopyalanmaz).
 *
 * Yuk: {tf, series, isProxy, providerId, basis, volScale, basisWarned,
 *       fetchedAt, sinceTime, seenKeys, params, cfgPatch, tailBars}
 * `seenKeys`: daha once degerlendirilmis olay anahtarlari (bkz.
 * core/learn/liveEvents.js). Donen `events` dizisi bu tikte yeni olan TUM
 * olaylari tasir; tekil `signal` / `touch` alanlari geriye uyum icin dizinin
 * sonuncusuyla doldurulur. Her olay canli sinyal gunlugune de yazilir.
 */
handlers['engine:live-tick'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const seriesMod = core('series')
  const binstore = core('store/binstore')
  const tfSec = core('tf').tfSeconds(tf)
  const logs = []

  let inc = toSeries(payload.series)
  if (!inc || inc.length === 0) {
    return {
      tf: tf, added: 0, basis: payload.basis === undefined ? null : payload.basis,
      lastBar: null, events: [], labeled: 0, signal: null, touch: null,
      logs: ['Saglayicidan mum gelmedi.'],
    }
  }
  inc = seriesMod.sanitize(inc)

  // VEKIL KAYNAK DUZELTMESI
  // Fiyat kaydirmasi (basis), hacim olcegi ve piyasa saati suzgeci tek
  // fonksiyonda uygulanir (loader.normalizeProxy). Onceden bunlar ayri ayri
  // yapiliyordu ve hicbiri hesaplanamadiginda HAM barlar depoya yaziliyordu:
  // gercek depoda 1m'ye 1613 ham PAXG bari girdi (hacim ~226 kat kucuk,
  // 160'i piyasanin kapali oldugu saatte). Ham bar bir kez girince basis 0
  // cikip duzeltme kalici olarak kapaniyor. Artik duzeltme hesaplanamazsa
  // HICBIR SEY yazilmaz ve senkron istenir.
  let basis = typeof payload.basis === 'number' && isFinite(payload.basis) ? payload.basis : null
  let basisComputed = false
  let basisWarned = !!payload.basisWarned
  let volScale = typeof payload.volScale === 'number' && isFinite(payload.volScale) && payload.volScale > 0
    ? payload.volScale
    : null
  let needsSync = false
  // Hafiza ile etkin ayar uyusmuyor: canli sinyal uretilmez, arayuz uyarir.
  let cfgMismatch = false

  if (payload.isProxy) {
    const loader = core('data/loader')
    if (basis === null || volScale === null) {
      // Bilinmeyen varsa ikisini birlikte yeniden hesaplariz.
      try {
        const stored = await getSeries(tf, false)
        const duzeltme = loader.normalizeProxy(stored, inc)
        if (duzeltme.ok) {
          basis = duzeltme.basis
          volScale = duzeltme.volScale
          basisComputed = true
          inc = duzeltme.series
        } else {
          needsSync = true
          if (!basisWarned) {
            basisWarned = true
            logs.push('Vekil kaynak duzeltilemedi (' + duzeltme.reason + '), bar yazilmadi. Veri Cek ile bosluk kapatilmali.')
          }
        }
      } catch (err) {
        needsSync = true
        logs.push('Vekil duzeltme hesaplanamadi: ' + (err && err.message ? err.message : String(err)))
      }
    } else {
      // Onceki turdan bilinen katsayilar: ayni sirayla uygulanir.
      inc = loader.applyBasis(inc, basis)
      if (volScale !== 1) {
        for (let i = 0; i < inc.length; i++) inc.volume[i] *= volScale
      }
      inc = loader.piyasaSaatleriyleSuz(inc)
    }
  }

  if (!inc || inc.length === 0) {
    return {
      tf: tf, added: 0, basis: basis, volScale: volScale, basisWarned: basisWarned,
      needsSync: needsSync, lastBar: null, events: [], labeled: 0,
      signal: null, touch: null,
      logs: logs.length ? logs : ['Duzeltmeden sonra yazilacak bar kalmadi.'],
    }
  }

  const lastBars = seriesMod.toBars(inc, inc.length - 1, inc.length)
  const lastBar = lastBars.length > 0 ? lastBars[0] : null

  // Kapanmis barlari ayikla (acik bar depoya yazilmaz). Olcut, isciye mesajin
  // ISLENDIGI an degil, saglayiciya istegin GONDERILDIGI andir: isci uzun bir
  // testle mesgulken (1m testi 53-60 sn) cekim aninda acik olan bar aksi
  // halde kapanmis sayilip yarim OHLCV ile kalici yaziliyordu.
  const fetchedAt = num(payload.fetchedAt, Math.floor(Date.now() / 1000))
  const closedEnd = seriesMod.closedEndIndex(inc.time, tfSec, fetchedAt, inc.length)

  let added = 0
  let stored = false
  if (closedEnd > 0) {
    // Bu zaman diliminin kendi dosyasi varsa oraya yazariz. Yoksa ve seri 1m
    // deposundan yeniden ornekleniyorsa dosya ACMAYIZ: bir kac barlik yeni
    // dosya, yukleyicide 1m'den turetilen tam seriyi golgeler. O durumda bar
    // yalnizca bellekteki seriye eklenir.
    let tfStat = null
    try {
      tfStat = await binstore.statSeries(paths.candlePath(tf))
    } catch (err) {
      tfStat = null
    }
    const hasTfStore = !!(tfStat && tfStat.count > 0)
    let baseHasData = false
    if (!hasTfStore && tf !== '1m') {
      try {
        const baseStat = await binstore.statSeries(paths.candlePath('1m'))
        baseHasData = !!(baseStat && baseStat.count > 0)
      } catch (err) {
        baseHasData = false
      }
    }
    const canStore = hasTfStore || !baseHasData

    const lastStored = hasTfStore ? num(tfStat.lastTime, -1) : -1
    const cached = seriesCache.tf === tf && seriesCache.series ? seriesCache.series : null
    const lastCached = cached && cached.length > 0 ? cached.time[cached.length - 1] : -1
    const lastKnown = Math.max(lastStored, lastCached)

    let startIdx = 0
    while (startIdx < closedEnd && inc.time[startIdx] <= lastKnown) startIdx++

    // BOSLUK DENETIMI: iki cekim arasinda piyasanin ACIK oldugu barlar
    // kacirildiysa bar eklemeyiz. Eksik barla devam etmek seride kalici bir
    // delik birakir; pivot, ATR ve hacim ortalamalari o delikten sonra
    // gecmisle tutarsiz hesaplanir. Bunun yerine senkron istenir.
    if (startIdx < closedEnd && lastKnown > 0 && inc.time[startIdx] - lastKnown > tfSec) {
      const piyasaAcikMi = core('session').createMarketCalendar()
      let acikBosluk = 0
      for (let t = lastKnown + tfSec; t < inc.time[startIdx]; t += tfSec) {
        if (piyasaAcikMi(t)) acikBosluk++
        if (acikBosluk > 0) break
      }
      if (acikBosluk > 0) {
        needsSync = true
        logs.push('Canli akista bosluk var (' + new Date(lastKnown * 1000).toISOString() +
          ' sonrasi), bar eklenmedi. Eksik donem Veri Cek ile kapatilmali.')
        startIdx = closedEnd
      }
    }

    if (startIdx < closedEnd) {
      const fresh = seriesMod.sliceSeries(inc, startIdx, closedEnd)
      if (canStore) {
        const res = await binstore.appendSeries(paths.candlePath(tf), fresh)
        added = num(res && res.added, 0)
        stored = true
      } else {
        // Ayri dosya yoksa bar yalnizca bellekteki seriye eklenir; bu barlar
        // "eklendi" sayilmaz ki sonraki turda yeniden denensin.
        added = fresh.length
        if (!liveStoreWarned) {
          liveStoreWarned = true
          logs.push('Canli barlar bellekte tutuluyor: ' + tf + ' serisi 1m deposundan turetiliyor, ayri dosya acilmadi.')
        }
      }
      if (cached) {
        seriesCache.series = seriesMod.sanitize(seriesMod.concatSeries(cached, fresh))
      }
    }
  }

  // Yeni kapanmis bar olustuysa son pencerede indikatoru kostur.
  //
  // KILITLENEN HATA: onceden yalnizca SON olay aliniyordu. Ayni barda iki
  // bolge olayi olustugunda (bir kutu dogarken baska bir kutuya dokunulmasi
  // gibi) digerleri kalici olarak kayboluyordu, cunku `sinceTime` sonuncunun
  // zamanina cekiliyordu. Artik `learn/liveEvents.selectNewEvents` yeni olan
  // TUM olaylari verir ve hepsi ayni hafiza ve ayarla degerlendirilir.
  let signal = null
  let touch = null
  let lastTouchTime = null
  const events = []
  let labeled = 0
  if (added > 0) {
    try {
      const s = await getSeries(tf, false)
      const tail = clampInt(payload.tailBars, 500, 50000, DEFAULT_TAIL_BARS)
      const start = Math.max(0, s.length - tail)
      const sub = seriesMod.sliceSeries(s, start, s.length)
      const ind = core('indicator/proZones').runIndicator(sub, payload.params || {}, tfSec)
      const touches = ind && Array.isArray(ind.touches) ? ind.touches : []
      const since = num(payload.sinceTime, 0)
      if (touches.length > 0) lastTouchTime = num(touches[touches.length - 1].time, 0)

      const liveEvents = core('learn/liveEvents')
      const adaylar = liveEvents.selectNewEvents(touches, since, payload.seenKeys)

      // Hafiza, ayar ve prototipler TEK KEZ yuklenir; butun adaylar ayni
      // ayarla olculur.
      const mem = await getMemory(tf, false)
      const memMeta = mem && mem.meta ? mem.meta : null
      // Son olcumun kanit durumu (varsa). Dosya yoksa veya izi farkliysa
      // kanit yok sayilir.
      let sonKanit = null
      try {
        const sonTest = await readJson(paths.backtestPath(tf))
        if (sonTest && sonTest.evidence &&
          (!memMeta || !memMeta.cfgHash || !sonTest.cfgHash || sonTest.cfgHash === memMeta.cfgHash)) {
          sonKanit = sonTest.evidence
        }
      } catch (err) {
        sonKanit = null
      }
      // Canli de tarama ve test ile AYNI birlestirmeyi kullanir; plan
      // hedefi hafizanin etiketlendigi outcomeCfg'den gelir.
      const canliCfg = core('learn/presets').resolveCfg(
        tf,
        payload.cfgPatch || cfgPatchGeriUyum(payload),
        memMeta
      )
      const hafizaVar = !!(mem && mem.events && mem.events.length > 0)
      // Hafiza farkli bir ayarla kurulduysa karsilastirma anlamsizdir: yeni
      // tanimla uretilen olay, eski tanimla etiketlenmis gecmisle olculur ve
      // bu hicbir yerde gorunmezdi.
      const izUyum = memMeta && memMeta.cfgHash
        ? memMeta.cfgHash === ayarIzi(
          payload.params || memMeta.indicatorParams || null,
          canliCfg.outcomeCfg,
          mem.ctxNames
        )
        : null

      if (adaylar.length > 0) {
        if (!hafizaVar) {
          logs.push('Yeni bolge olayi bulundu ama hafiza bos. Once "Geçmişi Tara" calistirin.')
        } else if (izUyum === false) {
          cfgMismatch = true
          logs.push('Hafiza farkli bir ayarla kuruldu, sinyal uretilmedi. "Geçmişi Tara" calistirin.')
        }
      }
      const uretilebilir = hafizaVar && izUyum !== false
      const protos = uretilebilir && adaylar.length > 0 ? await getProtos(tf, false) : []
      let ozellikYok = 0

      for (let i = 0; i < adaylar.length; i++) {
        const cand = adaylar[i]
        const hafif = lightEvent(cand)
        let sig = null
        if (uretilebilir) {
          const feats = core('learn/features').buildFeatures(sub, cand, ind.context)
          if (!feats) {
            ozellikYok++
          } else {
            sig = core('learn/signal').evaluateTouch(
              cand, feats, mem, protos, canliCfg.signalCfg, num(cand.time, fetchedAt)
            )
            if (sig && basis !== null && basis !== 0 && Array.isArray(sig.reasons)) {
              sig.reasons.push('Vekil kaynak fiyati ' + basis.toFixed(2) + ' birim kaydirildi.')
            }
          }
        }
        // GECIKME: olay barinin kapanisindan degerlendirme anina kadar kac bar
        // gectigi. 1'den buyukse fiyat coktan kacmis olabilir; sinyal yine
        // yayinlanir ama gecikmeli oldugu isaretlenir.
        const ageBars = (fetchedAt - (num(cand.time, 0) + tfSec)) / tfSec
        if (sig && ageBars > 1) {
          sig.stale = true
          if (!Array.isArray(sig.reasons)) sig.reasons = []
          sig.reasons.push('Gecikmeli degerlendirildi (' + ageBars.toFixed(1) + ' bar sonra).')
        }
        // KANIT DURUMU: son olcumde bu TURUN katma degeri kanitlandi mi.
        // Olcum yoksa veya ayar izi degistiyse "kanitlanmadi" kabul edilir.
        if (sig) {
          const kanit = sonKanit && sonKanit[sig.kind === 'form' ? 'form' : 'touch']
          sig.evidence = kanit || { n: 0, netR: null, netRLo: null, netRHi: null, liftPts: null, status: 'kanitlanmadi' }
          if (sig.evidence.status !== 'kanitli') {
            if (!Array.isArray(sig.reasons)) sig.reasons = []
            sig.reasons.push(sig.evidence.status === 'zayif'
              ? 'Bu sinyal turunun katma degeri zayif: son olcumde aralik sifiri iceriyor.'
              : 'Bu sinyal turunun katma degeri kanitlanmadi (son olcume gore).')
          }
        }
        events.push({
          key: liveEvents.eventKey(cand),
          touch: hafif,
          signal: sig,
          ageBars: ageBars,
        })
      }
      if (ozellikYok > 0) {
        logs.push(ozellikYok + ' yeni bolge olayi bulundu ama ozellik penceresi yetersiz.')
      }

      // GUNLUK: tetiklenmeyen olaylar da yazilir. Canli performansi olcmek
      // icin "esik gecilmedi" kayitlari da gerekir.
      const cfgIz = memMeta && memMeta.cfgHash ? memMeta.cfgHash : null
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        await liveLogEkle(tf, {
          type: 'event',
          key: e.key,
          tf: tf,
          time: e.touch ? num(e.touch.time, 0) : 0,
          fetchedAt: fetchedAt,
          ageBars: e.ageBars,
          providerId: payload.providerId || null,
          isProxy: !!payload.isProxy,
          basis: basis,
          volScale: volScale,
          cfgHash: cfgIz,
          touch: e.touch,
          signal: signalOzeti(e.signal),
        }, logs)
      }

      // Ufku dolmus kayitlarin sonucu her yeni barda hesaplanir. Sonuclar
      // ancak yeni bar geldikce olgunlastigi icin bar gelmeyen tikte
      // yapilacak is yoktur.
      labeled = await liveLogEtiketle(tf, s, tfSec, canliCfg.planOutcomeCfg, logs,
        (payload.cfgPatch && payload.cfgPatch.backtestCfg) || null)
    } catch (err) {
      logs.push('Canli kontrol hatasi: ' + (err && err.message ? err.message : String(err)))
    }
  }

  // GERIYE UYUM: arayuz ve live.js tekil `signal` / `touch` alanlarini da
  // okur, bunlar dizinin SONUNCU elemaniyla doldurulur.
  if (events.length > 0) {
    const son = events[events.length - 1]
    signal = son.signal
    touch = son.touch
  }

  return {
    tf: tf,
    added: added,
    stored: stored,
    basis: basis,
    volScale: volScale,
    basisComputed: basisComputed,
    basisWarned: basisWarned,
    // Duzeltme hesaplanamadi ya da akista bosluk olustu: arayuz bunu gorunce
    // eksik donemi Veri Cek ile kapatmali, yoksa canli bar hic yazilmaz.
    needsSync: needsSync,
    // Hafiza baska bir ayarla kuruldu: yeniden tarama gerekiyor.
    cfgMismatch: cfgMismatch,
    lastBar: lastBar,
    // Bu tikte yeni olan TUM olaylar, zaman sirasiyla.
    events: events,
    // Bu tikte gunluge yazilan sonuc satiri sayisi.
    labeled: labeled,
    signal: signal,
    touch: touch,
    lastTouchTime: lastTouchTime,
    logs: logs,
  }
}

/**
 * Canli sinyal gunlugunun ozeti. Arayuzdeki Test paneli bunu "Testte olculen"
 * rakamla yan yana gosterir, boylece canli ile olcum arasindaki sapma (drift)
 * gorunur olur.
 * Yuk: {tf, limit}
 */
handlers['engine:live-log'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const limit = clampInt(payload.limit, 1, 2000, 50)
  const okunan = await liveLogOku(tf)
  const records = okunan.records

  const bos = {
    tf: tf,
    found: false,
    count: 0,
    fired: 0,
    labeled: 0,
    wins: 0,
    winRate: null,
    netAtr: 0,
    expectancyAtr: null,
    stale: 0,
    firstTime: null,
    lastTime: null,
    records: [],
  }
  if (records.length === 0) return bos

  let fired = 0
  let labeledCount = 0
  let wins = 0
  let netAtr = 0
  let stale = 0
  let firstTime = null
  let lastTime = null
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    const t = num(rec.time, 0)
    if (firstTime === null || t < firstTime) firstTime = t
    if (lastTime === null || t > lastTime) lastTime = t
    if (num(rec.ageBars, 0) > 1) stale++
    const tetiklendi = !!(rec.signal && rec.signal.fired)
    if (!tetiklendi) continue
    fired++
    // Isabet ve net ATR YALNIZCA tetiklenen sinyaller uzerinden olculur:
    // esigi gecmeyen olay bir islem degildir. Test ozetindeki `winRate` ve
    // `expectancyAtr` de ayni tabani kullanir.
    if (!rec.labeled) continue
    labeledCount++
    if (rec.win === true) wins++
    if (Number.isFinite(rec.pnlAtr)) netAtr += rec.pnlAtr
  }

  const bas = Math.max(0, records.length - limit)
  const son = []
  for (let i = records.length - 1; i >= bas; i--) {
    const rec = records[i]
    son.push({
      key: rec.key,
      time: rec.time,
      ageBars: rec.ageBars,
      kind: rec.signal && rec.signal.kind ? rec.signal.kind : (rec.touch ? rec.touch.kind : null),
      direction: rec.signal && rec.signal.direction
        ? rec.signal.direction
        : (rec.touch ? rec.touch.direction : null),
      fired: !!(rec.signal && rec.signal.fired),
      winRate: rec.signal ? num(rec.signal.winRate, 0) : null,
      entry: rec.signal ? num(rec.signal.entry, 0) : null,
      providerId: rec.providerId,
      outcome: rec.outcome,
      win: rec.win,
      pnlAtr: rec.pnlAtr,
      barsToOutcome: rec.barsToOutcome,
    })
  }

  return {
    tf: tf,
    found: true,
    count: records.length,
    fired: fired,
    labeled: labeledCount,
    wins: wins,
    winRate: labeledCount > 0 ? wins / labeledCount : null,
    netAtr: netAtr,
    expectancyAtr: labeledCount > 0 ? netAtr / labeledCount : null,
    stale: stale,
    firstTime: firstTime,
    lastTime: lastTime,
    records: son,
  }
}

// ---------------------------------------------------------------------------
// Islemleri sinyale cevirme
// ---------------------------------------------------------------------------

/**
 * Geriye testin urettigi islemleri arayuzun bekledigi Signal bicimine cevirir.
 * @param {Array} trades
 * @param {{events:Array}} memory
 */
function tradesToSignals(trades, memory) {
  const byId = new Map()
  if (memory && Array.isArray(memory.events)) {
    for (let i = 0; i < memory.events.length; i++) byId.set(memory.events[i].id, memory.events[i])
  }
  const out = []
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]
    const e = byId.get(t.eventId)
    const winPct = Math.round(num(t.winRate, 0) * 100)
    // Gerekceler sinyalin kendisinden gelir; yalnizca yoksa kisa bir ozet kurulur.
    // Sonunda testin GERCEKLESEN sonucu eklenir, cunku gecmis sinyallerde bu
    // bilgi vardir ve kullanici icin en degerli satirdir.
    const reasons = Array.isArray(t.reasons) && t.reasons.length
      ? t.reasons.slice()
      : [
        num(t.matchCount, 0) + ' benzer kayıt bulundu, ortalama benzerlik ' + num(t.avgSimilarity, 0).toFixed(2),
        'Geçmiş başarı oranı %' + winPct,
      ]
    if (t.outcome) {
      reasons.push('Gerçekleşen sonuç: ' + (t.win ? 'kazanç' : 'kayıp') +
        ' (' + (t.outcome === 'respect' ? 'bölge tuttu' : (t.outcome === 'break' ? 'bölge kırıldı' : 'zaman aşımı')) + ')')
    }
    out.push({
      id: t.id,
      fired: true,
      // Olay turu geriye testin islem kaydinda yok, hafizadaki olaydan gelir.
      kind: e && e.kind === 'form' ? 'form' : 'touch',
      time: t.time,
      bar: t.bar,
      direction: t.direction,
      price: e ? e.price : t.entry,
      zoneTop: e ? e.zoneTop : num(t.entry, 0),
      zoneBottom: e ? e.zoneBottom : num(t.entry, 0),
      matchCount: num(t.matchCount, 0),
      avgSimilarity: num(t.avgSimilarity, 0),
      bestSimilarity: num(t.bestSimilarity, 0),
      winRate: num(t.winRate, 0),
      confidence: num(t.confidence, 0),
      expectedMfeAtr: num(t.expectedMfeAtr, 0),
      // Beklenen aleyhte hareket, SL MESAFESI DEGILDIR. Bir donem burada
      // `t.slAtr` yaziliyordu: test sinyalinde plan riski, canlida benzerlerin
      // ortalama aleyhte hareketi gorunuyordu, yani ayni etiketin altinda iki
      // farkli sayi vardi. Ikisi de artik ayri alanlarda.
      expectedMaeAtr: num(t.expectedMaeAtr, 0),
      planRiskAtr: num(t.slAtr, 0),
      entry: num(t.entry, 0),
      tp1: num(t.tp1, 0),
      // TP2 yoksa null kalir; 0 yazmak grafige sifir fiyatli bir cizgi koyardi.
      tp2: Number.isFinite(Number(t.tp2)) ? Number(t.tp2) : null,
      sl: num(t.sl, 0),
      rr: num(t.rr, 0),
      atr: num(t.atr, 0),
      session: t.session || (e ? e.session : ''),
      expectancy: num(t.expectancy, 0),
      topMatches: Array.isArray(t.topMatches) ? t.topMatches : [],
      reasons: reasons,
      outcome: t.outcome || null,
      barsToOutcome: num(t.barsToOutcome, -1),
      success: t.success === undefined ? null : !!t.success,
      win: t.win === undefined ? null : !!t.win,
      pnlAtr: num(t.pnlAtr, 0),
      eventId: t.eventId,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Mesaj dongusu
// ---------------------------------------------------------------------------

/** Ana iplige serbest log mesaji yollar. */
function log(message) {
  parentPort.postMessage({ type: 'log', message: String(message) })
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return
  const id = msg.id
  const cmd = String(msg.cmd || '')
  const payload = msg.payload || {}

  // Ilerleme mesajlarini kis, saniyede ~20 mesaj yeter.
  let lastPct = -1
  let lastAt = 0
  const progress = (pct, text) => {
    let p = num(pct, 0)
    if (p < 0) p = 0
    if (p > 100) p = 100
    const now = Date.now()
    if (p < 100 && now - lastAt < 50 && Math.abs(p - lastPct) < 1) return
    lastAt = now
    lastPct = p
    parentPort.postMessage({ type: 'progress', id: id, pct: p, msg: String(text === undefined || text === null ? '' : text) })
  }

  try {
    const fn = handlers[cmd]
    if (!fn) throw new Error('Bilinmeyen komut: ' + cmd)
    const data = await fn(payload, { progress: progress })
    parentPort.postMessage({ type: 'result', id: id, data: data === undefined ? null : data })
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      id: id,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    })
  }
})
