'use strict'

// A12 - src/core/indicator/masterTouch.js testleri (CONTRACTS.md bolum 9 ve 21).
//
// Sentetik seri tasarimi:
//   Her bar ayni sekle sahiptir (low = L, open = L+0.05, close = L+0.15,
//   high = L+0.30), yalnizca L seviyesi degisir. Boylece govde/aralik orani
//   sabit kalir ve flowStrength her yerde 1.0 olur; yalnizca hacmi buyuttugumuz
//   pivot barlarinda esik asilir. Bu sayede hangi barin bolge actigi kesindir.

const test = require('node:test')
const assert = require('node:assert/strict')

const { runIndicator, DEFAULT_PARAMS } = require('../src/core/indicator/masterTouch')
const series = require('../src/core/series')

const T0 = 1704067200   // 2024-01-01 00:00:00 UTC, 3600 ve 86400 katidir
const ADIM = 900        // 15 dakika

/** Sabit sekilli bar dizileri uretir. */
function taslak (n, seviyeFn) {
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  for (let i = 0; i < n; i++) {
    const L = seviyeFn(i)
    d.time[i] = T0 + i * ADIM
    d.low[i] = L
    d.open[i] = L + 0.05
    d.close[i] = L + 0.15
    d.high[i] = L + 0.30
    d.volume[i] = 100
  }
  return d
}

/** Belirtilen bara asagi fitil ekler, istege bagli hacim yukseltir. */
function dipEkle (d, bar, derinlik, hacim) {
  d.low[bar] = d.low[bar] - derinlik
  if (hacim !== undefined) d.volume[bar] = hacim
}

/** Deterministik PRNG (testin tekrarlanabilir olmasi icin). */
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

test('bolge olusumu: yuksek akisli pivot dipte tek destek bolgesi acilir', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)          // pivot dip, low = 95
  const s = series.fromArrays(d)

  const r = runIndicator(s, {}, ADIM)

  assert.equal(r.zones.length, 1, 'tam olarak bir bolge beklenir')
  const z = r.zones[0]
  assert.equal(z.isSupport, true)
  assert.equal(z.pivotBar, 250)
  assert.equal(z.createdBar, 250 + DEFAULT_PARAMS.lookback)
  assert.equal(z.createdTime, T0 + z.createdBar * ADIM)
  assert.equal(z.pivotTime, T0 + 250 * ADIM)
  assert.equal(z.endBar, z.createdBar + DEFAULT_PARAMS.boxLengthBars)
  assert.equal(z.top, 95, 'destek bolgesinin tavani pivot dip degeridir')
  // Genislik = atr200[pivot] * boxWidthAtr, sentetik seride ~0.325.
  const genislik = z.top - z.bottom
  assert.ok(genislik > 0.30 && genislik < 0.36, 'bolge genisligi ATR ile orantili olmali: ' + genislik)
  assert.ok(z.flow >= DEFAULT_PARAMS.minFlowStrength, 'pivot akisi esigi gecmeli: ' + z.flow)
  assert.equal(r.stats.zonesCreated, 1)
})

test('bolge olusumu: akis esigi altindaki pivot bolge acmaz', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5)                 // hacim normal, flowStrength ~ 1.0
  const s = series.fromArrays(d)

  const r = runIndicator(s, {}, ADIM)
  assert.equal(r.zones.length, 0)
  assert.equal(r.stats.zonesCreated, 0)
})

test('mergeNearAtr: yakin ikinci bolge ACILMAZ, kapali olunca acilir', () => {
  const kur = () => {
    const d = taslak(340, () => 100)
    dipEkle(d, 250, 5.0, 20000)      // low = 95.00
    dipEkle(d, 280, 4.95, 20000)     // low = 95.05, orta noktasi cok yakin
    return series.fromArrays(d)
  }

  const yakinKapali = runIndicator(kur(), { mergeNearAtr: 0 }, ADIM)
  assert.equal(yakinKapali.zones.length, 2, 'birlestirme kapaliyken iki bolge olmali')
  assert.equal(yakinKapali.stats.zonesMergedAway, 0)

  const yakinAcik = runIndicator(kur(), {}, ADIM) // varsayilan mergeNearAtr = 0.8
  assert.equal(yakinAcik.zones.length, 1, 'yakin bolge yeni kutu acmamali')
  assert.equal(yakinAcik.stats.zonesCreated, 1)
  assert.equal(yakinAcik.stats.zonesMergedAway, 1)
})

test('mergeNearAtr: uzak ikinci bolge normal sekilde acilir', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5.0, 20000)        // low = 95.00
  dipEkle(d, 280, 8.0, 20000)        // low = 92.00, orta noktalar uzak
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.equal(r.zones.length, 2)
  assert.equal(r.stats.zonesMergedAway, 0)
})

