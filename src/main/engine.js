'use strict'

/**
 * Motor koprusu. Agir isler (indikator taramasi, benzerlik, geriye test)
 * `worker_threads` icinde calisir, boylece arayuz donmaz.
 *
 * Protokol:
 *   ana -> isci : {id, cmd, payload}
 *   isci -> ana : {type:'result',   id, data}
 *                 {type:'error',    id, message, stack}
 *                 {type:'progress', id, pct, msg}
 *                 {type:'log',      message}
 *
 * Isci cokerse bekleyen tum sozler reddedilir ve isci yeniden baslatilir.
 * Ayni anda birden fazla cagri gonderilebilir; kuyruklama yapilmaz.
 */

const path = require('path')
const { Worker } = require('worker_threads')
const paths = require('./paths')

const WORKER_FILE = path.join(__dirname, 'worker', 'engine.worker.js')
const MAX_RESTART_DELAY_MS = 5000

/** @type {Worker|null} */
let worker = null
let nextId = 1
/** @type {Map<number,{resolve:Function,reject:Function,onProgress:Function|null,cmd:string}>} */
const pending = new Map()
let stopping = false
let crashStreak = 0
let restartTimer = null
/** @type {((message:string)=>void)|null} */
let logHandler = null

/** Isciden gelen serbest log mesajlarini dinler. */
function onLog(fn) {
  logHandler = typeof fn === 'function' ? fn : null
}

function emitLog(message) {
  if (logHandler) {
    try {
      logHandler(message)
    } catch (err) {
      // Dinleyici hatasi motoru etkilemesin.
    }
  }
}

/** Isciden gelen mesajlari ilgili soze yonlendirir. */
function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'log') {
    emitLog(String(msg.message || ''))
    return
  }
  const entry = pending.get(msg.id)
  if (!entry) return
  if (msg.type === 'progress') {
    if (entry.onProgress) {
      try {
        entry.onProgress(msg.pct, msg.msg)
      } catch (err) {
        // Ilerleme dinleyicisi hatasi isi bozmasin.
      }
    }
    return
  }
  pending.delete(msg.id)
  if (msg.type === 'result') {
    entry.resolve(msg.data)
  } else if (msg.type === 'error') {
    const err = new Error(msg.message || 'Motor hatasi')
    if (msg.stack) err.stack = msg.stack
    entry.reject(err)
  }
}

/** Bekleyen tum sozleri reddeder. */
function rejectAll(reason) {
  const entries = Array.from(pending.entries())
  pending.clear()
  for (const [, entry] of entries) {
    entry.reject(new Error(reason))
  }
}

/** Isciyi olusturur ve olaylarini baglar. */
function spawn() {
  // Isci ipliginde Electron `app` yoktur, veri klasorunu ortam degiskeni ve
  // workerData ile aktariyoruz.
  const dir = paths.dataDir()
  process.env.ZONE_MEMORY_DATA_DIR = dir

  worker = new Worker(WORKER_FILE, {
    workerData: { dataDir: dir, userDataDir: paths.userDataDir() },
    resourceLimits: { maxOldGenerationSizeMb: 6144 },
  })

  worker.on('message', handleMessage)

  worker.on('error', (err) => {
    emitLog('Motor hatasi: ' + (err && err.message ? err.message : String(err)))
    rejectAll('Motor beklenmedik sekilde durdu: ' + (err && err.message ? err.message : 'bilinmeyen hata'))
  })

  worker.on('exit', (code) => {
    worker = null
    if (pending.size > 0) {
      rejectAll('Motor kapandi (cikis kodu ' + code + '), islem tamamlanamadi.')
    }
    if (stopping) return
    crashStreak += 1
    const delay = Math.min(MAX_RESTART_DELAY_MS, 200 * Math.pow(2, crashStreak - 1))
    emitLog('Motor yeniden baslatiliyor (' + delay + ' ms sonra).')
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!stopping && !worker) spawn()
    }, delay)
    if (restartTimer.unref) restartTimer.unref()
  })

  // Uzun sure sorunsuz calistiysa cokme sayacini sifirla.
  const healthy = setTimeout(() => {
    crashStreak = 0
  }, 30000)
  if (healthy.unref) healthy.unref()
}

/** Motoru baslatir (zaten calisiyorsa bir sey yapmaz). */
function start() {
  stopping = false
  if (!worker) spawn()
  return true
}

/** Motoru durdurur ve bekleyen sozleri reddeder. */
async function stop() {
  stopping = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  rejectAll('Motor durduruldu.')
  if (worker) {
    const w = worker
    worker = null
    try {
      await w.terminate()
    } catch (err) {
      // Sonlandirma hatasi onemsiz.
    }
  }
}

/** Motoru yeniden baslatir (onbellekleri tamamen temizler). */
async function restart() {
  await stop()
  stopping = false
  spawn()
  return true
}

/**
 * Isciye komut gonderir.
 * @param {string} cmd
 * @param {object} [payload]
 * @param {(pct:number,msg:string)=>void} [onProgress]
 * @returns {Promise<*>}
 */
function call(cmd, payload, onProgress) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      if (stopping) {
        reject(new Error('Motor kapali.'))
        return
      }
      spawn()
    }
    const id = nextId++
    pending.set(id, {
      resolve,
      reject,
      onProgress: typeof onProgress === 'function' ? onProgress : null,
      cmd: cmd,
    })
    try {
      worker.postMessage({ id, cmd, payload: payload || {} })
    } catch (err) {
      pending.delete(id)
      reject(new Error('Komut gonderilemedi: ' + (err && err.message ? err.message : String(err))))
    }
  })
}

/** Motor calisiyor mu, kac islem bekliyor. */
function status() {
  return { running: !!worker, pending: pending.size }
}

module.exports = {
  start,
  stop,
  restart,
  call,
  status,
  onLog,
}
