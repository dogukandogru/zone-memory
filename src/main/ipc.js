'use strict'

/**
 * Renderer ile tek giris noktasi: `api:call`.
 *
 * Istek : {cmd, payload}
 * Yanit : {ok:true, data} veya {ok:false, error:'Turkce mesaj'}
 *
 * Renderer'a giden olaylar `api:event` kanalindan
 * {type, data} bicimiyle yollanir. Tipler: 'progress', 'live:candle',
 * 'live:signal', 'live:status', 'log'.
 *
 * Istisnalar renderer'a sizmaz; hepsi yakalanip mesaja cevrilir.
 */

const { ipcMain, app, dialog } = require('electron')

const engine = require('./engine')
const settings = require('./settings')
const live = require('./live')
const paths = require('./paths')
const logfile = require('./logfile')
const notify = require('./notify')

/** @type {import('electron').BrowserWindow|null} */
let mainWindow = null
let registered = false
// Uygulama kapanirken renderer'in sureduran cagrilari (saat, durum yoklama)
// "No handler registered" hatasi bastiriyordu. Dinleyiciyi kaldirmak yerine
// anlasilir bir cevap donduruyoruz; surec zaten kapaniyor.
let kapaniyor = false

/** Kapanis basladi: yeni cagrilara kisa bir hata donulur. */
function markShuttingDown() {
  kapaniyor = true
}

/** Olaylarin gidecegi pencereyi belirler. */
function setWindow(win) {
  mainWindow = win || null
}

/**
 * Renderer'a olay yollar.
 * @param {string} type
 * @param {*} data
 */
function send(type, data) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const wc = mainWindow.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    wc.send('api:event', { type: type, data: data })
  } catch (err) {
    // Pencere kapaniyor olabilir, sessizce gec.
  }
  // GUNLUK: ekrandaki satir 12-20 saniyede kayboluyordu, dosyada kalir.
  if (type === 'log' && data && data.message) {
    logfile.write({
      level: data.level || 'bilgi',
      source: data.source || 'uygulama',
      message: data.message,
    })
  }
}

/** Hata nesnesini kullaniciya gosterilecek Turkce metne cevirir. */
function errorText(err) {
  if (!err) return 'Bilinmeyen hata.'
  if (typeof err === 'string') return err
  if (err.message) return String(err.message)
  return String(err)
}

/** Saglayici listesi (renderer'daki saglayici secimi icin). */
function listProviders() {
  let mod
  try {
    mod = require('../core/data/provider')
  } catch (err) {
    return { providers: [], error: 'Saglayici modulu yuklenemedi.' }
  }
  const list = typeof mod.listProviders === 'function' ? mod.listProviders() : []
  // Fonksiyonlar IPC ile gecemez, yalnizca ust veriyi yolla.
  const plain = list.map((p) => ({
    id: p.id,
    name: p.name,
    needsKey: !!p.needsKey,
    caps: Array.isArray(p.caps) ? p.caps.slice() : [],
    isProxy: !!p.isProxy,
    note: p.note || '',
  }))
  return { providers: plain }
}

