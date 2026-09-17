'use strict'

/**
 * Uygulama dosya yollari.
 *
 * Yol birlestirme, ortam degiskeni onceligi ve klasor olusturma mantigi
 * `src/core/paths-core.js` icindedir; betikler de ayni modulu kullanir.
 * Bu dosyanin tek ek isi Electron icinde `app.getPath('userData')` degerini
 * varsayilan kok olarak vermektir.
 *
 * Electron disinda (scriptler, isci ipligi, testler) once
 * `ZONE_MEMORY_USER_DIR` / `ZONE_MEMORY_DATA_DIR` ortam degiskenlerine, o da
 * yoksa isletim sistemine gore varsayilan yola bakilir.
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

const core = require('../core/paths-core')

const APP_DIR_NAME = core.APP_DIR_NAME
const DEFAULT_SYMBOL = core.DEFAULT_SYMBOL

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

/**
 * Electron'un kullanici veri koku. Ortam degiskeni varsa paths-core bunu hic
 * cagirmaz, bu yuzden fonksiyon olarak gecilir.
 * @returns {string}
 */
function electronKok() {
  const app = electronApp()
  return app ? app.getPath('userData') : ''
}

/** Kullanici veri koku (settings.json burada durur). */
function userDataDir() {
  return core.userDir(electronKok)
}

/** Mum ve hafiza dosyalarinin bulundugu klasor. */
function dataDir() {
  return core.dataDir(electronKok)
}

/** Ayar dosyasi yolu. */
function settingsPath() {
  return core.settingsPath(electronKok)
}

/**
 * Mum deposu yolu.
 * @param {string} tf
 * @param {string} [symbol]
 */
function candlePath(tf, symbol) {
  return core.candlePath(tf, symbol, dataDir())
}

/**
 * Hafiza kayitlarinin UZANTISIZ taban yolu. memstore buna `.json` ve `.vec`
 * ekler; bu modulun yardimcilari da `.zones.json`, `.protos.json`,
 * `.signals.json` ekler.
 * @param {string} tf
 * @param {string} [symbol]
 */
function memoryPath(tf, symbol) {
  return core.memoryPath(tf, symbol, dataDir())
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

/**
 * Son yuruyen ileri test ozetinin yolu. Olcum diske yazilir, boylece
 * uygulama kapanip acildiginda "hangi ayarla ne olculdu" bilgisi kaybolmaz
 * (onceden her acilista ve zaman dilimi degisiminde siliniyordu).
 */
function backtestPath(tf, symbol) {
  return memoryPath(tf, symbol) + '.backtest.json'
}

/** Gerekli klasorleri olusturur, olusan yollari dondurur. */
function ensureDirs() {
  const user = core.ensureDir(userDataDir())
  const data = core.ensureDir(dataDir())
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
  backtestPath,
  ensureDirs,
}
