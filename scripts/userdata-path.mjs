// Electron olmadan uygulama veri klasorunu bulur.
//
// Betikler (import-legacy, fetch-history) Electron surecinin disinda calisir,
// bu yuzden `app.getPath('userData')` cagrilamaz. Yollarin tamami
// `src/core/paths-core.js` icinde hesaplanir; bu dosya yalnizca ESM yuzudur,
// boylece `src/main/paths.js` ile birebir ayni sonucu verir:
//
//   macOS   : ~/Library/Application Support/Zone Memory
//   Windows : %APPDATA%/Zone Memory
//   Linux   : ${XDG_CONFIG_HOME:-~/.config}/Zone Memory
//
// Ortam degiskenleri her seyin onunde gelir:
//   ZONE_MEMORY_USER_DIR -> kullanici veri koku
//   ZONE_MEMORY_DATA_DIR -> mum ve hafiza dosyalarinin klasoru

import { createRequire } from 'node:module'

// Cekirdek modul CommonJS oldugu icin createRequire ile yuklenir.
const require = createRequire(import.meta.url)
const cekirdek = require('../src/core/paths-core.js')

/** Uygulama klasorunun adi, Electron productName ile ayni olmali. */
export const APP_DIR_NAME = cekirdek.APP_DIR_NAME

/** Varsayilan sembol; dosya adlarinin onekidir. */
export const DEFAULT_SYMBOL = cekirdek.DEFAULT_SYMBOL

/**
 * Kullanici veri koku. settings.json bu klasorde durur.
 * @returns {string}
 */
export function userDataDir() {
  return cekirdek.userDir()
}

/**
 * Mum ve hafiza dosyalarinin klasoru: <userData>/data
 * @returns {string}
 */
export function dataDir() {
  return cekirdek.dataDir()
}

/**
 * Bir zaman dilimine ait mum deposunun tam yolu.
 * @param {string} tf '1m', '15m' gibi
 * @param {string} [symbol]
 * @param {string} [dir] Verilmezse dataDir() kullanilir
 * @returns {string}
 */
export function candlePath(tf, symbol, dir) {
  return cekirdek.candlePath(tf, symbol, dir)
}

/**
 * Hafiza kayitlarinin UZANTISIZ taban yolu.
 * @param {string} tf
 * @param {string} [symbol]
 * @param {string} [dir] Verilmezse dataDir() kullanilir
 * @returns {string}
 */
export function memoryPath(tf, symbol, dir) {
  return cekirdek.memoryPath(tf, symbol, dir)
}

/**
 * Ayar dosyasi yolu.
 * @returns {string}
 */
export function settingsPath() {
  return cekirdek.settingsPath()
}

/**
 * Veri klasorunu (ve ust klasorlerini) olusturur.
 * @param {string} [dir]
 * @returns {string} Olusturulan klasor
 */
export function ensureDataDir(dir) {
  return cekirdek.ensureDir(dir)
}
