'use strict'

// A12 - src/core/learn/cluster.js testleri (CONTRACTS.md bolum 13 ve 21).

const test = require('node:test')
const assert = require('node:assert/strict')

const cluster = require('../src/core/learn/cluster')
const { mulberry32, kmeans, buildPrototypes, matchPrototype } = cluster

// Em-dash karakteri kodda yazilmaz, kod noktasindan uretilir.
const EM_DASH = String.fromCharCode(0x2014)

/** Uc ayri kumede toplanan, deterministik uretilmis vektorler. */
function kumeliVeri (kumeBasi, boyut) {
  const rnd = mulberry32(2024)
  const merkezler = [
    [0, 0, 0, 0],
    [10, 10, 10, 10],
    [-10, 10, -10, 10],
  ]
  const out = []
  for (let m = 0; m < merkezler.length; m++) {
    for (let i = 0; i < kumeBasi; i++) {
      const v = new Float32Array(boyut)
      for (let d = 0; d < boyut; d++) v[d] = merkezler[m][d % 4] + (rnd() - 0.5) * 0.5
      out.push(v)
    }
  }
  return out
}

/** Sentetik hafiza olayi (prototip cikarimi icin). */
function olay (id, shape, basarili) {
  return {
    id: id,
    time: 1600000000 + id * 3600,
    direction: 'BUY',
    outcome: basarili ? 'respect' : 'break',
    success: !!basarili,
    mfeAtr: basarili ? 2 : 0.2,
    maeAtr: basarili ? 0.3 : 1.2,
    features: { shape: shape, ret: new Float32Array(32), ctx: new Float32Array(22) },
  }
}

test('mulberry32: deterministik ve 0..1 araliginda', () => {
  const a = mulberry32(42)
  const b = mulberry32(42)
  for (let i = 0; i < 100; i++) {
    const x = a()
    assert.equal(x, b(), 'ayni tohum ayni diziyi uretmeli')
    assert.ok(x >= 0 && x < 1, 'deger 0..1 arasinda olmali: ' + x)
  }
  // Farkli tohum farkli dizi.
  const c = mulberry32(43)
  const d = mulberry32(42)
  let fark = false
  for (let i = 0; i < 20; i++) if (c() !== d()) fark = true
  assert.ok(fark, 'farkli tohum farkli dizi uretmeli')
})

test('kmeans: ayni tohum ayni sonucu verir (determinizm)', () => {
  const v = kumeliVeri(20, 8)
  const a = kmeans(v, 3, { seed: 42, iters: 50 })
  const b = kmeans(v, 3, { seed: 42, iters: 50 })

  assert.equal(a.centroids.length, b.centroids.length)
  assert.deepEqual(Array.from(a.assignments), Array.from(b.assignments))
  assert.equal(a.inertia, b.inertia)
  for (let j = 0; j < a.centroids.length; j++) {
    assert.deepEqual(Array.from(a.centroids[j]), Array.from(b.centroids[j]))
  }
})

test('kmeans: bos kume olusmaz', () => {
  const v = kumeliVeri(20, 8)
  const k = 3
  const r = kmeans(v, k, { seed: 7 })
  assert.equal(r.centroids.length, k)
  assert.equal(r.assignments.length, v.length)

  const sayilar = new Array(k).fill(0)
  for (let i = 0; i < r.assignments.length; i++) {
    const j = r.assignments[i]
    assert.ok(j >= 0 && j < k, 'atama gecerli kume indeksi olmali: ' + j)
    sayilar[j]++
  }
  for (let j = 0; j < k; j++) {
    assert.ok(sayilar[j] > 0, j + '. kume bos kalmamali')
  }
})

test('kmeans: ayrik kumeleri dogru ayirir', () => {
  const kumeBasi = 15
  const v = kumeliVeri(kumeBasi, 4)
  const r = kmeans(v, 3, { seed: 42 })
  // Ayni gercek kumedeki tum noktalar ayni etikete dusmeli.
  for (let m = 0; m < 3; m++) {
    const ilk = r.assignments[m * kumeBasi]
    for (let i = 1; i < kumeBasi; i++) {
      assert.equal(r.assignments[m * kumeBasi + i], ilk, 'ayrik kume bolunmemeli')
    }
  }
  assert.ok(r.inertia >= 0)
})

test('kmeans: k nokta sayisindan buyukse merkez sayisi kirpilir', () => {
  const v = [Float32Array.from([1, 1]), Float32Array.from([5, 5])]
  const r = kmeans(v, 10, { seed: 1 })
  assert.equal(r.centroids.length, 2)
})

