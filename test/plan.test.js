'use strict'

// SINYAL PLANI (src/core/learn/plan.js): giris, SL, TP ve sonuc, ATR cinsinden.
//
// Kullanici: "ATR'ye gore TP ve ATR'ye gore SL ayarlayabilmeliyim". Tanim:
// SL = giris -/+ slAtr x ATR, TP = giris +/- tpAtr x ATR; ayni barda ikisi de
// vurulursa SL, seri bitince 'open', ufuk dolunca 'timeout'.

const test = require('node:test')
const assert = require('node:assert/strict')
const { planKur, planCoz, sinyaliPlanla, DEFAULT_PLAN_CFG, planKipi } = require('../src/core/learn/plan')
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
// ATR kipi ornekleri (kutusuz); kutu kipi icin asagida ayri ornekler.
const AL = { price: 100, atr: 2, direction: 'BUY', time: T0 }
const SAT = { price: 100, atr: 2, direction: 'SELL', time: T0 }
const ATR_KIP = { planMode: 'atr' }
// Kutu kipi: AL destek kutusu 96-98, giris 100; SAT direnc kutusu 102-104.
const AL_KUTU = { price: 100, atr: 2, direction: 'BUY', time: T0, zoneTop: 98, zoneBottom: 96 }
const SAT_KUTU = { price: 100, atr: 2, direction: 'SELL', time: T0, zoneTop: 104, zoneBottom: 102 }

test('KUTU KIPI (varsayilan): SL uzak kenar + pay, TP = risk x oran', () => {
  assert.equal(planKipi({}), 'kutu', 'varsayilan kip kutu')
  assert.equal(planKipi({ planMode: 'saçma' }), 'kutu', 'gecersiz kip varsayilana duser')
  // AL: uzak kenar 96, pay 0,25 x 2 = 0,5 -> SL 95,5; risk 4,5; TP 104,5
  const al = planKur(AL_KUTU, {})
  assert.deepEqual({ mode: al.mode, sl: al.sl, tp: al.tp, risk: al.risk, rr: al.rr }, { mode: 'kutu', sl: 95.5, tp: 104.5, risk: 4.5, rr: 1 })
  // SAT: uzak kenar 104 -> SL 104,5; risk 4,5; oran 1,5 -> TP 93,25
  const sat = planKur(SAT_KUTU, { tpRr: 1.5 })
  assert.equal(sat.sl, 104.5)
  assert.equal(sat.tp, 93.25)
  assert.equal(sat.rr, 1.5)
  // Pay 0: SL tam kenar.
  assert.equal(planKur(AL_KUTU, { breakBufferAtr: 0 }).sl, 96)
  // Kutu kenari yoksa ya da giris SL'nin yanlis tarafindaysa plan yok.
  assert.equal(planKur(AL, {}), null, 'kutu kipinde kutu kenari sart')
  assert.equal(planKur(Object.assign({}, AL_KUTU, { price: 95 }), {}), null, 'giris SL altinda: kutu coktan kirilmis')
  assert.equal(planKur(AL_KUTU, { tpRr: 0 }), null)
})

test('plan seviyeleri (ATR kipi): SL ve TP ATR katlari, yon aynali', () => {
  const al = planKur(AL, { planMode: 'atr', slAtr: 1, tpAtr: 1 })
  assert.equal(al.mode, 'atr')
  assert.deepEqual({ entry: al.entry, sl: al.sl, tp: al.tp, rr: al.rr }, { entry: 100, sl: 98, tp: 102, rr: 1 })
  const sat = planKur(SAT, { planMode: 'atr', slAtr: 0.5, tpAtr: 1.5 })
  assert.equal(sat.sl, 101, 'SAT: SL yukarida, 0,5 ATR')
  assert.equal(sat.tp, 97, 'SAT: TP asagida, 1,5 ATR')
  assert.equal(sat.rr, 3)
  assert.deepEqual({ sl: DEFAULT_PLAN_CFG.slAtr, tp: DEFAULT_PLAN_CFG.tpAtr }, { sl: 1, tp: 1 }, 'varsayilan birebir')
})

