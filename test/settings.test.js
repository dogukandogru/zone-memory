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

// ---------------------------------------------------------------------------
// PAKETE GOMULU API ANAHTARI
// ---------------------------------------------------------------------------
// Musteriye kurulu halde teslim edilen yapida anahtarin hazir gelmesi icin
// `src/main/apiKeys.local.json` okunur. Dosya git'te DEGILDIR; bu testler
// dosyanin olmadigi (normal gelistirme) ve oldugu (musteri yapisi) halleri
// birlikte kilitler.
//
// Not: bu bir sir saklama yontemi DEGILDIR, asar sifrelenmis degildir.

const ANAHTAR_DOSYASI = path.join(__dirname, '..', 'src', 'main', 'apiKeys.local.json')

test('gomulu anahtar dosyasi YOKKEN anahtarlar bos gelir', () => {
  if (fs.existsSync(ANAHTAR_DOSYASI)) {
    // Gelistiricinin gercek anahtari duruyor olabilir, ona DOKUNMAYIZ.
    return
  }
  const { settings } = tazeAyarlar()
  assert.strictEqual(settings.get('apiKeys.polygon'), '')
  assert.strictEqual(settings.get('apiKeys.twelvedata'), '')
})

test('gomulu anahtar varsayilan olur, kullanici ezebilir, diske yazilmaz', () => {
  if (fs.existsSync(ANAHTAR_DOSYASI)) return   // gercek anahtari ezme

  fs.writeFileSync(ANAHTAR_DOSYASI, JSON.stringify({
    polygon: '  GOMULU_POLYGON  ',            // bosluklar kirpilmali
    twelvedata: '',                            // bos deger yok sayilmali
    kotuAlan: 'yoksayilmali',
  }))
  try {
    const { dir, settings } = tazeAyarlar()

    assert.strictEqual(settings.get('apiKeys.polygon'), 'GOMULU_POLYGON')
    assert.strictEqual(settings.get('apiKeys.twelvedata'), '')
    assert.strictEqual(settings.get('apiKeys.kotuAlan'), undefined)

    // Varsayilana ESIT oldugu icin ayar dosyasina yazilmaz.
    settings.applySetPayload({ patch: { timeframe: '1h' } })
    assert.strictEqual(diskten(dir).apiKeys, undefined,
      'gomulu anahtar kullanici dosyasina kopyalanmamali')

    // Musteri kendi anahtarini girerse gomulu olani ezer ve diske yazilir.
    settings.applySetPayload({ key: 'apiKeys.polygon', value: 'MUSTERI' })
    assert.strictEqual(settings.get('apiKeys.polygon'), 'MUSTERI')
    assert.strictEqual(diskten(dir).apiKeys.polygon, 'MUSTERI')
  } finally {
    fs.unlinkSync(ANAHTAR_DOSYASI)
  }
})

test('bozuk gomulu anahtar dosyasi uygulamayi durdurmaz', () => {
  if (fs.existsSync(ANAHTAR_DOSYASI)) return

  fs.writeFileSync(ANAHTAR_DOSYASI, '{ bu gecerli json degil')
  try {
    const { settings } = tazeAyarlar()
    assert.strictEqual(settings.get('apiKeys.polygon'), '')
  } finally {
    fs.unlinkSync(ANAHTAR_DOSYASI)
  }
})

// GOMULU ANAHTAR BOSLUGU DOLDURUR, GIRILMIS ANAHTARI EZMEZ.
//
// Kilitlenen tuzak: gomulu anahtar VARSAYILANDIR, kullanicinin yamasi ise
// varsayilani ezer. Kullanici ayar ekranini bir kez acip kaydettiyse yamada
// `apiKeys.oanda: ""` kalabiliyor; o zaman pakete gomulu anahtar hicbir zaman
// devreye girmiyor ve kullanici yine "API anahtari gerekli" hatasi aliyor.
// Sebebi de gorunmez, ayarlarda alan dolu gibi durur.