test('BOLGE BASINA TEK ILK DOKUNUS: ikinci dokunus olay uretmez', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)          // bolge: top = 95, bottom ~ 94.675
  dipEkle(d, 300, 5.2)               // 1. dokunus, low = 94.8
  dipEkle(d, 320, 5.2)               // 2. dokunus, olay URETMEMELI
  const s = series.fromArrays(d)

  const r = runIndicator(s, {}, ADIM)
  assert.equal(r.zones.length, 1)
  assert.equal(r.touches.length, 1, 'yalnizca ilk dokunus olay uretmeli')
  assert.equal(r.stats.firstTouches, 1)

  const t = r.touches[0]
  assert.equal(t.bar, 300)
  assert.equal(t.time, T0 + 300 * ADIM)
  assert.equal(t.zoneId, r.zones[0].id)
  assert.equal(t.isSupport, true)
  assert.equal(t.direction, 'BUY')
  assert.equal(t.zoneAgeBars, 300 - r.zones[0].createdBar)
  assert.ok(t.penetration > 0 && t.penetration <= 1, 'penetration 0..1 arasinda olmali: ' + t.penetration)
  assert.ok(t.atr > 0, 'dokunus barinda ATR dolu olmali')
  assert.equal(r.zones[0].touchCount, 1)

  // Sozlesmedeki parts anahtarlari her zaman bulunmali.
  for (const anahtar of ['flow', 'trend', 'volatility', 'session', 'sweep', 'rejection', 'mss', 'fvg']) {
    assert.equal(typeof t.parts[anahtar], 'boolean', anahtar + ' bayragi eksik')
  }
  assert.ok(t.maxScore >= 1)
  assert.ok(t.score >= 0 && t.score <= t.maxScore)
  assert.equal(typeof t.qualified, 'boolean')
  assert.ok(['Asia', 'London', 'New York', 'Other'].includes(t.session))
})

test('kirilma sayaci: ardisik olmayan barda sifirlanir', () => {
  const n = 340
  // Kapanislari bolgenin altina indiren seviye: 90 + 0.15 = 90.15 < ~94.675
  const seviye = (i) => {
    if (i === 270 || i === 271) return 90
    if (i >= 273 && i <= 275) return 90
    return 100
  }
  const d = taslak(n, seviye)
  dipEkle(d, 250, 5, 20000)
  const s = series.fromArrays(d)

  // Sayac: 270 -> 1, 271 -> 2, 272 -> SIFIRLANIR, 273 -> 1, 274 -> 2, 275 -> 3
  const r = runIndicator(s, { breakConfirmBars: 3 }, ADIM)
  assert.equal(r.zones.length, 1)
  assert.equal(r.zones[0].broken, true)
  assert.equal(r.zones[0].brokenBar, 275, 'sayac 272. barda sifirlanmali')

  // Esik 2 olsaydi 271. barda kirilirdi.
  const r2 = runIndicator(s, { breakConfirmBars: 2 }, ADIM)
  assert.equal(r2.zones[0].broken, true)
  assert.equal(r2.zones[0].brokenBar, 271)
})

test('kirilma: kapanis bolge icinde kaldigi surece bolge kirilmaz', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.equal(r.zones[0].broken, false)
  assert.equal(r.zones[0].brokenBar, -1)
})

