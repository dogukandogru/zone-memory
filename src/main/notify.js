'use strict'

/**
 * MASAUSTU BILDIRIMI (C5)
 *
 * Karar desteginin degeri sinyali ZAMANINDA gormekte. Canli sinyal yalnizca
 * alt seritte 20 saniye duran bir satir olarak cikiyordu; uygulama arka
 * plandayken (macOS'ta pencere kapaliyken canli dongu calismaya devam eder)
 * sinyal hicbir yere ulasmiyordu. Sinyal seyrek geldigi icin (15 dakikalikta
 * yilda yaklasik 15 tetiklenen sinyal) kacan her sinyal pahali.
 *
 * Kurallar:
 * - Yalnizca TETIKLENEN ve gecikmemis sinyaller bildirilir.
 * - Varsayilan olarak yalnizca KANITLI turler bildirilir (`onlyProven`).
 *   Kanitlanmamis bir sinyal icin bildirim gondermek, olculmemis bir seyi
 *   acil gibi gostermek olurdu. Kullanici Ayarlar'dan acabilir.
 * - Bildirime tiklaninca pencere one gelir ve sinyal secilir.
 */

const { Notification, app, shell } = require('electron')

const settings = require('./settings')

/** Pencereyi gosterip odaklayan geri cagri (main.js kurar). */
let showWindow = null
/** Renderer'a olay yollayan fonksiyon (ipc.js kurar). */
let emitter = null
/** Okunmamis bildirim sayaci (dock rozeti). */
let okunmamis = 0

/**
 * Baglantilari kurar.
 * @param {{showWindow?:Function, emit?:Function}} opts
 */
function init(opts) {
  const o = opts || {}
  if (typeof o.showWindow === 'function') showWindow = o.showWindow
  if (typeof o.emit === 'function') emitter = o.emit
}

/** Ayarlardaki bildirim bolumu (eksik alanlar varsayilandan). */
function cfg() {
  const s = settings.get('notify') || {}
  return {
    desktop: s.desktop !== false,
    sound: s.sound !== false,
    onlyFired: s.onlyFired !== false,
    onlyProven: s.onlyProven !== false,
  }
}

/**
 * Sinyalin ozet metni (bildirim govdesi).
 *
 * Plan seviyeleri + orneklem ozeti. Oran TEK BASINA yazilmaz: 5 kayittan
 * 3'u ile 30 kayittan 18'i ayni yuzdeyi verir ama ayni sey degildir.
 */
function ozet(signal) {
  const p = (x) => (typeof x === 'number' && isFinite(x) ? x.toFixed(2) : '-')
  const parcalar = [
    'Giris ' + p(signal.entry),
    'SL ' + p(signal.sl),
    'TP1 ' + p(signal.tp1),
  ]
  const kisa = signal.summaryText || ''
  if (kisa) parcalar.push(kisa)
  else if (typeof signal.winRate === 'number' && isFinite(signal.winRate)) {
    parcalar.push('gecmiste %' + Math.round(signal.winRate * 100))
  }
  return parcalar.join(', ')
}

/**
 * Sinyal icin bildirim gosterir (kurallar tutuyorsa).
 *
 * @param {{tf:string, signal:Object}} veri
 * @returns {boolean} Bildirim gosterildiyse true
 */
function signalGeldi(veri) {
  const signal = veri && veri.signal ? veri.signal : null
  if (!signal) return false
  const ayar = cfg()
  if (!ayar.desktop) return false
  if (ayar.onlyFired && signal.fired !== true) return false
  // Gecikmeli degerlendirilen sinyalde fiyat coktan kacmis olabilir.
  if (signal.stale === true) return false
  if (ayar.onlyProven) {
    const kanit = signal.evidence && signal.evidence.status
    if (kanit !== 'kanitli') return false
  }

  let destekli = false
  try {
    destekli = Notification.isSupported()
  } catch (err) {
    destekli = false
  }
  if (!destekli) return false

  const yon = signal.direction === 'SELL' ? 'SAT' : 'AL'
  const tur = signal.kind === 'form' ? 'kutu olusumu' : 'bolge dokunusu'
  const baslik = yon + ' sinyali, ' + tur + ' (' + String(veri.tf || '') + ')'

  try {
    const bildirim = new Notification({
      title: baslik,
      body: ozet(signal),
      silent: !ayar.sound,
    })
    bildirim.on('click', () => {
      okunmamis = 0
      rozetiYaz()
      if (showWindow) {
        try { showWindow() } catch (err) { /* pencere kurulamadi */ }
      }
      if (emitter) {
        try { emitter('live:focus-signal', { id: signal.id, tf: veri.tf }) } catch (err) { /* onemsiz */ }
      }
    })
    bildirim.show()
  } catch (err) {
    return false
  }

  okunmamis += 1
  rozetiYaz()
  dikkatCek()
  return true
}

/** macOS dock rozeti. */
function rozetiYaz() {
  try {
    if (process.platform === 'darwin' && app.dock && app.dock.setBadge) {
      app.dock.setBadge(okunmamis > 0 ? String(okunmamis) : '')
    }
  } catch (err) {
    // Rozet yazilamazsa sorun degil.
  }
}

/** Pencere arka plandayken dikkat cekme (macOS zipla, Windows yanip son). */
function dikkatCek() {
  try {
    if (process.platform === 'darwin' && app.dock && app.dock.bounce) {
      app.dock.bounce('informational')
    }
  } catch (err) {
    // Onemsiz.
  }
}

/** Pencere odaklaninca cagrilir: rozet sifirlanir. */
function okundu() {
  okunmamis = 0
  rozetiYaz()
}

/** Okunmamis sayisi (arayuz rozeti icin). */
function unreadCount() {
  return okunmamis
}

module.exports = {
  init,
  signalGeldi,
  okundu,
  unreadCount,
  // Test icin: kural katmani Electron olmadan da denenebilsin.
  _ozet: ozet,
  _cfg: cfg,
}
