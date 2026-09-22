'use strict'

// OTOMATIK GUNCELLEME KORUMALARI
//
// Guncelleme mantiginin kendisi (indirme, kurulum) electron-updater'in isi ve
// burada sinanmaz. Sinanan sey, guncellemenin NEREDE CALISMAMASI gerektigi:
//
//  - Gelistirmede calisirsa her `npm start` aga cikar.
//  - Tasinabilir (zip'ten acilmis) surumde electron-updater kurulumun kendisini
//    degistirmeye calisir; ortada kurulum yoktur, hata verir ve kullanici
//    anlamsiz bir uyari gorur.
//
// Bir de en onemlisi: guncellemenin MUSTERININ VERISINE dokunmadigi. Veri
// kurulum klasorunun disinda, %APPDATA%\Zone Memory\data altinda durur.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

/**
 * Electron sahtelenerek updater.js yuklenir.
 * @param {{isPackaged:boolean, resourcesPath:string}} ortam
 */
function updaterYukle(ortam) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-updater-'))
  process.env.ZONE_MEMORY_USER_DIR = dir
  process.env.ZONE_MEMORY_DATA_DIR = path.join(dir, 'data')

  const sahteElectron = {
    app: { isPackaged: ortam.isPackaged },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: { openExternal() {} },
  }

  const eskiResources = process.resourcesPath
  Object.defineProperty(process, 'resourcesPath', {
    value: ortam.resourcesPath, configurable: true, writable: true,
  })

  const asilYukle = Module._load
  Module._load = function (istek) {
    if (istek === 'electron') return sahteElectron
    // electron-updater'i HIC yukletmiyoruz: gercek modul aga cikmaya calisir.
    if (istek === 'electron-updater') throw new Error('test: yuklenmemeli')
    return asilYukle.apply(this, arguments)
  }
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'main'))) delete require.cache[anahtar]
  }
  const updater = require('../src/main/updater')
  Module._load = asilYukle

  return {
    updater,
    dir,
    geriAl: () => {
      Object.defineProperty(process, 'resourcesPath', {
        value: eskiResources, configurable: true, writable: true,
      })
    },
  }
}

/** Kurulum surumunu taklit eden kaynak klasoru (app-update.yml iceren). */
function kurulumKlasoru() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-res-'))
  fs.writeFileSync(path.join(d, 'app-update.yml'), 'provider: github\n')
  return d
}

/** Tasinabilir surumu taklit eden kaynak klasoru (app-update.yml YOK). */
function tasinabilirKlasor() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zm-res-'))
}

test('gelistirme calistirmasinda guncelleme KAPALI', () => {
  const { updater, geriAl } = updaterYukle({
    isPackaged: false, resourcesPath: kurulumKlasoru(),
  })
  try {
    const d = updater._calisabilirMi()
    assert.strictEqual(d.olur, false)
    assert.strictEqual(d.sebep, 'gelistirme-calistirmasi')
    // baslat() cagrisi da patlamamali, sessizce donmeli.
    updater.baslat({})
  } finally {
    geriAl()
  }
})

test('tasinabilir surumde guncelleme KAPALI', () => {
  const { updater, geriAl } = updaterYukle({
    isPackaged: true, resourcesPath: tasinabilirKlasor(),
  })
  try {
    const d = updater._calisabilirMi()
    assert.strictEqual(d.olur, false)
    assert.strictEqual(d.sebep, 'tasinabilir-surum',
      'zip\'ten acilmis surumde electron-updater yuklenmemeli')
    updater.baslat({})
  } finally {
    geriAl()
  }
})

test('kurulum surumunde guncelleme ACIK', () => {
  const { updater, geriAl } = updaterYukle({
    isPackaged: true, resourcesPath: kurulumKlasoru(),
  })
  try {
    const d = updater._calisabilirMi()
    assert.strictEqual(d.olur, true)
    assert.strictEqual(d.sebep, '')
    // Bu ortamda baslat() electron-updater'i yuklemeye calisir; sahte yukleyici
    // hata firlatir ve bu HATA YUTULMALIDIR, uygulama acilmaya devam etmeli.
    updater.baslat({})
  } finally {
    geriAl()
  }
})

test('bekleyen guncelleme yokken cikista kurulum denenmez', () => {
  const { updater, geriAl } = updaterYukle({
    isPackaged: true, resourcesPath: kurulumKlasoru(),
  })
  try {
    assert.strictEqual(updater.cikisKurulumu(), false)
  } finally {
    geriAl()
  }
})

// GUNCELLEME VERIYE DOKUNMAZ.
//
// Bu, kod okunarak degil YAPIYLA garanti edilir: veri kullanici klasorunde,
// uygulama ise kurulum klasorundedir. Ikisinin ayri oldugunu kilitliyoruz;
// biri digerinin altina tasinirsa guncelleme musterinin 17 yillik verisini
// silerdi.
test('veri klasoru kurulum klasorunun ICINDE degildir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-yol-'))
  process.env.ZONE_MEMORY_USER_DIR = dir
  delete process.env.ZONE_MEMORY_DATA_DIR
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'core', 'paths-core'))) delete require.cache[anahtar]
  }
  const core = require('../src/core/paths-core')

  const veri = core.dataDir(dir)
  // Kurulum klasoru Windows'ta %LOCALAPPDATA%\Programs altindadir; veri ise
  // %APPDATA% altinda. Testte yapabilecegimiz kontrol: veri klasoru
  // uygulamanin calistigi dizinin (process.resourcesPath / __dirname) altinda
  // OLMAMALI.
  const uygulamaKoku = path.join(__dirname, '..')
  assert.ok(!veri.startsWith(uygulamaKoku + path.sep),
    'veri klasoru uygulama klasorunun altinda olmamali: ' + veri)
  assert.ok(veri.includes(dir), 'veri kullanici klasorunun altinda olmali: ' + veri)
})
