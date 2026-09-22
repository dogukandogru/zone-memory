'use strict'

// ILK ACILISTA GOMULU VERININ KURULMASI
//
// Musteriye teslimde veri klasorunu elle kopyalamak gerekiyordu; yanlis
// klasore kopyalandiginda uygulama "kayit yok" diyor ve sebebi
// gorunmuyordu. Artik veri kurulumun icinde geliyor ve ilk acilista yerine
// konuyor.
//
// BU DOSYANIN ASIL ISI TEK BIR SEYI KILITLEMEK: var olan verinin ustune
// ASLA yazilmamasi. Bir guncelleme kurulumu, musterinin aylardir biriktirdigi
// canli barlari ve taradigi hafizayi sessizce eski bir anlik goruntuyle
// degistirseydi bu geri alinamaz bir kayip olurdu.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Her testte temiz klasorler ve taze modul kopyasi. */
function tazeKurulum() {
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-firstrun-'))
  const userDir = path.join(kok, 'user')
  const dataDir = path.join(userDir, 'data')
  const gomulu = path.join(kok, 'bundled-data')
  fs.mkdirSync(userDir, { recursive: true })
  fs.mkdirSync(gomulu, { recursive: true })

  process.env.ZONE_MEMORY_USER_DIR = userDir
  process.env.ZONE_MEMORY_DATA_DIR = dataDir
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'main'))) delete require.cache[anahtar]
  }
  const firstrun = require('../src/main/firstrun')
  return { kok, userDir, dataDir, gomulu, firstrun }
}

/** Gomulu klasore ornek dosyalar koyar. */
function gomuluDoldur(gomulu) {
  fs.writeFileSync(path.join(gomulu, 'XAUUSD_15m.bin'), Buffer.alloc(2048, 7))
  fs.writeFileSync(path.join(gomulu, 'XAUUSD_15m_memory.json'), '{"gomulu":true}')
  fs.writeFileSync(path.join(gomulu, 'XAUUSD_15m_memory.vec'), Buffer.alloc(512, 3))
}

test('bos makinede gomulu veri kurulur', () => {
  const { dataDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)

  const sonuc = firstrun._kopyala(gomulu, (fs.mkdirSync(dataDir, { recursive: true }), dataDir))
  assert.strictEqual(sonuc.kopyalandi, 3)
  assert.strictEqual(sonuc.atlanan, 0)
  assert.strictEqual(sonuc.bayt, 2048 + 15 + 512)

  assert.ok(fs.existsSync(path.join(dataDir, 'XAUUSD_15m.bin')))
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'XAUUSD_15m_memory.json'), 'utf8'),
    '{"gomulu":true}')
  // Yarim kalmis gecici dosya birakilmamali.
  assert.strictEqual(fs.readdirSync(dataDir).filter((a) => a.endsWith('.yukleniyor')).length, 0)
})

// BU TESTIN BUTUN KONUSU BU.
test('var olan verinin USTUNE YAZILMAZ', () => {
  const { dataDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)

  // Musterinin kendi verisi: aylarca biriktirilmis, taranmis.
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'XAUUSD_15m.bin'), 'MUSTERININ KENDI VERISI')
  fs.writeFileSync(path.join(dataDir, 'XAUUSD_1m.bin'), 'BASKA BIR DOSYA')

  assert.strictEqual(firstrun._veriVarMi(dataDir), true)

  const sonuc = firstrun.kur(gomulu)
  assert.strictEqual(sonuc.durum, 'veri-zaten-var')
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'XAUUSD_15m.bin'), 'utf8'),
    'MUSTERININ KENDI VERISI', 'musterinin dosyasi degismemeli')
  assert.ok(!fs.existsSync(path.join(dataDir, 'XAUUSD_15m_memory.json')),
    'gomulu dosyalarin HICBIRI kopyalanmamali')
})

test('tek bir .bin bile varsa kurulum yapilmaz', () => {
  const { dataDir, firstrun } = tazeKurulum()
  fs.mkdirSync(dataDir, { recursive: true })
  // Yalnizca bir hafiza dosyasi: .bin yok, yani depo bos sayilir.
  fs.writeFileSync(path.join(dataDir, 'XAUUSD_15m_memory.json'), '{}')
  assert.strictEqual(firstrun._veriVarMi(dataDir), false)

  fs.writeFileSync(path.join(dataDir, 'XAUUSD_4h.bin'), 'x')
  assert.strictEqual(firstrun._veriVarMi(dataDir), true)
})

test('okunamayan klasor "veri var" sayilir: emin olmadan yazilmaz', () => {
  const { kok, firstrun } = tazeKurulum()
  assert.strictEqual(firstrun._veriVarMi(path.join(kok, 'hic-olmayan-klasor')), true)
})

test('gomulu veri yoksa sessizce gecilir', () => {
  const { kok, firstrun } = tazeKurulum()
  const sonuc = firstrun.kur(path.join(kok, 'hic-olmayan-gomulu'))
  assert.strictEqual(sonuc.durum, 'gomulu-veri-yok')
})

