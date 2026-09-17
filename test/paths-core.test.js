'use strict'

// V8 - src/core/paths-core.js testleri.
// Electron'suz saf yol hesabi. Hem betikler (scripts/*.mjs) hem de
// src/main/paths.js bu modulu kullanir; ortam degiskeni onceligi ve yedek
// adlari burada kilitlenir.

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')

const yollar = require('../src/core/paths-core')

const ESKI_USER = process.env.ZONE_MEMORY_USER_DIR
const ESKI_DATA = process.env.ZONE_MEMORY_DATA_DIR

/** Ortam degiskenlerini temizler; her test kendi degerini kurar. */
beforeEach(() => {
  delete process.env.ZONE_MEMORY_USER_DIR
  delete process.env.ZONE_MEMORY_DATA_DIR
})

/** Testten once ne varsa geri koyar. */
afterEach(() => {
  if (ESKI_USER === undefined) delete process.env.ZONE_MEMORY_USER_DIR
  else process.env.ZONE_MEMORY_USER_DIR = ESKI_USER
  if (ESKI_DATA === undefined) delete process.env.ZONE_MEMORY_DATA_DIR
  else process.env.ZONE_MEMORY_DATA_DIR = ESKI_DATA
})

test('userDir: ZONE_MEMORY_USER_DIR her seyin onunde gelir', () => {
  process.env.ZONE_MEMORY_USER_DIR = '/tmp/zm-kok'
  assert.equal(yollar.userDir(), '/tmp/zm-kok')
  // Verilen varsayilan bile ortam degiskenini gecemez.
  assert.equal(yollar.userDir('/baska/kok'), '/tmp/zm-kok')
})

test('userDir: varsayilan dize olarak verilebilir (Electron userData)', () => {
  assert.equal(yollar.userDir('/uygulama/userData'), '/uygulama/userData')
})

test('userDir: varsayilan fonksiyon YALNIZCA gerektiginde cagrilir', () => {
  let cagri = 0
  const cozucu = () => {
    cagri++
    return '/uygulama/userData'
  }

  process.env.ZONE_MEMORY_USER_DIR = '/tmp/zm-kok'
  assert.equal(yollar.userDir(cozucu), '/tmp/zm-kok')
  assert.equal(cagri, 0, 'ortam degiskeni varken cozucu cagrilmamali')

  delete process.env.ZONE_MEMORY_USER_DIR
  assert.equal(yollar.userDir(cozucu), '/uygulama/userData')
  assert.equal(cagri, 1)
})

test('userDir: varsayilan yoksa isletim sistemi koku', () => {
  assert.equal(yollar.userDir(), yollar.defaultUserDir())
  assert.ok(yollar.defaultUserDir().endsWith(yollar.APP_DIR_NAME))
})

test('userDir: bos donen cozucu isletim sistemi koku ile sonuclanir', () => {
  // Electron yokken electronKok() bos dize doner.
  assert.equal(yollar.userDir(() => ''), yollar.defaultUserDir())
})

test('dataDir: kok altinda data klasoru', () => {
  assert.equal(yollar.dataDir('/uygulama'), path.join('/uygulama', 'data'))
})

test('dataDir: ZONE_MEMORY_DATA_DIR koku tamamen gecersiz kilar', () => {
  process.env.ZONE_MEMORY_DATA_DIR = '/tmp/zm-veri'
  assert.equal(yollar.dataDir('/uygulama'), '/tmp/zm-veri')
})

test('settingsPath: ayar dosyasi kokte durur', () => {
  assert.equal(yollar.settingsPath('/uygulama'), path.join('/uygulama', 'settings.json'))
  process.env.ZONE_MEMORY_DATA_DIR = '/tmp/zm-veri'
  assert.equal(
    yollar.settingsPath('/uygulama'),
    path.join('/uygulama', 'settings.json'),
    'settings.json veri klasorunden etkilenmez'
  )
})

