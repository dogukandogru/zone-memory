'use strict'

/**
 * OTOMATIK GUNCELLEME
 *
 * Musteri uygulamayi actiginda yeni surum var mi diye bakar, varsa arka
 * planda indirir ve kullanicidan onay alarak kurar. Amac: bir duzeltme
 * yaptigimizda musterinin elle kurulum dosyasi almasina gerek kalmamasi.
 *
 * ----------------------------------------------------------------------------
 * NEREDE CALISIR, NEREDE CALISMAZ
 * ----------------------------------------------------------------------------
 * Yalnizca PAKETLENMIS ve KURULMUS (NSIS) uygulamada calisir:
 *   - Gelistirmede (`npm start`) kapalidir, yoksa her calistirmada aga cikar.
 *   - Tasinabilir (zip'ten acilan) surumde de kapalidir. electron-updater
 *     kurulumun kendisini degistirerek calisir; zip'ten acilmis bir klasorde
 *     yapacak bir sey yoktur ve denerse hata verir. Ilk teslim tasinabilir
 *     surumle yapiliyorsa musteri BIR KEZ kurulum surumune gecmelidir.
 *
 * ----------------------------------------------------------------------------
 * VERIYE DOKUNMAZ
 * ----------------------------------------------------------------------------
 * Guncelleme paketi yalnizca UYGULAMAYI degistirir. Mum deposu ve hafiza
 * `%APPDATA%\\Zone Memory\\data` altinda, uygulamanin kurulum klasorunun
 * DISINDA durur; guncelleme oraya dokunmaz. Guncelleme paketlerinde gomulu
 * veri de yoktur (bkz. scripts/prepare-dist.mjs --no-data): veri yalnizca
 * ilk kurulumda gider, her guncellemede 300 MB indirmenin anlami yok.
 *
 * ----------------------------------------------------------------------------
 * NEDEN OTOMATIK KURMUYOR
 * ----------------------------------------------------------------------------
 * Indirme otomatiktir ama KURULUM kullaniciya sorulur. Sebep: kurulum
 * uygulamayi kapatir. Canli akis acikken ya da uzun bir tarama sururken
 * uygulamayi habersiz kapatmak, o ana kadarki isi cope atmak olurdu.
 * Kullanici "sonra" derse guncelleme uygulama kapanirken kendiliginden kurulur.
 */

const { app, dialog, shell } = require('electron')

const logfile = require('./logfile')

/** Pencereyi one getiren geri cagri (main.js kurar). */
let showWindow = null
/** Renderer'a durum yollayan fonksiyon (main.js kurar). */
let emitter = null

/** Uygulama kapanirken kurulum yapilsin mi (kullanici "sonra" dedi). */
let cikistaKur = false
/** Ayni oturumda ayni surum icin iki kez soru sorulmasin. */
let sorulanSurum = null
/** electron-updater nesnesi; yalnizca gerektiginde yuklenir. */
let autoUpdater = null

/** Gunluge yazar. */
function log(seviye, mesaj) {
  try {
    logfile.write({ level: seviye, source: 'updater', message: mesaj })
  } catch (err) {
    // Gunluk yazilamazsa guncelleme yine de denenir.
  }
}

/** Arayuze durum bildirir (alt seritte gorunur). */
function bildir(durum, ek) {
  if (!emitter) return
  try {
    emitter('update:status', Object.assign({ durum: durum }, ek || {}))
  } catch (err) {
    // Arayuz henuz yoksa onemsiz.
  }
}

/**
 * Guncelleme calisabilir mi.
 *
 * `app.isPackaged` paketlenmemis calistirmayi eler. Tasinabilir surumu ayirt
 * etmek icin electron-updater'in kendi dosyasina bakariz: kurulum surumunde
 * paketin yaninda `app-update.yml` bulunur, tasinabilir klasorde bulunmaz.
 */
function calisabilirMi() {
  if (!app.isPackaged) return { olur: false, sebep: 'gelistirme-calistirmasi' }
  try {
    const fs = require('fs')
    const path = require('path')
    const yml = path.join(process.resourcesPath, 'app-update.yml')
    if (!fs.existsSync(yml)) return { olur: false, sebep: 'tasinabilir-surum' }
  } catch (err) {
    return { olur: false, sebep: 'dosya-okunamadi' }
  }
  return { olur: true, sebep: '' }
}

/** electron-updater'i yukler ve ayarlar. */
function updaterAl() {
  if (autoUpdater) return autoUpdater
  const mod = require('electron-updater')
  autoUpdater = mod.autoUpdater

  // Indirme otomatik, kurulum degil (bkz. dosya basi).
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  // electron-updater kendi gunlugunu bizim dosyamiza yazsin.
  autoUpdater.logger = {
    info: (m) => log('bilgi', String(m)),
    warn: (m) => log('bilgi', String(m)),
    error: (m) => log('hata', String(m)),
    debug: () => {},
  }
  return autoUpdater
}

