'use strict'

/**
 * Ayarlar. Tek bir JSON dosyasinda tutulur, okurken DEFAULTS ile derin
 * birlestirilir, yazarken once .tmp dosyasina yazilip rename edilir (atomik).
 *
 * Not: Varsayilan indikator/sonuc/sinyal ayarlari cekirdek modullerden
 * REQUIRE edilerek alinir, kopyalanmaz. Boylece cekirdek degisince ayarlar
 * kendiliginden guncel kalir. Cekirdek modul henuz yoksa (paralel gelistirme)
 * bos nesne kullanilir; ilgili modul zaten kendi varsayilanini uygular.
 */

const fs = require('fs')
const path = require('path')
const paths = require('./paths')

/** Cekirdek modulden sabit okur, modul yoksa yedek degeri dondurur. */
function coreConst(modulePath, name, fallback) {
  try {
    const mod = require(modulePath)
    const val = mod && mod[name]
    if (val && typeof val === 'object') return val
  } catch (err) {
    // Modul henuz yazilmamis olabilir, sessizce yedege dus.
  }
  return fallback
}

const DEFAULTS = {
  symbol: 'XAUUSD',
  timeframe: '5m',
  indicatorParams: coreConst('../core/indicator/proZones', 'DEFAULT_PARAMS', {}),
  outcomeCfg: coreConst('../core/learn/outcome', 'DEFAULT_OUTCOME_CFG', {}),
  signalCfg: coreConst('../core/learn/signal', 'DEFAULT_SIGNAL_CFG', {}),
  // Canli varsayilani Binance PAXGUSDT'dir. Yahoo (GC=F) olculdu ve bu agdan
  // tekrarli isteklerde HTTP 429 (hiz siniri) donuyor, yani canli takip icin
  // guvenilir degil. Binance anahtarsiz, gercek zamanli ve gercek hacimli
  // calisiyor; PAXG fiziki altina dayali oldugu icin spot XAUUSD'yi yakindan
  // izler, aradaki seviye farki basis duzeltmesiyle kapatilir (loader.js).
  // En dogru canli spot fiyat icin Polygon (C:XAUUSD) anahtari onerilir.
  providers: { history: 'histdata', live: 'binance' },
  apiKeys: { twelvedata: '', polygon: '' },
  // GERIYE TEST VE PLAN MALIYETI
  // Islem maliyeti ve kayma olcumun en belirleyici girdisidir (1 dakikalikta
  // brut edimin tamamini yiyor) ama bir donem yalnizca kodda sabitti ve
  // kullanici kendi spreadini giremiyordu. Tek kaynak burasidir: tarama,
  // test ve plan hesabi bu degerleri kullanir.
  backtestCfg: {
    // Fiyata oranli maliyet (gidis-donus). 0.000068 = 4400 dolarlik altinda
    // yaklasik 0,30 dolar.
    costPct: 0.000068,
    // Sabit dolar maliyet; yalnizca costPct 0 ise kullanilir.
    costUsd: 0,
    // Limit emirde beklenen kayma, ATR biriminde (giris aleyhine eklenir).
    slippageAtr: 0,
    // Tur ve yon basina asgari aday sayisi (isinma olcutu).
    warmupPerBucket: 100,
  },
  livePollSeconds: 20,
  // Uygulama acilir acilmaz canli takibi kendiliginden baslatir. Kapatmak
  // istersen Ayarlar ekranindan kapatabilirsin; basarisiz olursa uygulama
  // normal calismaya devam eder, yalnizca uyari gosterilir.
  autoStartLive: true,
  // Zaman dilimi degistirildiginde (ve acilista) eksik mumlari indirir,
  // gerekiyorsa hafizayi yeniden kurar. Geriye test buna DAHIL DEGILDIR;
  // o, kullanicinin Test sekmesinden baslattigi ayri ve uzun bir istir.
  autoPrepareOnTfChange: true,
  theme: 'dark',
}

/** Duz nesne mi (dizi ve null degil). */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Derin kopya (JSON uyumlu degerler icin). */
function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone)
  if (isPlainObject(v)) {
    const out = {}
    for (const k of Object.keys(v)) out[k] = deepClone(v[k])
    return out
  }
  return v
}

/**
 * `base` uzerine `patch` degerlerini derin yazar. Diziler tumuyle degisir.
 * base degistirilmez, yeni nesne doner.
 */
