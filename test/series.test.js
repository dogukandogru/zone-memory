'use strict'

// A12 - src/core/series.js testleri (CONTRACTS.md bolum 4 ve 21).
// resample kova hizalamasi, ikili aramalar ve concatSeries tekillestirmesi.

const test = require('node:test')
const assert = require('node:assert/strict')

const series = require('../src/core/series')

/**
 * Duz dizilerden Series kurar. Sutunlar verilmezse makul varsayilanlar uretilir.
 * @param {number[]} time
 * @param {Object} [ops]
 */
function seri (time, ops) {
  const o = ops || {}
  const n = time.length
  const varsayilan = (ad, taban) => {
    if (o[ad]) return o[ad]
    const a = new Array(n)
    for (let i = 0; i < n; i++) a[i] = taban + i
    return a
  }
  return series.fromArrays({
    time: time,
    open: varsayilan('open', 100),
    high: varsayilan('high', 101),
    low: varsayilan('low', 99),
    close: varsayilan('close', 100.5),
    volume: o.volume || new Array(n).fill(10),
  })
}

test('createSeries / emptySeries: tipli diziler ve dogru uzunluk', () => {
  const s = series.createSeries(4)
  assert.equal(s.length, 4)
  assert.ok(s.time instanceof Float64Array)
  assert.ok(s.close instanceof Float64Array)
  assert.equal(s.time.length, 4)
  assert.equal(series.emptySeries().length, 0)
})

test('resample: kova baslangici epoch katlarina hizalanir', () => {
  // 1 dakikalik barlar, 5 dakikaya cevrilecek.
  const t0 = 1704067200 // 2024-01-01 00:00:00 UTC, 300'un kati
  const time = []
  for (let i = 0; i < 10; i++) time.push(t0 + 60 + i * 60) // 00:01'den basla
  const s = seri(time)
  const r = series.resample(s, 300)

  for (let i = 0; i < r.length; i++) {
    assert.equal(r.time[i] % 300, 0, 'kova basi 300 katina hizali olmali: ' + r.time[i])
  }
  // 00:01..00:04 -> ilk kova t0, 00:05..00:09 -> t0+300, 00:10 -> t0+600
  assert.equal(r.length, 3)
  assert.equal(r.time[0], t0)
  assert.equal(r.time[1], t0 + 300)
  assert.equal(r.time[2], t0 + 600)
})

test('resample: OHLCV toplama kurallari', () => {
  const t0 = 1704067200
  const time = [t0, t0 + 60, t0 + 120, t0 + 300, t0 + 360]
  const s = series.fromArrays({
    time: time,
    open: [10, 11, 12, 20, 21],
    high: [15, 13, 12.5, 22, 25],
    low: [9, 10.5, 11, 19, 20],
    close: [11, 12, 12.4, 21, 24],
    volume: [1, 2, 3, 4, 5],
  })
  const r = series.resample(s, 300)
  assert.equal(r.length, 2)
  // Ilk kova: 3 bar
  assert.equal(r.open[0], 10)
  assert.equal(r.high[0], 15)
  assert.equal(r.low[0], 9)
  assert.equal(r.close[0], 12.4)
  assert.equal(r.volume[0], 6)
  // Ikinci kova: 2 bar
  assert.equal(r.open[1], 20)
  assert.equal(r.high[1], 25)
  assert.equal(r.low[1], 19)
  assert.equal(r.close[1], 24)
  assert.equal(r.volume[1], 9)
})

test('resample: bos kova URETILMEZ (piyasa kapali bosluklari korunur)', () => {
  const t0 = 1704067200
  // t0 kovasinda iki bar, sonra 1 saatlik bosluk, sonra tek bar.
  const time = [t0, t0 + 60, t0 + 3600]
  const s = seri(time)
  const r = series.resample(s, 300)
  assert.equal(r.length, 2, 'bosluga bar uydurulmamali')
  assert.equal(r.time[0], t0)
  assert.equal(r.time[1], t0 + 3600)
})

test('resample: hedef zaman dilimi pozitif degilse hata', () => {
  const s = seri([1704067200])
  assert.throws(() => series.resample(s, 0))
  assert.throws(() => series.resample(s, -5))
})

test('indexAtTime: ikili arama, tam eslesme yoksa -1', () => {
  const time = [100, 200, 300, 400, 500, 600, 700]
  const s = seri(time)
  for (let i = 0; i < time.length; i++) {
    assert.equal(series.indexAtTime(s, time[i]), i)
  }
  assert.equal(series.indexAtTime(s, 250), -1)
  assert.equal(series.indexAtTime(s, 50), -1)
  assert.equal(series.indexAtTime(s, 900), -1)
  assert.equal(series.indexAtTime(series.emptySeries(), 100), -1)
})

