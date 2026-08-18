'use strict'

/**
 * Uygulama dosya yollari.
 *
 * Electron icinde `app.getPath('userData')` kullanilir. Electron disinda
 * (scriptler, isci ipligi, testler) once `ZONE_MEMORY_DATA_DIR` ortam
 * degiskenine, o da yoksa isletim sistemine gore varsayilan yola bakilir.
 *
 * Yerlesim:
 *   <userData>/settings.json
 *   <userData>/data/XAUUSD_<tf>.bin           mum deposu (binstore)
 *   <userData>/data/XAUUSD_<tf>_memory.json   hafiza ust verisi (memstore)
 *   <userData>/data/XAUUSD_<tf>_memory.vec    ozellik vektorleri (memstore)
 *   <userData>/data/XAUUSD_<tf>_memory.zones.json
 *   <userData>/data/XAUUSD_<tf>_memory.protos.json
 *   <userData>/data/XAUUSD_<tf>_memory.signals.json
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const APP_DIR_NAME = 'Zone Memory'
const DEFAULT_SYMBOL = 'XAUUSD'

/**
 * Electron `app` nesnesini guvenli sekilde bulur.
 * Isci ipliginde veya duz Node'da `require('electron')` bir yol dizesi
 * dondurebilir; bu yuzden `getPath` var mi diye bakariz.
 * @returns {object|null}
 */
function electronApp() {
  try {
    const electron = require('electron')
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app
    }
  } catch (err) {
    // Electron yok, duz Node ortamindayiz.
  }
  return null
}

/** Isletim sistemine gore varsayilan kullanici veri koku. */
function defaultUserDataDir() {
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

/** Kullanici veri koku (settings.json burada durur). */
function userDataDir() {
  if (process.env.ZONE_MEMORY_USER_DIR) return process.env.ZONE_MEMORY_USER_DIR
  const app = electronApp()
  if (app) return app.getPath('userData')
  return defaultUserDataDir()
}

/** Mum ve hafiza dosyalarinin bulundugu klasor. */
function dataDir() {
  if (process.env.ZONE_MEMORY_DATA_DIR) return process.env.ZONE_MEMORY_DATA_DIR
  return path.join(userDataDir(), 'data')
}

/** Ayar dosyasi yolu. */
function settingsPath() {
  return path.join(userDataDir(), 'settings.json')
}

/**
 * Mum deposu yolu.
 * @param {string} tf
 * @param {string} [symbol]
 */
function candlePath(tf, symbol) {
  return path.join(dataDir(), (symbol || DEFAULT_SYMBOL) + '_' + tf + '.bin')
}

/**
 * Hafiza kayitlarinin UZANTISIZ taban yolu. memstore buna `.json` ve `.vec`
 * ekler; bu modulun yardimcilari da `.zones.json`, `.protos.json`,
 * `.signals.json` ekler.
 * @param {string} tf
 * @param {string} [symbol]
 */
function memoryPath(tf, symbol) {
  return path.join(dataDir(), (symbol || DEFAULT_SYMBOL) + '_' + tf + '_memory')
}

/** Kayitli bolge listesi yolu. */
function zonesPath(tf, symbol) {
  return memoryPath(tf, symbol) + '.zones.json'
}

/** Kayitli prototip listesi yolu. */
function protosPath(tf, symbol) {
  return memoryPath(tf, symbol) + '.protos.json'
}

/** Uretilmis gecmis sinyaller yolu. */
function signalsPath(tf, symbol) {
  return memoryPath(tf, symbol) + '.signals.json'
}

/** Gerekli klasorleri olusturur, olusan yollari dondurur. */
function ensureDirs() {
  const user = userDataDir()
  const data = dataDir()
  fs.mkdirSync(user, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  return { userDataDir: user, dataDir: data }
}

module.exports = {
  APP_DIR_NAME,
  DEFAULT_SYMBOL,
  userDataDir,
  dataDir,
  settingsPath,
  candlePath,
  memoryPath,
  zonesPath,
  protosPath,
  signalsPath,
  ensureDirs,
}