test('plan kurulamaz: giris yok, ATR yok, mesafe sifir', () => {
  assert.equal(planKur({ direction: 'BUY', atr: 2 }, ATR_KIP), null)
  assert.equal(planKur(Object.assign({}, AL, { atr: 0 }), ATR_KIP), null)
  assert.equal(planKur(AL, { planMode: 'atr', slAtr: 0, tpAtr: 1 }), null)
  assert.equal(planKur(AL, { planMode: 'atr', slAtr: 1, tpAtr: -1 }), null)
  assert.equal(planKur(null, {}), null)
})

test('sonuc: hangisi once vurulursa o, ayni barda ikisi de vurulursa SL', () => {
  const plan = { sl: 98, tp: 102 }
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [101, 102.5, 100.5, 102]]), 0, plan, true, 200).result, 'tp')
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [99, 99.5, 97.5, 98]]), 0, plan, true, 200).result, 'sl')
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [100, 103, 97, 100]]), 0, plan, true, 200).result, 'sl')
  // Sinyal barinin kendisi SAYILMAZ.
  assert.equal(planCoz(seri([[100, 103, 97, 100], [100, 100.2, 99.8, 100]]), 0, plan, true, 200).result, 'open')
})

test('sonuc: seri bitince ACIK, ufuk dolunca SURE DOLDU', () => {
  const plan = { sl: 98, tp: 102 }
  const sakin = [[100, 100.2, 99.8, 100], [100, 100.2, 99.8, 100], [100, 100.2, 99.8, 100]]
  const acik = planCoz(seri(sakin), 0, plan, true, 200)
  assert.equal(acik.result, 'open')
  assert.equal(acik.resolvedTime, null)
  const dolu = planCoz(seri(sakin), 0, plan, true, 2)
  assert.equal(dolu.result, 'timeout')
  assert.equal(dolu.bars, 2)
})

test('SAT yonu aynali: SL yukarida, TP asagida', () => {
  const plan = { sl: 102, tp: 98 }
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [99, 99.5, 97.5, 98]]), 0, plan, false, 200).result, 'tp')
  assert.equal(planCoz(seri([[100, 100.5, 99.5, 100], [101, 102.5, 100.5, 102]]), 0, plan, false, 200).result, 'sl')
})

test('sinyaliPlanla: sinyali zamana gore bulur, plani takar (kip yazili), seri yoksa ACIK', () => {
  const s = seri([[100, 100.5, 99.5, 100], [101, 102.5, 100.5, 102]])
  const sig = Object.assign({}, AL)
  const plan = sinyaliPlanla(s, sig, { planMode: 'atr', slAtr: 1, tpAtr: 1, planHorizonBars: 200 })
  assert.equal(sig.plan, plan)
  assert.equal(plan.mode, 'atr')
  assert.equal(plan.result, 'tp')
  assert.equal(plan.resolvedTime, T0 + 60)
  assert.equal(sinyaliPlanla(null, Object.assign({}, AL_KUTU), {}).result, 'open')
  assert.equal(sinyaliPlanla(null, Object.assign({}, AL_KUTU), {}).mode, 'kutu')
  const atrsiz = Object.assign({}, AL, { atr: 0 })
  assert.equal(sinyaliPlanla(s, atrsiz, ATR_KIP), null)
  assert.equal(atrsiz.plan, null)
})

test('MESAFE DEGISINCE SONUC DEGISIR: TP 1 ATR vurulur, TP 3 ATR acik kalir', () => {
  const s = seri([[100, 100.5, 99.5, 100], [101, 102.5, 100.5, 102], [101, 102.5, 100.5, 102]])
  const dar = sinyaliPlanla(s, Object.assign({}, AL), { planMode: 'atr', slAtr: 1, tpAtr: 1 })
  const genis = sinyaliPlanla(s, Object.assign({}, AL), { planMode: 'atr', slAtr: 1, tpAtr: 3 })
  assert.equal(dar.result, 'tp')
  assert.equal(genis.result, 'open')
})
