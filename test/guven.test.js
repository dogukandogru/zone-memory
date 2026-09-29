'use strict'

// GUVEN YUZDESI (core/learn/guven.js): "bu yapi gecmiste geldiginde kacinda
// TP oldu", benzerlik agirlikli. Nedensellik, agirlik, kuculutme ve metin.

const test = require('node:test')
const assert = require('node:assert/strict')
const G = require('../src/core/learn/guven')

const T = 1_700_000_000
const tp = (sim, r) => ({ similarity: sim, plan: { result: 'tp', resolvedTime: r === undefined ? 1 : r } })
const sl = (sim, r) => ({ similarity: sim, plan: { result: 'sl', resolvedTime: r === undefined ? 1 : r } })

test('esit benzerlikte oran = TP payi, taban orana dogru cekilir', () => {
  // 6/10 TP, hepsi benzerlik 1 (agirlik 1): etkin orneklem 10,
  // (0,6*10 + 10*0,47) / 20 = 0,535 -> %53 (kayan noktada yarim asagi)
  const k = [tp(1), tp(1), tp(1), tp(1), tp(1), tp(1), sl(1), sl(1), sl(1), sl(1)]
  const g = G.guvenHesapla(k, T, 0.47)
  assert.equal(g.confidence, 53)
  assert.equal(g.confidenceRaw, 0.6)
  assert.equal(g.confidenceN, 10)
  assert.equal(g.confidenceNeff, 10)
  assert.equal(g.confidenceBase, 0.47)
  // Uclar kalibre kalir: 10/10 -> %74, 0/10 -> %23; %100 ve %0 gorunmez.
  assert.equal(G.guvenHesapla(Array(10).fill(tp(1)), T, 0.47).confidence, 74)
  assert.equal(G.guvenHesapla(Array(10).fill(sl(1)), T, 0.47).confidence, 23)
})

test('agirlik benzerlikle duser: yakin komsu uzaktakinden cok sayilir', () => {
  assert.equal(G.komsuAgirligi(1), 1)
  assert.ok(Math.abs(G.komsuAgirligi(0.98) - Math.exp(-1)) < 1e-12, '0,02 uzak = e^-1')
  assert.ok(G.komsuAgirligi(0.9) < 0.01, '0,10 uzak = e^-5, neredeyse sifir')
  // Bir yakin TP (0,98) + bes uzak SL (0,90): ham oran TP'ye yakin kalir.
  const g = G.guvenHesapla([tp(0.98), sl(0.9), sl(0.9), sl(0.9), sl(0.9), sl(0.9)], T, 0.5)
  assert.ok(g.confidenceRaw > 0.9, 'uzak besli yakin tekliyi bastiramaz: ' + g.confidenceRaw)
  assert.ok(g.confidenceNeff < 1.5, 'etkin orneklem ~1: ' + g.confidenceNeff)
  // Ayni komsular esit benzerlikte olsaydi oran 1/6 olurdu.
  assert.ok(Math.abs(G.guvenHesapla([tp(1), sl(1), sl(1), sl(1), sl(1), sl(1)], T, 0.5).confidenceRaw - 1 / 6) < 1e-12)
})

test('nedensellik: sinyal aninda sonucu belli olmayan komsu SAYILMAZ', () => {
  const k = [tp(1, T - 1), tp(1, T), tp(1, T + 100), { similarity: 1, plan: { result: 'open', resolvedTime: null } },
    { similarity: 1, plan: { result: 'timeout', resolvedTime: T - 5 } }, { similarity: 1, plan: null }, null]
  const g = G.guvenHesapla(k, T, 0.5)
  assert.equal(g.confidenceN, 1, 'yalnizca T-1 sayilir: T ve T+100 sonra, open/timeout sonuc degil')
  assert.equal(g.confidenceRaw, 1)
})

test('komsu yoksa yuzde taban orandir; en fazla GUVEN_KOMSU komsu katilir', () => {
  const bos = G.guvenHesapla([], T, 0.42)
  assert.equal(bos.confidence, 42)
  assert.equal(bos.confidenceRaw, null)
  assert.equal(bos.confidenceN, 0)
  assert.equal(G.guvenHesapla(null, T, undefined).confidence, 50, 'taban bilinmiyorsa 0,5')
  const cok = Array(80).fill(tp(1))
  assert.equal(G.guvenHesapla(cok, T, 0.5).confidenceN, G.GUVEN_KOMSU)
})

test('taban oranlari: listedeki cozulmus planlarin TP orani, tur basina', () => {
  const liste = [
    { kind: 'form', plan: { result: 'tp' } }, { kind: 'form', plan: { result: 'sl' } },
    { kind: 'form', plan: { result: 'open' } }, { kind: 'touch', plan: { result: 'tp' } },
    { kind: 'touch', plan: null }, null,
  ]
  assert.deepEqual(G.tabanOranlari(liste), { form: 0.5, touch: 1 })
  assert.deepEqual(G.tabanOranlari([]), { form: 0.5, touch: 0.5 })
})

test('metin: "TP şansı %56"', () => {
  assert.equal(G.guvenMetni({ confidence: 56, confidenceRaw: 0.6, confidenceN: 50 }), 'TP şansı %56')
  assert.equal(G.guvenMetni({ confidence: 47 }), 'TP şansı %47')
  assert.equal(G.guvenMetni({}), '')
})
