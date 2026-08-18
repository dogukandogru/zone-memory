// Electron olmadan uygulama veri klasorunu bulur.
//
// Betikler (import-legacy, fetch-history) Electron surecinin disinda calisir,
// bu yuzden `app.getPath('userData')` cagrilamaz. Burada ayni yollar isletim
// sistemine gore elle hesaplanir ve `src/main/paths.js` ile birebir ayni
// sonucu verir:
//
//   macOS   : ~/Library/Application Support/Zone Memory
//   Windows : %APPDATA%/Zone Memory
//   Linux   : ${XDG_CONFIG_HOME:-~/.config}/Zone Memory
//
// Ortam degiskenleri her seyin onunde gelir:
//   ZONE_MEMORY_USER_DIR -> kullanici veri koku
//   ZONE_MEMORY_DATA_DIR -> mum ve hafiza dosyalarinin klasoru

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Uygulama klasorunun adi, Electron productName ile ayni olmali. */
export const APP_DIR_NAME = 'Zone Memory'

/** Varsayilan sembol; dosya adlarinin onekidir. */
export const DEFAULT_SYMBOL = 'XAUUSD'

/**
 * Isletim sistemine gore varsayilan kullanici veri koku.
 * @returns {string}
 */
function varsayilanKok() {
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
 * Kullanici veri koku. settings.json bu klasorde durur.
 * @returns {string}
 */
export function userDataDir() {
  if (process.env.ZONE_MEMORY_USER_DIR) return process.env.ZONE_MEMORY_USER_DIR
  return varsayilanKok()
}

/**
 * Mum ve hafiza dosyalarinin klasoru: <userData>/data
 * @returns {string}
 */
export function dataDir() {
  if (process.env.ZONE_MEMORY_DATA_DIR) return process.env.ZONE_MEMORY_DATA_DIR
  return path.join(userDataDir(), 'data')
}

/**
 * Bir zaman dilimine ait mum deposunun tam yolu.
 * @param {string} tf '1m', '15m' gibi
 * @param {string} [symbol]
 * @param {string} [dir] Verilmezse dataDir() kullanilir
 * @returns {string}
 */
export function candlePath(tf, symbol, dir) {
  return path.join(dir || dataDir(), (symbol || DEFAULT_SYMBOL) + '_' + tf + '.bin')
}

/**
 * Veri klasorunu (ve ust klasorlerini) olusturur.
 * @param {string} [dir]
 * @returns {string} Olusturulan klasor
 */
export function ensureDataDir(dir) {
  const hedef = dir || dataDir()
  fs.mkdirSync(hedef, { recursive: true })
  return hedef
}
