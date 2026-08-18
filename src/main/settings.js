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
  indicatorParams: coreConst('../core/indicator/masterTouch', 'DEFAULT_PARAMS', {}),
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
  livePollSeconds: 20,
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

/** Bellek onbellegi, her cagrida diskten okumamak icin. */
let cache = null

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
  cache = deepMerge(DEFAULTS, parsed || {})
  return deepClone(cache)
}

/**
 * Verilen nesneyi (kismi olabilir) mevcut ayarlarin uzerine yazar ve diske
 * atomik olarak kaydeder.
 * @param {object} patch
 * @returns {object} Guncel tam ayar nesnesi
 */
function save(patch) {
  const current = load()
  const next = deepMerge(current, patch || {})
  const file = paths.settingsPath()
  const tmp = file + '.tmp'
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  cache = next
  return deepClone(next)
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

/** Onbellegi bosaltir (test ve veri klasoru degisimi icin). */
function reset() {
  cache = null
}

module.exports = {
  DEFAULTS,
  load,
  save,
  get,
  set,
  reset,
  deepMerge,
}
