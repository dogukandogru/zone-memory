'use strict'

/**
 * Canli veri dongusu.
 *
 * Secili saglayicidan `livePollSeconds` araligiyla son ~200 bar cekilir ve
 * motora yollanir. Agir is (fiyat kaydirmasi, depoya ekleme, indikator,
 * benzerlik) isci ipliginde yapilir; burada yalnizca ag istegi ve olay
 * yayini vardir. Boylece 6 milyon barlik seri ana iplige hic kopyalanmaz.
 *
 * Yayinlanan olaylar:
 *   'live:candle'  her cekimde son bar
 *   'live:signal'  yeni bir bolge olayinda (kutu olusumu veya ilk dokunus)
 *                  uretilen Signal
 *   'live:status'  baslama, durma ve durum degisimi
 *   'log'          Turkce bilgi ve hata mesajlari
 */

const engine = require('./engine')
const settings = require('./settings')

const FETCH_BARS = 200
const MIN_POLL_SECONDS = 5
const MAX_POLL_SECONDS = 3600

/** @type {((type:string, data:*)=>void)|null} */
let emitter = null

const state = {
  running: false,
  tf: null,
  providerId: null,
  providerName: '',
  isProxy: false,
  pollSeconds: 20,
  basis: null,
  // Vekil kaynagin hacmini depodaki olcege tasiyan katsayi.
  volScale: null,
  sinceTime: 0,
  lastPollTime: null,
  lastBarTime: null,
  lastError: null,
  ticks: 0,
  signals: 0,
  addedBars: 0,
  // Duzeltme hesaplanamadi veya akista bosluk var: bar yazilmiyor, once
  // Veri Cek ile eksik donem kapatilmali.
  needsSync: false,
}

let timer = null
let ticking = false
let basisLogged = false
let basisWarned = false

/** ipc.js olay yollayicisini burada kaydeder. */
function setEmitter(fn) {
  emitter = typeof fn === 'function' ? fn : null
}

function emitEvent(type, data) {
  if (!emitter) return
  try {
    emitter(type, data)
  } catch (err) {
    // Yayin hatasi dongueyi durdurmasin.
  }
}

function logLine(message) {
  emitEvent('log', { source: 'live', message: String(message), time: Math.floor(Date.now() / 1000) })
}

/** Saglayici modulunu tembel yukler. */
function getProviderById(id) {
  let providerMod
  try {
    providerMod = require('../core/data/provider')
  } catch (err) {
    throw new Error('Saglayici modulu yuklenemedi: ' + (err && err.message ? err.message : String(err)))
  }
  const p = providerMod.getProvider(id)
  if (!p) throw new Error('Canli saglayici bulunamadi: ' + String(id))
  return p
}

/** Anlik durum. */
function status() {
  return {
    running: state.running,
    tf: state.tf,
    providerId: state.providerId,
    providerName: state.providerName,
    isProxy: state.isProxy,
    pollSeconds: state.pollSeconds,
    basis: state.basis,
    lastPollTime: state.lastPollTime,
    lastBarTime: state.lastBarTime,
    lastError: state.lastError,
    ticks: state.ticks,
    signals: state.signals,
    addedBars: state.addedBars,
    needsSync: state.needsSync,
  }
}

/**
 * Canli akisi baslatir.
 * @param {{tf?:string, providerId?:string}} [opts]
 */
async function start(opts) {
  const cfg = settings.load()
  const tf = (opts && opts.tf) || cfg.timeframe || '15m'
  const providerId = (opts && opts.providerId) || (cfg.providers && cfg.providers.live) || 'yahoo'

  const provider = getProviderById(providerId)
  const apiKey = (cfg.apiKeys && cfg.apiKeys[providerId]) || ''
  if (provider.needsKey && !apiKey) {
    throw new Error(provider.name + ' icin API anahtari gerekli. Ayarlar sekmesinden girin.')
  }
  if (Array.isArray(provider.caps) && provider.caps.indexOf('live') === -1) {
    logLine(provider.name + ' canli veri icin onerilmiyor, yine de denenecek.')
  }

  stopTimer()

  state.running = true
  state.tf = tf
  state.providerId = providerId
  state.providerName = provider.name || providerId
  state.isProxy = !!provider.isProxy
  state.pollSeconds = Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.floor(Number(cfg.livePollSeconds) || 20)))
  state.basis = null
  state.volScale = null
  state.lastError = null
  state.ticks = 0
  state.signals = 0
  state.addedBars = 0
  // Baslangictan ONCEKI olaylar icin sinyal uretilmez.
  state.sinceTime = Math.floor(Date.now() / 1000)
  basisLogged = false
  basisWarned = false

  logLine('Canli akis basladi: ' + state.providerName + ', ' + tf + ', ' + state.pollSeconds + ' saniyede bir.')
  emitEvent('live:status', status())

  timer = setInterval(() => {
    tick().catch(() => {})
  }, state.pollSeconds * 1000)
  if (timer.unref) timer.unref()

  // Ilk cekimi beklemeden baslat.
  tick().catch(() => {})

  return status()
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Canli akisi durdurur. */
function stop() {
  const wasRunning = state.running
  stopTimer()
  state.running = false
  if (wasRunning) {
    logLine('Canli akis durduruldu.')
    emitEvent('live:status', status())
  }
  return status()
}

