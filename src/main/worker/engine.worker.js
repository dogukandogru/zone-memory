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
const path = require('path')
const { parentPort, workerData } = require('worker_threads')

// Veri klasorunu ana iplikten devral (isci ipliginde Electron `app` yoktur).
if (workerData && workerData.dataDir) process.env.ZONE_MEMORY_DATA_DIR = workerData.dataDir
if (workerData && workerData.userDataDir) process.env.ZONE_MEMORY_USER_DIR = workerData.userDataDir

const paths = require('../paths')

/** 2100-01-01, "sonsuz" ust zaman siniri yerine kullanilir. */
const MAX_TIME = 4102444800
/** Canli kontrolde indikatorun kosturuldugu kuyruk pencere uzunlugu. */
const DEFAULT_TAIL_BARS = 4000
/**
 * Gecersiz kalan olcum dosyalarina eklenen ek. Bu dosyalar SILINMEZ: ayar izi
 * bir guncellemeyle de degisebiliyor ve o durumda kullanici kendi yapmadigi
 * bir degisiklik yuzunden gecmisini kaybediyordu.
 */
const ONCEKI_EKI = '.onceki'

// ---------------------------------------------------------------------------
// Cekirdek modul yukleyici (tembel)
// ---------------------------------------------------------------------------

const coreCache = new Map()

/**
 * Son geriye testin KIRPILMAMIS sonucu (CSV dokumu icin).
 *
 * Diske yazilan ozet islem listesini icermez; arayuz de yalnizca son 3000
 * islemi gorur. Dokum ise TAM olmali, cunku amac kullanicinin sayilari
 * bagimsiz dogrulayabilmesi. Tarama ve hafiza silme bunu temizler.
 */
let sonBacktest = null

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
    throw new Error('Çekirdek modül yüklenemedi: core/' + rel + ' (' + (err && err.message ? err.message : String(err)) + ')')
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
    throw new Error('Geçersiz zaman dilimi: ' + String(tf))
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
    // SNIPER: Pine'in kendi sinyali. Ayri bir olay turu degil, nitelenmis bir
    // dokunus; istatistik dokunus kovasinda kalir ama arayuz bunu ayirt
    // edebilmeli, yoksa kullanici sinyali "sade dokunus" sanir.
    sniper: !!e.sniper,
    sniperScore: Number.isFinite(e.sniperScore) ? e.sniperScore : null,
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

/**
 * UST ZAMAN DILIMI ESLESMESI (Y3 olcumu icin).
 *
 * Her alt zaman dilimine, kabaca dort katindaki bir ust dilim eslenir. Bu
 * eslesme yalnizca OLCUM icindir; sinyal kararina girmez.
 */
const UST_TF_ESLESME = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '4h' }

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
        'Bu zaman diliminin hafızası eski indikatör sürümünden kalma (bağlam ' +
        mem.ctxNames.length + ' boyut, şimdi ' + guncel.length +
        '). "Geçmişi Tara" ile yeniden oluşturun.'
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
    throw new Error('Bu zaman dilimi için hafıza yok. Önce "Geçmişi Tara" çalıştırın.')
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
          logs.push('Canlı sinyal günlüğü yazılamadı: ' + (err2 && err2.message ? err2.message : String(err2)))
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
    sniper: !!sig.sniper,
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
    return { tf: tf, bars: 0, gaps: [], monthly: [], message: 'Depoda bu zaman dilimi için veri yok.' }
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
  //
  // EKSIK DOSYA DA URETILIR. Bir donem yalnizca `added > 0` kosulu vardi ve
  // bu, veri paketi turetilmis dosyalari sildikten SONRA acilan piyasa kapali
  // bir oturumda hicbirini geri yazmiyordu: OANDA sifir yeni bar doner,
  // `added` sifir kalir, dosyalar silinmis halde kalirdi. Uygulama yine
  // calisiyordu (seri 1 dakikaliktan bellekte orneklenir) ama her acilista
  // 7,13 milyon bar bastan orneklenir ve bu dilimler "veri yok" sayilip
  // gereksiz senkron denemesi baslatilirdi.
  const uretilen = []
  const eksikTf = []
  for (const ust of TURETILEN_TF) {
    if (!(await fileExists(paths.candlePath(ust)))) eksikTf.push(ust)
  }
  const yenidenUret = hedefTf === '1m' && ((res && res.added > 0) || eksikTf.length > 0)
  if (yenidenUret) {
    const taban = await binstore.readSeries(paths.candlePath('1m'))
    if (taban && taban.length > 0) {
      // Yeni bar geldiyse HEPSI tazelenir; gelmediyse yalnizca eksikler.
      const hedefler = (res && res.added > 0) ? TURETILEN_TF : eksikTf
      for (let i = 0; i < hedefler.length; i++) {
        const ust = hedefler[i]
        ctx.progress(75 + (i / hedefler.length) * 24, ust + ' yeniden üretiliyor')
        const s = seriesMod.resample(taban, tfSeconds(ust))
        await binstore.writeSeries(paths.candlePath(ust), s)
        uretilen.push({ tf: ust, count: s.length })
      }
    }
  }

  clearCache(null)
  ctx.progress(100, 'Veri güncellendi')
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
  if (!file) throw new Error('İçeri aktarılacak dosya yolu verilmedi.')
  if (!(await fileExists(file))) throw new Error('Dosya bulunamadı: ' + file)

  const binstore = core('store/binstore')
  const seriesMod = core('series')
  let incoming = null

  if (file.toLowerCase().endsWith('.bin')) {
    incoming = await binstore.readSeries(file)
    if (!incoming) throw new Error('İkili dosya okunamadı: ' + file)
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
      if ((i & 65535) === 0) ctx.progress(5 + 60 * (i / lines.length), 'CSV ayrıştırılıyor')
    }
    incoming = seriesMod.fromArrays(cols)
  }

  ctx.progress(75, 'Depoya yazılıyor')
  const res = await binstore.appendSeries(paths.candlePath(tf), incoming)
  clearCache(tf)
  if (tf === '1m') clearCache(null)
  ctx.progress(100, 'Tamamlandı')
  return { tf: tf, added: res ? res.added : 0, total: res ? res.total : 0 }
}

