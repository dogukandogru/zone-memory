'use strict'

// A12 - src/core/learn/similarity.js testleri (CONTRACTS.md bolum 12 ve 21).
//
// SOZLESME NOTU: sozlesme `knn` opts alanlarini {k, direction, excludeWithinSec,
// beforeTime, weights} olarak listeler, ancak `excludeWithinSec` "sorgu zamanina
// yakin kayitlari ele" demesine ragmen Features nesnesi zaman tasimaz. Uygulama
// bu boslugu `opts.queryTime` ile kapatiyor; asagidaki komsu dislama testi de
// dokunus zamanini `queryTime` ile geciriyor.

const test = require('node:test')
const assert = require('node:assert/strict')

const sim = require('../src/core/learn/similarity')
const { pearson, cosine, euclidean, dtwDistance, similarity, knn, DEFAULT_WEIGHTS } = sim

const F32 = (a) => Float32Array.from(a)

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

/** Sekil vektoru: taban patern + gurultu. */
function sekil (taban, gurultu, rnd) {
  const out = new Float32Array(16)
  for (let i = 0; i < 16; i++) {
    out[i] = taban[i % taban.length] + (gurultu > 0 ? (rnd() - 0.5) * gurultu : 0)
  }
  return out
}

/** Sentetik hafiza olayi. */
function olay (id, time, direction, f, basarili) {
  return {
    id: id,
    time: time,
    direction: direction,
    price: 1900 + id,
    atr: 1,
    outcome: basarili ? 'respect' : 'break',
    success: !!basarili,
    mfeAtr: basarili ? 2 : 0.2,
    maeAtr: basarili ? 0.3 : 1.2,
    features: f,
  }
}

test('DEFAULT_WEIGHTS sozlesmedeki degerler', () => {
  assert.deepEqual(DEFAULT_WEIGHTS, { shape: 0.60, ctx: 0.25, dtw: 0.15 })
})

test('pearson: bilinen degerler', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12, 'tam dogrusal artis 1')
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12, 'tam ters dogrusal -1')
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), 0, 'sabit seride 0')
  assert.equal(pearson([1, 2, 3], [1, 1, 1]), 0)
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [1, 2, 3, 4]) - 1) < 1e-12)
  // Kaydirma ve olcek bagimsizligi.
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [101, 102, 103, 104]) - 1) < 1e-12)
  assert.equal(pearson([1], [1]), 0, 'tek elemanda 0')
})

test('pearson: elle hesaplanmis ara deger', () => {
  // a = [1,2,3], b = [1,3,2] -> r = 0.5
  assert.ok(Math.abs(pearson([1, 2, 3], [1, 3, 2]) - 0.5) < 1e-12)
})

test('cosine: bilinen degerler', () => {
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12, 'dik vektorler 0')
  assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-12, 'ayni yonde 1')
  assert.ok(Math.abs(cosine([1, 2, 3], [-1, -2, -3]) + 1) < 1e-12, 'ters yonde -1')
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12, '45 derece 1/sqrt(2)')
  assert.equal(cosine([0, 0], [1, 1]), 0, 'sifir normlu vektorde 0')
})

test('euclidean: bilinen degerler', () => {
  assert.equal(euclidean([0, 0], [3, 4]), 5)
  assert.equal(euclidean([1, 2, 3], [1, 2, 3]), 0)
})

test('dtwDistance: ayni seride 0', () => {
  const a = [1, 3, 2, 5, 4, 6, 2, 1]
  assert.equal(dtwDistance(a, a, 5), 0)
  assert.equal(dtwDistance(Float32Array.from(a), Float32Array.from(a), 5), 0)
})

test('dtwDistance: simetrik', () => {
  const rnd = prng(11)
  for (let deneme = 0; deneme < 5; deneme++) {
    const n = 12
    const a = new Float64Array(n)
    const b = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      a[i] = rnd() * 4 - 2
      b[i] = rnd() * 4 - 2
    }
    const ab = dtwDistance(a, b, 5)
    const ba = dtwDistance(b, a, 5)
    assert.ok(Math.abs(ab - ba) < 1e-12, 'DTW simetrik olmali: ' + ab + ' vs ' + ba)
  }
})

test('dtwDistance: negatif olmayan ve (n+m) ile normalize', () => {
  // a ve b sabit farkli: her hizalama adiminda |fark| = 1 birikir.
  const a = [0, 0, 0, 0]
  const b = [1, 1, 1, 1]
  const d = dtwDistance(a, b, 5)
  assert.ok(d > 0)
  // Kosegen yol: 4 adim x 1 = 4, normalize 4 / (4 + 4) = 0.5
  assert.ok(Math.abs(d - 0.5) < 1e-12, 'normalize edilmis DTW 0.5 olmali: ' + d)
})

test('dtwDistance: farkli uzunluklarda sonlu deger uretir', () => {
  const d = dtwDistance([1, 2, 3, 4, 5], [1, 3, 5], 1)
  assert.ok(Number.isFinite(d) && d >= 0, 'bant otomatik genisletilmeli: ' + d)
})