test('kmeans: bos girdide guvenli sonuc', () => {
  const r = kmeans([], 3, {})
  assert.deepEqual(r.centroids, [])
  assert.equal(r.assignments.length, 0)
  assert.equal(r.inertia, 0)
})

test('buildPrototypes: ayni tohumda ayni prototipler, alanlar dolu', () => {
  const v = kumeliVeri(20, 16)
  const events = []
  for (let i = 0; i < v.length; i++) events.push(olay(i, v[i], i % 5 !== 0))

  const a = buildPrototypes({ events }, { k: 3, minSize: 5, seed: 42 })
  const b = buildPrototypes({ events }, { k: 3, minSize: 5, seed: 42 })
  assert.ok(a.length > 0, 'prototip uretilmeli')
  assert.equal(a.length, b.length)

  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    assert.equal(p.id, i)
    assert.ok(p.size >= 5, 'minSize altindaki kumeler elenmeli')
    assert.ok(p.winRate >= 0 && p.winRate <= 1)
    assert.ok(p.avgMfeAtr >= 0)
    assert.ok(p.avgMaeAtr >= 0)
    assert.ok(p.centroid instanceof Float32Array)
    assert.equal(p.centroid.length, 16)
    assert.equal(typeof p.label, 'string')
    assert.ok(p.label.length > 0)
    assert.ok(Array.isArray(p.memberIds))
    assert.equal(p.memberIds.length, p.size)
    assert.equal(p.label.includes(EM_DASH), false, 'em-dash kullanilmamali')
    // Determinizm
    assert.equal(p.label, b[i].label)
    assert.deepEqual(Array.from(p.centroid), Array.from(b[i].centroid))
    assert.deepEqual(p.memberIds, b[i].memberIds)
  }
  // Buyukten kucuge sirali.
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].size >= a[i].size)
})

test('buildPrototypes: minSize altindaki kumeler elenir', () => {
  const v = kumeliVeri(20, 16)
  const events = []
  for (let i = 0; i < v.length; i++) events.push(olay(i, v[i], true))
  const cok = buildPrototypes({ events }, { k: 3, minSize: 1000, seed: 42 })
  assert.deepEqual(cok, [], 'hicbir kume esigi gecemezse bos dizi donmeli')
})

test('buildPrototypes: sonucu olmayan hafizada bos dizi', () => {
  assert.deepEqual(buildPrototypes({ events: [] }, {}), [])
  assert.deepEqual(buildPrototypes(null, {}), [])
  const ham = [{ id: 0, time: 1, features: { shape: new Float32Array(16) } }]
  assert.deepEqual(buildPrototypes({ events: ham }, { minSize: 1 }), [])
})

test('matchPrototype: en yakin prototipi ve 0..1 arasi benzerligi dondurur', () => {
  const v = kumeliVeri(20, 16)
  const events = []
  for (let i = 0; i < v.length; i++) events.push(olay(i, v[i], true))
  const protos = buildPrototypes({ events }, { k: 3, minSize: 5, seed: 42 })
  assert.ok(protos.length > 0)

  const m = matchPrototype(protos[0].centroid, protos)
  assert.notEqual(m, null)
  assert.equal(m.prototype.id, protos[0].id, 'kendi merkezine en yakin olmali')
  assert.ok(m.similarity >= 0 && m.similarity <= 1)
  assert.ok(m.similarity > 0.99, 'kendi merkeziyle benzerlik 1 civari olmali: ' + m.similarity)

  assert.equal(matchPrototype(null, protos), null)
  assert.equal(matchPrototype(protos[0].centroid, []), null)
  assert.equal(matchPrototype(protos[0].centroid, null), null)
})

test('label: egim + son hareket semasini uretir', () => {
  const yukselen = Float32Array.from([0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1])
  const ad = cluster.label(yukselen)
  assert.equal(typeof ad, 'string')
  assert.ok(ad.startsWith('Yukselen'), 'yukselen sekil Yukselen ile baslamali: ' + ad)
  // Oynaklik parcasi KALDIRILDI: merkez vektor normalize edildigi icin
  // "sikisik / genis" ayrimi seklin kendisi hakkinda bir sey soylemiyordu.
  assert.equal(ad.split(' + ').length, 2, 'iki bilesenli ad beklenir: ' + ad)
  assert.ok(!/sikisik|genis/.test(ad), 'ad oynaklik parcasi tasimamali: ' + ad)

  const dusen = Float32Array.from([1, 0.85, 0.7, 0.5, 0.35, 0.2, 0.1, 0.05, 0])
  assert.ok(cluster.label(dusen).startsWith('Dusen'))

  const yatay = Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
  assert.ok(cluster.label(yatay).startsWith('Yatay'))
})
