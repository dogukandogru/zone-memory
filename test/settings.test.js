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

// O2 - dosyaya yalnizca kullanicinin degistirdigi alanlar yazilir. Onceden
// birlesik nesnenin tamami yaziliyordu: zaman dilimi hazir ayarlari fiilen
// hic devreye girmiyor, cekirdek varsayilan degisiklikleri kullaniciya
// ulasmiyordu.
test('diske yalnizca varsayilandan farkli alanlar ve surum yazilir', () => {
  const { dir, settings } = tazeAyarlar()
  settings.applySetPayload({ patch: { signalCfg: { minMatches: 7 } } })
  const disk = diskten(dir)
  assert.strictEqual(disk.settingsVersion, settings.SETTINGS_VERSION)
  assert.strictEqual(disk.signalCfg.minMatches, 7)
  assert.strictEqual(disk.indicatorParams, undefined, 'dokunulmayan indikator ayarlari yazilmamali')
  assert.strictEqual(disk.theme, undefined, 'varsayilana esit alan yazilmamali')
  // Birlesik ayar yine tam gelir.
  assert.strictEqual(settings.get('theme'), settings.DEFAULTS.theme)
  assert.strictEqual(settings.get('indicatorParams.pivotLen'), settings.DEFAULTS.indicatorParams.pivotLen)
  // Kullanici yamasi ayrica okunabilir (hazir ayar katmani icin gerekli).
  assert.deepStrictEqual(settings.loadPatch().signalCfg, { minMatches: 7 })
})

test('eski bicimli dosya gocurulur: esikler korunur, signalCfg.outcomeCfg atilir', () => {
  const { dir, settings } = tazeAyarlar()
  // Eski surum: tum varsayilanlar diske donmus ve signalCfg.outcomeCfg null.
  const eski = JSON.parse(JSON.stringify(settings.DEFAULTS))
  eski.signalCfg.outcomeCfg = null
  eski.signalCfg.minMatches = 5
  eski.signalCfg.minWinRate = 0.6
  eski.outcomeCfg.targetAtr = 1.5
  eski.timeframe = '15m'
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(eski, null, 2))
  settings.reset()

  const yama = settings.loadPatch()
  assert.strictEqual(yama.signalCfg.minMatches, 5, 'kullanicinin esigi korunmali')
  assert.strictEqual(yama.signalCfg.minWinRate, 0.6)
  assert.strictEqual(yama.outcomeCfg.targetAtr, 1.5)
  assert.ok(!('outcomeCfg' in yama.signalCfg), 'signalCfg.outcomeCfg atilmali')
  assert.strictEqual(yama.indicatorParams, undefined, 'varsayilana esit indikator ayarlari atilmali')
  assert.strictEqual(yama.timeframe, '15m')
  // Goc diske de yazilir.
  assert.strictEqual(diskten(dir).settingsVersion, settings.SETTINGS_VERSION)
})

// ---------------------------------------------------------------------------
// C8 - PROTOTIP KIRLETMESI
// ---------------------------------------------------------------------------
// Ayar anahtari renderer'dan geliyor. `setPath('__proto__.x', 1)` ana surecte
// Object.prototype'a yaziyordu ve bu, uygulamanin TAMAMININ davranisini
// degistirebilirdi.
//
// Not: korumanin ilk yazimi da ayni tuzaga dusmustu. Yasakli anahtarlar
// `{ __proto__: 1 }` nesne degismeziyle tutulunca kendi ozelligi olusmuyor,
// nesnenin PROTOTIPI ayarlaniyor ve kontrol `__proto__`u hic yakalamiyor.

test('__proto__ ve constructor anahtarlari Object.prototype\'a yazamaz', () => {
  const { settings } = tazeAyarlar()
  {
    settings.set('__proto__.kotu', 1)
    settings.set('constructor.prototype.kotu2', 2)
    settings.save(JSON.parse('{"__proto__":{"kotu3":3}}'))
    settings.save(JSON.parse('{"signalCfg":{"__proto__":{"kotu4":4}}}'))

    const bos = {}
    assert.strictEqual(bos.kotu, undefined, '__proto__.x yazilmamali')
    assert.strictEqual(bos.kotu2, undefined, 'constructor.prototype.x yazilmamali')
    assert.strictEqual(bos.kotu3, undefined, 'yamadaki __proto__ yazilmamali')
    assert.strictEqual(bos.kotu4, undefined, 'ic ice __proto__ yazilmamali')

    // Normal ayarlar etkilenmemeli.
    settings.set('timeframe', '1h')
    assert.strictEqual(settings.get('timeframe'), '1h')
  }
})