/** Gecmisi tarar, hafizayi, bolgeleri ve prototipleri diske yazar. */
handlers['engine:scan'] = async function (payload, ctx) {
  const tf = requireTf(payload.tf)
  const force = !!payload.force
  // Hafiza yeniden kuruluyor: elde tutulan islem dokumu ESKI etiketlere ait.
  sonBacktest = null
  ctx.progress(0, 'Mumlar okunuyor')
  const s = await getSeries(tf, force)
  if (!s || s.length < 200) {
    throw new Error('Tarama için yeterli mum yok (' + (s ? s.length : 0) + ' bar). Önce veri indirin.')
  }

  const memoryMod = core('learn/memory')
  const memstore = core('store/memstore')

  // Tarama, test ve canli AYNI birlestirmeyi kullanir: cekirdek varsayilani,
  // zaman dilimine ait hazir ayar, sonra kullanicinin yamasi
  // (bkz. core/learn/presets.js resolveCfg).
  const uygulanan = core('learn/presets').resolveCfg(tf, payload.cfgPatch || cfgPatchGeriUyum(payload), null)
  const params = Object.assign({}, payload.params || {})

  ctx.progress(2, 'İndikatör çalışıyor')
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

  ctx.progress(82, 'Hafıza diske yazılıyor')
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

  ctx.progress(88, 'Bölgeler kaydediliyor')
  await writeJsonAtomic(paths.zonesPath(tf), zones)

  ctx.progress(91, 'Prototipler çıkarılıyor')
  let protos = []
  try {
    protos = core('learn/cluster').buildPrototypes({ events: events }, {}) || []
  } catch (err) {
    protos = []
    log('Prototipler hesaplanamadı: ' + (err && err.message ? err.message : String(err)))
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

  // Test sinyalleri ve son test ozeti YALNIZCA ayar izi degistiyse gecersizdir.
  // Onceden her taramada siliniyordu: canli akis depoya bar ekledikce
  // otomatik tarama basliyor ve kullanicinin olcumu sessizce kayboluyordu.
  //
  // SILMIYORUZ, YEDEKLIYORUZ. Bu yol yalnizca kullanici Ayarlar'dan bir deger
  // degistirdiginde calismiyor: bir GUNCELLEME indikator varsayilanlarini
  // degistirdiginde de calisiyor. O durumda kullanici hicbir sey yapmamistir,
  // uygulamayi acar ve listesini bulamaz. Olculdu: boyle bir guncellemede 990
  // sinyal geri donusu olmadan gitmisti. Artik dosya `.onceki` ekiyle duruyor.
  const sonTest = await readJson(paths.backtestPath(tf))
  const eskiIz = sonTest && sonTest.cfgHash ? String(sonTest.cfgHash) : null
  // ISARET DOSYASI: depo baska bir kaynaktan yeniden kuruldu. Ayar izi bunu
  // YAKALAYAMAZ, cunku ayar hic degismemistir; degisen veridir ve eski sinyal
  // listesi artik baska bir veri kumesinin olaylarina isaret eder.
  //
  // ISARET BURADA SILINMEZ. Bir donem tarama biter bitmez siliniyordu, ama
  // olcumu asil yeniden kuran sey TARAMA DEGIL, ardindan gelen TESTTIR. Test
  // en uzun adim; kullanici o sirada uygulamayi kapatirsa isaret gitmis,
  // olcum dosyalari da yedege tasinmis oluyordu. Sonraki acilista hafiza
  // guncel oldugu icin tarama hic calismiyor, eski iz de null oldugundan
  // "olcum gecersiz" bir daha hic denmiyordu: liste KALICI olarak bos
  // kaliyor ve kullanicinin elle test calistirmasi gerekiyordu.
  // Isareti test tuketir (`engine:backtest`).
  const yenileIsareti = paths.olcumYenilePath(tf)
  const veriDegisti = await fileExists(yenileIsareti)
  const izDegisti = !!(eskiIz && eskiIz !== yeniIz) || veriDegisti
  if (izDegisti) {
    signalCache = { tf: tf, signals: [] }
    for (const dosya of [paths.signalsPath(tf), paths.backtestPath(tf)]) {
      try {
        await fsp.rename(dosya, dosya + ONCEKI_EKI)
      } catch (err) {
        // Dosya yoksa sorun degil.
      }
    }
    log((veriDegisti
      ? 'Veri kaynağı değiştiği için eski test sinyalleri geçersiz. '
      : 'Ayarlar değiştiği için eski test sinyalleri geçersiz. ') +
      'Yedekleri "' + ONCEKI_EKI + '" ekiyle duruyor.')
  } else {
    signalCache = { tf: null, signals: null }
  }

  ctx.progress(97, 'Özet hazırlanıyor')
  let summary = null
  try {
    summary = memoryMod.summarize({ tf: tf, ctxNames: built.ctxNames, events: events })
  } catch (err) {
    summary = null
  }

  ctx.progress(100, 'Tarama tamamlandı')
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
    // Ayar izi degistigi icin sinyal listesi gecersiz kalindi. Arayuz bunu
    // gorunce testi KENDISI baslatir, boylece liste kullanicidan hicbir sey
    // istemeden yeniden dolar.
    signalsInvalidated: izDegisti,
    // Sebep: 'veri' (depo baska bir kaynaktan kuruldu) veya 'ayar'.
    // Kullaniciya DOGRU sebebi soylemek gerekiyor: veri paketi yuzunden
    // "Ayarlar degisti" demek, hicbir ayara dokunmamis kullaniciyi kendi
    // esiklerinin bozuldugunu sanip Ayarlar'i kurcalamaya iter.
    invalidationReason: izDegisti ? (veriDegisti ? 'veri' : 'ayar') : null,
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

  // TEK BIR BOLGENIN OLAYLARI ISTENDIYSE zaman araligi ve limit UYGULANMAZ.
  //
  // Onceden `zoneId` yok sayiliyordu: bolgeye tiklayan kullaniciya son 5000
  // olay donuyordu ve arayuz eslesme bulamayinca butun listeyi o bolgeninmis
  // gibi basiyordu. Olculdu: yanlis liste gosterilen bolge payi 15m'de %42,
  // 5m'de %74, 1m'de %92,4. Baska bolgelerin skorlari ve etiketleri yanlis
  // bolgeye kanit olarak atfediliyordu; ustelik her tiklamada birkac MB IPC
  // ve 5000 DOM satiri arayuzu donduruyordu.
  const evs = mem.events
  const zoneIdHam = payload.zoneId
  const zoneId = zoneIdHam === undefined || zoneIdHam === null || zoneIdHam === ''
    ? null
    : Number(zoneIdHam)
  if (zoneId !== null && Number.isFinite(zoneId)) {
    const bolgeOlaylari = []
    for (let i = 0; i < evs.length; i++) {
      if (Number(evs[i].zoneId) === zoneId) bolgeOlaylari.push(evs[i])
    }
    return {
      tf: tf,
      zoneId: zoneId,
      touches: bolgeOlaylari.map(lightEvent),
      total: bolgeOlaylari.length,
      truncated: false,
    }
  }

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

/**
 * HAFIZA VE ISLEM DOKUMUNU CSV OLARAK YAZAR.
 *
 * Neden: kullanici sistemin iddialarini (tur tabani, isabet, net beklenti,
 * kalibrasyon) Excel ya da Python ile BAGIMSIZ dogrulayamiyordu; bu inceleme
 * bile her olcum icin ayri betik yazmak zorunda kaldi. Arayuz testin yalnizca
 * son islemlerini gosteriyor, brut sonuc ve maliyet diske hic yazilmiyordu.
 *
 * Yanina ayni adla bir `.meta.json` yazilir: hangi ayar, hangi surum ve hangi
 * hafiza ile uretildigi olmadan dokum tek basina dogrulanamaz.
 */
handlers['engine:export-csv'] = async function (payload) {
  const tf = requireTf(payload.tf)
  const ne = payload.what === 'trades' ? 'trades' : 'events'
  const dosya = String(payload.filePath || '')
  if (!dosya) throw new Error('Dosya yolu verilmedi.')
  const csv = core('csv')

  let satirlar = []
  let sutunlar = []
  let ozet = null
  let kullanilanAyar = null
  let cfgHash = null

  if (ne === 'trades') {
    if (!sonBacktest || sonBacktest.tf !== tf) {
      throw new Error('Önce bu zaman diliminde Test sekmesinden ölçüm çalıştırın.')
    }
    satirlar = sonBacktest.trades
    ozet = sonBacktest.summary
    kullanilanAyar = sonBacktest.usedCfg
    cfgHash = sonBacktest.cfgHash
    // Gerekce ve komsu listesi CSV'ye SIGMAZ (cok satirli metin ve dizi);
    // sayisal dogrulama icin de gerekmiyor.
    const atla = { reasons: 1, topMatches: 1 }
    const anahtarlar = new Set()
    for (const t of satirlar) {
      for (const k of Object.keys(t)) if (!atla[k]) anahtarlar.add(k)
    }
    sutunlar = csv.zamanSutunlari('time').concat(
      Array.from(anahtarlar).filter((k) => k !== 'time').map((k) => ({ key: k, header: k })))
  } else {
    const mem = await getMemory(tf, false)
    if (!mem || !mem.events || mem.events.length === 0) {
      throw new Error('Bu zaman diliminde hafıza yok.')
    }
    const ctxAdlari = Array.isArray(mem.ctxNames) ? mem.ctxNames : []
    satirlar = mem.events.map((e) => {
      const hafif = lightEvent(e)
      // Skor bilesenleri duzlestirilir; ic ice nesne CSV'de sutun olamaz.
      const parts = e.parts || {}
      for (const ad of Object.keys(parts)) hafif['part_' + ad] = parts[ad] ? 1 : 0
      // Baglam vektoru adlandirilmis sutunlara acilir (sekil ve getiri HARIC:
      // 48 sutun daha eklemek dosyayi okunmaz yapar ve dogrulamaya katkisi yok).
      const ctx = e.features && e.features.ctx ? e.features.ctx : null
      if (ctx) {
        for (let i = 0; i < ctxAdlari.length && i < ctx.length; i++) {
          hafif['ctx_' + ctxAdlari[i]] = ctx[i]
        }
      }
      return hafif
    })
    const anahtarlar = new Set()
    for (const r of satirlar) for (const k of Object.keys(r)) anahtarlar.add(k)
    sutunlar = csv.zamanSutunlari('time').concat(
      Array.from(anahtarlar).filter((k) => k !== 'time').map((k) => ({ key: k, header: k })))
    cfgHash = mem.meta && mem.meta.cfgHash ? mem.meta.cfgHash : null
  }

  // Her satira ayar izi: dosya baska bir ayarla karistirilamasin.
  if (cfgHash) {
    for (const r of satirlar) r.cfgHash = cfgHash
    sutunlar = sutunlar.concat([{ key: 'cfgHash', header: 'cfgHash' }])
  }

  const damga = buildDamgasi()
  let yazilan = 0
  const parcalar = []
  for (const parca of csv.csvChunks(satirlar, sutunlar)) {
    parcalar.push(parca)
  }
  await fsp.writeFile(dosya, parcalar.join(''), 'utf8')
  yazilan = satirlar.length

  try {
    await writeJsonAtomic(dosya.replace(/\.csv$/i, '') + '.meta.json', {
      tf: tf,
      what: ne,
      rows: yazilan,
      zaman: new Date().toISOString(),
      cfgHash: cfgHash,
      usedCfg: kullanilanAyar,
      summary: ozet,
      memory: sonBacktest && sonBacktest.tf === tf ? sonBacktest.memory : null,
      appVersion: damga.appVersion || null,
      buildCommit: damga.buildCommit,
      buildSrcHash: damga.buildSrcHash,
    })
  } catch (err) {
    log('CSV yan bilgisi yazılamadı: ' + (err && err.message ? err.message : String(err)))
  }

  return { tf: tf, what: ne, rows: yazilan, filePath: dosya }
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
      'engine:backtest yük biçimi değişti: eşikler ve ısınma ' +
      '{ cfg: { warmupEvents, cfgPatch } } içinde gönderilmeli.'
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
    ctx.progress(1, 'Komşular hesaplanıyor (ilk koşu)')
    cache = candcache.buildCandidates(mem, cfg, (pct, msg) => ctx.progress(num(pct, 0) * 0.6, msg))
    try {
      const tmp = onbellekYolu + '.tmp'
      await fsp.writeFile(tmp, candcache.serialize(cache))
      await fsp.rename(tmp, onbellekYolu)
    } catch (err) {
      log('Aday önbelleği yazılamadı: ' + (err && err.message ? err.message : String(err)))
    }
  }

  // UST ZAMAN DILIMI BAGLAMI (Y3): olcum. Ust zaman diliminin serisi depoda
  // varsa indikator ORADA yeniden kosulur ve kutu durumu araliklari (zaman
  // cizelgesi) cikarilir. Cizelge, "o karar aninda bu kutu bu sinirlarla
  // BILINIYOR MUYDU" sorusunu ileriye bakmadan cevaplar; zones.json'daki
  // createdTime (bar acilisi) ve nihai sinirlar KULLANILMAZ.
  //
  // Sinyal karari ETKILENMEZ: bu yalnizca alt kume kirilimidir. Olculdu, naif
  // zamanlamayla gorunen +7 puanlik fark dogru zamanlamayla kayboluyor.
  const altKumeKancalari = []
  try {
    const ustTf = UST_TF_ESLESME[tf]
    if (ustTf) {
      const ustSeri = await loadSeriesFromStore(ustTf)
      if (ustSeri && ustSeri.length > 200) {
        const ustSn = core('tf').tfSeconds(ustTf)
        const ustInd = core('indicator/proZones').runIndicator(
          ustSeri,
          Object.assign({}, (memMeta && memMeta.indicatorParams) || {}, { recordTimeline: true }),
          ustSn
        )
        const htf = core('learn/htfContext')
        const dizin = htf.buildHtfIndex(ustInd.timeline)
        const ustAtr = ustInd.context && ustInd.context.atr ? ustInd.context.atr : null
        const ustZaman = ustSeri.time
        const tfSn = core('tf').tfSeconds(tf)
        // Karar anindaki ust TF ATR'si: o ana kadar KAPANMIS son ust bar.
        const ustAtrBul = (tSec) => {
          if (!ustAtr || !ustZaman) return 0
          let lo = 0
          let hi = ustZaman.length - 1
          let son = -1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (ustZaman[mid] + ustSn <= tSec) { son = mid; lo = mid + 1 } else hi = mid - 1
          }
          return son >= 0 ? num(ustAtr[son], 0) : 0
        }
        altKumeKancalari.push((ev) => {
          const karar = num(ev.time, 0) + tfSn
          const durum = htf.htfAt(dizin, karar, num(ev.price, 0),
            ev.direction === 'SELL' ? 'SELL' : 'BUY', { atr: ustAtrBul(karar), nearAtr: 0.5 })
          return 'Üst TF bölgesi (' + ustTf + '): ' + htf.htfSubset(durum)
        })
        log('Üst zaman dilimi bağlamı hazır: ' + ustTf + ', ' + dizin.rows.length + ' kutu aralığı')
      }
    }
  } catch (err) {
    log('Üst zaman dilimi bağlamı kurulamadı: ' + (err && err.message ? err.message : String(err)))
  }

  // EKONOMIK TAKVIM (Y2): dosya varsa testin alt kume kirilimi doldurulur.
  // Sinyal karari ETKILENMEZ; kapi yalnizca signalCfg.newsBlackoutMin > 0
  // iken devreye girer ve o ayar kullanicinindir. Takvim yoksa hicbir sey
  // degismez ve ozette bySubset null kalir.
  const takvimModul = core('calendar')
  const takvim = takvimModul.loadCalendar(paths.calendarPath())
  if (takvim) {
    const tfSn = core('tf').tfSeconds(tf)
    // Karar ani olayin BASLADIGI an degil, barin KAPANISIDIR.
    altKumeKancalari.push((ev) =>
      'Veri penceresi: ' + takvimModul.newsSubset(takvim, num(ev.time, 0) + tfSn))
    log('Ekonomik takvim yüklendi: ' + takvim.count + ' kayıt' +
      (takvim.skipped > 0 ? ', ' + takvim.skipped + ' satır atlandı' : ''))
  }

  // Her boyut kendi icinde tum olaylari boler; kanca etiket DIZISI doner.
  if (altKumeKancalari.length > 0) {
    cfg.subsetOf = (ev) => altKumeKancalari.map((f) => f(ev))
  }

  ctx.progress(62, 'Geriye test başlıyor')
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
    log('Test özeti diske yazılamadı: ' + (err && err.message ? err.message : String(err)))
  }

  // OLCUM YENILEME ISARETI BURADA TUKETILIR, taramada degil.
  //
  // Olcumu yeniden kuran sey tarama degil, bu testtir; isaret ancak simdi
  // karsiligini buldu. Tarama silseydi ve kullanici test sirasinda uygulamayi
  // kapatsaydi, sonraki acilista hafiza guncel oldugu icin tarama hic
  // calismaz, eski iz de null oldugundan "olcum gecersiz" bir daha hic
  // denmezdi: liste KALICI olarak bos kalirdi.
  try {
    await fsp.unlink(paths.olcumYenilePath(tf))
  } catch (err) {
    // Isaret yoksa sorun degil, olagan durum budur.
  }

  // CSV DISA AKTARIMI ICIN: kirpilmamis islem listesi bellekte tutulur.
  // Arayuz yalnizca son 3000 islemi goruyor; dosyaya yazilan dokum ise TAM
  // olmali, yoksa kullanici kendi hesabini yapamaz.
  sonBacktest = {
    tf: tf,
    zaman: Math.floor(Date.now() / 1000),
    trades: trades,
    summary: ozet,
    usedCfg: kullanilanAyar,
    cfgHash: hafizaIz || etkinIz,
    memory: hafizaOzeti,
  }

  ctx.progress(100, 'Test tamamlandı')
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

  // BENZERLIK AGIRLIGI DEGISTI MI.
  //
  // Ayar izi bunu KAPSAMAZ: iz indikator ayarini ve etiket tanimini tutar,
  // komsu agirligini degil. Ama agirlik degisince komsular da degisir, yani
  // listedeki her sinyal baska bir karsilastirmadan cikmis olur. Bu, ayar
  // ekranindan degistirildiginde oldugu gibi, UYGULAMANIN VARSAYILANI
  // degistiginde de olur; ikincisini hicbir sey yakalamiyordu.
  const etkinAgirlik = core('learn/similarity').agirlikCoz(
    core('learn/presets').resolveCfg(tf, payload && payload.cfgPatch ? payload.cfgPatch : {}, null).signalCfg
  )
  const eskiAgirlik = kayit.usedCfg && kayit.usedCfg.signalCfg
    ? kayit.usedCfg.signalCfg.weights
    : null
  const yakin = (a, b) => Math.abs(num(a, 0) - num(b, 0)) < 1e-9
  const agirlikAyni = !eskiAgirlik ? null : (
    yakin(eskiAgirlik.shape, etkinAgirlik.shape) &&
    yakin(eskiAgirlik.ctx, etkinAgirlik.ctx) &&
    yakin(eskiAgirlik.dtw, etkinAgirlik.dtw)
  )
  return Object.assign({
    tf: tf,
    found: true,
    stillValid: gecerli,
    weightsMatch: agirlikAyni,
    activeWeights: etkinAgirlik,
  }, kayit)
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
  // Hafiza silindi: elde tutulan islem dokumu artik hangi hafizaya ait
  // oldugu bilinmeyen bir kalinti olurdu.
  sonBacktest = null
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
/**
 * HACIM REJIMI: kapi orani tarihsel referansin cok uzerinde mi.
 *
 * Referans, deponun VEKIL YAZILMAMIS son bolumunden hesaplanir ve surec
 * basina bir kez cikarilir (kaynak degismedikce degismez). Canli oran ise her
 * turda son 2000 bardan olculur.
 *
 * Esik 1,5 kat: olculdu, duzeltme calisirken PAXG orani spot referansin
 * yaklasik 0,8 katina iniyor (%2,63'e karsi %3,13), duzeltme calismazken
 * yaklasik 4 katina cikiyor (%12,27). Arada genis bir pay var.
 */