function deepMerge(base, patch) {
  const out = deepClone(base)
  if (!isPlainObject(patch)) return out
  for (const key of Object.keys(patch)) {
    const pv = patch[key]
    if (pv === undefined) continue
    if (isPlainObject(pv) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], pv)
    } else {
      out[key] = deepClone(pv)
    }
  }
  return out
}

/** Nokta ile ayrilmis yoldan deger okur: 'apiKeys.polygon'. */
function getPath(obj, key) {
  const parts = String(key).split('.')
  let cur = obj
  for (const p of parts) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined
    cur = cur[p]
    if (cur === undefined) return undefined
  }
  return cur
}

/** Nokta ile ayrilmis yola deger yazar, ara nesneleri olusturur. */
function setPath(obj, key, val) {
  const parts = String(key).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (!isPlainObject(cur[p])) cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = deepClone(val)
  return obj
}

/**
 * ESKI INDIKATOR AYARLARINI TEMIZLEME
 * ---------------------------------------------------------------------------
 * Uygulama once MASTER 1 TOUCH indikatoruyle (masterTouch.js) calisiyordu ve
 * kullanicilarin diskinde o indikatorun parametreleri duruyor. Yeni indikator
 * (proZones.js) bazi anahtar adlarini PAYLASIYOR ama anlamlari veya olcekleri
 * farkli:
 *   minScoreForSignal  eskiden 9 bilesenli skor icin 5 idi, yenide skor
 *                      5 bilesenli; 5 degeri "tum bilesenler dogru olsun"
 *                      demeye gelir ve neredeyse hicbir sinyal kalmaz
 *   strongScoreLevel   eski 6, yeni skorun tavani 5
 *   hardSessionGate    eskiden true ve yalnizca Londra + New York acikti,
 *                      yeni indikator seansi sert kapi olarak kullanmiyor
 *   boxLengthBars      eski 120, Pine'daki karsiligi 100
 * Bu yuzden eski semanin izi (`lookback` / `boxWidthAtr` / `minFlowStrength`
 * gibi yalnizca eski indikatorde bulunan alanlar) varsa indikator ayarlari
 * tumuyle varsayilana dondurulur. Kullanicinin sonuc, sinyal ve saglayici
 * ayarlarina dokunulmaz.
 */
const ESKI_INDIKATOR_ALANLARI = ['lookback', 'boxWidthAtr', 'minFlowStrength', 'mergeNearAtr']

function indikatorAyariniGocur(parsed) {
  if (!isPlainObject(parsed) || !isPlainObject(parsed.indicatorParams)) return parsed
  const p = parsed.indicatorParams
  let eski = false
  for (const alan of ESKI_INDIKATOR_ALANLARI) {
    if (Object.prototype.hasOwnProperty.call(p, alan)) { eski = true; break }
  }
  if (!eski) return parsed
  const out = deepClone(parsed)
  delete out.indicatorParams
  return out
}

/**
 * SAYISAL AYAR SINIRLARI
 * ---------------------------------------------------------------------------
 * Arayuzdeki min/max yalnizca HTML ozniteligidir, tarayici bunu zorlamaz ve
 * bos birakilan alan 0 olarak gelebilir. Sinir disi bir esik sessizce
 * kaydedilirse sonuclari anlasilmaz olur: minMatches 0 ise her olay sinyal
 * olur, minSimilarity 5 ise hicbir olay eslesmez. Bu yuzden yazmadan once
 * sayilar buradaki araliklara kirpilir; sayi olmayan veya sonsuz degerlerde
 * onceki deger korunur.
 */