/** Tek bir cekim adimi. */
async function tick() {
  if (!state.running || ticking) return
  ticking = true
  try {
    const cfg = settings.load()
    const provider = getProviderById(state.providerId)
    const apiKey = (cfg.apiKeys && cfg.apiKeys[state.providerId]) || ''
    const tfmod = require('../core/tf')
    const tfSec = tfmod.tfSeconds(state.tf)

    // Kapanmis bar olcutu bu an uzerinden hesaplanir. Istegin GONDERILDIGI
    // ani kullaniriz: isci uzun bir isle mesgulse mesaj dakikalar sonra
    // islenebilir ve o sirada acik olan bar kapanmis sayilirdi.
    const now = Math.floor(Date.now() / 1000)
    const from = now - tfSec * (FETCH_BARS + 5)

    const fetched = await provider.fetchCandles({
      tfSec: tfSec,
      from: from,
      to: now,
      apiKey: apiKey,
    })

    // Cekim sirasinda durdurulmus olabiliriz.
    if (!state.running) return

    if (!fetched || !fetched.length) {
      state.lastError = 'Saglayicidan mum gelmedi.'
      logLine(state.providerName + ': mum gelmedi, tekrar denenecek.')
      return
    }

    const res = await engine.call('engine:live-tick', {
      tf: state.tf,
      series: {
        length: fetched.length,
        time: fetched.time,
        open: fetched.open,
        high: fetched.high,
        low: fetched.low,
        close: fetched.close,
        volume: fetched.volume,
      },
      isProxy: state.isProxy,
      basis: state.basis,
      volScale: state.volScale,
      basisWarned: basisWarned,
      fetchedAt: now,
      sinceTime: state.sinceTime,
      params: cfg.indicatorParams || {},
      outcomeCfg: cfg.outcomeCfg || {},
      signalCfg: cfg.signalCfg || {},
    })

    state.ticks += 1
    state.lastPollTime = Math.floor(Date.now() / 1000)
    state.lastError = null

    if (res && res.basisWarned) basisWarned = true
    if (res && typeof res.volScale === 'number' && isFinite(res.volScale) && res.volScale > 0) {
      state.volScale = res.volScale
    }
    if (res && typeof res.basis === 'number' && isFinite(res.basis)) {
      state.basis = res.basis
      if (!basisLogged) {
        basisLogged = true
        logLine('Vekil kaynak fiyati spot seviyesine ' + res.basis.toFixed(2) + ' birim kaydirilarak kullaniliyor.')
      }
    }
    if (res && Array.isArray(res.logs)) {
      for (const line of res.logs) logLine(line)
    }
    if (res && res.lastBar) {
      state.lastBarTime = res.lastBar.time
      emitEvent('live:candle', { tf: state.tf, bar: res.lastBar, providerId: state.providerId })
    }
    if (res && res.added > 0) {
      state.addedBars += res.added
    }
    // Duzeltme hesaplanamadi ya da akista bosluk olustu: bar YAZILMADI.
    // Arayuz bunu gorunce eksik donemi Veri Cek ile kapatir, yoksa canli
    // akis sessizce durur.
    if (res && res.needsSync) {
      state.needsSync = true
      emitEvent('live:gap', {
        tf: state.tf,
        providerId: state.providerId,
        lastBarTime: state.lastBarTime,
      })
    } else if (res && res.added > 0) {
      state.needsSync = false
    }
    if (res && res.touch && typeof res.touch.time === 'number') {
      // Ayni olayin tekrar degerlendirilmesini onle.
      if (res.touch.time > state.sinceTime) state.sinceTime = res.touch.time
    }
    if (res && res.signal) {
      state.signals += 1
      emitEvent('live:signal', { tf: state.tf, signal: res.signal, touch: res.touch || null })
      const dir = res.signal.direction === 'BUY' ? 'ALIS' : 'SATIS'
      if (res.signal.fired) {
        const tur = res.signal.kind === 'form' ? 'kutu olusumu' : 'bolge dokunusu'
        logLine('Yeni sinyal: ' + dir + ' (' + tur + '), basari beklentisi %' +
          Math.round((res.signal.winRate || 0) * 100) + '.')
      } else {
        logLine('Yeni bolge olayi bulundu ama esikler gecilmedi, sinyal yayinlanmadi.')
      }
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    state.lastError = message
    // Durdurulduktan sonra gelen hatalar icin gurultu yapma.
    if (state.running) logLine('Canli veri hatasi: ' + message + ' Denemeye devam ediliyor.')
  } finally {
    ticking = false
  }
}

module.exports = {
  setEmitter,
  start,
  stop,
  status,
}
