'use strict'

/**
 * Electron'suz saf yol hesabi.
 *
 * Hem `src/main/paths.js` (Electron icinde) hem de `scripts/*.mjs` betikleri
 * ayni yollari uretmek zorunda. Yol birlestirme, ortam degiskeni onceligi ve
 * klasor olusturma mantigi burada TEK yerde durur; Electron'a ozel olan tek
 * sey `app.getPath('userData')` degeridir ve o disaridan verilir.
 *
 * Yerlesim:
 *   <userDir>/settings.json
 *   <userDir>/data/XAUUSD_<tf>.bin           mum deposu (binstore)
 *   <userDir>/data/XAUUSD_<tf>_memory.json   hafiza ust verisi (memstore)
 *   <userDir>/data/XAUUSD_<tf>_memory.vec    ozellik vektorleri (memstore)
 *
 * Varsayilan kok:
 *   macOS   : ~/Library/Application Support/Zone Memory
 *   Windows : %APPDATA%/Zone Memory
 *   Linux   : ${XDG_CONFIG_HOME:-~/.config}/Zone Memory
 *
 * Ortam degiskenleri her seyin onunde gelir:
 *   ZONE_MEMORY_USER_DIR -> kullanici veri koku
 *   ZONE_MEMORY_DATA_DIR -> mum ve hafiza dosyalarinin klasoru
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/** Uygulama klasorunun adi, Electron productName ile ayni olmali. */
const APP_DIR_NAME = 'Zone Memory'

/** Varsayilan sembol; dosya adlarinin onekidir. */
const DEFAULT_SYMBOL = 'XAUUSD'

/** Hafiza dosyalarinin tasindigi yedek klasorunun adi. */
const ESKI_HAFIZA_KLASORU = '_eski_hafiza_yedek'

/**
 * Dize veya fonksiyon olarak verilen varsayilani cozer.
 * Fonksiyon YALNIZCA gerektiginde cagrilir; boylece Electron'un
 * `app.getPath` cagrisi ortam degiskeni varken hic yapilmaz.
 * @param {string|function():string|undefined} deger
 * @returns {string}
 */
function coz(deger) {
  if (typeof deger === 'function') {
    const sonuc = deger()
    return typeof sonuc === 'string' ? sonuc : ''
  }
  return typeof deger === 'string' ? deger : ''
}

/**
 * Isletim sistemine gore varsayilan kullanici veri koku (ortam degiskensiz).
 * @returns {string}
 */
function defaultUserDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME)
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, APP_DIR_NAME)
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, APP_DIR_NAME)
}

/**
 * Kullanici veri koku (settings.json burada durur).
 * @param {string|function():string} [varsayilan] Ortam degiskeni yoksa
 *   kullanilacak kok. Electron icinde `app.getPath('userData')` gecilir.
 * @returns {string}
 */
function userDir(varsayilan) {
  if (process.env.ZONE_MEMORY_USER_DIR) return process.env.ZONE_MEMORY_USER_DIR
  const ozel = coz(varsayilan)
  if (ozel) return ozel
  return defaultUserDir()
}

/**
 * Mum ve hafiza dosyalarinin klasoru: <userDir>/data
 * @param {string|function():string} [kok] Kullanici veri koku
 * @returns {string}
 */
function dataDir(kok) {
  if (process.env.ZONE_MEMORY_DATA_DIR) return process.env.ZONE_MEMORY_DATA_DIR
  return path.join(userDir(kok), 'data')
}

/**
 * Ayar dosyasi yolu.
 * @param {string|function():string} [kok] Kullanici veri koku
 * @returns {string}
 */
function settingsPath(kok) {
  return path.join(userDir(kok), 'settings.json')
}

/**
 * Mum deposu yolu.
 * @param {string} tf '1m', '15m' gibi
 * @param {string} [symbol]
 * @param {string} [dir] Verilmezse dataDir() kullanilir
 * @returns {string}
 */
function candlePath(tf, symbol, dir) {
  return path.join(dir || dataDir(), (symbol || DEFAULT_SYMBOL) + '_' + tf + '.bin')
}

/**
 * Hafiza kayitlarinin UZANTISIZ taban yolu. memstore buna `.json` ve `.vec`
 * ekler; cagiranlar `.zones.json`, `.protos.json`, `.signals.json` ekler.
 * @param {string} tf
 * @param {string} [symbol]
 * @param {string} [dir] Verilmezse dataDir() kullanilir
 * @returns {string}
 */
function memoryPath(tf, symbol, dir) {
  return path.join(dir || dataDir(), (symbol || DEFAULT_SYMBOL) + '_' + tf + '_memory')
}

/**
 * Bir dosyanin hafiza kaydi olup olmadigini soyler.
 * '<sembol>_<tf>_memory' ile baslayan her dosya (json, vec, zones, protos,
 * signals) bu kapsama girer.
 * @param {string} ad Dosya adi (klasorsuz)
 * @param {string} [symbol]
 * @returns {boolean}
 */
function isMemoryFile(ad, symbol) {
  const onek = (symbol || DEFAULT_SYMBOL) + '_'
  if (ad.indexOf(onek) !== 0) return false
  return ad.indexOf('_memory') > onek.length - 1
}

/**
 * Uzerine yazilacak bir dosyanin yedek yolu: '<ad>.bak-<damga>'
 * @param {string} yol
 * @param {string} damga 'YYYYMMDD-HHMMSS'
 * @returns {string}
 */
function yedekYolu(yol, damga) {
  return yol + '.bak-' + damga
}

/**
 * Aktarim sonrasi eski hafizalarin tasinacagi klasor:
 * '<dataDir>/_eski_hafiza_yedek/<damga>'
 * @param {string} veriKlasoru
 * @param {string} damga 'YYYYMMDD-HHMMSS'
 * @returns {string}
 */
function eskiHafizaKlasoru(veriKlasoru, damga) {
  return path.join(veriKlasoru, ESKI_HAFIZA_KLASORU, damga)
}

/**
 * Klasoru (ve ust klasorlerini) olusturur.
 * @param {string} [dir] Verilmezse dataDir() kullanilir
 * @returns {string} Olusturulan klasor
 */
function ensureDir(dir) {
  const hedef = dir || dataDir()
  fs.mkdirSync(hedef, { recursive: true })
  return hedef
}

module.exports = {
  APP_DIR_NAME,
  DEFAULT_SYMBOL,
  ESKI_HAFIZA_KLASORU,
  defaultUserDir,
  userDir,
  dataDir,
  settingsPath,
  candlePath,
  memoryPath,
  isMemoryFile,
  yedekYolu,
  eskiHafizaKlasoru,
  ensureDir,
}