const SINIRLAR = {
  livePollSeconds: [3, 3600],
  'backtestCfg.costPct': [0, 0.01],
  'backtestCfg.costUsd': [0, 100],
  'backtestCfg.slippageAtr': [0, 2],
  'backtestCfg.warmupPerBucket': [0, 5000],
  'signalCfg.k': [1, 200],
  'signalCfg.minSimilarity': [0, 0.999],
  'signalCfg.minMatches': [1, 1000],
  'signalCfg.minWinRate': [0, 1],
  'signalCfg.minRr': [0, 10],
  'signalCfg.minExpectancy': [-1, 5],
  'signalCfg.tp1Pct': [1, 99],
  'signalCfg.tp2Pct': [1, 99],
  'signalCfg.slPct': [1, 99],
  'signalCfg.excludeWithinSec': [0, 86400 * 365],
  'outcomeCfg.horizonBars': [1, 5000],
  'outcomeCfg.targetAtr': [0, 20],
  'outcomeCfg.breakBufferAtr': [0, 20],
  'outcomeCfg.minTargetAtr': [0, 20],
  'outcomeCfg.formTargetRr': [0, 10],
  'outcomeCfg.maxFormRiskAtr': [0, 50],
  'outcomeCfg.tpAtr': [0, 20],
  'outcomeCfg.slAtr': [0, 20],
  'indicatorParams.pivotLen': [1, 100],
  'indicatorParams.atrLen': [1, 500],
  'indicatorParams.zoneAtrMult': [0.01, 10],
  'indicatorParams.mergeAtrMult': [0, 10],
  'indicatorParams.maxZones': [1, 500],
  'indicatorParams.maxAgeBars': [1, 5000],
  'indicatorParams.touchCooldown': [0, 1000],
  'indicatorParams.boxLengthBars': [1, 5000],
  'indicatorParams.volumeLen': [1, 1000],
  'indicatorParams.minVolRatio': [0, 100],
  'indicatorParams.minFlowToShow': [0, 10],
  'indicatorParams.bbLen': [2, 1000],
  'indicatorParams.bbMult': [0, 10],
  'indicatorParams.breakAtrMult': [0, 10],
  'indicatorParams.minScoreForSignal': [0, 5],
  'indicatorParams.strongScoreLevel': [0, 5],
  'indicatorParams.strongFlowLevel': [0, 10],
  'indicatorParams.wickMinRatio': [0, 1],
  'indicatorParams.emaFastLen': [1, 1000],
  'indicatorParams.emaSlowLen': [1, 2000],
  'indicatorParams.mintick': [1e-8, 1000],
}

/** Bilinen zaman dilimleri; gecersiz timeframe yazilmasin diye. */
const TF_LISTESI = coreConst('../core/tf', 'TF_SECONDS', {})

/**
 * Yazilacak ayar nesnesindeki sayisal degerleri SINIRLAR araliklarina kirpar.
 * Sayi olmayan degerde `current` icindeki onceki deger korunur.
 * @param {object} next Yazilacak tam ayar nesnesi
 * @param {object} current Diskteki mevcut tam ayar nesnesi
 */
function sinirla(next, current) {
  const out = deepClone(next)
  for (const yol of Object.keys(SINIRLAR)) {
    const ham = getPath(out, yol)
    if (ham === undefined) continue
    const [alt, ust] = SINIRLAR[yol]
    const deger = typeof ham === 'number' ? ham : Number(ham)
    if (!Number.isFinite(deger)) {
      const eski = getPath(current, yol)
      if (eski !== undefined) setPath(out, yol, eski)
      continue
    }
    setPath(out, yol, Math.min(ust, Math.max(alt, deger)))
  }
  const tf = out.timeframe
  if (tf !== undefined && !Object.prototype.hasOwnProperty.call(TF_LISTESI, String(tf))) {
    out.timeframe = current.timeframe
  }
  return out
}

/**
 * AYAR DOSYASI YALNIZCA KULLANICININ DEGISTIRDIGI ALANLARI TUTAR
 * ---------------------------------------------------------------------------
 * Onceden `save` birlesik nesnenin TAMAMINI yaziyordu. Bunun iki kotu sonucu
 * vardi: (1) cekirdek varsayilanlari veya zaman dilimi hazir ayarlari
 * degistiginde kullaniciya hic ulasmiyordu, (2) hazir ayarlar fiilen hic
 * devreye girmiyordu, cunku dosyadaki her alan "kullanici boyle istedi"
 * sayiliyordu. Artik diske yalnizca DEFAULTS'tan FARKLI alanlar ve
 * `settingsVersion` yazilir; hazir ayar katmani arada calisir
 * (bkz. core/learn/presets.js resolveCfg).
 */
const SETTINGS_VERSION = 2

/**
 * Kullanici yamasindaki alanlar: bu alanlar varsayilana esit olsa bile
 * korunur, cunku hazir ayar onlari ezmesin diye ACIKCA secilmis olabilirler.
 */
const HAZIR_AYARIN_YONETTIGI = [
  'outcomeCfg.targetAtr',
  'signalCfg.minSimilarity',
  'signalCfg.minMatches',
  'signalCfg.minWinRate',
]

/** Nesnedeki tum yaprak yollarini (nokta ile) toplar. */
function yapraklar(obj, onek, out) {
  const liste = out || []
  if (!isPlainObject(obj)) return liste
  for (const k of Object.keys(obj)) {
    const yol = onek ? onek + '.' + k : k
    if (isPlainObject(obj[k])) yapraklar(obj[k], yol, liste)
    else liste.push(yol)
  }
  return liste
}

