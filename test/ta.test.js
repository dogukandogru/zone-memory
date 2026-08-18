'use strict'

// A12 - src/core/ta.js testleri (CONTRACTS.md bolum 7 ve 21).
// Elle hesaplanmis kucuk ornekler uzerinden Pine tohumlamasi, NaN isinmasi,
// pencere sinirlari ve pivot konumlandirmasi dogrulanir.

const test = require('node:test')
const assert = require('node:assert/strict')

const ta = require('../src/core/ta')

/** Kayan nokta karsilastirmasi. */
function yakin (a, b, tol) {
  const t = tol === undefined ? 1e-9 : tol
  assert.ok(Number.isFinite(a), 'deger sonlu olmali, gelen: ' + a)
  assert.ok(Math.abs(a - b) <= t, 'beklenen ' + b + ', gelen ' + a)
}

/** Dizinin [0, k) araligindaki tum degerleri NaN olmali (sifir DEGIL). */
function isinmaNaN (arr, k, ad) {
  for (let i = 0; i < k; i++) {
    assert.ok(Number.isNaN(arr[i]), ad + ' isinma bolgesi ' + i + '. barda NaN olmali, gelen: ' + arr[i])
  }
}

const F = (a) => Float64Array.from(a)

test('sma: ilk len-1 bar NaN, sonrasi duz ortalama', () => {
  const out = ta.sma(F([1, 2, 3, 4, 5]), 3)
  isinmaNaN(out, 2, 'sma')
  yakin(out[2], 2)
  yakin(out[3], 3)
  yakin(out[4], 4)
})

test('ema: out[len-1] SMA ile tohumlanir, sonrasi alpha = 2/(len+1)', () => {
  const out = ta.ema(F([1, 2, 3, 4, 5]), 3)
  isinmaNaN(out, 2, 'ema')
  // Tohum: (1+2+3)/3 = 2, alpha = 0.5
  yakin(out[2], 2)
  yakin(out[3], 0.5 * 4 + 0.5 * 2)   // 3
  yakin(out[4], 0.5 * 5 + 0.5 * 3)   // 4
})

test('rma: out[len-1] SMA ile tohumlanir, sonrasi alpha = 1/len', () => {
  const out = ta.rma(F([1, 2, 3, 4, 5]), 3)
  isinmaNaN(out, 2, 'rma')
  yakin(out[2], 2)
  yakin(out[3], (4 + 2 * 2) / 3)              // 8/3
  yakin(out[4], (5 + 2 * (8 / 3)) / 3)        // 31/9
})

test('ema ve rma: seri len kadar bile degilse tamami NaN', () => {
  const e = ta.ema(F([1, 2]), 5)
  const r = ta.rma(F([1, 2]), 5)
  isinmaNaN(e, 2, 'ema')
  isinmaNaN(r, 2, 'rma')
})

test('trueRange: ilk bar high - low, sonrasi uc adayin azamisi', () => {
  const high = F([10, 12, 11])
  const low = F([9, 10.5, 8])
  const close = F([9.5, 11, 9])
  const tr = ta.trueRange(high, low, close)
  yakin(tr[0], 1)                                   // 10 - 9
  yakin(tr[1], Math.max(1.5, 2.5, 1))               // |12 - 9.5| = 2.5
  yakin(tr[2], Math.max(3, 0, 3))                   // |8 - 11| = 3
})

test('atr: rma(trueRange, len) ile birebir ayni', () => {
  const high = F([10, 12, 11, 13, 12])
  const low = F([9, 10.5, 8, 11, 10])
  const close = F([9.5, 11, 9, 12.5, 11])
  const a = ta.atr(high, low, close, 3)
  const b = ta.rma(ta.trueRange(high, low, close), 3)
  isinmaNaN(a, 2, 'atr')
  for (let i = 2; i < a.length; i++) yakin(a[i], b[i])
})

test('rsi: ilk gecerli deger len indeksinde, oncesi NaN', () => {
  const src = F([1, 2, 3, 4, 5, 6, 7])
  const out = ta.rsi(src, 3)
  isinmaNaN(out, 3, 'rsi')
  // Surekli yukselen seride dusus yok, rma(down) = 0 -> 100
  for (let i = 3; i < out.length; i++) yakin(out[i], 100)
})

test('rsi: surekli dusen seride 0, dalgali seride 0..100 arasinda', () => {
  const dusen = ta.rsi(F([7, 6, 5, 4, 3, 2, 1]), 3)
  for (let i = 3; i < dusen.length; i++) yakin(dusen[i], 0)

  const dalgali = ta.rsi(F([10, 11, 10.5, 12, 11.5, 13, 12.5, 14]), 3)
  for (let i = 3; i < dalgali.length; i++) {
    assert.ok(dalgali[i] > 0 && dalgali[i] < 100, 'rsi 0..100 arasinda olmali: ' + dalgali[i])
  }
})