const REJIM_KAT = 1.5
/** Canli oran kac bardan olculur. */
const REJIM_PENCERE = 2000
let rejimOnbellek = { tf: null, ref: null }

async function hacimRejimiKontrol (tf, seri, tfSec) {
  if (!seri || seri.length < REJIM_PENCERE) return null
  const loader = core('data/loader')
  try {
    if (rejimOnbellek.tf !== tf || rejimOnbellek.ref === null) {
      const araliklar = await loader.vekilAraliklariOku(paths.dataDir(), tf)
      // Referans: en eski vekil araligindan ONCEKI son bolum. Vekil hic
      // yazilmamissa serinin sonu kullanilir.
      let son = seri.length
      if (araliklar.length > 0) {
        let enErken = Infinity
        for (const r of araliklar) {
          if (r && Number.isFinite(r.from) && r.from < enErken) enErken = r.from
        }
        if (Number.isFinite(enErken)) {
          son = 0
          while (son < seri.length && seri.time[son] < enErken) son++
        }
      }
      const bas = Math.max(0, son - 8 * 7 * 86400 / (tfSec > 0 ? tfSec : 60))
      const olcum = loader.hacimKapiOrani(seri, { fromIndex: bas, toIndex: son })
      rejimOnbellek = { tf: tf, ref: olcum.n > 500 ? olcum.rate : null }
    }
    const ref = rejimOnbellek.ref
    if (!(ref > 0)) return null
    const canli = loader.hacimKapiOrani(seri, { fromIndex: seri.length - REJIM_PENCERE })
    if (canli.n < 200) return null
    return { rate: canli.rate, ref: ref, bozuk: canli.rate > ref * REJIM_KAT }
  } catch (err) {
    return null
  }
}

