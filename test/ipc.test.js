// Renderer ile ana surec arasindaki `settings:set` ve `settings:reset`
// yolunu gercek ipc yonlendiricisi uzerinden dogrular. Asil hata buradaydi:
// arayuz ciplak yama gonderiyor, yonlendirici bunu `save({})` cagirisina
// ceviriyordu, yani hicbir ayar kaydedilmiyordu.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

/** Electron olmadan ipc.js yuklenebilsin diye kucuk bir sahte modul. */
function electronsuzYukle(sahteEngine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-ipc-'))
  process.env.ZONE_MEMORY_USER_DIR = dir
  process.env.ZONE_MEMORY_DATA_DIR = path.join(dir, 'data')

  const sahteElectron = {
    app: { getVersion: () => '0.0.0-test', getPath: () => dir, isPackaged: false },
    ipcMain: { handle() {}, removeHandler() {} },
  }
  const asilYukle = Module._load
  Module._load = function (istek, _ust, _ana) {
    if (istek === 'electron') return sahteElectron
    // Motor cagrilarini yakalamak icin (API anahtari yolunu dogrularken).
    if (sahteEngine && istek === './engine') return sahteEngine
    return asilYukle.apply(this, arguments)
  }
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'main'))) delete require.cache[anahtar]
  }
  const ipc = require('../src/main/ipc')
  const settings = require('../src/main/settings')
  settings.reset()
  Module._load = asilYukle
  return { dir, ipc, settings }
}

test('settings:set uc yuk biciminde de diske yazar', async () => {
  const { dir, ipc, settings } = electronsuzYukle()

  await ipc.dispatch('settings:set', { timeframe: '1h' })
  await ipc.dispatch('settings:set', { patch: { signalCfg: { minMatches: 7 } } })
  await ipc.dispatch('settings:set', { providers: { live: 'okx' } })
  await ipc.dispatch('settings:set', { key: 'apiKeys.polygon', value: 'anahtar-123' })

  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.strictEqual(disk.timeframe, '1h')
  assert.strictEqual(disk.signalCfg.minMatches, 7)
  assert.strictEqual(disk.providers.live, 'okx')
  assert.strictEqual(disk.apiKeys.polygon, 'anahtar-123')

  // Onbellek bosaltilip yeniden okunsa da ayni deger gelir.
  settings.reset()
  assert.strictEqual(settings.get('signalCfg.minMatches'), 7)
})

test('settings:reset anahtarlari ve saglayiciyi korur', async () => {
  const { ipc } = electronsuzYukle()
  await ipc.dispatch('settings:set', {
    patch: { apiKeys: { polygon: 'anahtar-xyz' }, providers: { live: 'okx' }, signalCfg: { minMatches: 33 } },
  })
  const sonra = await ipc.dispatch('settings:reset', {})
  assert.strictEqual(sonra.apiKeys.polygon, 'anahtar-xyz')
  assert.strictEqual(sonra.providers.live, 'okx')
  assert.notStrictEqual(sonra.signalCfg.minMatches, 33)
})

// ---------------------------------------------------------------------------
// V5 - API ANAHTARI VERI CEK'E ILETILIR AMA RENDERER'A HIC GITMEZ
// ---------------------------------------------------------------------------
// Veri Cek ve otomatik hazirlik `data:sync` cagirirken yuke anahtar
// koymuyordu, ipc de eklemiyordu; bu yuzden Polygon veya Twelve Data
// secilince senkron HER ZAMAN "API anahtari gerekli" hatasi veriyordu. Bu da
// vekil hacim ve basis sorunlarinin en dogrudan cozumu olan gercek spot
// kaynagi kapatiyordu.

test('data:sync ayarlardaki anahtari yuke ekler, renderer anahtar gondermez', async () => {
  const cagrilar = []
  const sahteEngine = {
    call: async (cmd, payload) => { cagrilar.push({ cmd, payload }); return { ok: true, added: 0 } },
    restart: async () => {},
    status: () => ({}),
    onLog: () => {},
  }
  const { ipc } = electronsuzYukle(sahteEngine)

  await ipc.dispatch('settings:set', { patch: { apiKeys: { polygon: 'gizli-anahtar' } } })

  // Renderer anahtar GONDERMEZ, yalnizca saglayici kimligi gonderir.
  await ipc.dispatch('data:sync', { tf: '15m', providerId: 'polygon' })

  assert.strictEqual(cagrilar.length, 1)
  assert.strictEqual(cagrilar[0].cmd, 'data:sync')
  assert.strictEqual(cagrilar[0].payload.apiKey, 'gizli-anahtar',
    'anahtar ana surecte yuke eklenmeli')
  assert.strictEqual(cagrilar[0].payload.tf, '15m')

  // Anahtar kayitli olmayan bir saglayicida alan HIC eklenmez.
  await ipc.dispatch('data:sync', { tf: '15m', providerId: 'twelvedata' })
  assert.strictEqual(cagrilar[1].payload.apiKey, undefined)

  // Anahtarsiz saglayicida da eklenmez.
  await ipc.dispatch('data:sync', { tf: '15m', providerId: 'histdata' })
  assert.strictEqual(cagrilar[2].payload.apiKey, undefined)
})
