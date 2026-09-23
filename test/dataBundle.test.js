'use strict'

// OANDA VERI PAKETI (src/main/dataBundle.js)
//
// Uygulama tek kaynakla calisiyor: OANDA. Ama mevcut kurulumlarin deposu
// HistData + Binance ile kurulmustu ve ayari degistirmek tek basina yetmiyor:
// depo oldugu yerde kalir, yeni gelen barlar ESKI deponun fiyat ve hacim
// olcegine uydurulur. Depo yeniden kurulmali.
//
// OANDA'dan tek tek indirmek olculdu: 1 dakikalik tam gecmis ~7 milyon mum ve
// bir saatten uzun suruyor, yani musterinin makinesinde yapilamaz. Bu yuzden
// hazir dosya indiriliyor.
//
// BURADA KILITLENEN: dosya yerine konurken ESKI DEPO KAYBOLMAMALI ve bozuk
// bir dosya ASLA yerine gecmemeli. Kullanicinin 17 yillik verisi soz konusu.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const binstore = require('../src/core/store/binstore')
const series = require('../src/core/series')

/** Her testte temiz bir veri klasoru ve taze modul kopyasi. */
function tazeModul() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-veri-'))
  process.env.ZONE_MEMORY_USER_DIR = dir
  process.env.ZONE_MEMORY_DATA_DIR = path.join(dir, 'data')
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true })
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'main'))) delete require.cache[anahtar]
  }
  const dataBundle = require('../src/main/dataBundle')
  const paths = require('../src/main/paths')
  return { dir, dataBundle, paths }
}

/** Kucuk ama GECERLI bir mum deposu yazar. */
async function depoYaz(yol, adet, ilkFiyat) {
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [] }
  for (let i = 0; i < adet; i++) {
    const f = (ilkFiyat || 2000) + i * 0.1
    d.time.push(1700000000 + i * 60)
    d.open.push(f)
    d.high.push(f + 1)
    d.low.push(f - 1)
    d.close.push(f + 0.5)
    d.volume.push(100 + i)
  }
  await binstore.writeSeries(yol, series.fromArrays(d))
}

test('gelistirme yapisinda paket HIC indirilmez', async () => {
  const { dataBundle } = tazeModul()
  // Ozet bos: dogrulanamayan bir dosyayi kullanicinin deposuna koymaktansa
  // eski depoyla devam etmek yeglenir. (Yayin yapisinda ozet doludur ve bu
  // test o zaman kurulum isaretiyle degil, bos olmayan ozetle gecer.)
  if (dataBundle.PAKET_SHA256) {
    fs.writeFileSync(dataBundle.isaretYolu(), JSON.stringify({ surum: dataBundle.GEREKLI_SURUM }))
  }
  assert.strictEqual(dataBundle.gerekiyorMu(), false)
  const sonuc = await dataBundle.kur({})
  assert.strictEqual(sonuc.kuruldu, false)
  assert.strictEqual(sonuc.sebep, 'gerekmiyor')
})

test('kurulum isareti okunur, ayni surum ikinci kez kurulmaz', () => {
  const { dataBundle } = tazeModul()
  assert.strictEqual(dataBundle.kuruluSurum(), 0, 'isaret yokken sifir')
  fs.writeFileSync(dataBundle.isaretYolu(), JSON.stringify({ surum: dataBundle.GEREKLI_SURUM }))
  assert.strictEqual(dataBundle.kuruluSurum(), dataBundle.GEREKLI_SURUM)
  // Bozuk isaret uygulamayi durdurmaz, "kurulu degil" sayilir.
  fs.writeFileSync(dataBundle.isaretYolu(), 'bozuk')
  assert.strictEqual(dataBundle.kuruluSurum(), 0)
})

test('yerineKoy: ESKI DEPO SILINMEZ, .oncekiKaynak olarak durur', async () => {
  const { dataBundle, paths } = tazeModul()
  const hedef = paths.candlePath('1m')
  // Kullanicinin mevcut deposu (baska bir fiyat seviyesiyle ayirt edilir).
  await depoYaz(hedef, 50, 1000)
  const yeni = hedef + '.indiriliyor'
  await depoYaz(yeni, 80, 4000)

  const sonuc = await dataBundle.yerineKoy(yeni, { enAzBar: 10 })
  assert.strictEqual(sonuc.kuruldu, true)
  assert.strictEqual(sonuc.bar, 80)

  // BU TESTIN BUTUN KONUSU: 17 yillik veri geri donusu olmadan gitmemeli.
  assert.strictEqual(fs.existsSync(hedef + '.oncekiKaynak'), true, 'eski depo YEDEKLENMELI')
  const eski = await binstore.readSeries(hedef + '.oncekiKaynak')
  assert.strictEqual(eski.length, 50, 'yedek bozulmamali')
  assert.ok(Math.abs(eski.close[0] - 1000.5) < 0.01, 'yedek ESKI veriyi tasimali')

  const simdiki = await binstore.readSeries(hedef)
  assert.strictEqual(simdiki.length, 80, 'yeni depo yerine gecmeli')
  assert.ok(Math.abs(simdiki.close[0] - 4000.5) < 0.01)
})

