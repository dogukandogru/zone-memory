'use strict'

// GUVEN YUZDESI (core/learn/guven.js): "bu yapi gecmiste geldiginde kacinda
// TP oldu". Nedensellik, kuculutme ve metin.

const test = require('node:test')
const assert = require('node:assert/strict')
const G = require('../src/core/learn/guven')

const T = 1_700_000_000
const tp = (r) => ({ result: 'tp', resolvedTime: r })
const sl = (r) => ({ result: 'sl', resolvedTime: r })

test('oran: sayilan komsulardan kaci TP, taban orana dogru cekilir', () => {
  // 6/10 TP, taban 0,47: (6 + 10*0,47) / (10 + 10) = 0,535 -> %53 (yarim
  // asagi yuvarlanir: 53,49999 kayan noktada)
  const komsular = [tp(1), tp(2), tp(3), tp(4), tp(5), tp(6), sl(7), sl(8), sl(9), sl(10)]
  const g = G.guvenHesapla(komsular, T, 0.47)
  assert.deepEqual(g, { confidence: 53, confidenceTp: 6, confidenceN: 10, confidenceBase: 0.47 })
  // 10/10 -> %74, 0/10 -> %23: uclar kalibre kalir, %100 ve %0 gorunmez.
  assert.equal(G.guvenHesapla(Array(10).fill(tp(1)), T, 0.47).confidence, 74)
  assert.equal(G.guvenHesapla(Array(10).fill(sl(1)), T, 0.47).confidence, 23)
})

test('nedensellik: sinyal aninda sonucu belli olmayan komsu SAYILMAZ', () => {
  const komsular = [tp(T - 1), tp(T), tp(T + 100), { result: 'open', resolvedTime: null }, { result: 'timeout', resolvedTime: T - 5 }, null]
  const g = G.guvenHesapla(komsular, T, 0.5)
  assert.equal(g.confidenceN, 1, 'yalnizca T-1 sayilir: T ve T+100 sonra, open/timeout sonuc degil')
  assert.equal(g.confidenceTp, 1)
})

test('komsu yoksa yuzde taban orandir; en fazla GUVEN_KOMSU komsu sayilir', () => {
  assert.equal(G.guvenHesapla([], T, 0.42).confidence, 42)
  assert.equal(G.guvenHesapla(null, T, undefined).confidence, 50, 'taban bilinmiyorsa 0,5')
  const cok = Array(30).fill(tp(1))
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

test('metin: "TP şansı %56 (6/10)", dayanak yoksa yalnizca yuzde', () => {
  assert.equal(G.guvenMetni({ confidence: 56, confidenceTp: 6, confidenceN: 10 }), 'TP şansı %56 (6/10)')
  assert.equal(G.guvenMetni({ confidence: 47 }), 'TP şansı %47')
  assert.equal(G.guvenMetni({ confidence: 47, confidenceN: 0, confidenceTp: 0 }), 'TP şansı %47')
  assert.equal(G.guvenMetni({}), '')
})