/** Kullaniciya "simdi kurayim mi" diye sorar. */
async function kurulumuSor(bilgi) {
  const surum = bilgi && bilgi.version ? String(bilgi.version) : '?'
  if (sorulanSurum === surum) return
  sorulanSurum = surum

  if (showWindow) {
    try { showWindow() } catch (err) { /* pencere yoksa yine de sorulur */ }
  }

  let yanit = null
  try {
    yanit = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Şimdi kur ve yeniden başlat', 'Uygulamayı kapatınca kur'],
      defaultId: 0,
      cancelId: 1,
      title: 'Güncelleme hazır',
      message: 'Yeni sürüm indirildi: ' + surum,
      detail: 'Kurulum uygulamayı kapatıp yeniden başlatır. Canlı akış açıksa ' +
        'veya tarama sürüyorsa "Uygulamayı kapatınca kur" seçeneğini kullanın; ' +
        'güncelleme siz çıkarken kendiliğinden kurulur.\n\n' +
        'Mum verisi ve hafıza güncellemeden etkilenmez.',
      noLink: true,
    })
  } catch (err) {
    log('hata', 'Guncelleme sorusu gosterilemedi: ' + (err && err.message))
    return
  }

  if (yanit && yanit.response === 0) {
    log('bilgi', 'Kullanici simdi kurmayi secti: ' + surum)
    // isSilent=false: kurulum penceresi gorunsun, kullanici ne oldugunu bilsin.
    // isForceRunAfter=true: kurulumdan sonra uygulama geri acilsin.
    setImmediate(() => updaterAl().quitAndInstall(false, true))
    return
  }
  cikistaKur = true
  log('bilgi', 'Guncelleme cikista kurulacak: ' + surum)
  bildir('cikista-kurulacak', { surum: surum })
}

/**
 * Guncelleme kontrolunu baslatir.
 * @param {{showWindow?:Function, emit?:Function}} [opts]
 */
function baslat(opts) {
  const o = opts || {}
  if (typeof o.showWindow === 'function') showWindow = o.showWindow
  if (typeof o.emit === 'function') emitter = o.emit

  const durum = calisabilirMi()
  if (!durum.olur) {
    log('bilgi', 'Otomatik guncelleme kapali: ' + durum.sebep)
    return
  }

  let up = null
  try {
    up = updaterAl()
  } catch (err) {
    log('hata', 'electron-updater yuklenemedi: ' + (err && err.message))
    return
  }

  up.on('checking-for-update', () => bildir('bakiliyor'))
  up.on('update-not-available', () => {
    log('bilgi', 'Guncelleme yok, surum guncel.')
    bildir('guncel')
  })
  up.on('update-available', (bilgi) => {
    log('bilgi', 'Guncelleme bulundu: ' + (bilgi && bilgi.version) + ', indiriliyor.')
    bildir('indiriliyor', { surum: bilgi && bilgi.version })
  })
  up.on('download-progress', (p) => {
    bildir('indiriliyor', { yuzde: p && p.percent ? Math.round(p.percent) : 0 })
  })
  up.on('update-downloaded', (bilgi) => {
    log('bilgi', 'Guncelleme indirildi: ' + (bilgi && bilgi.version))
    bildir('indirildi', { surum: bilgi && bilgi.version })
    kurulumuSor(bilgi)
  })
  up.on('error', (err) => {
    // AG HATASI UYGULAMAYI DURDURMAZ. Musterinin internetinin olmamasi ya da
    // GitHub'a erisememesi uygulamanin calismasini engellememelidir.
    log('hata', 'Guncelleme denemesi basarisiz: ' + (err && err.message ? err.message : String(err)))
    bildir('hata', { mesaj: err && err.message ? err.message : String(err) })
  })

  // Acilista hemen sorma: uygulamanin ilk saniyeleri veri yukleme ve
  // isci baslatmayla dolu, ag istegi onlarla yarismasin.
  setTimeout(() => {
    try {
      up.checkForUpdates()
    } catch (err) {
      log('hata', 'Guncelleme kontrolu baslatilamadi: ' + (err && err.message))
    }
  }, 8000)
}

/** Uygulama kapanirken cagrilir: bekleyen guncelleme varsa kurar. */
function cikisKurulumu() {
  if (!cikistaKur || !autoUpdater) return false
  try {
    log('bilgi', 'Cikista guncelleme kuruluyor.')
    autoUpdater.quitAndInstall(false, false)
    return true
  } catch (err) {
    log('hata', 'Cikista kurulum yapilamadi: ' + (err && err.message))
    return false
  }
}

/** Kullanici menuden elle kontrol ettiginde. */
function elleKontrol() {
  const durum = calisabilirMi()
  if (!durum.olur) {
    const mesajlar = {
      'gelistirme-calistirmasi': 'Geliştirme çalıştırmasında güncelleme kontrolü yapılmaz.',
      'tasinabilir-surum': 'Bu, taşınabilir (kurulumsuz) sürüm. Otomatik güncelleme yalnızca ' +
        'kurulum sürümünde çalışır. Kurulum dosyasını indirip bir kez kurmanız yeterli.',
    }
    dialog.showMessageBox({
      type: 'info',
      title: 'Güncelleme',
      message: mesajlar[durum.sebep] || 'Güncelleme kontrolü bu çalıştırmada yapılamıyor.',
      buttons: ['Tamam'],
      noLink: true,
    }).catch(() => {})
    return
  }
  try {
    updaterAl().checkForUpdates()
  } catch (err) {
    log('hata', 'Elle kontrol basarisiz: ' + (err && err.message))
  }
}

/** Surum notlarini tarayicida acar. */
function surumNotlariniAc() {
  try {
    shell.openExternal('https://github.com/dogukandogru/zone-memory/releases')
  } catch (err) {
    // Tarayici acilamazsa onemsiz.
  }
}

module.exports = {
  baslat,
  cikisKurulumu,
  elleKontrol,
  surumNotlariniAc,
  // Test icin.
  _calisabilirMi: calisabilirMi,
}