test('similarity: ayni vektorlerde tum bilesenler 1', () => {
  const f = {
    shape: F32([0, 0.2, 0.4, 0.6, 0.8, 1, 0.7, 0.3]),
    ret: F32([1, -1, 0.5, -0.5, 0.2, -0.2, 1.5, -1.5]),
    ctx: F32([0.5, 0.2, 0.9, 0.1]),
  }
  const r = similarity(f, f)
  assert.ok(Math.abs(r.shapeSim - 1) < 1e-9)
  assert.ok(Math.abs(r.ctxSim - 1) < 1e-9)
  assert.ok(Math.abs(r.dtwSim - 1) < 1e-9)
  assert.ok(Math.abs(r.score - 1) < 1e-9)
})

test('similarity: tum bilesenler ve skor 0..1 arasinda', () => {
  const rnd = prng(5)
  for (let i = 0; i < 20; i++) {
    const a = { shape: sekil([0, 1, 0.5], 1, rnd), ret: sekil([0, 1], 2, rnd), ctx: sekil([0.5], 1, rnd) }
    const b = { shape: sekil([1, 0, 0.5], 1, rnd), ret: sekil([1, 0], 2, rnd), ctx: sekil([0.2], 1, rnd) }
    const r = similarity(a, b)
    for (const alan of ['shapeSim', 'ctxSim', 'dtwSim', 'score']) {
      assert.ok(r[alan] >= 0 && r[alan] <= 1, alan + ' 0..1 disinda: ' + r[alan])
    }
  }
})

test('knn: sonuclar benzerlige gore AZALAN sirali ve en fazla k adet', () => {
  const rnd = prng(31)
  const taban = [0, 0.3, 0.6, 1, 0.7, 0.4, 0.2, 0.1]
  const sorgu = {
    shape: sekil(taban, 0, rnd),
    ret: F32(new Array(32).fill(0).map((_, i) => Math.sin(i / 3))),
    ctx: F32(new Array(8).fill(0.5)),
  }

  const events = []
  for (let i = 0; i < 40; i++) {
    const f = {
      shape: sekil(taban, i * 0.05, rnd),
      ret: F32(new Array(32).fill(0).map((_, j) => Math.sin(j / 3) + i * 0.01)),
      ctx: F32(new Array(8).fill(0.5)),
    }
    events.push(olay(i, 1600000000 + i * 864000, 'BUY', f, i % 2 === 0))
  }

  const r = knn(sorgu, { events }, { k: 10 })
  assert.ok(r.length > 0)
  assert.ok(r.length <= 10, 'en fazla k adet donmeli')
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].similarity >= r[i].similarity, 'siralama azalan olmali')
  }
  for (const x of r) {
    assert.ok(x.event, 'her sonuc kaydin kendisini tasimali')
    assert.ok(x.similarity >= 0 && x.similarity <= 1)
    assert.ok(x.shapeSim >= 0 && x.shapeSim <= 1)
    assert.ok(x.ctxSim >= 0 && x.ctxSim <= 1)
    assert.ok(x.dtwSim >= 0 && x.dtwSim <= 1)
  }
  // Gurultusuz kayit (i = 0) en benzer olmali.
  assert.equal(r[0].event.id, 0)
})

