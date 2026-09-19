'use strict'

/**
 * Electron ana sureci. Pencereyi acar, menuyu kurar, IPC ve motoru baslatir.
 */

const path = require('path')
const { app, BrowserWindow, Menu, dialog, shell } = require('electron')

const paths = require('./paths')
const ipc = require('./ipc')
const engine = require('./engine')
const live = require('./live')
const logfile = require('./logfile')
const notify = require('./notify')

const IS_MAC = process.platform === 'darwin'
const IS_DEV = process.argv.includes('--dev')

/**
 * EKRAN GORUNTUSU MODU (gelistirme yardimcisi)
 * `--shot <dosya>` verilirse uygulama acilir, arayuz yerlesene kadar bekler,
 * pencerenin goruntusunu PNG olarak yazar ve kapanir. Amac: bir degisikligin
 * gercek arayuzde nasil gorundugunu, pencereyi elle acmadan dogrulayabilmek.
 * `--shot-panel <ad>` ile once bir panel sekmesi acilir (signals, zones,
 * memory, settings, test), `--shot-wait <sn>` bekleme suresini uzatir,
 * `--shot-scroll son` (ya da piksel sayisi) panel govdesini kaydirir,
 * `--shot-click <secici>` once bir ogeye tiklar.
 */
function argDegeri(ad) {
  const i = process.argv.indexOf(ad)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}
const SHOT_PATH = argDegeri('--shot')
const SHOT_PANEL = argDegeri('--shot-panel')
const SHOT_WAIT = Number(argDegeri('--shot-wait')) || 12
/** `--shot-scroll son` panelin sonuna kaydirir, sayi verilirse o kadar piksel. */
const SHOT_SCROLL = argDegeri('--shot-scroll')
/** `--shot-click <secici>` ekran goruntusunden once bir ogeye tiklar. */
const SHOT_CLICK = argDegeri('--shot-click')

/** @type {BrowserWindow|null} */
let mainWindow = null

/** Ana pencereyi olusturur. */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#131722',
    title: 'Zone Memory',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    ipc.setWindow(null)
  })

  // Pencere odaklaninca okunmamis bildirim rozeti sifirlanir.
  mainWindow.on('focus', () => {
    notify.okundu()
  })

  // Arayuz sureci cokerse ekran bosalir ve hicbir iz kalmazdi.
  mainWindow.webContents.on('render-process-gone', (olay, ayrinti) => {
    logfile.write({
      level: 'hata',
      source: 'arayuz',
      message: 'Arayuz sureci sonlandi: ' + (ayrinti && ayrinti.reason ? ayrinti.reason : 'bilinmiyor') +
        (ayrinti && ayrinti.exitCode !== undefined ? ' (cikis kodu ' + ayrinti.exitCode + ')' : ''),
    })
  })

  // Yeni pencere acma istekleri varsayilan tarayiciya gider.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'right' })
  }

  ipc.setWindow(mainWindow)

  if (SHOT_PATH) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (SHOT_PANEL && mainWindow) {
            await mainWindow.webContents.executeJavaScript(
              'document.querySelector(\'[data-tab="' + SHOT_PANEL + '"]\')?.click(); true'
            )
            await new Promise((r) => setTimeout(r, 1500))
          }
          // Tiklama gerektiren durumlar (sinyal ayrintisi, bolge karti) baska
          // turlu dogrulanamiyordu.
          if (SHOT_CLICK && mainWindow) {
            await mainWindow.webContents.executeJavaScript(
              '(function(){var e=document.querySelector(' + JSON.stringify(String(SHOT_CLICK)) + ');' +
              'if(e)e.click();return !!e})()'
            )
            await new Promise((r) => setTimeout(r, 1200))
          }

          // Panel govdesini kaydirmak: uzun panellerde ekranin altinda kalan
          // tablolar (alt kume kirilimi, sermaye egrisi) baska turlu
          // dogrulanamiyordu.
          if (SHOT_SCROLL && mainWindow) {
            await mainWindow.webContents.executeJavaScript(
              // Aktif paneldeki TUM kaydirilabilir kaplar kaydirilir: sinyal
              // ayrintisi ayri bir kapta cizildigi icin yalnizca panel
              // govdesini kaydirmak yetmiyordu.
              '(function(){var hedef=' + (SHOT_SCROLL === 'son' ? '-1' : String(Number(SHOT_SCROLL) || 0)) + ';' +
              'var kaplar=document.querySelectorAll(".panel.active .scroll, .panel.active .panel-body");' +
              'if(!kaplar.length)kaplar=document.querySelectorAll(".panel-body");' +
              'for(var i=0;i<kaplar.length;i++){var k=kaplar[i];' +
              'if(k.scrollHeight>k.clientHeight)k.scrollTop=hedef<0?k.scrollHeight:hedef}' +
              'return true})()'
            )
            await new Promise((r) => setTimeout(r, 600))
          }
          const resim = await mainWindow.webContents.capturePage()
          require('fs').writeFileSync(SHOT_PATH, resim.toPNG())
          process.stdout.write('Ekran goruntusu yazildi: ' + SHOT_PATH + '\n')
        } catch (err) {
          process.stderr.write('Ekran goruntusu alinamadi: ' + (err && err.message ? err.message : String(err)) + '\n')
        }
        app.quit()
      }, SHOT_WAIT * 1000)
    })
  }

  return mainWindow
}

