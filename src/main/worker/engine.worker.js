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
// Komutlar
// ---------------------------------------------------------------------------

const handlers = {}

/** Veri ve hafiza durumu. */
handlers['data:status'] = async function () {
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
      hasZones: await fileExists(paths.zonesPath(tf)),
      hasPrototypes: await fileExists(paths.protosPath(tf)),
      hasSignals: await fileExists(paths.signalsPath(tf)),
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

  // Zaman dilimine gore olculmus hazir ayar taban alinir; kullanicinin
  // Ayarlar ekranindan verdigi degerler bunu ezer (bkz. learn/presets.js).
  const uygulanan = core('learn/presets').applyPreset(tf, payload.outcomeCfg, null)

  ctx.progress(2, 'Indikator calisiyor')
  const built = memoryMod.buildMemory(
    s,
    { tf: tf, params: payload.params || {}, outcomeCfg: uygulanan.outcomeCfg },
    (pct, msg) => ctx.progress(2 + num(pct, 0) * 0.78, msg)
  )

  const events = built.events || []
  const zones = built.zones || []

  ctx.progress(82, 'Hafiza diske yaziliyor')
  await memstore.saveMemory(paths.memoryPath(tf), {
    tf: tf,
    ctxNames: built.ctxNames,
    events: events,
    // Hangi bara kadar taradigimiz. Arayuz bunu deponun son bariyla
    // karsilastirip hafizanin geride kalip kalmadigini anlar.
    builtToTime: s.length > 0 ? s.time[s.length - 1] : 0,
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
  memoryCache = { tf: tf, memory: { tf: tf, ctxNames: built.ctxNames, events: events } }
  zonesCache = { tf: tf, zones: zones }
  protoCache = { tf: tf, protos: protos }
  signalCache = { tf: tf, signals: [] }
  try {
    await fsp.unlink(paths.signalsPath(tf))
  } catch (err) {
    // Sinyal dosyasi yoksa sorun degil.
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

/** Tek bir dokunusu hafizayla karsilastirir. */
handlers['engine:evaluate'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const mem = await requireMemory(tf, false)
  const evs = mem.events

  let ev = null
  if (payload.touchId === undefined || payload.touchId === null) {
    ev = evs[evs.length - 1]
  } else {
    const wanted = Number(payload.touchId)
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i].id === wanted) {
        ev = evs[i]
        break
      }
    }
  }
  if (!ev) throw new Error('Dokunus bulunamadi: ' + String(payload.touchId))
  if (!ev.features) throw new Error('Bu dokunusun ozellik vektoru yok, hafizayi yeniden tarayin.')

  const protos = await getProtos(tf, false)
  const signalMod = core('learn/signal')
  const signal = signalMod.evaluateTouch(ev, ev.features, mem, protos, payload.signalCfg || {}, ev.time)
  return { tf: tf, signal: signal, touch: lightEvent(ev) }
}

/** Yuruyen ileri test. Uretilen sinyalleri diske yazar. */
handlers['engine:backtest'] = async function (payload, ctx) {
  const tf = requireTf(payload.tf)
  const mem = await requireMemory(tf, false)
  const protos = await getProtos(tf, false)
  const bt = core('learn/backtest')

  // Hazir ayar taban, kullanicinin verdigi degerler ustte (bkz. learn/presets.js).
  const gelen = payload.cfg || {}
  const uygulanan = core('learn/presets').applyPreset(tf, gelen.outcomeCfg, gelen.signalCfg)
  const cfg = Object.assign({}, gelen, {
    signalCfg: Object.assign({}, uygulanan.signalCfg, { outcomeCfg: uygulanan.outcomeCfg }),
    outcomeCfg: uygulanan.outcomeCfg,
  })

  ctx.progress(1, 'Geriye test basliyor')
  const res = bt.runBacktest(mem, protos, cfg, (pct, msg) => ctx.progress(num(pct, 0) * 0.92, msg))

  const trades = res && Array.isArray(res.trades) ? res.trades : []
  ctx.progress(94, 'Sinyaller kaydediliyor')
  const signals = tradesToSignals(trades, mem)
  await writeJsonAtomic(paths.signalsPath(tf), signals)
  signalCache = { tf: tf, signals: signals }

  const tradeLimit = clampInt(payload.tradeLimit, 100, 20000, 3000)
  const shownTrades = trades.length > tradeLimit ? trades.slice(trades.length - tradeLimit) : trades

  ctx.progress(100, 'Test tamamlandi')
  return {
    tf: tf,
    summary: res ? res.summary : null,
    byYear: res && Array.isArray(res.byYear) ? res.byYear : [],
    equity: thinCurve(res ? res.equity : [], 3000),
    trades: shownTrades,
    tradeCount: trades.length,
    signalCount: signals.length,
  }
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
 */
handlers['engine:live-tick'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const seriesMod = core('series')
  const binstore = core('store/binstore')
  const tfSec = core('tf').tfSeconds(tf)
  const logs = []

  let inc = toSeries(payload.series)
  if (!inc || inc.length === 0) {
    return { tf: tf, added: 0, basis: payload.basis === undefined ? null : payload.basis, lastBar: null, signal: null, touch: null, logs: ['Saglayicidan mum gelmedi.'] }
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
      needsSync: needsSync, lastBar: null, signal: null, touch: null,
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
  let signal = null
  let touch = null
  let lastTouchTime = null
  if (added > 0) {
    try {
      const s = await getSeries(tf, false)
      const tail = clampInt(payload.tailBars, 500, 50000, DEFAULT_TAIL_BARS)
      const start = Math.max(0, s.length - tail)
      const sub = seriesMod.sliceSeries(s, start, s.length)
      const ind = core('indicator/proZones').runIndicator(sub, payload.params || {}, tfSec)
      const touches = ind && Array.isArray(ind.touches) ? ind.touches : []
      const since = num(payload.sinceTime, 0)

      let cand = null
      for (let i = touches.length - 1; i >= 0; i--) {
        if (num(touches[i].time, 0) > since) {
          cand = touches[i]
          break
        }
      }
      if (touches.length > 0) lastTouchTime = num(touches[touches.length - 1].time, 0)

      if (cand) {
        touch = lightEvent(cand)
        const feats = core('learn/features').buildFeatures(sub, cand, ind.context)
        const mem = await getMemory(tf, false)
        if (!feats) {
          logs.push('Yeni bolge olayi bulundu ama ozellik penceresi yetersiz.')
        } else if (!mem || !mem.events || mem.events.length === 0) {
          logs.push('Yeni bolge olayi bulundu ama hafiza bos. Once "Geçmişi Tara" calistirin.')
        } else {
          const protos = await getProtos(tf, false)
          signal = core('learn/signal').evaluateTouch(cand, feats, mem, protos, payload.signalCfg || {}, num(cand.time, fetchedAt))
          if (signal && basis !== null && basis !== 0 && Array.isArray(signal.reasons)) {
            signal.reasons.push('Vekil kaynak fiyati ' + basis.toFixed(2) + ' birim kaydirildi.')
          }
        }
      }
    } catch (err) {
      logs.push('Canli kontrol hatasi: ' + (err && err.message ? err.message : String(err)))
    }
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
    lastBar: lastBar,
    signal: signal,
    touch: touch,
    lastTouchTime: lastTouchTime,
    logs: logs,
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
      expectedMaeAtr: num(t.slAtr, 0),
      entry: num(t.entry, 0),
      tp1: num(t.tp1, 0),
      tp2: num(t.tp2, 0),
      sl: num(t.sl, 0),
      rr: num(t.rr, 0),
      atr: num(t.atr, 0),
      session: t.session || (e ? e.session : ''),
      prototypeId: t.prototypeId === undefined ? null : t.prototypeId,
      prototypeSim: num(t.prototypeSim, 0),
      prototypeLabel: t.prototypeLabel || '',
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