test('candlePath / memoryPath: sembol ve zaman dilimi adlandirmasi', () => {
  assert.equal(yollar.candlePath('1m', 'XAUUSD', '/veri'), path.join('/veri', 'XAUUSD_1m.bin'))
  assert.equal(yollar.candlePath('15m', undefined, '/veri'), path.join('/veri', 'XAUUSD_15m.bin'))
  assert.equal(
    yollar.memoryPath('1h', 'XAUUSD', '/veri'),
    path.join('/veri', 'XAUUSD_1h_memory'),
    'hafiza yolu UZANTISIZ tabandir'
  )
})

test('candlePath: klasor verilmezse dataDir kullanilir', () => {
  process.env.ZONE_MEMORY_DATA_DIR = '/tmp/zm-veri'
  assert.equal(yollar.candlePath('1m'), path.join('/tmp/zm-veri', 'XAUUSD_1m.bin'))
})

test('isMemoryFile: yalnizca sembolun hafiza dosyalari', () => {
  assert.equal(yollar.isMemoryFile('XAUUSD_1m_memory.json'), true)
  assert.equal(yollar.isMemoryFile('XAUUSD_1m_memory.vec'), true)
  assert.equal(yollar.isMemoryFile('XAUUSD_15m_memory.zones.json'), true)
  assert.equal(yollar.isMemoryFile('XAUUSD_30m_memory.protos.json'), true)
  // Mum deposu hafiza degildir, tasinmaz.
  assert.equal(yollar.isMemoryFile('XAUUSD_1m.bin'), false)
  // Baska sembol dokunulmaz.
  assert.equal(yollar.isMemoryFile('BASKA_1m_memory.json'), false)
  assert.equal(yollar.isMemoryFile('BASKA_1m_memory.json', 'BASKA'), true)
  // Zaman dilimi olmayan ad eslesmez.
  assert.equal(yollar.isMemoryFile('XAUUSD_memory.json'), false)
})

test('yedekYolu: "<ad>.bak-<damga>"', () => {
  assert.equal(
    yollar.yedekYolu('/veri/XAUUSD_1m.bin', '20260917-040506'),
    '/veri/XAUUSD_1m.bin.bak-20260917-040506'
  )
})

test('eskiHafizaKlasoru: veri klasoru altinda tarihli klasor', () => {
  assert.equal(
    yollar.eskiHafizaKlasoru('/veri', '20260917-040506'),
    path.join('/veri', '_eski_hafiza_yedek', '20260917-040506')
  )
})

test('ensureDir: klasoru olusturur ve yolunu dondurur', () => {
  const fs = require('node:fs')
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-paths-'))
  try {
    const hedef = path.join(kok, 'a', 'b')
    assert.equal(yollar.ensureDir(hedef), hedef)
    assert.ok(fs.statSync(hedef).isDirectory())
    // Ikinci cagri hata vermez.
    assert.equal(yollar.ensureDir(hedef), hedef)
  } finally {
    fs.rmSync(kok, { recursive: true, force: true })
  }
})

test('src/main/paths.js Electron disinda paths-core ile ayni sonucu verir', () => {
  process.env.ZONE_MEMORY_USER_DIR = '/tmp/zm-kok'
  const paths = require('../src/main/paths')
  assert.equal(paths.userDataDir(), '/tmp/zm-kok')
  assert.equal(paths.dataDir(), path.join('/tmp/zm-kok', 'data'))
  assert.equal(paths.settingsPath(), path.join('/tmp/zm-kok', 'settings.json'))
  assert.equal(paths.candlePath('1m'), path.join('/tmp/zm-kok', 'data', 'XAUUSD_1m.bin'))
  assert.equal(
    paths.memoryPath('1m'),
    path.join('/tmp/zm-kok', 'data', 'XAUUSD_1m_memory')
  )
  assert.equal(
    paths.zonesPath('1m'),
    path.join('/tmp/zm-kok', 'data', 'XAUUSD_1m_memory.zones.json')
  )
  assert.equal(paths.APP_DIR_NAME, yollar.APP_DIR_NAME)
  assert.equal(paths.DEFAULT_SYMBOL, yollar.DEFAULT_SYMBOL)

  process.env.ZONE_MEMORY_DATA_DIR = '/tmp/zm-veri'
  assert.equal(paths.dataDir(), '/tmp/zm-veri')
  assert.equal(paths.candlePath('5m'), path.join('/tmp/zm-veri', 'XAUUSD_5m.bin'))
})