/**
 * Ekonomik takvimi surec basina BIR KEZ yukler.
 *
 * Canli dongu her 20 saniyede bir cagiriliyor; dosyayi her tikta okumak
 * gereksiz disk erisimi olurdu. Kullanici takvimi degistirirse uygulamayi
 * yeniden baslatmasi (ya da isciyi yeniden kurmasi) gerekir; dosya
 * degisikligini izlemek bu ozellik icin fazla karmasik.
 */
let takvimDurumu = { yuklendi: false, cal: null }
function takvimOnbellek () {
  if (takvimDurumu.yuklendi) return takvimDurumu.cal
  let cal = null
  try {
    cal = core('calendar').loadCalendar(paths.calendarPath())
  } catch (err) {
    cal = null
  }
  takvimDurumu = { yuklendi: true, cal: cal }
  if (cal) log('Ekonomik takvim yüklendi: ' + cal.count + ' kayıt')
  return cal
}

/**
 * Turetilmis zaman dilimi dosyalarinin kaynak izlerini siler.
 *
 * Canli akis yalnizca 1 dakikalige yazar; turetilmis dosyalar o anda eskir.
 * Dosyalari her tikte yeniden yazmak pahali olurdu (5m dosyasi 1,2 milyon
 * bar), bu yuzden yalnizca IZ silinir ve yukleyici bir sonraki okumada
 * kendisi tazeler.
 */
