'use strict'

// A12 - src/core/learn/features.js testleri (CONTRACTS.md bolum 11 ve 21).

const test = require('node:test')
const assert = require('node:assert/strict')

const features = require('../src/core/learn/features')
const series = require('../src/core/series')

const { SHAPE_LEN, RET_LEN, WINDOW_BARS, CTX_NAMES, buildFeatures, rowLength, packRow, unpackRow } = features

const T0 = 1704067200
const ADIM = 900

/** Kapanis dizisinden seri kurar (diger sutunlar kapanistan turetilir). */
function seriKur (closes) {
  const n = closes.length
  const time = new Array(n)
  const open = new Array(n)
  const high = new Array(n)
  const low = new Array(n)
  const volume = new Array(n)
  for (let i = 0; i < n; i++) {
    time[i] = T0 + i * ADIM
    open[i] = i === 0 ? closes[0] : closes[i - 1]
    high[i] = Math.max(open[i], closes[i]) + 0.3
    low[i] = Math.min(open[i], closes[i]) - 0.3
    volume[i] = 100
  }
  return series.fromArrays({ time, open, high, low, close: closes, volume })
}

/** Sozlesmedeki tum alanlari tasiyan ornek olay (proZones ciktisi). */
function dokunus (bar, kind) {
  return {
    id: 1, zoneId: 1, kind: kind || 'touch', isSupport: true, direction: 'BUY',
    bar: bar, time: T0 + bar * ADIM, price: 100,
    zoneTop: 100.5, zoneBottom: 99.5, zoneFlow: 5.0,
    zoneAgeBars: 30, penetration: 0.4, entryDistAtr: 1.0,
    bbDistAtr: 0.6, volRatio: 1.5, atr: 1.0,
    score: 3, maxScore: 5, qualified: true, strong: false, session: 'London',
    parts: {
      flow: true, trend: false, session: true, rejection: true, volume: false,
    },
  }
}

/** Ornek IndicatorContext. */
function baglam (n) {
  const f = (v) => { const a = new Float64Array(n); a.fill(v); return a }
  return {
    atr: f(1.0), rsi: f(55), sma20: f(99.5), sma50: f(98.5),
    bbBasis: f(100), bbUpper: f(101), bbLower: f(99),
    volRatio: f(1.2), flowScore: f(3.6),
    bullTrend: new Uint8Array(n).fill(1),
    bearTrend: new Uint8Array(n),
    sessionIdx: new Uint8Array(n).fill(1),
    localHour: new Uint8Array(n).fill(10),
    localDow: new Uint8Array(n).fill(3),
  }
}