test('knn: direction filtresi yalnizca ayni yondeki kayitlari birakir', () => {
  const rnd = prng(77)
  const taban = [0, 0.5, 1, 0.5]
  const sorgu = { shape: sekil(taban, 0, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([1, 0, 1]) }

  const events = []
  for (let i = 0; i < 20; i++) {
    const f = { shape: sekil(taban, 0.2, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([1, 0, 1]) }
    events.push(olay(i, 1600000000 + i * 864000, i % 2 === 0 ? 'BUY' : 'SELL', f, true))
  }

  const r = knn(sorgu, { events }, { k: 20, direction: 'SELL' })
  assert.ok(r.length > 0)
  for (const x of r) assert.equal(x.event.direction, 'SELL')
})

test('knn: beforeTime filtresi GELECEKTEKI kayitlari eler (ileriye bakma yasagi)', () => {
  const rnd = prng(1234)
  const taban = [0, 0.4, 0.8, 1, 0.6, 0.2]
  const sorgu = { shape: sekil(taban, 0, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([0.4, 0.6, 0.8]) }

  const T = 1600000000
  const GUN = 86400
  const events = []
  for (let i = 0; i < 40; i++) {
    const f = { shape: sekil(taban, 0.1, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([0.4, 0.6, 0.8]) }
    events.push(olay(i, T + i * 10 * GUN, 'BUY', f, true))
  }

  const kesim = T + 20 * 10 * GUN   // 20. kaydin zamani
  const r = knn(sorgu, { events }, { k: 40, beforeTime: kesim })
  assert.ok(r.length > 0, 'gecmisten aday bulunmali')
  for (const x of r) {
    assert.ok(x.event.time < kesim,
      'beforeTime sonrasi kayit donmemeli: id=' + x.event.id + ' time=' + x.event.time)
    assert.ok(x.event.id < 20, 'gelecekteki kayit id sizmis: ' + x.event.id)
  }

  // Filtresiz cagri gelecekteki kayitlari da getirebilmeli (kontrol testi).
  const hepsi = knn(sorgu, { events }, { k: 40 })
  let gelecekVar = false
  for (const x of hepsi) if (x.event.time >= kesim) gelecekVar = true
  assert.ok(gelecekVar, 'filtresiz cagri gelecekteki kayitlari da degerlendirmeli')
})

test('knn: beforeTime esitlik durumunda kaydi ELER (kesin kucukluk)', () => {
  const rnd = prng(8)
  const taban = [0, 1, 0.5]
  const sorgu = { shape: sekil(taban, 0, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([1, 1]) }
  const events = [
    olay(0, 1000, 'BUY', { shape: sekil(taban, 0, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([1, 1]) }, true),
    olay(1, 2000, 'BUY', { shape: sekil(taban, 0, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([1, 1]) }, true),
  ]
  const r = knn(sorgu, { events }, { k: 10, beforeTime: 2000 })
  assert.equal(r.length, 1)
  assert.equal(r[0].event.id, 0)
})

test('knn: excludeWithinSec sorgu zamanina yakin kayitlari eler', () => {
  const rnd = prng(4321)
  const taban = [0, 0.5, 1, 0.5, 0]
  const sorgu = { shape: sekil(taban, 0, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([0.3, 0.7]) }

  const T = 1600000000
  const GUN = 86400
  const events = []
  for (let i = 0; i < 21; i++) {
    const f = { shape: sekil(taban, 0.05, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([0.3, 0.7]) }
    // -10 gunden +10 gune, sorgu zamani tam ortada.
    events.push(olay(i, T + (i - 10) * GUN, 'BUY', f, true))
  }

  const disla = 3 * GUN
  const r = knn(sorgu, { events }, { k: 30, excludeWithinSec: disla, queryTime: T })
  assert.ok(r.length > 0)
  for (const x of r) {
    assert.ok(Math.abs(x.event.time - T) >= disla,
      'komsu dislama calismamis: id=' + x.event.id)
  }
  // -3..+3 gun araligindaki 5 kayit (id 8..12) elenmis olmali.
  const kalanIdler = r.map((x) => x.event.id).sort((a, b) => a - b)
  for (const id of [8, 9, 10, 11, 12]) {
    assert.equal(kalanIdler.includes(id), false, id + ' numarali komsu kayit elenmeliydi')
  }
  assert.equal(r.length, 16)
})

test('knn: sonucu olmayan veya ozelligi olmayan kayitlar aday degildir', () => {
  const rnd = prng(55)
  const taban = [0, 1, 0.5, 0.2]
  const f = () => ({ shape: sekil(taban, 0.05, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([1, 0]) })
  const sorgu = { shape: sekil(taban, 0, rnd), ret: F32(new Array(32).fill(0)), ctx: F32([1, 0]) }

  const events = [
    olay(0, 1000, 'BUY', f(), true),
    { id: 1, time: 2000, direction: 'BUY', features: f() },          // outcome yok
    { id: 2, time: 3000, direction: 'BUY', outcome: 'respect', success: true }, // features yok
    olay(3, 4000, 'BUY', f(), false),
  ]
  const r = knn(sorgu, { events }, { k: 10 })
  const idler = r.map((x) => x.event.id).sort((a, b) => a - b)
  assert.deepEqual(idler, [0, 3])
})

test('knn: bos hafiza veya gecersiz sorguda bos dizi', () => {
  const sorgu = { shape: F32([0, 1, 0.5]), ret: F32([0, 0, 0]), ctx: F32([1]) }
  assert.deepEqual(knn(sorgu, { events: [] }, { k: 5 }), [])
  assert.deepEqual(knn(sorgu, null, { k: 5 }), [])
  assert.deepEqual(knn(null, { events: [] }, { k: 5 }), [])
})

test('knn: 20 bin kayitta tek sorgu 50 ms altinda kalir', () => {
  const rnd = prng(909)
  const taban = [0, 0.2, 0.5, 0.8, 1, 0.7, 0.4, 0.1]
  const sorgu = {
    shape: sekil(taban, 0, rnd),
    ret: F32(new Array(32).fill(0).map((_, i) => Math.sin(i / 5))),
    ctx: F32(new Array(22).fill(0.5)),
  }
  const events = new Array(20000)
  for (let i = 0; i < 20000; i++) {
    const f = {
      shape: sekil(taban, 0.6, rnd),
      ret: F32(new Array(32).fill(0).map((_, j) => Math.sin(j / 5) + rnd() * 0.1)),
      ctx: F32(new Array(22).fill(0.5)),
    }
    events[i] = olay(i, 1400000000 + i * 3600, 'BUY', f, i % 3 === 0)
  }
  const memory = { events }
  knn(sorgu, memory, { k: 25 })   // isinma
  const t0 = process.hrtime.bigint()
  const r = knn(sorgu, memory, { k: 25 })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(r.length, 25)
  assert.ok(ms < 50, 'knn 50 ms altinda kalmali, olculen: ' + ms.toFixed(1) + ' ms')
})