test('bos makinede kur() ucdan uca calisir', () => {
  const { dataDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)

  const sonuc = firstrun.kur(gomulu)
  assert.strictEqual(sonuc.durum, 'kuruldu')
  assert.strictEqual(sonuc.kopyalandi, 3)
  assert.ok(fs.existsSync(path.join(dataDir, 'XAUUSD_15m.bin')))

  // Ikinci acilista bir daha kurmaz.
  const ikinci = firstrun.kur(gomulu)
  assert.strictEqual(ikinci.durum, 'veri-zaten-var')
})

test('kopyalanamayan dosya digerlerini durdurmaz', () => {
  const { dataDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)
  // Klasor, dosya degil: atlanmali ama digerleri kopyalanmali.
  fs.mkdirSync(path.join(gomulu, 'alt-klasor'))

  fs.mkdirSync(dataDir, { recursive: true })
  const sonuc = firstrun._kopyala(gomulu, dataDir)
  assert.strictEqual(sonuc.kopyalandi, 3)
  assert.strictEqual(sonuc.atlanan, 1)
})

// ---------------------------------------------------------------------------
// GOMULU AYARLAR
// ---------------------------------------------------------------------------
// Hafiza, paketi hazirlayan makinedeki ayarlarla kuruldu ve kendi ayar izini
// tasiyor. Ayarlar gitmezse musteride iz tutmuyor, otomatik tarama hafizayi
// bastan kuruyor ve test sinyalleri siliniyor. Gercekte oldu: 5m'de 990
// yayinlanan sinyal ilk acilista silindi ve liste bos gorundu.

test('gomulu ayarlar kurulur ve veri klasorune SIZMAZ', () => {
  const { userDir, dataDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)
  fs.writeFileSync(path.join(gomulu, 'settings.bundled.json'),
    JSON.stringify({ timeframe: '1h', signalCfg: { minMatches: 20 } }))

  const sonuc = firstrun.kur(gomulu)
  assert.strictEqual(sonuc.durum, 'kuruldu')
  assert.strictEqual(sonuc.ayar, 'kuruldu')

  const yazilan = JSON.parse(fs.readFileSync(path.join(userDir, 'settings.json'), 'utf8'))
  assert.strictEqual(yazilan.timeframe, '1h')
  assert.strictEqual(yazilan.signalCfg.minMatches, 20)

  // Ayar dosyasi VERI degildir, veri klasorune kopyalanmamali.
  assert.ok(!fs.existsSync(path.join(dataDir, 'settings.bundled.json')))
  assert.ok(!fs.existsSync(path.join(dataDir, 'settings.json')))
})

test('musterinin kendi ayarlari varsa USTUNE YAZILMAZ', () => {
  const { userDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)
  fs.writeFileSync(path.join(gomulu, 'settings.bundled.json'),
    JSON.stringify({ timeframe: '1h' }))
  fs.writeFileSync(path.join(userDir, 'settings.json'),
    JSON.stringify({ timeframe: '15m', kendi: true }))

  const sonuc = firstrun.kur(gomulu)
  assert.strictEqual(sonuc.ayar, 'ayar-zaten-var')
  const kalan = JSON.parse(fs.readFileSync(path.join(userDir, 'settings.json'), 'utf8'))
  assert.strictEqual(kalan.timeframe, '15m', 'musterinin ayari degismemeli')
  assert.strictEqual(kalan.kendi, true)
})

test('bozuk gomulu ayar dosyasi yazilmaz', () => {
  const { userDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)
  fs.writeFileSync(path.join(gomulu, 'settings.bundled.json'), '{ bozuk json')

  const sonuc = firstrun.kur(gomulu)
  assert.strictEqual(sonuc.ayar, 'hata')
  assert.ok(!fs.existsSync(path.join(userDir, 'settings.json')),
    'bozuk ayar yazilmaktansa hic yazilmamali')
  assert.ok(!fs.existsSync(path.join(userDir, 'settings.json.yukleniyor')),
    'yarim dosya birakilmamali')
})

test('veri zaten varken bile ayarlar kurulur', () => {
  const { userDir, dataDir, gomulu, firstrun } = tazeKurulum()
  gomuluDoldur(gomulu)
  fs.writeFileSync(path.join(gomulu, 'settings.bundled.json'), JSON.stringify({ timeframe: '1h' }))
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'XAUUSD_15m.bin'), 'MUSTERI VERISI')

  // Kullanici veriyi elle koymus ama ayarlari koymamis olabilir; o durumda
  // da iz tutmaz, yani ayar kurulumu veriden BAGIMSIZ olmali.
  const sonuc = firstrun.kur(gomulu)
  assert.strictEqual(sonuc.durum, 'veri-zaten-var')
  assert.strictEqual(sonuc.ayar, 'kuruldu')
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(userDir, 'settings.json'), 'utf8')).timeframe, '1h')
})