/** Deterministik PRNG. */
function prng (tohum) {
  let a = tohum >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('sabitler sozlesmedeki degerler', () => {
  assert.equal(SHAPE_LEN, 16)
  assert.equal(RET_LEN, 32)
  assert.equal(WINDOW_BARS, 32)
  assert.deepEqual(CTX_NAMES, [
    'rsi', 'atrPct', 'distSma20Atr', 'distSma50Atr',
    'hourSin', 'hourCos', 'dowSin', 'dowCos',
    'zoneWidthAtr', 'zoneAge', 'zoneFlow', 'penetration',
    'scoreRatio', 'pFlow', 'pTrend', 'pSession', 'pRejection', 'pVolume',
    'isSupport', 'trendState', 'isForm', 'bbDistAtr', 'volRatio', 'entryDistAtr',
  ])
  assert.equal(rowLength(), SHAPE_LEN + RET_LEN + CTX_NAMES.length)
})

test('pencere yetmiyorsa null doner', () => {
  const closes = new Array(40)
  for (let i = 0; i < 40; i++) closes[i] = 100 + i
  const s = seriKur(closes)
  const c = baglam(40)
  assert.equal(buildFeatures(s, dokunus(31), c), null, 'bar < WINDOW_BARS ise null')
  assert.notEqual(buildFeatures(s, dokunus(32), c), null)
  assert.equal(buildFeatures(s, dokunus(40), c), null, 'seri disi bar null')
  assert.equal(buildFeatures(null, dokunus(35), c), null)
  assert.equal(buildFeatures(s, null, c), null)
})

test('shape: uzunluk 16, degerler 0..1, en az bir 0 ve bir 1', () => {
  const rnd = prng(4242)
  const n = 80
  const closes = new Array(n)
  let p = 100
  for (let i = 0; i < n; i++) { p += (rnd() - 0.5) * 3; closes[i] = p }
  const s = seriKur(closes)
  const f = buildFeatures(s, dokunus(60), baglam(n))

  assert.equal(f.shape.length, SHAPE_LEN)
  assert.ok(f.shape instanceof Float32Array)
  let enAz = Infinity
  let enCok = -Infinity
  for (let i = 0; i < SHAPE_LEN; i++) {
    const v = f.shape[i]
    assert.ok(v >= 0 && v <= 1, 'shape degeri 0..1 disinda: ' + v)
    if (v < enAz) enAz = v
    if (v > enCok) enCok = v
  }
  assert.equal(enAz, 0, 'min-max normalizasyonda en kucuk deger 0 olmali')
  assert.equal(enCok, 1, 'min-max normalizasyonda en buyuk deger 1 olmali')
})

test('shape: duz seride tum degerler 0.5', () => {
  const closes = new Array(60).fill(1900)
  const s = seriKur(closes)
  const f = buildFeatures(s, dokunus(50), baglam(60))
  for (let i = 0; i < SHAPE_LEN; i++) {
    assert.equal(f.shape[i], 0.5, i + '. shape degeri 0.5 olmali, gelen ' + f.shape[i])
  }
})

test('ret: uzunluk 32, z-score ortalamasi ~0 ve sapmasi ~1', () => {
  const rnd = prng(99)
  const n = 80
  const closes = new Array(n)
  let p = 2000
  for (let i = 0; i < n; i++) { p *= 1 + (rnd() - 0.5) * 0.01; closes[i] = p }
  const s = seriKur(closes)
  const f = buildFeatures(s, dokunus(60), baglam(n))

  assert.equal(f.ret.length, RET_LEN)
  assert.ok(f.ret instanceof Float32Array)
  let toplam = 0
  for (let i = 0; i < RET_LEN; i++) toplam += f.ret[i]
  const ort = toplam / RET_LEN
  assert.ok(Math.abs(ort) < 1e-4, 'z-score ortalamasi ~0 olmali: ' + ort)

  let kare = 0
  for (let i = 0; i < RET_LEN; i++) kare += (f.ret[i] - ort) * (f.ret[i] - ort)
  const std = Math.sqrt(kare / RET_LEN)
  assert.ok(Math.abs(std - 1) < 1e-4, 'z-score sapmasi ~1 olmali: ' + std)
})

test('ret: duz seride tum degerler 0 (standart sapma sifir)', () => {
  const closes = new Array(60).fill(1900)
  const s = seriKur(closes)
  const f = buildFeatures(s, dokunus(50), baglam(60))
  for (let i = 0; i < RET_LEN; i++) assert.equal(f.ret[i], 0)
})

test('ctx: uzunluk CTX_NAMES ile ayni ve tum degerler sonlu', () => {
  const closes = new Array(60)
  for (let i = 0; i < 60; i++) closes[i] = 100 + Math.sin(i / 4) * 3
  const s = seriKur(closes)
  const f = buildFeatures(s, dokunus(50), baglam(60))

  assert.equal(f.ctx.length, CTX_NAMES.length)
  assert.ok(f.ctx instanceof Float32Array)
  for (let i = 0; i < f.ctx.length; i++) {
    assert.ok(Number.isFinite(f.ctx[i]), CTX_NAMES[i] + ' sonlu olmali: ' + f.ctx[i])
  }
})

test('ctx: sozlesmedeki hesap kurallari (secili alanlar)', () => {
  const n = 60
  const closes = new Array(n).fill(100)
  const s = seriKur(closes)
  const c = baglam(n)
  const t = dokunus(50)
  const f = buildFeatures(s, t, c)
  const idx = (ad) => CTX_NAMES.indexOf(ad)

  // rsi / 100
  assert.ok(Math.abs(f.ctx[idx('rsi')] - 0.55) < 1e-6)
  // min(atr / price * 100, 1) -> atr 1, price 100 -> min(1, 1) = 1
  assert.ok(Math.abs(f.ctx[idx('atrPct')] - 1) < 1e-6)
  // clamp((price - sma20) / atr, -5, 5) / 5 -> (100 - 99.5)/1 = 0.5 -> 0.1
  assert.ok(Math.abs(f.ctx[idx('distSma20Atr')] - 0.1) < 1e-6)
  // clamp((price - sma50) / atr, -5, 5) / 5 -> 1.5 -> 0.3
  assert.ok(Math.abs(f.ctx[idx('distSma50Atr')] - 0.3) < 1e-6)
  // hourSin / hourCos, saat 10
  assert.ok(Math.abs(f.ctx[idx('hourSin')] - Math.sin((2 * Math.PI * 10) / 24)) < 1e-6)
  assert.ok(Math.abs(f.ctx[idx('hourCos')] - Math.cos((2 * Math.PI * 10) / 24)) < 1e-6)
  // dowSin / dowCos, gun 3
  assert.ok(Math.abs(f.ctx[idx('dowSin')] - Math.sin((2 * Math.PI * 3) / 7)) < 1e-6)
  assert.ok(Math.abs(f.ctx[idx('dowCos')] - Math.cos((2 * Math.PI * 3) / 7)) < 1e-6)
  // clamp(zoneWidth / atr, 0, 5) / 5 -> 1 / 5 = 0.2
  assert.ok(Math.abs(f.ctx[idx('zoneWidthAtr')] - 0.2) < 1e-6)
  // min(zoneAgeBars / 120, 1) -> 30/120 = 0.25
  assert.ok(Math.abs(f.ctx[idx('zoneAge')] - 0.25) < 1e-6)
  // clamp(zoneFlow, 0, 10) / 10 -> 5.0/10 = 0.5 (flow skoru Pine'da 1..10)
  assert.ok(Math.abs(f.ctx[idx('zoneFlow')] - 0.5) < 1e-6)
  // penetration dogrudan
  assert.ok(Math.abs(f.ctx[idx('penetration')] - 0.4) < 1e-6)
  // score / maxScore -> 3/5
  assert.ok(Math.abs(f.ctx[idx('scoreRatio')] - 3 / 5) < 1e-6)
  // parts bayraklari
  assert.equal(f.ctx[idx('pFlow')], 1)
  assert.equal(f.ctx[idx('pTrend')], 0)
  assert.equal(f.ctx[idx('pSession')], 1)
  assert.equal(f.ctx[idx('pRejection')], 1)
  assert.equal(f.ctx[idx('pVolume')], 0)
  // isSupport ve trendState
  assert.equal(f.ctx[idx('isSupport')], 1)
  assert.equal(f.ctx[idx('trendState')], 1)
  // olay turu: ornek dokunus, form degil
  assert.equal(f.ctx[idx('isForm')], 0)
  // clamp(bbDistAtr, 0, 3) / 3 -> 0.6/3 = 0.2
  assert.ok(Math.abs(f.ctx[idx('bbDistAtr')] - 0.2) < 1e-6)
  // clamp(volRatio, 0, 3) / 3 -> 1.5/3 = 0.5
  assert.ok(Math.abs(f.ctx[idx('volRatio')] - 0.5) < 1e-6)
  // clamp(entryDistAtr, 0, 5) / 5 -> 1.0/5 = 0.2
  assert.ok(Math.abs(f.ctx[idx('entryDistAtr')] - 0.2) < 1e-6)
})

test('ctx: isForm boyutu iki olay turunu ayirir', () => {
  const n = 60
  const s = seriKur(new Array(n).fill(100))
  const c = baglam(n)
  const idx = CTX_NAMES.indexOf('isForm')

  assert.equal(buildFeatures(s, dokunus(50, 'touch'), c).ctx[idx], 0)
  assert.equal(buildFeatures(s, dokunus(50, 'form'), c).ctx[idx], 1)
})

test('ctx: trendState bearTrend durumunda -1 olur', () => {
  const n = 60
  const s = seriKur(new Array(n).fill(100))
  const c = baglam(n)
  c.bullTrend = new Uint8Array(n)
  c.bearTrend = new Uint8Array(n).fill(1)
  const f = buildFeatures(s, dokunus(50), c)
  assert.equal(f.ctx[CTX_NAMES.indexOf('trendState')], -1)
})

test('packRow / unpackRow: gidis donus', () => {
  const rnd = prng(2024)
  const n = 80
  const closes = new Array(n)
  let p = 100
  for (let i = 0; i < n; i++) { p += (rnd() - 0.5) * 2; closes[i] = p }
  const s = seriKur(closes)
  const f = buildFeatures(s, dokunus(60), baglam(n))

  const rowLen = rowLength()
  const buf = new Float32Array(rowLen * 3)
  const sonraki = packRow(f, buf, rowLen)     // 1. satira yaz
  assert.equal(sonraki, rowLen * 2, 'packRow bir sonraki satirin ofsetini dondurmeli')

  const geri = unpackRow(buf, rowLen)
  assert.equal(geri.shape.length, SHAPE_LEN)
  assert.equal(geri.ret.length, RET_LEN)
  assert.equal(geri.ctx.length, CTX_NAMES.length)
  for (let i = 0; i < SHAPE_LEN; i++) assert.equal(geri.shape[i], f.shape[i])
  for (let i = 0; i < RET_LEN; i++) assert.equal(geri.ret[i], f.ret[i])
  for (let i = 0; i < CTX_NAMES.length; i++) assert.equal(geri.ctx[i], f.ctx[i])

  // Komsu satirlara tasma olmamali.
  for (let i = 0; i < rowLen; i++) assert.equal(buf[i], 0)
  for (let i = rowLen * 2; i < rowLen * 3; i++) assert.equal(buf[i], 0)
})

test('buildFeatures: pencerede gecersiz kapanis varsa null doner', () => {
  const n = 60
  const closes = new Array(n).fill(100)
  closes[40] = 0        // gecersiz fiyat
  const s = seriKur(closes)
  assert.equal(buildFeatures(s, dokunus(50), baglam(n)), null)
})

// SEKIL PENCERESI AYARI
//
// Kullanici "sadece cok kisa oncesine bakiyor, biraz daha genis bakabilir"
// dedi. Pencere kodda 32 bar sabitti. Artik Ayarlar'dan degistirilebiliyor.
//
// KASITLI SINIR: yalnizca SEKIL penceresi degisir, getiri vektoru 32 kalir.
// Getirinin uzunlugu degisseydi hafiza dosyasinin SATIR BOYU degisir, eski
// dosyalar okunamaz hale gelirdi.

/** Dalgali kapanislardan seri uretir (sabit seri sekli 0.5'e duzler). */
function dalgaliSeri (n) {
  const closes = new Array(n)
  for (let i = 0; i < n; i++) closes[i] = 100 + Math.sin(i / 9) * 4 + Math.sin(i / 23) * 7
  return seriKur(closes)
}

test('sekil penceresi: varsayilan 32 ve eski davranisla AYNI sonucu verir', () => {
  const s = dalgaliSeri(200)
  const c = baglam(200)
  const a = buildFeatures(s, dokunus(100), c)
  const b = buildFeatures(s, dokunus(100), c, { shapeWindowBars: 32 })
  assert.deepEqual(Array.from(a.shape), Array.from(b.shape),
    'ayar verilmemisi ile 32 verilmisi ayni olmali')
})

test('sekil penceresi: pencere buyuyunce SEKIL degisir, getiri DEGISMEZ', () => {
  const s = dalgaliSeri(400)
  const c = baglam(400)
  const dar = buildFeatures(s, dokunus(300), c, { shapeWindowBars: 32 })
  const genis = buildFeatures(s, dokunus(300), c, { shapeWindowBars: 128 })

  assert.equal(genis.shape.length, SHAPE_LEN, 'nokta sayisi HER ZAMAN sabit')
  assert.notDeepEqual(Array.from(dar.shape), Array.from(genis.shape),
    'daha genis pencere baska bir bicim vermeli')

  // SATIR BOYU KORUNMALI: getiri vektoru penceresizdir.
  assert.equal(dar.ret.length, RET_LEN)
  assert.equal(genis.ret.length, RET_LEN)
  assert.deepEqual(Array.from(dar.ret), Array.from(genis.ret),
    'getiri vektoru sekil penceresinden ETKILENMEMELI')
})

test('sekil penceresi: yeterli bar yoksa null doner', () => {
  const s = dalgaliSeri(200)
  const c = baglam(200)
  // 128 barlik pencere isteyip 100. barda sormak: gecmis yetmez.
  assert.equal(buildFeatures(s, dokunus(100), c, { shapeWindowBars: 128 }), null)
  assert.notEqual(buildFeatures(s, dokunus(130), c, { shapeWindowBars: 128 }), null)
})

test('sekil penceresi: sinirlarin disindaki degerler kirpilir', () => {
  assert.equal(features.sekilPenceresi({ shapeWindowBars: 5 }), features.SHAPE_WINDOW_EN_AZ)
  assert.equal(features.sekilPenceresi({ shapeWindowBars: 9999 }), features.SHAPE_WINDOW_EN_COK)
  assert.equal(features.sekilPenceresi(null), features.SHAPE_WINDOW_VARSAYILAN)
  assert.equal(features.sekilPenceresi({ shapeWindowBars: 'abc' }), features.SHAPE_WINDOW_VARSAYILAN)
})

// IZ, VARSAYILANDA DEGISMEZ.
//
// Ize yeni bir alan eklendiginde degeri varsayilan olsa bile alan dolu
// gecilirse HERKESIN izi degisir ve hicbir sey degismedigi halde tam yeniden
// tarama tetiklenir. Olculdu: varsayilanla iz 76e9eb372de3 -> 8b482d9f21de.
test('izIcinOzellikAyari: varsayilan pencere ize GIRMEZ', () => {
  assert.equal(features.izIcinOzellikAyari(null), null)
  assert.equal(features.izIcinOzellikAyari({}), null)
  assert.equal(features.izIcinOzellikAyari({ shapeWindowBars: features.SHAPE_WINDOW_VARSAYILAN }), null)
  // Sinira kirpilan deger de varsayilana esitse yine girmez.
  assert.equal(features.izIcinOzellikAyari({ shapeWindowBars: 'abc' }), null)

  // Degistirilmis pencere ize GIRER, yoksa eski hafiza sessizce kullanilirdi.
  assert.deepEqual(features.izIcinOzellikAyari({ shapeWindowBars: 96 }), { shapeWindowBars: 96 })
})