test('yerineKoy: BOZUK dosya yerine gecmez, eski depo yerinde kalir', async () => {
  const { dataBundle, paths } = tazeModul()
  const hedef = paths.candlePath('1m')
  await depoYaz(hedef, 50, 1000)
  const bozuk = hedef + '.indiriliyor'
  fs.writeFileSync(bozuk, 'bu bir mum deposu degil')

  await assert.rejects(() => dataBundle.yerineKoy(bozuk, { enAzBar: 10 }),
    /okunamadı veya beklenenden kısa/)

  // Eski depo YERINDE ve okunabilir olmali.
  const kalan = await binstore.readSeries(hedef)
  assert.strictEqual(kalan.length, 50)
  assert.strictEqual(fs.existsSync(bozuk), false, 'bozuk dosya temizlenmeli')
  assert.strictEqual(fs.existsSync(dataBundle.isaretYolu()), false,
    'kurulmadan isaret yazilmamali')
})

test('yerineKoy: KISA dosya yerine gecmez', async () => {
  const { dataBundle, paths } = tazeModul()
  const hedef = paths.candlePath('1m')
  await depoYaz(hedef, 50, 1000)
  const kisa = hedef + '.indiriliyor'
  await depoYaz(kisa, 5, 4000)

  // Yarim inmis bir dosya sessizce yerine gecerse kullanici 17 yillik veri
  // yerine bir haftalik veriyle calismaya baslardi.
  await assert.rejects(() => dataBundle.yerineKoy(kisa, { enAzBar: 1000 }),
    /okunamadı veya beklenenden kısa/)
  const kalan = await binstore.readSeries(hedef)
  assert.strictEqual(kalan.length, 50)
})

test('yerineKoy: turetilmis zaman dilimleri silinir, olcum yenileme isareti kalir', async () => {
  const { dataBundle, paths } = tazeModul()
  const hedef = paths.candlePath('1m')
  await depoYaz(hedef, 50, 1000)

  // Eski kaynaktan turetilmis dosyalar ve kaynak kayitlari.
  for (const tf of dataBundle.TURETILEN) {
    await depoYaz(paths.candlePath(tf), 20, 1000)
    fs.writeFileSync(paths.candlePath(tf) + '.meta.json', '{}')
  }
  fs.writeFileSync(path.join(paths.dataDir(), 'XAUUSD_1m.proxy.json'), '{"ranges":[]}')

  const yeni = hedef + '.indiriliyor'
  await depoYaz(yeni, 80, 4000)
  await dataBundle.yerineKoy(yeni, { enAzBar: 10 })

  for (const tf of dataBundle.TURETILEN) {
    assert.strictEqual(fs.existsSync(paths.candlePath(tf)), false,
      tf + ' ESKI kaynaktan turetilmisti, silinmeli')
    assert.strictEqual(fs.existsSync(paths.candlePath(tf) + '.meta.json'), false)
  }
  // Eski kaynak kaydi yeni depo icin anlamsiz; kalsaydi yeni barlar "kaynak
  // degisti" sayilip ESKI olcege uydurulurdu.
  assert.strictEqual(fs.existsSync(path.join(paths.dataDir(), 'XAUUSD_1m.proxy.json')), false)

  // Ayar izi VERI degisimini yakalayamaz; isaret bunu tarama katmanina tasir.
  for (const tf of ['1m'].concat(dataBundle.TURETILEN)) {
    assert.strictEqual(fs.existsSync(paths.olcumYenilePath(tf)), true,
      tf + ' icin olcum yenileme isareti birakilmali')
  }

  const isaret = JSON.parse(fs.readFileSync(dataBundle.isaretYolu(), 'utf8'))
  assert.strictEqual(isaret.surum, dataBundle.GEREKLI_SURUM)
  assert.strictEqual(isaret.kaynak, 'oanda')
  assert.strictEqual(isaret.bar, 80)
})

test('yerineKoy: depo HIC YOKKEN de calisir (temiz kurulum)', async () => {
  const { dataBundle, paths } = tazeModul()
  const hedef = paths.candlePath('1m')
  const yeni = hedef + '.indiriliyor'
  await depoYaz(yeni, 80, 4000)

  const sonuc = await dataBundle.yerineKoy(yeni, { enAzBar: 10 })
  assert.strictEqual(sonuc.kuruldu, true)
  assert.strictEqual(fs.existsSync(hedef), true)
  assert.strictEqual(fs.existsSync(hedef + '.oncekiKaynak'), false,
    'tasinacak eski depo yoksa bos yedek uretilmemeli')
})
