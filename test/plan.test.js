'use strict'

// SINYAL PLANI (src/core/learn/plan.js): giris, SL, TP ve sonuc, DOLAR bazli.
//
// Kullanicinin tanimi: "M1'de 10 dolar, M5'te 20, M15'te 30; 4025'te aldik,
// 4015'e gelince SL". Bu testler tanimi kilitler: SL = giris -/+ slUsd,
// TP = giris +/- tpUsd, ayni barda ikisi de vurulursa SL, seri bitince
// 'open', ufuk dolunca 'timeout'; dilim basina varsayilan ve yama.

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  planKur, planCoz, sinyaliPlanla, planAyariCoz, DEFAULT_PLAN_BY_TF, PLAN_MODE,
} = require('../src/core/learn/plan')
const series = require('../src/core/series')

const T0 = 1700000000
function seri (barlar) {
  return series.fromArrays({
    time: barlar.map((_b, i) => T0 + i * 60),
    open: barlar.map((b) => b[0]),
    high: barlar.map((b) => b[1]),
    low: barlar.map((b) => b[2]),
    close: barlar.map((b) => b[3]),
    volume: barlar.map(() => 1),
  })
}
const AL = { price: 4025, direction: 'BUY', time: T0 }
const SAT = { price: 4025, direction: 'SELL', time: T0 }

test('plan seviyeleri: kullanicinin ornegi, 4025 alis, SL 10 dolar -> 4015', () => {
  const al = planKur(AL, { slUsd: 10, tpUsd: 10 })
  assert.equal(al.entry, 4025)
  assert.equal(al.sl, 4015)
  assert.equal(al.tp, 4035)
  assert.equal(al.rr, 1)
  const sat = planKur(SAT, { slUsd: 20, tpUsd: 40 })
  assert.equal(sat.sl, 4045, 'SAT: SL yukarida')
  assert.equal(sat.tp, 3985, 'SAT: TP asagida')
  assert.equal(sat.rr, 2)
})

test('plan kurulamaz: giris yok, mesafe yok veya sifir', () => {
  assert.equal(planKur({ direction: 'BUY' }, { slUsd: 10, tpUsd: 10 }), null)
  assert.equal(planKur(AL, { slUsd: 0, tpUsd: 10 }), null)
  assert.equal(planKur(AL, { slUsd: 10 }), null)
  assert.equal(planKur(AL, null), null)
  assert.equal(planKur(null, { slUsd: 10, tpUsd: 10 }), null)
})

test('dilim basina varsayilan ve kullanici yamasi', () => {
  assert.deepEqual(planAyariCoz('1m', null), { slUsd: 10, tpUsd: 10 })
  assert.deepEqual(planAyariCoz('5m', null), { slUsd: 20, tpUsd: 20 })
  assert.deepEqual(planAyariCoz('15m', null), { slUsd: 30, tpUsd: 30 })
  assert.equal(DEFAULT_PLAN_BY_TF['4h'].slUsd, 100)
  // Yalnizca degisen alan yamadan gelir, digeri varsayilan kalir.
  assert.deepEqual(planAyariCoz('5m', { '5m': { slUsd: 25 } }), { slUsd: 25, tpUsd: 20 })
  // Baska dilimin yamasi bu dilimi etkilemez.
  assert.deepEqual(planAyariCoz('5m', { '1m': { slUsd: 3 } }), { slUsd: 20, tpUsd: 20 })
  // Gecersiz yama (0, negatif, metin) varsayilana duser.
  assert.deepEqual(planAyariCoz('5m', { '5m': { slUsd: 0, tpUsd: 'x' } }), { slUsd: 20, tpUsd: 20 })
  // Bilinmeyen dilim 15m'ye duser, patlamaz.
  assert.deepEqual(planAyariCoz('2h', null), { slUsd: 30, tpUsd: 30 })
})

test('sonuc: hangisi once vurulursa o, ayni barda ikisi de vurulursa SL', () => {
  const plan = { sl: 4015, tp: 4035 }
  assert.equal(planCoz(seri([[4025, 4026, 4024, 4025], [4030, 4036, 4028, 4034]]), 0, plan, true, 200).result, 'tp')
  assert.equal(planCoz(seri([[4025, 4026, 4024, 4025], [4020, 4022, 4014, 4016]]), 0, plan, true, 200).result, 'sl')
  assert.equal(planCoz(seri([[4025, 4026, 4024, 4025], [4025, 4040, 4010, 4025]]), 0, plan, true, 200).result, 'sl')
  // Sinyal barinin kendisi SAYILMAZ.
  assert.equal(planCoz(seri([[4025, 4040, 4010, 4025], [4025, 4026, 4024, 4025]]), 0, plan, true, 200).result, 'open')
})

test('sonuc: seri bitince ACIK, ufuk dolunca SURE DOLDU', () => {
  const plan = { sl: 4015, tp: 4035 }
  const sakin = [[4025, 4026, 4024, 4025], [4025, 4026, 4024, 4025], [4025, 4026, 4024, 4025]]
  const acik = planCoz(seri(sakin), 0, plan, true, 200)
  assert.equal(acik.result, 'open')
  assert.equal(acik.resolvedTime, null)
  const dolu = planCoz(seri(sakin), 0, plan, true, 2)
  assert.equal(dolu.result, 'timeout')
  assert.equal(dolu.bars, 2)
})

test('SAT yonu aynali: SL yukarida, TP asagida', () => {
  const plan = { sl: 4035, tp: 4015 }
  assert.equal(planCoz(seri([[4025, 4026, 4024, 4025], [4020, 4022, 4014, 4016]]), 0, plan, false, 200).result, 'tp')
  assert.equal(planCoz(seri([[4025, 4026, 4024, 4025], [4030, 4036, 4028, 4034]]), 0, plan, false, 200).result, 'sl')
})

test('sinyaliPlanla: sinyali zamana gore bulur, plani sinyale takar, seri yoksa ACIK', () => {
  const s = seri([[4025, 4026, 4024, 4025], [4030, 4036, 4028, 4034]])
  const sig = Object.assign({}, AL)
  const plan = sinyaliPlanla(s, sig, { slUsd: 10, tpUsd: 10, planHorizonBars: 200 })
  assert.equal(sig.plan, plan)
  assert.equal(plan.mode, PLAN_MODE)
  assert.equal(plan.result, 'tp')
  assert.equal(plan.resolvedTime, T0 + 60)
  const sig2 = Object.assign({}, AL)
  assert.equal(sinyaliPlanla(null, sig2, { slUsd: 10, tpUsd: 10 }).result, 'open')
  const sig3 = Object.assign({}, AL)
  assert.equal(sinyaliPlanla(s, sig3, { slUsd: 0, tpUsd: 10 }), null)
  assert.equal(sig3.plan, null)
})

test('MESAFE DEGISINCE SONUC DEGISIR: ayni seri, TP 10 vurulur, TP 30 acik kalir', () => {
  const s = seri([[4025, 4026, 4024, 4025], [4030, 4036, 4028, 4034], [4030, 4036, 4028, 4034]])
  const dar = sinyaliPlanla(s, Object.assign({}, AL), { slUsd: 10, tpUsd: 10 })
  const genis = sinyaliPlanla(s, Object.assign({}, AL), { slUsd: 10, tpUsd: 30 })
  assert.equal(dar.result, 'tp')
  assert.equal(genis.result, 'open')
})