test('lastIndexAtOrBefore / firstIndexAtOrAfter: sinir davranislari', () => {
  const time = [100, 200, 300, 400]
  const s = seri(time)

  assert.equal(series.lastIndexAtOrBefore(s, 100), 0)
  assert.equal(series.lastIndexAtOrBefore(s, 250), 1)
  assert.equal(series.lastIndexAtOrBefore(s, 400), 3)
  assert.equal(series.lastIndexAtOrBefore(s, 9999), 3)
  assert.equal(series.lastIndexAtOrBefore(s, 99), -1)

  assert.equal(series.firstIndexAtOrAfter(s, 100), 0)
  assert.equal(series.firstIndexAtOrAfter(s, 101), 1)
  assert.equal(series.firstIndexAtOrAfter(s, 400), 3)
  assert.equal(series.firstIndexAtOrAfter(s, 401), -1)
  assert.equal(series.firstIndexAtOrAfter(s, 0), 0)
})

test('lastIndexAtOrBefore: buyuk seride dogrusal tarama ile ayni sonuc', () => {
  const n = 5000
  const time = new Array(n)
  for (let i = 0; i < n; i++) time[i] = 1000 + i * 7
  const s = seri(time)
  for (let k = 0; k < n; k += 137) {
    const t = time[k] + 3
    let beklenen = -1
    for (let i = 0; i < n; i++) if (time[i] <= t) beklenen = i
    assert.equal(series.lastIndexAtOrBefore(s, t), beklenen)
  }
})

test('concatSeries: zaman sirali birlestirme, cakisanlarda YENI veri kazanir', () => {
  const a = series.fromArrays({
    time: [100, 200, 300],
    open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3],
    close: [1, 2, 3], volume: [1, 2, 3],
  })
  const b = series.fromArrays({
    time: [300, 400],
    open: [30, 40], high: [30, 40], low: [30, 40],
    close: [30, 40], volume: [30, 40],
  })
  const c = series.concatSeries(a, b)
  assert.equal(c.length, 4)
  assert.deepEqual(Array.from(c.time), [100, 200, 300, 400])
  // 300 zaman damgasinda b kazanmali.
  assert.equal(c.close[2], 30)
  assert.equal(c.volume[2], 30)
  assert.equal(c.close[3], 40)
})

test('concatSeries: bos seriler ve sirasi bozuk aralik', () => {
  const bos = series.emptySeries()
  const a = seri([100, 200])
  assert.equal(series.concatSeries(bos, bos).length, 0)
  assert.equal(series.concatSeries(a, bos).length, 2)
  assert.equal(series.concatSeries(bos, a).length, 2)

  // b tamamen a'dan once geliyorsa sonuc yine artan sirali olmali.
  const b = seri([10, 20])
  const c = series.concatSeries(a, b)
  assert.deepEqual(Array.from(c.time), [10, 20, 100, 200])
})

test('sanitize: NaN satirlari atar, tekrarlari birler, sirayi duzeltir', () => {
  const s = series.fromArrays({
    time: [300, 100, 200, 200, NaN],
    open: [3, 1, 2, 22, 5],
    high: [3, 1, 2, 22, 5],
    low: [3, 1, 2, 22, 5],
    close: [3, 1, 2, 22, 5],
    volume: [3, 1, 2, 22, 5],
  })
  const t = series.sanitize(s)
  assert.deepEqual(Array.from(t.time), [100, 200, 300])
  // Ayni zaman damgasinda sonuncusu kazanir.
  assert.equal(t.close[1], 22)
})

test('sliceSeries: [from, to) araligini kopyalamadan dondurur', () => {
  const s = seri([100, 200, 300, 400, 500])
  const p = series.sliceSeries(s, 1, 4)
  assert.equal(p.length, 3)
  assert.deepEqual(Array.from(p.time), [200, 300, 400])
  // subarray kullanildigi icin ayni tamponu paylasmali.
  assert.equal(p.time.buffer, s.time.buffer)
})

test('toBars: chart icin nesne dizisi uretir', () => {
  const s = seri([100, 200, 300])
  const bars = series.toBars(s, 1, 3)
  assert.equal(bars.length, 2)
  assert.equal(bars[0].time, 200)
  assert.ok('open' in bars[0] && 'high' in bars[0] && 'low' in bars[0])
  assert.ok('close' in bars[0] && 'volume' in bars[0])
})