test('HTF trend: ileriye bakma yok, gelecekteki barlar onceki degerleri degistirmez', () => {
  const n = 400
  const m = 302   // 1 saatlik kovanin (300..303) ikinci bari
  const rnd = prng(20240101)

  const a = taslak(n, () => 100)
  let p = 100
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 2
    a.low[i] = p
    a.open[i] = p + 0.05
    a.close[i] = p + 0.15
    a.high[i] = p + 0.30
  }

  // b, m. bardan itibaren tamamen farkli: guclu yukselis.
  const b = {
    time: a.time.slice(), open: a.open.slice(), high: a.high.slice(),
    low: a.low.slice(), close: a.close.slice(), volume: a.volume.slice(),
  }
  for (let i = m; i < n; i++) {
    const L = 100 + (i - m + 1) * 5
    b.low[i] = L
    b.open[i] = L + 0.05
    b.close[i] = L + 0.15
    b.high[i] = L + 0.30
  }

  const par = { useHtfTrend: true, trendTf: '1h', emaFastLen: 3, emaSlowLen: 5 }
  const ra = runIndicator(series.fromArrays(a), par, ADIM)
  const rb = runIndicator(series.fromArrays(b), par, ADIM)

  // 300..303 barlari ayni HTF kovasindadir ve o kova bar 303'e kadar kapanmaz;
  // dolayisiyla 303. bara kadar trend degerleri degismemelidir.
  for (let i = 0; i <= 303; i++) {
    assert.equal(rb.context.bullTrend[i], ra.context.bullTrend[i], i + '. barda bullTrend ileriye bakmis')
    assert.equal(rb.context.bearTrend[i], ra.context.bearTrend[i], i + '. barda bearTrend ileriye bakmis')
  }

  // Test bos olmasin: onekte hem 1 hem 0 gorulmeli.
  let bir = 0
  let sifir = 0
  for (let i = 0; i <= 303; i++) {
    if (ra.context.bullTrend[i] === 1) bir++
    else sifir++
  }
  assert.ok(bir > 0 && sifir > 0, 'onekte trend degerleri degismiyorsa test anlamsizdir')

  // Degisiklik gercekten etkili olmali: 304 ve sonrasinda fark bulunmali.
  let fark = false
  for (let i = 304; i < n; i++) {
    if (rb.context.bullTrend[i] !== ra.context.bullTrend[i]) { fark = true; break }
  }
  assert.ok(fark, 'gelecekteki veri degisimi HTF trendini hic etkilemediyse test gecersizdir')
})

test('HTF trend: trendTf grafik zaman diliminden kucuk veya esitse seri oldugu gibi kullanilir', () => {
  const n = 300
  const rnd = prng(7)
  const d = taslak(n, () => 100)
  let p = 100
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 2
    d.low[i] = p
    d.open[i] = p + 0.05
    d.close[i] = p + 0.15
    d.high[i] = p + 0.30
  }
  const s = series.fromArrays(d)
  const r = runIndicator(s, { useHtfTrend: true, trendTf: '15m', emaFastLen: 3, emaSlowLen: 5 }, ADIM)

  // Isinma disindaki barlarda bullTrend ile bearTrend ayni anda 1 olamaz.
  for (let i = 0; i < n; i++) {
    assert.ok(!(r.context.bullTrend[i] === 1 && r.context.bearTrend[i] === 1))
  }
})

test('context: sozlesmedeki tum ara diziler dolu ve dogru tipte', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  const c = r.context

  for (const ad of ['atr', 'atr200', 'rsi', 'sma20', 'sma50', 'flowStrength']) {
    assert.ok(c[ad] instanceof Float64Array, ad + ' Float64Array olmali')
    assert.equal(c[ad].length, n, ad + ' uzunlugu bar sayisi kadar olmali')
  }
  for (const ad of ['bullTrend', 'bearTrend', 'sessionIdx', 'localHour', 'localDow']) {
    assert.ok(c[ad] instanceof Uint8Array, ad + ' Uint8Array olmali')
    assert.equal(c[ad].length, n)
  }
  // Isinma bolgeleri NaN olmali, sifir DEGIL.
  assert.ok(Number.isNaN(c.atr200[0]), 'atr200 isinmasi NaN olmali')
  assert.ok(Number.isNaN(c.sma50[0]), 'sma50 isinmasi NaN olmali')
  assert.ok(c.atr200[n - 1] > 0)
  for (let i = 0; i < n; i++) {
    assert.ok(c.localHour[i] <= 23)
    assert.ok(c.localDow[i] <= 6)
    assert.ok(c.sessionIdx[i] <= 3)
  }
})

test('runIndicator: bos seride guvenli sonuc dondurur', () => {
  const r = runIndicator(series.emptySeries(), {}, ADIM)
  assert.deepEqual(r.zones, [])
  assert.deepEqual(r.touches, [])
  assert.equal(r.stats.bars, 0)
  assert.equal(r.context.atr.length, 0)
})

test('onProgress: en fazla 100 kez, 0..100 arasi artan yuzde ile cagrilir', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  const cagrilar = []
  runIndicator(series.fromArrays(d), {}, ADIM, (pct, msg) => {
    cagrilar.push(pct)
    assert.equal(typeof msg, 'string')
  })
  assert.ok(cagrilar.length > 0)
  assert.ok(cagrilar.length <= 100, 'ilerleme en fazla 100 kez bildirilmeli: ' + cagrilar.length)
  for (let i = 0; i < cagrilar.length; i++) {
    assert.ok(cagrilar[i] >= 0 && cagrilar[i] <= 100)
    if (i > 0) assert.ok(cagrilar[i] > cagrilar[i - 1], 'yuzde artan olmali')
  }
  assert.equal(cagrilar[cagrilar.length - 1], 100)
})
