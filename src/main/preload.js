'use strict'

/**
 * Preload. Renderer'a yalnizca `window.api` verilir:
 *   api.call(cmd, payload) -> Promise<data>   hata olursa Error firlatir
 *   api.on(type, handler)                     olay abonesi
 *   api.off(type, handler)                    abonelik iptali
 *
 * Olay tipleri: 'progress', 'live:candle', 'live:signal', 'live:status', 'log'.
 * '*' ile tum olaylar dinlenebilir.
 */

const { contextBridge, ipcRenderer } = require('electron')

/** @type {Map<string, Set<Function>>} */
const listeners = new Map()

ipcRenderer.on('api:event', (_event, msg) => {
  if (!msg || typeof msg !== 'object') return
  const type = String(msg.type || '')
  const data = msg.data
  const direct = listeners.get(type)
  if (direct) {
    for (const fn of Array.from(direct)) {
      try {
        fn(data, type)
      } catch (err) {
        // Dinleyici hatasi digerlerini engellemesin.
      }
    }
  }
  const all = listeners.get('*')
  if (all) {
    for (const fn of Array.from(all)) {
      try {
        fn(data, type)
      } catch (err) {
        // Dinleyici hatasi digerlerini engellemesin.
      }
    }
  }
})

/**
 * Ana surece komut yollar.
 * @param {string} cmd
 * @param {object} [payload]
 * @returns {Promise<*>}
 */
async function call(cmd, payload) {
  const res = await ipcRenderer.invoke('api:call', { cmd: cmd, payload: payload || {} })
  if (!res || res.ok !== true) {
    throw new Error(res && res.error ? res.error : 'Bilinmeyen hata.')
  }
  return res.data
}

/** Olay dinleyicisi ekler. */
function on(type, handler) {
  if (typeof handler !== 'function') return
  const key = String(type)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(handler)
}

/** Olay dinleyicisini kaldirir. Handler verilmezse o tipin tumu silinir. */
function off(type, handler) {
  const key = String(type)
  const set = listeners.get(key)
  if (!set) return
  if (typeof handler === 'function') {
    set.delete(handler)
    if (set.size === 0) listeners.delete(key)
  } else {
    listeners.delete(key)
  }
}

contextBridge.exposeInMainWorld('api', {
  call: call,
  on: on,
  off: off,
})