/** Gelistiricinin gercek anahtar dosyasini bozmadan sahte dosyayla calisir. */
function sahteAnahtarDosyasiyla(icerik, govde) {
  const yedek = ANAHTAR_DOSYASI + '.test-yedegi'
  const vardi = fs.existsSync(ANAHTAR_DOSYASI)
  if (vardi) fs.renameSync(ANAHTAR_DOSYASI, yedek)
  fs.writeFileSync(ANAHTAR_DOSYASI, JSON.stringify(icerik))
  try {
    govde()
  } finally {
    fs.unlinkSync(ANAHTAR_DOSYASI)
    if (vardi) fs.renameSync(yedek, ANAHTAR_DOSYASI)
  }
}

test('yamada BOS kalan anahtar gomulu olanla doldurulur', () => {
  sahteAnahtarDosyasiyla({ oanda: 'GOMULU_OANDA' }, () => {
    const { dir, settings } = tazeAyarlar()

    // Kullanici ayar ekranini acip kaydetmis: yamada bos anahtar duruyor.
    settings.applySetPayload({ patch: { apiKeys: { oanda: '' } } })
    assert.strictEqual(diskten(dir).apiKeys.oanda, '',
      'once bos degerin gercekten diske yazildigini dogrula')

    // BU TESTIN BUTUN KONUSU: bos deger gomulu anahtari ezmemeli.
    settings.reset()
    assert.strictEqual(settings.get('apiKeys.oanda'), 'GOMULU_OANDA')
  })
})

test('gomulu anahtar GIRILMIS anahtari ezmez', () => {
  sahteAnahtarDosyasiyla({ oanda: 'GOMULU_OANDA' }, () => {
    const { settings } = tazeAyarlar()
    settings.applySetPayload({ key: 'apiKeys.oanda', value: 'KULLANICININ_KENDI' })
    settings.reset()
    assert.strictEqual(settings.get('apiKeys.oanda'), 'KULLANICININ_KENDI',
      'kullanicinin girdigi anahtar her zaman onceliklidir')
  })
})

test('yalnizca bosluk iceren anahtar da bos sayilir', () => {
  sahteAnahtarDosyasiyla({ oanda: 'GOMULU_OANDA' }, () => {
    const { settings } = tazeAyarlar()
    settings.applySetPayload({ key: 'apiKeys.oanda', value: '   ' })
    settings.reset()
    assert.strictEqual(settings.get('apiKeys.oanda'), 'GOMULU_OANDA')
  })
})

// VERI KAYNAGI GOCU (settingsVersion 3)
//
// Kutulara TradingView'da OANDA:XAUUSD grafiginde bakiliyor. Uygulama ise
// gecmiste HistData, canlida Binance PAXGUSDT (bir token, yani VEKIL)
// kullaniyordu; olculdu, grafikteki kutularin yalnizca %56,7'si uretiliyordu.
// Varsayilani degistirmek TEK BASINA yetmez: kayitli secim varsayilani EZER
// ve mevcut kurulumlarin hepsinde secim yazili. Bu yuzden goc gerekiyor.

test('kayitli eski veri kaynagi OANDA ya tasinir', () => {
  const { dir, settings } = tazeAyarlar()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    settingsVersion: 2,
    providers: { history: 'histdata', live: 'binance' },
    signalCfg: { minMatches: 20 },
  }))
  settings.reset()

  assert.strictEqual(settings.get('providers.history'), 'oanda')
  assert.strictEqual(settings.get('providers.live'), 'oanda')
  // Kullanicinin kendi esikleri goc sirasinda KAYBOLMAMALI.
  assert.strictEqual(settings.get('signalCfg.minMatches'), 20)
})

test('kaynak secimi olmayan eski dosya da OANDA ile acilir', () => {
  const { dir, settings } = tazeAyarlar()
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    settingsVersion: 2,
    timeframe: '15m',
  }))
  settings.reset()
  assert.strictEqual(settings.get('providers.history'), 'oanda')
  assert.strictEqual(settings.get('providers.live'), 'oanda')
  assert.strictEqual(settings.get('timeframe'), '15m')
})

test('goc sonrasi kullanici yine de baska bir kaynak secebilir', () => {
  const { settings } = tazeAyarlar()
  settings.applySetPayload({ key: 'providers.live', value: 'binance' })
  settings.reset()
  assert.strictEqual(settings.get('providers.live'), 'binance',
    'goc bir kez calisir, kullaniciyi kilitlemez')
  assert.strictEqual(settings.get('providers.history'), 'oanda')
})