/** Hakkinda penceresi. */
function showAbout() {
  const detay = [
    'Surum: ' + app.getVersion(),
    'Electron: ' + process.versions.electron,
    'Node: ' + process.versions.node,
    'Veri klasoru: ' + paths.dataDir(),
  ].join('\n')

  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'Zone Memory Hakkinda',
    message: 'Zone Memory',
    detail: 'XAUUSD destek/direnc bolge hafizasi ve canli patern eslestirme.\n\n' + detay,
    buttons: ['Tamam'],
    noLink: true,
  })
}

/** Turkce uygulama menusu. */
function buildMenu() {
  const template = []

  if (IS_MAC) {
    template.push({
      label: 'Zone Memory',
      submenu: [
        { label: 'Zone Memory Hakkinda', click: showAbout },
        { type: 'separator' },
        { label: 'Gizle', role: 'hide' },
        { label: 'Digerlerini Gizle', role: 'hideOthers' },
        { label: 'Tumunu Goster', role: 'unhide' },
        { type: 'separator' },
        { label: 'Cikis', role: 'quit' },
      ],
    })
  }

  template.push({
    label: 'Dosya',
    submenu: IS_MAC
      ? [{ label: 'Pencereyi Kapat', role: 'close' }]
      : [{ label: 'Cikis', role: 'quit' }],
  })

  template.push({
    label: 'Duzenle',
    submenu: [
      { label: 'Geri Al', role: 'undo' },
      { label: 'Yinele', role: 'redo' },
      { type: 'separator' },
      { label: 'Kes', role: 'cut' },
      { label: 'Kopyala', role: 'copy' },
      { label: 'Yapistir', role: 'paste' },
      { label: 'Tumunu Sec', role: 'selectAll' },
    ],
  })

  template.push({
    label: 'Gorunum',
    submenu: [
      { label: 'Yenile', role: 'reload' },
      { label: 'Zorla Yenile', role: 'forceReload' },
      { label: 'Gelistirici Araclari', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: 'Gercek Boyut', role: 'resetZoom' },
      { label: 'Yakinlastir', role: 'zoomIn' },
      { label: 'Uzaklastir', role: 'zoomOut' },
      { type: 'separator' },
      { label: 'Tam Ekran', role: 'togglefullscreen' },
    ],
  })

  template.push({
    label: 'Yardim',
    submenu: [
      { label: 'Hakkinda', click: showAbout },
      {
        label: 'Veri Klasorunu Ac',
        click: () => {
          shell.openPath(paths.dataDir())
        },
      },
      {
        // Gece olusan hatalarin ne zaman basladigini bulmanin tek yolu.
        label: 'Gunluk Klasorunu Ac',
        click: () => {
          shell.openPath(logfile.ensureDirSync())
        },
      },
    ],
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Pencereyi one getirir; macOS'ta pencere kapatilmissa yeniden olusturur.
 * Bildirime tiklandiginda cagrilir.
 */
function pencereyiGoster() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// SURECI DUSUREN HATALAR DOSYAYA YAZILIR.
//
// Bunlar olustugunda uygulama ya kapaniyor ya da pencere bosaliyor; ekrandaki
// 12-20 saniyelik durum satiri hicbir ise yaramiyordu.
process.on('uncaughtException', (err) => {
  logfile.write({
    level: 'hata',
    source: 'ana-surec',
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : null,
  })
})
process.on('unhandledRejection', (sebep) => {
  logfile.write({
    level: 'hata',
    source: 'ana-surec',
    message: 'Yakalanmamis soz reddi: ' + (sebep && sebep.message ? sebep.message : String(sebep)),
    stack: sebep && sebep.stack ? sebep.stack : null,
  })
})

// Tek ornek kilidi: ikinci ornek varolan pencereyi one getirir.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    paths.ensureDirs()
    // Eski gunlukleri temizle ve klasoru kur.
    logfile.init()
    // Bildirime tiklaninca pencere one gelsin (macOS'ta pencere kapaliysa
    // yeniden olusturulur).
    notify.init({ showWindow: pencereyiGoster })
    buildMenu()
    ipc.register()
    engine.start()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // macOS'ta uygulama menude acik kalir, diger sistemlerde kapanir.
    if (!IS_MAC) app.quit()
  })

  app.on('before-quit', () => {
    // Once kapanis bayragi: renderer'in sureduran cagrilari (saat, durum
    // yoklama) "No handler registered" hatasi yerine anlasilir cevap alsin.
    ipc.markShuttingDown()
    try {
      live.stop()
    } catch (err) {
      // Kapanista hata onemsiz.
    }
    engine.stop()
  })
}
