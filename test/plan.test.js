'use strict'

// SINYAL PLANI (src/core/learn/plan.js): giris, SL, TP ve sonuc.
//
// Kullanici istedi: sinyalde TP/SL nerede ve islem TP ile mi SL ile mi
// sonuclandi; oran (varsayilan 1'e 1) ayarlardan degisince sonuc da degissin.
// Bu testler TANIMI kilitler: SL kutunun uzak kenari + pay, TP = giris +/-
// oran x risk, ayni barda ikisi de vurulursa SL, seri bitince 'open', ufuk
// dolunca 'timeout'.

const test = require('node:test')
const assert = require('node:assert/strict')
const { planKur, planCoz, sinyaliPlanla, DEFAULT_PLAN_CFG } = require('../src/core/learn/plan')
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
const AL = { price: 100, zoneTop: 99.8, zoneBottom: 99, atr: 1, direction: 'BUY', time: T0 }
const SAT = { price: 100, zoneTop: 101, zoneBottom: 100.2, atr: 1, direction: 'SELL', time: T0 }

test('plan seviyeleri: SL kutunun uzak kenari + pay, TP = giris +/- oran x risk', () => {
  const al = planKur(AL, { tpRr: 1, breakBufferAtr: 0.25 })
  assert.equal(al.entry, 100)
  assert.equal(al.sl, 98.75, 'AL: kutu alti 99 - 0,25 ATR')
  assert.ok(Math.abs(al.tp - 101.25) < 1e-9, '1:1 -> risk 1,25 kadar yukari')
  const sat = planKur(SAT, { tpRr: 2, breakBufferAtr: 0.25 })
  assert.equal(sat.sl, 101.25, 'SAT: kutu ustu 101 + 0,25 ATR')
  assert.ok(Math.abs(sat.tp - 97.5) < 1e-9, '2:1 -> risk 1,25 x 2 kadar asagi')
  assert.equal(DEFAULT_PLAN_CFG.tpRr, 1, 'varsayilan birebir')
})

test('plan kurulamaz: kapanis kutunun otesinde, ATR yok, seviye yok', () => {
  assert.equal(planKur(Object.assign({}, AL, { price: 98 }), {}), null, 'risk <= 0')
  assert.equal(planKur(Object.assign({}, AL, { atr: 0 }), {}), null)
  assert.equal(planKur(Object.assign({}, AL, { zoneBottom: NaN }), {}), null)
  assert.equal(planKur(null, {}), null)
})

test('sonuc: hangisi once vurulursa o, ayni barda ikisi de vurulursa SL', () => {
  const plan = { sl: 98.75, tp: 101.25 }
  // bar1: TP vurulur
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [101, 101.5, 100.5, 101]]), 0, plan, true, 200).result, 'tp')
  // bar1: SL vurulur
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [99, 99.5, 98.5, 99]]), 0, plan, true, 200).result, 'sl')
  // bar1: IKISI DE (genis bar) -> temkinli: SL
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [100, 102, 98, 100]]), 0, plan, true, 200).result, 'sl')
  // sinyal barinin kendisi SAYILMAZ (startIdx dahil degil)
  assert.equal(planCoz(seri([[100, 102, 98, 100], [100, 100.2, 99.8, 100]]), 0, plan, true, 200).result, 'open')
})

test('sonuc: seri bitince ACIK, ufuk dolunca SURE DOLDU', () => {
  const plan = { sl: 98.75, tp: 101.25 }
  const sakin = [[100, 100.2, 99.8, 100], [100, 100.2, 99.8, 100], [100, 100.2, 99.8, 100]]
  const acik = planCoz(seri(sakin), 0, plan, true, 200)
  assert.equal(acik.result, 'open')
  assert.equal(acik.resolvedTime, null)
  const dolu = planCoz(seri(sakin), 0, plan, true, 2)
  assert.equal(dolu.result, 'timeout')
  assert.equal(dolu.bars, 2)
})

test('SAT yonu aynali: SL yukarida, TP asagida', () => {
  const plan = { sl: 101.25, tp: 98.75 }
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [99, 99.5, 98.5, 99]]), 0, plan, false, 200).result, 'tp')
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [101, 101.5, 100.5, 101]]), 0, plan, false, 200).result, 'sl')
})

test('sinyaliPlanla: sinyali zamana gore bulur, plani sinyale takar, seri yoksa ACIK', () => {
  const s = seri([[100, 100.5, 99.5, 100], [101, 101.5, 100.5, 101]])
  const sig = Object.assign({}, AL)
  const plan = sinyaliPlanla(s, sig, { tpRr: 1, breakBufferAtr: 0.25, planHorizonBars: 200 })
  assert.equal(sig.plan, plan)
  assert.equal(plan.result, 'tp')
  assert.equal(plan.resolvedTime, T0 + 60)
  const sig2 = Object.assign({}, AL)
  assert.equal(sinyaliPlanla(null, sig2, {}).result, 'open', 'seri yoksa sonuc bilinmez')
  const sig3 = Object.assign({}, AL, { price: 98 })
  assert.equal(sinyaliPlanla(s, sig3, {}), null)
  assert.equal(sig3.plan, null, 'kurulamayan plan null olarak takilir')
})

test('ORAN DEGISINCE SONUC DEGISIR: ayni seri, 1:1 TP, 3:1 acik', () => {
  const s = seri([[100, 100.5, 99.5, 100], [101, 101.5, 100.5, 101], [101, 101.5, 100.5, 101]])
  const bir = sinyaliPlanla(s, Object.assign({}, AL), { tpRr: 1, breakBufferAtr: 0.25 })
  const uc = sinyaliPlanla(s, Object.assign({}, AL), { tpRr: 3, breakBufferAtr: 0.25 })
  assert.equal(bir.result, 'tp')
  assert.equal(uc.result, 'open')
  assert.ok(uc.tp > bir.tp)
})