async function turetilmisIzleriGecersizKil () {
  const loader = core('data/loader')
  const { TURETILEN_TF } = core('tf')
  for (const tf of TURETILEN_TF) {
    try {
      await fsp.unlink(loader.turetilmisIzYolu(paths.dataDir(), tf))
    } catch (err) {
      // Iz yoksa silinecek de yoktur.
    }
  }
}

/**
 * Canli analiz serisi: grafik zaman diliminde, 1 dakikaliktan TURETILMIS.
 *
 * Canli akis 1 dakikalige yaziyorsa grafik zaman diliminin dosyasi eskimistir;
 * o dosyayi okumak canli barlari gormemek demektir. Bu yuzden 1 dakikalik
 * serinin kuyrugu bellekte yeniden orneklenir.
 *
 * @param {string} tf Grafik zaman dilimi
 * @param {string} yazimTf Canlinin yazdigi zaman dilimi
 * @param {number} kuyrukBar Grafik zaman diliminde gereken bar sayisi
 */
async function canliAnalizSerisi (tf, yazimTf, kuyrukBar) {
  if (yazimTf === tf) return await getSeries(tf, false)
  const seriesMod = core('series')
  const taban = await getSeries(yazimTf, false)
  if (!taban || taban.length === 0) return seriesMod.emptySeries()
  const tfSn = core('tf').tfSeconds(tf)
  const yazimSn = core('tf').tfSeconds(yazimTf)
  const gerekenTabanBar = Math.ceil(kuyrukBar * (tfSn / yazimSn)) + Math.ceil(tfSn / yazimSn) + 2
  const bas = Math.max(0, taban.length - gerekenTabanBar)
  // Kova sinirina hizala, yoksa ilk kova eksik veriyle olusur.
  let hizaliBas = bas
  while (hizaliBas < taban.length && taban.time[hizaliBas] % tfSn !== 0) hizaliBas++
  const dilim = seriesMod.sliceSeries(taban, hizaliBas, taban.length)
  return seriesMod.resample(dilim, tfSn)
}

