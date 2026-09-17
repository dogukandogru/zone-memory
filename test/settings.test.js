// Ayarlarin diske gercekten yazildigini ve sinir denetimini kilitler.
// Arayuz bir donem ciplak yama gonderiyordu, ipc ise yalnizca {patch} veya
// {key,value} taniyordu: sonuc olarak hicbir ayar kaydedilmiyordu.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Her testte temiz bir kullanici klasoru ve taze modul kopyasi. */
function tazeAyarlar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-settings-'))
  process.env.ZONE_MEMORY_USER_DIR = dir
  process.env.ZONE_MEMORY_DATA_DIR = path.join(dir, 'data')
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'main'))) delete require.cache[anahtar]
  }
  const settings = require('../src/main/settings')
  settings.reset()
  return { dir, settings }
}

/** Diskteki ayar dosyasini okur. */
function diskten(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
}

test('ciplak yama, {patch} ve {key,value} biciminin ucu de diske yazilir', () => {
  const { dir, settings } = tazeAyarlar()

  settings.applySetPayload({ timeframe: '1h' })
  assert.strictEqual(settings.get('timeframe'), '1h')
  assert.strictEqual(diskten(dir).timeframe, '1h')

  settings.applySetPayload({ patch: { signalCfg: { minMatches: 7 } } })
  assert.strictEqual(settings.get('signalCfg.minMatches'), 7)
  assert.strictEqual(diskten(dir).signalCfg.minMatches, 7)

  settings.applySetPayload({ providers: { live: 'okx' } })
  assert.strictEqual(settings.get('providers.live'), 'okx')
  // Yama derin birlesir, dokunulmayan alan korunur.
  assert.strictEqual(settings.get('providers.history'), settings.DEFAULTS.providers.history)

  settings.applySetPayload({ key: 'apiKeys.polygon', value: 'deneme-anahtar' })
  assert.strictEqual(diskten(dir).apiKeys.polygon, 'deneme-anahtar')
})

test('onbellek bosaltilip yeniden okununca degerler diskten geri gelir', () => {
  const { settings } = tazeAyarlar()
  settings.applySetPayload({ patch: { timeframe: '15m', livePollSeconds: 45 } })
  settings.reset()
  assert.strictEqual(settings.get('timeframe'), '15m')
  assert.strictEqual(settings.get('livePollSeconds'), 45)
})

test('sinir disi ve gecersiz degerler yazilmadan once kirpilir', () => {
  const { settings } = tazeAyarlar()
  const onceki = settings.get('signalCfg.minSimilarity')

  const yeni = settings.applySetPayload({
    patch: { signalCfg: { minMatches: -3, minSimilarity: 5, k: 10000 }, livePollSeconds: 0 },
  })
  assert.strictEqual(yeni.signalCfg.minMatches, 1, 'minMatches en az 1 olmali')
  assert.strictEqual(yeni.signalCfg.minSimilarity, 0.999, 'minSimilarity ust sinira kirpilmali')
  assert.strictEqual(yeni.signalCfg.k, 200)
  assert.strictEqual(yeni.livePollSeconds, 3)

  // Sayi olmayan deger onceki degeri korur.
  const sonra = settings.applySetPayload({ patch: { signalCfg: { minSimilarity: 'abc' } } })
  assert.strictEqual(sonra.signalCfg.minSimilarity, 0.999)
  assert.notStrictEqual(onceki, undefined)

  // Bilinmeyen zaman dilimi yazilmaz.
  const tfSonra = settings.applySetPayload({ patch: { timeframe: '7dk' } })
  assert.strictEqual(tfSonra.timeframe, settings.DEFAULTS.timeframe)
})

test('varsayilanlara donus API anahtarlarini, saglayicilari ve zaman dilimini korur', () => {
  const { dir, settings } = tazeAyarlar()
  settings.applySetPayload({
    patch: {
      apiKeys: { polygon: 'gizli-anahtar' },
      providers: { live: 'okx' },
      timeframe: '1h',
      signalCfg: { minMatches: 42 },
    },
  })

  const sonra = settings.varsayilanlaraDon()
  assert.strictEqual(sonra.apiKeys.polygon, 'gizli-anahtar', 'anahtar silinmemeli')
  assert.strictEqual(sonra.providers.live, 'okx')
  assert.strictEqual(sonra.timeframe, '1h')
  assert.strictEqual(sonra.signalCfg.minMatches, settings.DEFAULTS.signalCfg.minMatches)
  assert.strictEqual(diskten(dir).apiKeys.polygon, 'gizli-anahtar')
})

test('replace dosyadaki artik anahtarlari dusurur', () => {
  const { dir, settings } = tazeAyarlar()
  settings.applySetPayload({ patch: { eskiAlan: 'silinmeli', timeframe: '1h' } })
  assert.strictEqual(diskten(dir).eskiAlan, 'silinmeli')
  settings.replace({ timeframe: '1h' })
  assert.strictEqual(diskten(dir).eskiAlan, undefined)
  assert.strictEqual(diskten(dir).timeframe, '1h')
})