/** Ana komut dagitimi. */
async function dispatch(cmd, payload) {
  const p = payload || {}

  switch (cmd) {
    case 'app:info': {
      // Yapi damgasi paketleme sirasinda yazilir (scripts/stamp-build.mjs).
      // Gelistirme calistirmasinda dosya olmayabilir, o zaman bos gecilir.
      let build = null
      try {
        build = require('../build-info.json')
      } catch (err) {
        build = null
      }
      return {
        version: app.getVersion(),
        builtAt: build && build.builtAt ? build.builtAt : null,
        commit: build && build.commit ? build.commit : null,
        // Kirli agactan alinan olcum izlenemez; arayuz bunu basligta gosterir.
        dirty: build && build.dirty !== undefined ? !!build.dirty : null,
        changedFiles: build && Number.isFinite(build.changedFiles) ? build.changedFiles : null,
        srcHash: build && build.srcHash ? build.srcHash : null,
        // Paketlenmemis calistirmada kod her an degisebilir, damga bagsizdir.
        dev: !app.isPackaged,
        platform: process.platform,
        electron: process.versions.electron,
        node: process.versions.node,
        dataDir: paths.dataDir(),
        userDataDir: paths.userDataDir(),
      }
    }

    case 'settings:get':
      return settings.get(p.key)

    // Yalnizca kullanicinin acikca degistirdigi alanlar. Tarama, test ve canli
    // bunu zaman dilimine ait hazir ayarla birlestirir (presets.resolveCfg);
    // birlesik ayar gonderilse hazir ayar katmani devre disi kalirdi.
    case 'settings:patch':
      return settings.loadPatch()

    // Yuk bicimi: {key, value} veya {patch} ya da ciplak yama nesnesi.
    // Cozumleme settings.js icindedir, boylece testten de ayni yol gecer.
    case 'settings:set':
      return settings.applySetPayload(p)

    // API anahtarlari, saglayici secimi ve acik zaman dilimi korunur.
    case 'settings:reset':
      return settings.varsayilanlaraDon()

    // Arayuz 'data:providers' adiyla cagirir; 'providers:list' eski addir.
    case 'data:providers':
    case 'providers:list':
      return listProviders()

    // API ANAHTARI RENDERER'A HIC GITMEZ.
    //
    // Veri Cek ve otomatik hazirlik `data:sync` cagirirken yuke anahtar
    // koymuyordu, ipc de eklemiyordu; bu yuzden Polygon veya Twelve Data
    // secilince senkron HER ZAMAN "API anahtari gerekli" hatasi veriyordu.
    // Anahtar burada, ana surecte, ayarlardan okunup yuke eklenir; boylece
    // renderer'a hicbir zaman gonderilmez.
    case 'data:sync': {
      const id = p.providerId || p.provider || ''
      const anahtarlar = settings.get('apiKeys') || {}
      const anahtar = id && anahtarlar[id] ? String(anahtarlar[id]) : ''
      const yuk = Object.assign({}, p)
      if (anahtar) yuk.apiKey = anahtar
      return await engine.call(cmd, yuk, (pct, msg) => {
        send('progress', { cmd: cmd, pct: pct, msg: msg })
      })
    }

    // CSV DOKUMU: dosya secimi ANA SURECTE yapilir (renderer'in dosya
    // sistemine erisimi yok) ve yol isciye iletilir.
    case 'export:csv': {
      const ne = p.what === 'trades' ? 'trades' : 'events'
      const tf = p.tf ? String(p.tf) : ''
      const ad = 'XAUUSD_' + tf + (ne === 'trades' ? '_islemler' : '_olaylar') + '.csv'
      const secim = await dialog.showSaveDialog(mainWindow || undefined, {
        title: ne === 'trades' ? 'İşlem dökümünü kaydet' : 'Hafıza olaylarını kaydet',
        defaultPath: ad,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      if (secim.canceled || !secim.filePath) return { cancelled: true }
      return await engine.call('engine:export-csv', {
        tf: tf, what: ne, filePath: secim.filePath,
      })
    }

    // Calisan uzun islemi durdurur. Isci ipligi yeniden baslatmak, suren
    // taramayi kesmenin tek guvenilir yolu: cekirdek dongulerin icine iptal
    // kontrolu serpistirmek yerine islemi butun olarak birakiyoruz.
    // Bekleyen tum sozler reddedilir, arayuz bunu hata olarak gosterir.
    case 'engine:cancel':
      await engine.restart()
      send('log', { level: 'info', message: 'İşlem durduruldu.' })
      return { ok: true, cancelled: true }

    case 'live:start':
      return await live.start(p)

    case 'live:stop':
      return live.stop()

    case 'live:status':
      return live.status()

    case 'engine:restart':
      await engine.restart()
      return { ok: true }

    case 'engine:status':
      return engine.status()

    default:
      // Kalan her sey motora gider, ilerleme renderer'a aktarilir.
      return await engine.call(cmd, p, (pct, msg) => {
        send('progress', { cmd: cmd, pct: pct, msg: msg })
      })
  }
}

/** IPC dinleyicilerini kurar. Yalnizca bir kez calisir. */
function register(win) {
  if (win) setWindow(win)
  if (registered) return
  registered = true

  live.setEmitter(send)
  live.setNotifier((veri) => notify.signalGeldi(veri))
  notify.init({ emit: send })
  engine.onLog((message) => {
    send('log', { source: 'engine', message: message, time: Math.floor(Date.now() / 1000) })
  })

  ipcMain.handle('api:call', async (event, msg) => {
    const cmd = msg && msg.cmd ? String(msg.cmd) : ''
    const payload = msg && msg.payload ? msg.payload : {}
    if (kapaniyor) return { ok: false, error: 'Uygulama kapanıyor.' }
    if (!cmd) return { ok: false, error: 'Komut adi verilmedi.' }
    try {
      const data = await dispatch(cmd, payload)
      return { ok: true, data: data === undefined ? null : data }
    } catch (err) {
      // Yigin izi arayuze GITMEZ ama dosyaya yazilir: hatanin nerede
      // olustugu sonradan ancak boyle bulunabiliyor.
      logfile.write({
        level: 'hata',
        source: 'ipc:' + cmd,
        message: errorText(err),
        stack: err && err.stack ? err.stack : null,
      })
      return { ok: false, error: errorText(err) }
    }
  })
}

/** Dinleyicileri kaldirir (uygulama kapanisinda). */
function unregister() {
  if (!registered) return
  registered = false
  try {
    ipcMain.removeHandler('api:call')
  } catch (err) {
    // Dinleyici zaten yoksa sorun degil.
  }
}

module.exports = {
  register,
  unregister,
  markShuttingDown,
  setWindow,
  send,
  // Test icin: komut yonlendirici dogrudan cagrilabilsin (yuk bicimi
  // uyusmazliklari burada yakalanir, arayuzde degil).
  dispatch,
}