/**
 * UST ZAMAN DILIMI BAGLAMI (Y3) - CANLI ICIN ONBELLEK.
 *
 * Indikatoru ust dilimde kosmak ucuzdur (olculdu: 28.000 bar / 4h icin 0,09
 * sn) ama her tikta yapmak gereksiz. Dizin, ust dilimde YENI BIR BAR
 * KAPANDIGINDA yeniden kurulur.
 *
 * Bu baglam SINYAL KARARINA GIRMEZ; yalnizca ayrinti ekraninda bilgi satiri
 * olarak gosterilir. Olculdu (15m olaylari, 4h bolgeleri, dogru zamanlama):
 * ayni yonlu ust bolge yakinindaki olusum olaylari %30,3 tutuyor, tabani
 * %42,8; yani katki YOK, hatta ters yonde. Naif zamanlamayla (bar acilisi +
 * nihai sinirlar) ayni olcum +3,2 puan POZITIF gorunuyordu.
 */
const htfDurumu = { tf: null, ustTf: null, sonUstBar: 0, dizin: null, atrBul: null }

async function htfBaglamiHazirla (tf, indicatorParams) {
  const ustTf = UST_TF_ESLESME[tf]
  if (!ustTf) return null
  let ustSeri
  try {
    ustSeri = await loadSeriesFromStore(ustTf)
  } catch (err) {
    return null
  }
  if (!ustSeri || ustSeri.length < 200) return null
  const sonBar = ustSeri.time[ustSeri.length - 1]
  if (htfDurumu.tf === tf && htfDurumu.ustTf === ustTf && htfDurumu.sonUstBar === sonBar) {
    return htfDurumu
  }
  const ustSn = core('tf').tfSeconds(ustTf)
  let ind
  try {
    ind = core('indicator/proZones').runIndicator(
      ustSeri, Object.assign({}, indicatorParams || {}, { recordTimeline: true }), ustSn)
  } catch (err) {
    return null
  }
  const htf = core('learn/htfContext')
  const dizin = htf.buildHtfIndex(ind.timeline)
  const atr = ind.context && ind.context.atr ? ind.context.atr : null
  const zaman = ustSeri.time
  const atrBul = (tSec) => {
    if (!atr) return 0
    let lo = 0
    let hi = zaman.length - 1
    let son = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (zaman[mid] + ustSn <= tSec) { son = mid; lo = mid + 1 } else hi = mid - 1
    }
    return son >= 0 ? num(atr[son], 0) : 0
  }
  htfDurumu.tf = tf
  htfDurumu.ustTf = ustTf
  htfDurumu.sonUstBar = sonBar
  htfDurumu.dizin = dizin
  htfDurumu.atrBul = atrBul
  return htfDurumu
}

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
      logs: ['Sağlayıcıdan mum gelmedi.'],
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

  // Hacim duzeltmesi artik SABIT BIR OLCEK DEGIL: vekilin hacim ORANI
  // dagilimi spot seriye eslestiriliyor (V3). Bu yuzden "onceki turdan bilinen
  // katsayilari uygula" kisayolu KALDIRILDI; kisayol, tam yolun yazdigindan
  // baska hacimler uretir ve iki yol sessizce ayrisirdi. Duzeltme her turda
  // bastan hesaplanir (olculdu: 8 haftalik 1 dakikalik pencerede yaklasik
  // 10 ms, 20 saniyelik dongu icin onemsiz).
  // YAZIM ZAMAN DILIMI GRAFIKTEN FARKLI OLABILIR (V6).
  //
  // Canli akis 1 dakikalik depo varken 1 dakikalik bar ceker ve YALNIZCA
  // 1m'ye yazar; grafigin zaman dilimi ondan turetilir. Onceden her zaman
  // dilimi kendi dosyasina yaziyordu ve dosyalar sessizce ayrisiyordu
  // (olculdu: 5m 323 bar geride, 15m'de 181 fazla / 95 eksik bar).
  const yazimTf = typeof payload.writeTf === 'string' && payload.writeTf ? payload.writeTf : tf
  const yazimSn = yazimTf === tf ? tfSec : core('tf').tfSeconds(yazimTf)

  let basisYas = null
  if (payload.isProxy) {
    const loader = core('data/loader')
    try {
      // KARSILASTIRMA YAZIM ZAMAN DILIMINDE YAPILIR. Canli 1 dakikalik bar
      // cekerken grafik serisiyle (15m) karsilastirmak ortak zaman damgasi
      // birakmaz ve duzeltme her tikte basarisiz olur.
      const stored = await getSeries(yazimTf, false)
      const duzeltme = loader.normalizeProxy(stored, inc, {
        tfSec: yazimSn,
        proxyRanges: await loader.vekilAraliklariOku(paths.dataDir(), yazimTf),
      })
      if (duzeltme.ok) {
        basis = duzeltme.basis
        volScale = duzeltme.volScale
        basisComputed = true
        inc = duzeltme.series
        // Basisin YASI: kac saniyelik ortak bolgeden hesaplandigi degil,
        // depodaki son gercek barin uzerinden ne kadar gectigi. Canli
        // gerekcede gorunur, cunku eskimis bir basis sessizce yanlis fiyat
        // seviyesi uretir.
        if (stored && stored.length > 0) {
          // `fetchedAt` asagida tanimli; burada yuke bakariz (ayni deger).
          const cekimAni = num(payload.fetchedAt, Math.floor(Date.now() / 1000))
          basisYas = Math.max(0, cekimAni - stored.time[stored.length - 1])
        }
      } else {
        needsSync = true
        if (!basisWarned) {
          basisWarned = true
          logs.push('Vekil kaynak düzeltilemedi (' + duzeltme.reason + '), bar yazılmadı. Veri Çek ile boşluk kapatılmalı.')
        }
      }
    } catch (err) {
      needsSync = true
      logs.push('Vekil düzeltme hesaplanamadı: ' + (err && err.message ? err.message : String(err)))
    }
  }

  if (!inc || inc.length === 0) {
    return {
      tf: tf, added: 0, basis: basis, volScale: volScale, basisWarned: basisWarned,
      needsSync: needsSync, lastBar: null, events: [], labeled: 0,
      signal: null, touch: null,
      logs: logs.length ? logs : ['Düzeltmeden sonra yazılacak bar kalmadı.'],
    }
  }

  const lastBars = seriesMod.toBars(inc, inc.length - 1, inc.length)
  const lastBar = lastBars.length > 0 ? lastBars[0] : null

  // Kapanmis barlari ayikla (acik bar depoya yazilmaz). Olcut, isciye mesajin
  // ISLENDIGI an degil, saglayiciya istegin GONDERILDIGI andir: isci uzun bir
  // testle mesgulken (1m testi 53-60 sn) cekim aninda acik olan bar aksi
  // halde kapanmis sayilip yarim OHLCV ile kalici yaziliyordu.
  const fetchedAt = num(payload.fetchedAt, Math.floor(Date.now() / 1000))
  const closedEnd = seriesMod.closedEndIndex(inc.time, yazimSn, fetchedAt, inc.length)

  let added = 0
  let stored = false
  if (closedEnd > 0) {
    // Bu zaman diliminin kendi dosyasi varsa oraya yazariz. Yoksa ve seri 1m
    // deposundan yeniden ornekleniyorsa dosya ACMAYIZ: bir kac barlik yeni
    // dosya, yukleyicide 1m'den turetilen tam seriyi golgeler. O durumda bar
    // yalnizca bellekteki seriye eklenir.
    let tfStat = null
    try {
      tfStat = await binstore.statSeries(paths.candlePath(yazimTf))
    } catch (err) {
      tfStat = null
    }
    const hasTfStore = !!(tfStat && tfStat.count > 0)
    let baseHasData = false
    if (!hasTfStore && yazimTf !== '1m') {
      try {
        const baseStat = await binstore.statSeries(paths.candlePath('1m'))
        baseHasData = !!(baseStat && baseStat.count > 0)
      } catch (err) {
        baseHasData = false
      }
    }
    const canStore = hasTfStore || !baseHasData

    const lastStored = hasTfStore ? num(tfStat.lastTime, -1) : -1
    const cached = seriesCache.tf === yazimTf && seriesCache.series ? seriesCache.series : null
    const lastCached = cached && cached.length > 0 ? cached.time[cached.length - 1] : -1
    const lastKnown = Math.max(lastStored, lastCached)

    let startIdx = 0
    while (startIdx < closedEnd && inc.time[startIdx] <= lastKnown) startIdx++

    // BOSLUK DENETIMI: iki cekim arasinda piyasanin ACIK oldugu barlar
    // kacirildiysa bar eklemeyiz. Eksik barla devam etmek seride kalici bir
    // delik birakir; pivot, ATR ve hacim ortalamalari o delikten sonra
    // gecmisle tutarsiz hesaplanir. Bunun yerine senkron istenir.
    if (startIdx < closedEnd && lastKnown > 0 && inc.time[startIdx] - lastKnown > yazimSn) {
      const piyasaAcikMi = core('session').createMarketCalendar()
      let acikBosluk = 0
      for (let t = lastKnown + yazimSn; t < inc.time[startIdx]; t += yazimSn) {
        if (piyasaAcikMi(t)) acikBosluk++
        if (acikBosluk > 0) break
      }
      if (acikBosluk > 0) {
        needsSync = true
        logs.push('Canlı akışta boşluk var (' + new Date(lastKnown * 1000).toISOString() +
          ' sonrası), bar eklenmedi. Eksik dönem Veri Çek ile kapatılmalı.')
        startIdx = closedEnd
      }
    }

    if (startIdx < closedEnd) {
      const fresh = seriesMod.sliceSeries(inc, startIdx, closedEnd)
      if (canStore) {
        const res = await binstore.appendSeries(paths.candlePath(yazimTf), fresh)
        added = num(res && res.added, 0)
        stored = true
        // Turetilmis dosyalar artik guncel degil: izleri silinir ki yukleyici
        // bir sonraki okumada 1 dakikaliktan tazelesin. Dosyalarin kendisini
        // her tikte yeniden yazmak 1,2 milyon barlik 5m dosyasi icin
        // gereksiz bir maliyet olurdu.
        if (yazimTf === '1m') await turetilmisIzleriGecersizKil()
      } else {
        // Ayri dosya yoksa bar yalnizca bellekteki seriye eklenir; bu barlar
        // "eklendi" sayilmaz ki sonraki turda yeniden denensin.
        added = fresh.length
        if (!liveStoreWarned) {
          liveStoreWarned = true
          logs.push('Canlı barlar bellekte tutuluyor: ' + tf + ' serisi 1m deposundan türetiliyor, ayrı dosya açılmadı.')
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
  // Isci icindeki kontrol hatasi: bar yazildi ama sinyal uretilemedi.
  let kontrolHatasi = null
  if (added > 0) {
    try {
      // KUYRUK PENCERESI: indikatorun son barlari TAM SERIYLE AYNI hesaplamasi
      // icin gereken uzunluk. Sabit 4000 bar, 1 dakikalik grafikte ust zaman
      // dilimi EMA'sini isitmiyordu (15 dakikalik trend icin yalnizca 266 ust
      // bar) ve canli olay hafizadakinden farkli cikiyordu: olculdu, 1m canli
      // olaylarin %5,8'inde baglam vektoru, %2,4'unde trend ve skor,
      // %1,3'unde qualified bayragi farkliydi.
      // Indikator asagida `payload.params` ile kosturuluyor; kuyruk uzunlugu
      // da AYNI ayardan hesaplanmali. (Hafizanin meta'si bu kapsamda daha
      // asagida tanimli; oradan okumak sessiz bir ReferenceError uretiyordu.)
      const gerekenKuyruk = core('indicator/proZones').requiredTailBars(
        payload.params || null, tfSec)
      const tail = clampInt(payload.tailBars, 500, 50000,
        Math.max(DEFAULT_TAIL_BARS, gerekenKuyruk))
      // Canli 1 dakikalige yaziyorsa grafik serisi ONDAN turetilir: grafik
      // zaman diliminin dosyasi bu anda eskimistir.
      const s = await canliAnalizSerisi(tf, yazimTf, tail)
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
      // HACIM REJIMI KORUMASI (V3).
      //
      // Kutu kapisi `vR = hacim / SMA(hacim)` oranina bakar. Kaynak degisince
      // bu oran sessizce kayar: olculdu, ham PAXG 1 dakikalikta kapi %12,27
      // oraninda aciliyor, spot referansinda %3,13. Duzeltme calisiyorsa oran
      // referansa yakin kalmali; hala belirgin yuksekse o donemde uretilen
      // olaylar hafizadakilerle KARSILASTIRILAMAZ, bu yuzden sinyal
      // uretilmez.
      const rejim = await hacimRejimiKontrol(tf, s, tfSec)
      if (rejim && rejim.bozuk) {
        logs.push('Hacim rejimi kaymış (kapı oranı %' + (rejim.rate * 100).toFixed(1) +
          ', referans %' + (rejim.ref * 100).toFixed(1) + '), sinyal üretilmedi.')
      }
      // EKONOMIK TAKVIM (Y2): dosya yoksa null kalir ve hicbir sey degismez.
      // Her tikta diskten okumak yerine surec boyunca bir kez yuklenir.
      const canliTakvim = takvimOnbellek()
      // UST ZAMAN DILIMI BAGLAMI (Y3): yalnizca bilgi satiri, karara girmez.
      const canliHtf = await htfBaglamiHazirla(
        tf, memMeta && memMeta.indicatorParams ? memMeta.indicatorParams : null)
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
          logs.push('Yeni bölge olayı bulundu ama hafıza boş. Önce "Geçmişi Tara" çalıştırın.')
        } else if (izUyum === false) {
          cfgMismatch = true
          logs.push('Hafıza farklı bir ayarla kuruldu, sinyal üretilmedi. "Geçmişi Tara" çalıştırın.')
        }
      }
      const uretilebilir = hafizaVar && izUyum !== false && !(rejim && rejim.bozuk)
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
              cand, feats, mem, protos, canliCfg.signalCfg, num(cand.time, fetchedAt),
              // Yuksek etkili veri: karar ani barin KAPANISIDIR. Takvim yoksa
              // null gecer ve hicbir sey degismez.
              { news: canliTakvim
                ? core('calendar').nearestEvent(canliTakvim, num(cand.time, 0) + tfSec)
                : null }
            )
            if (sig && basis !== null && basis !== 0 && Array.isArray(sig.reasons)) {
              // Basisin DEGERI ve YASI birlikte yazilir: eskimis bir basis
              // sessizce yanlis fiyat seviyesi uretir, kullanici bunu
              // gerekcede gormeli.
              sig.reasons.push('Vekil kaynak fiyatı ' + basis.toFixed(2) + ' birim kaydırıldı' +
                (Number.isFinite(basisYas)
                  ? ' (depodaki son gerçek bar ' + Math.round(basisYas / 60) + ' dakika önce)'
                  : '') + '.')
            }
            // UST ZAMAN DILIMI BAGLAMI: bilgi, sinyale KATILMAZ.
            if (sig && canliHtf && canliHtf.dizin) {
              const htfMod = core('learn/htfContext')
              const karar = num(cand.time, 0) + tfSec
              const durum = htfMod.htfAt(canliHtf.dizin, karar, num(cand.price, 0),
                cand.direction === 'SELL' ? 'SELL' : 'BUY',
                { atr: canliHtf.atrBul(karar), nearAtr: 0.5 })
              sig.htf = {
                tf: canliHtf.ustTf,
                state: htfMod.htfSubset(durum),
                inside: durum.sameInside || durum.oppositeInside,
              }
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
          sig.reasons.push('Gecikmeli değerlendirildi (' + ageBars.toFixed(1) + ' bar sonra).')
        }
        // KANIT DURUMU: son olcumde bu TURUN katma degeri kanitlandi mi.
        // Olcum yoksa veya ayar izi degistiyse "kanitlanmadi" kabul edilir.
        if (sig) {
          // Tek kaynaktan metin: alt serit, gunluk ve masaustu bildirimi ayni
          // cumleyi kullansin.
          sig.summaryText = core('learn/signalText').sinyalOzeti(sig)
          const kanit = sonKanit && sonKanit[sig.kind === 'form' ? 'form' : 'touch']
          sig.evidence = kanit || { n: 0, netR: null, netRLo: null, netRHi: null, liftPts: null, status: 'kanitlanmadi' }
          if (sig.evidence.status !== 'kanitli') {
            if (!Array.isArray(sig.reasons)) sig.reasons = []
            sig.reasons.push(sig.evidence.status === 'zayif'
              ? 'Bu sinyal türünün katma değeri zayıf: son ölçümde aralık sıfırı içeriyor.'
              : 'Bu sinyal türünün katma değeri kanıtlanmadı (son ölçüme göre).')
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
        logs.push(ozellikYok + ' yeni bölge olayı bulundu ama özellik penceresi yetersiz.')
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
      // Gunluk satiri 12-20 saniyede kayboluyordu; hata artik durum
      // nesnesiyle de donuyor ve gostergede kalici olarak gorunuyor.
      kontrolHatasi = (err && err.message ? err.message : String(err))
      logs.push('Canlı kontrol hatası: ' + kontrolHatasi)
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
    // Isci icinde olusan kontrol hatasi (varsa). Gunluk satiri 12-20 saniyede
    // kayboluyordu; bu alan gostergede kalici olarak gorunur.
    checkError: kontrolHatasi,
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
      // Olay turu HAFIZADAKI olaydan okunur. Islem kaydinin kendisinde de
      // `kind` alani var (bkz. learn/backtest.js), ama olay bulunamazsa
      // burada dokunus varsayilir.
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
      // TEK KAYNAKTAN METIN: alt serit, gunluk, masaustu bildirimi ve grafik
      // isareti ayni cumleyi kullansin (bkz. learn/signalText.js).
      summaryText: core('learn/signalText').sinyalOzeti(t),
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

/**
 * Hafiza yazimindan kalan .tmp artiklarini siler.
 *
 * saveMemory uc gecici dosya yazip sirayla rename ediyor; arada cokme ya da
 * iptal olursa geride yarim bir .tmp kalir. Zararsizdir ama klasoru kirletir
 * ve "yazim yarida kaldi" izini gizler. Isci acilisinda bir kez temizlenir.
 */
const GECICI_YAS_SN = 3600

async function gecicileriTemizle () {
  try {
    const dir = paths.dataDir()
    const dosyalar = await fsp.readdir(dir)
    const simdi = Date.now()
    for (const ad of dosyalar) {
      if (!/_memory\..*\.tmp$/.test(ad)) continue
      const tam = path.join(dir, ad)
      try {
        // YALNIZCA ESKIMIS ARTIKLAR. Betikler (ornek: measure-all --scan)
        // uygulama acikken ayni klasore yazabiliyor; taze bir .tmp dosyasi
        // SUREN bir yazim olabilir ve silmek o kaydi bozar.
        const st = await fsp.stat(tam)
        if ((simdi - st.mtimeMs) / 1000 < GECICI_YAS_SN) continue
        await fsp.unlink(tam)
        log('Yarım kalmış hafıza geçici dosyası silindi: ' + ad)
      } catch (err) {
        // Baska bir surec kullaniyor olabilir, sessizce gec.
      }
    }
  } catch (err) {
    // Klasor okunamazsa temizlik yapilmaz; kritik degil.
  }
}
gecicileriTemizle()

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