/**
 * `tam` nesnesinin `taban` ile ayni olmayan alanlarini dondurur (derin fark).
 * @param {object} tam
 * @param {object} taban
 * @returns {object}
 */
function fark(tam, taban) {
  const out = {}
  if (!isPlainObject(tam)) return out
  for (const k of Object.keys(tam)) {
    const a = tam[k]
    const b = isPlainObject(taban) ? taban[k] : undefined
    if (isPlainObject(a) && isPlainObject(b)) {
      const alt = fark(a, b)
      if (Object.keys(alt).length > 0) out[k] = alt
    } else if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = deepClone(a)
    } else if (a !== b) {
      out[k] = deepClone(a)
    }
  }
  return out
}

/**
 * Diske yazilacak yamayi uretir: varsayilandan farkli her alan, ayrica
 * kullanicinin daha once veya bu cagrida acikca verdigi alanlar.
 */
function yamayiUret(birlesik, oncekiYama, gelenYama) {
  const yama = fark(birlesik, DEFAULTS)
  const korunacak = new Set()
  for (const yol of yapraklar(oncekiYama || {})) {
    if (HAZIR_AYARIN_YONETTIGI.indexOf(yol) >= 0) korunacak.add(yol)
  }
  for (const yol of yapraklar(gelenYama || {})) korunacak.add(yol)
  for (const yol of korunacak) {
    const deger = getPath(birlesik, yol)
    if (deger !== undefined) setPath(yama, yol, deger)
  }
  delete yama.settingsVersion
  return yama
}

/**
 * Eski surumden gelen ayar dosyasini yeni bicime cevirir: kullanicinin sinyal
 * ve sonuc ayarlari AYNEN korunur (canli davranis degismesin), yalnizca
 * `signalCfg.outcomeCfg` (dosyada `null` duruyordu ve plan hedefini
 * varsayilana dusuruyordu) atilir. Diger alanlarda varsayilana esit olanlar
 * yamadan cikar.
 * @param {object} parsed Diskten okunan ham nesne
 * @returns {{yama:object, gocuruldu:boolean}}
 */
function ayarGocu(parsed) {
  const ham = indikatorAyariniGocur(parsed || {})
  if (num(ham.settingsVersion) === SETTINGS_VERSION) {
    const yama = deepClone(ham)
    delete yama.settingsVersion
    return { yama: yama, gocuruldu: false }
  }
  const birlesik = deepMerge(DEFAULTS, ham)
  const yama = fark(birlesik, DEFAULTS)
  // Kullanicinin esikleri aynen korunur.
  if (isPlainObject(ham.signalCfg)) {
    const s = deepClone(ham.signalCfg)
    delete s.outcomeCfg
    yama.signalCfg = Object.assign({}, yama.signalCfg || {}, s)
  }
  if (isPlainObject(ham.outcomeCfg)) {
    yama.outcomeCfg = Object.assign({}, yama.outcomeCfg || {}, deepClone(ham.outcomeCfg))
  }
  delete yama.settingsVersion
  return { yama: yama, gocuruldu: true }
}

/** Sayiya cevirir, olmazsa NaN. */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** Bellek onbellegi, her cagrida diskten okumamak icin. */
let cache = null
/** Kullanicinin acikca degistirdigi alanlar (diske yazilan yama). */
let patchCache = null

/** Ayarlari diskten okur ve DEFAULTS ile birlestirir. */
function load() {
  if (cache) return deepClone(cache)
  let raw = null
  try {
    raw = fs.readFileSync(paths.settingsPath(), 'utf8')
  } catch (err) {
    raw = null
  }
  let parsed = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      // Bozuk dosya: varsayilanlara don, dosyayi ilk kayitta duzeltiriz.
      parsed = null
    }
  }
  const goc = ayarGocu(parsed || {})
  patchCache = goc.yama
  cache = deepMerge(DEFAULTS, patchCache)
  if (goc.gocuruldu && raw) {
    // Dosyayi yeni bicime cevir; basarisiz olursa bellekteki hali gecerlidir.
    try {
      yaz(cache)
    } catch (err) {
      // Salt okunur klasor olabilir, sessizce gec.
    }
  }
  return deepClone(cache)
}

/**
 * Kullanicinin acikca degistirdigi alanlar. Tarama, test ve canli bu yamayi
 * hazir ayar katmaniyla birlestirir (presets.resolveCfg).
 * @returns {object}
 */