test('rollingMax / rollingMin: pencere [i-len+1 .. i] sinirlari', () => {
  const src = F([3, 1, 4, 1, 5, 9, 2, 6])
  const mx = ta.rollingMax(src, 3)
  const mn = ta.rollingMin(src, 3)
  isinmaNaN(mx, 2, 'rollingMax')
  isinmaNaN(mn, 2, 'rollingMin')

  const beklenenMax = [4, 4, 5, 9, 9, 9]
  const beklenenMin = [1, 1, 1, 1, 2, 2]
  for (let i = 0; i < beklenenMax.length; i++) {
    yakin(mx[i + 2], beklenenMax[i])
    yakin(mn[i + 2], beklenenMin[i])
  }
})

test('rollingMax: pencere disindaki eski uc deger dusurulur', () => {
  // 9 yalnizca 3 barlik pencerede kaldigi surece gorunmeli.
  const src = F([1, 9, 1, 1, 1, 1])
  const mx = ta.rollingMax(src, 3)
  yakin(mx[2], 9)
  yakin(mx[3], 9)
  yakin(mx[4], 1)  // 9 artik pencerede degil
  yakin(mx[5], 1)
})

test('rollingMean ve stdev: bilinen degerler', () => {
  const src = F([2, 4, 4, 4, 4, 4, 4])
  const ort = ta.rollingMean(src, 3)
  isinmaNaN(ort, 2, 'rollingMean')
  yakin(ort[2], (2 + 4 + 4) / 3)
  yakin(ort[6], 4)

  const sd = ta.stdev(F([2, 4, 4, 4, 5, 5, 7, 9]), 8)
  isinmaNaN(sd, 7, 'stdev')
  yakin(sd[7], 2, 1e-9)   // anakutle sapmasi
})

test('pivotHigh: deger c+right indeksine yazilir, digerleri NaN', () => {
  const high = F([1, 3, 2, 5, 2, 3, 1])
  const out = ta.pivotHigh(high, 1, 1)
  // c=1 -> out[2]=3, c=3 -> out[4]=5, c=5 -> out[6]=3
  const beklenen = [NaN, NaN, 3, NaN, 5, NaN, 3]
  for (let i = 0; i < beklenen.length; i++) {
    if (Number.isNaN(beklenen[i])) {
      assert.ok(Number.isNaN(out[i]), i + '. bar NaN olmali, gelen: ' + out[i])
    } else {
      yakin(out[i], beklenen[i])
    }
  }
})

test('pivotLow: pivotHigh simetrigi, deger c+right indeksinde', () => {
  const low = F([9, 7, 8, 5, 8, 7, 9])
  const out = ta.pivotLow(low, 1, 1)
  const beklenen = [NaN, NaN, 7, NaN, 5, NaN, 7]
  for (let i = 0; i < beklenen.length; i++) {
    if (Number.isNaN(beklenen[i])) {
      assert.ok(Number.isNaN(out[i]), i + '. bar NaN olmali, gelen: ' + out[i])
    } else {
      yakin(out[i], beklenen[i])
    }
  }
})

test('pivotHigh / pivotLow: esitlikte pivot YOKTUR', () => {
  const ph = ta.pivotHigh(F([1, 3, 3, 1]), 1, 1)
  for (let i = 0; i < ph.length; i++) {
    assert.ok(Number.isNaN(ph[i]), 'esit tepe pivot uretmemeli, ' + i + ': ' + ph[i])
  }
  const pl = ta.pivotLow(F([9, 5, 5, 9]), 1, 1)
  for (let i = 0; i < pl.length; i++) {
    assert.ok(Number.isNaN(pl[i]), 'esit dip pivot uretmemeli, ' + i + ': ' + pl[i])
  }
})

test('pivotHigh: asimetrik left/right ile konum dogru', () => {
  // left = 2, right = 3. Merkez c = 3 (deger 9), out[6] beklenir.
  const high = F([1, 2, 3, 9, 4, 3, 2, 1])
  const out = ta.pivotHigh(high, 2, 3)
  yakin(out[6], 9)
  for (let i = 0; i < out.length; i++) {
    if (i === 6) continue
    assert.ok(Number.isNaN(out[i]), i + '. bar NaN olmali, gelen: ' + out[i])
  }
})

test('shift: n bar geriye kaydirir, bas kisim NaN', () => {
  const out = ta.shift(F([1, 2, 3, 4]), 2)
  isinmaNaN(out, 2, 'shift')
  yakin(out[2], 1)
  yakin(out[3], 2)
})

test('clamp: alt ve ust sinira kirpar', () => {
  assert.equal(ta.clamp(-3, 0, 1), 0)
  assert.equal(ta.clamp(0.5, 0, 1), 0.5)
  assert.equal(ta.clamp(9, 0, 1), 1)
})

test('isinma bolgeleri sifir degil NaN (sozlesme genel kurali)', () => {
  const src = F([5, 6, 7, 8, 9, 10])
  const fns = [
    ['sma', ta.sma(src, 4)],
    ['ema', ta.ema(src, 4)],
    ['rma', ta.rma(src, 4)],
    ['rollingMax', ta.rollingMax(src, 4)],
    ['rollingMin', ta.rollingMin(src, 4)],
    ['stdev', ta.stdev(src, 4)],
  ]
  for (const [ad, arr] of fns) {
    for (let i = 0; i < 3; i++) {
      assert.notEqual(arr[i], 0, ad + ' isinmasi sifir olmamali')
      assert.ok(Number.isNaN(arr[i]), ad + ' isinmasi NaN olmali')
    }
  }
})