function loadPatch() {
  load()
  return deepClone(patchCache || {})
}

/**
 * Verilen nesneyi (kismi olabilir) mevcut ayarlarin uzerine yazar ve diske
 * atomik olarak kaydeder.
 * @param {object} patch
 * @returns {object} Guncel tam ayar nesnesi
 */
function save(patch) {
  const current = load()
  const next = sinirla(deepMerge(current, patch || {}), current)
  return yaz(next, patch || {})
}

/**
 * Verilen TAM ayar nesnesini diske yazar (birlestirme yapmaz, eski anahtarlar
 * dusertir). Varsayilanlara donus icin gereklidir: `save` derin birlestirdigi
 * icin dosyada kalan fazla anahtarlari silemez.
 * @param {object} next
 * @returns {object} Guncel tam ayar nesnesi
 */
function replace(next) {
  const current = load()
  const birlesik = sinirla(deepMerge(DEFAULTS, next || {}), current)
  // Onceki yamayi tasimayiz: replace "yalnizca bunlar kaldi" demektir.
  patchCache = {}
  return yaz(birlesik, next || {})
}

/**
 * Ayarlari atomik olarak diske yazar. Dosyaya yalnizca kullanicinin
 * degistirdigi alanlar ve surum numarasi gider.
 * @param {object} birlesik Tam (varsayilanlarla birlesmis) ayar nesnesi
 * @param {object} [gelenYama] Bu cagrida acikca verilen alanlar
 */
function yaz(birlesik, gelenYama) {
  const yama = yamayiUret(birlesik, patchCache, gelenYama)
  const govde = Object.assign({ settingsVersion: SETTINGS_VERSION }, yama)
  const file = paths.settingsPath()
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(govde, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  patchCache = yama
  cache = deepMerge(DEFAULTS, yama)
  return deepClone(cache)
}

/**
 * Tek bir ayari okur. Anahtar verilmezse tum ayarlari dondurur.
 * @param {string} [key] 'theme' veya 'apiKeys.polygon' gibi
 */
function get(key) {
  const all = load()
  if (key === undefined || key === null || key === '') return all
  return getPath(all, key)
}

/**
 * Tek bir ayari yazar ve diske kaydeder.
 * @param {string} key
 * @param {*} val
 * @returns {object} Guncel tam ayar nesnesi
 */
function set(key, val) {
  const all = load()
  setPath(all, key, val)
  return save(all)
}

/**
 * `settings:set` yuk bicimini tek yerde cozer. Arayuz uc bicimde cagiriyordu
 * ve ipc yalnizca birini taniyordu; ciplak yama gonderildiginde `save({})`
 * calisiyor, yani hicbir degisiklik kaydedilmiyordu (ekranda "kaydedildi"
 * yazmasina ragmen). DEFAULTS icinde key, patch veya value adinda ust duzey
 * bir alan olmadigi icin ciplak yamayi tanimak guvenlidir.
 * @param {{key?:string, value?:*, patch?:object}|object} p
 * @returns {object} Guncel tam ayar nesnesi
 */
function applySetPayload(p) {
  if (!isPlainObject(p)) return load()
  if (p.key !== undefined && p.key !== null && p.key !== '') return set(p.key, p.value)
  if (isPlainObject(p.patch)) return save(p.patch)
  if (isPlainObject(p.value)) return save(p.value)
  return save(p)
}

/**
 * Varsayilanlara doner ama API anahtarlarini, saglayici secimini ve acik olan
 * zaman dilimini KORUR. Anahtarlarin tek kopyasi bu dosyadadir; sifirlama
 * onlari silerse kullanici ucretli saglayiciya yeniden abone olmak zorunda
 * kalabilir.
 * @returns {object} Guncel tam ayar nesnesi
 */
function varsayilanlaraDon() {
  const current = load()
  const next = deepClone(DEFAULTS)
  next.apiKeys = deepClone(current.apiKeys || DEFAULTS.apiKeys)
  next.providers = deepClone(current.providers || DEFAULTS.providers)
  next.timeframe = current.timeframe || DEFAULTS.timeframe
  return replace(next)
}

/** Onbellegi bosaltir (test ve veri klasoru degisimi icin). */
function reset() {
  cache = null
}

module.exports = {
  DEFAULTS,
  SINIRLAR,
  SETTINGS_VERSION,
  load,
  loadPatch,
  save,
  replace,
  applySetPayload,
  varsayilanlaraDon,
  get,
  set,
  reset,
  deepMerge,
  sinirla,
}
