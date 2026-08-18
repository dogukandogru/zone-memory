'use strict'

// A12 - src/core/learn/signal.js testleri (CONTRACTS.md bolum 15 ve 21).

const test = require('node:test')
const assert = require('node:assert/strict')

const { evaluateTouch, DEFAULT_SIGNAL_CFG } = require('../src/core/learn/signal')

// Em-dash karakteri kodda yazilmaz, kod noktasindan uretilir.
const EM_DASH = String.fromCharCode(0x2014)
const GUN = 86400
const T_SORGU = 1700000000

/** Sabit, varyansli ozellik vektoru. */
function ozellik () {
  const shape = new Float32Array(16)
  for (let i = 0; i < 16; i++) shape[i] = Math.sin(i / 2.5) * 0.5 + 0.5
  const ret = new Float32Array(32)
  for (let i = 0; i < 32; i++) ret[i] = Math.sin(i / 3)
  const ctx = new Float32Array(22)
  for (let i = 0; i < 22; i++) ctx[i] = (i % 5) / 4
  return { shape, ret, ctx }
}

/** Sozlesmedeki tum alanlari tasiyan dokunus. */
function dokunus (yon) {
  return {
    id: 7, zoneId: 3, isSupport: yon === 'BUY', direction: yon,
    bar: 500, time: T_SORGU, price: 2000,
    zoneTop: 2001, zoneBottom: 1999, zoneFlow: 2.5,
    zoneAgeBars: 25, penetration: 0.5, atr: 4,
    score: 5, maxScore: 8, qualified: true, strong: false, session: 'London',
    parts: { flow: true, trend: true, volatility: true, session: true, sweep: false, rejection: false, mss: false, fvg: false },
  }
}

/**
 * Sorguyla BIREBIR ayni ozellige sahip hafiza kayitlari uretir; boylece
 * benzerlik 1.0 olur ve esik davranisi net olcuulur.
 * Zamanlar 10 gun arayla, sorgudan cok once.
 */
function hafizaKur (adet, basariliAdet, yon) {
  const events = []
  for (let i = 0; i < adet; i++) {
    const basarili = i < basariliAdet
    events.push({
      id: i,
      time: T_SORGU - (adet - i) * 10 * GUN,
      direction: yon,
      price: 1900 + i,
      atr: 4,
      outcome: basarili ? 'respect' : 'break',
      success: basarili,
      mfeAtr: basarili ? 2 : 0.2,
      maeAtr: basarili ? 0.3 : 1.2,
      features: ozellik(),
    })
  }
  return { tf: '15m', ctxNames: [], events }
}

test('DEFAULT_SIGNAL_CFG sozlesmedeki alanlari birebir tasir', () => {
  // Sozlesme bolum 15'teki alanlar dogrulanir. Uygulama bunlara EK alanlar
  // (useZoneStop, outcomeCfg, minRr, minExpectancy) ekledi; ek alanlar
  // sozlesmeyi bozmaz, eksik alan bozar.
  //
  // minMatches ve minWinRate degerleri sozlesmedeki ilk tahminden (5 / 0.60)
  // gercek veriyle yapilan ornek disi taramaya gore guncellendi (15 / 0.62).
  // Gerekce signal.js basindaki yorumda ve README'de.
  const sozlesme = {
    k: 25, minSimilarity: 0.80, minMatches: 15, minWinRate: 0.62,
    excludeWithinSec: 86400 * 3,
    tp1Pct: 40, tp2Pct: 70, slPct: 75,
  }
  for (const ad of Object.keys(sozlesme)) {
    assert.equal(DEFAULT_SIGNAL_CFG[ad], sozlesme[ad], ad + ' sozlesmedeki degerde olmali')
  }
  assert.deepEqual(DEFAULT_SIGNAL_CFG.weights, { shape: 0.60, ctx: 0.25, dtw: 0.15 })
})

test('hafiza bossa fired false ve gerekce dolu', () => {
  const s = evaluateTouch(dokunus('BUY'), ozellik(), { events: [] }, [], {}, null)
  assert.equal(s.fired, false)
  assert.equal(s.matchCount, 0)
  assert.equal(s.winRate, 0)
  assert.ok(Array.isArray(s.reasons) && s.reasons.length > 0, 'reasons her zaman dolu olmali')
  assert.ok(s.reasons.some((r) => r.includes('Hafıza')), 'hafiza bos gerekcesi bulunmali')
})

test('ozellik vektoru yoksa fired false ve gerekce acik', () => {
  const s = evaluateTouch(dokunus('BUY'), null, hafizaKur(20, 20, 'BUY'), [], {}, null)
  assert.equal(s.fired, false)
  assert.ok(s.reasons.some((r) => r.includes('Özellik')), 'ozellik vektoru gerekcesi bulunmali')
})

test('eslesme sayisi esigin ALTINDA ise fired false', () => {
  // 3 kayit var, minMatches 5.
  const s = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(3, 3, 'BUY'), [], {}, null)
  assert.equal(s.matchCount, 3)
  assert.equal(s.winRate, 1)
  assert.equal(s.fired, false, 'yeterli eslesme yokken sinyal uretilmemeli')
  assert.ok(s.reasons.some((r) => r.includes('Yeterli benzer kayıt yok')))
})

test('basari orani esigin ALTINDA ise fired false', () => {
  // 10 kayit, 3 basarili -> winRate 0.30 < 0.60
  const s = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(10, 3, 'BUY'), [], {}, null)
  assert.equal(s.matchCount, 10)
  assert.ok(Math.abs(s.winRate - 0.3) < 1e-9)
  assert.equal(s.fired, false)
  assert.ok(s.reasons.some((r) => r.includes('Başarı oranı yetersiz')))
})

test('benzerlik esigini gecemeyen kayitlar plana girmez', () => {
  // Hafiza kayitlarini sorgunun tam tersi yap: sekil korelasyonu -1, baglam
  // kosinusu -1 olur ve birlesik skor esigin (0.80) cok altinda kalir.
  const q = ozellik()
  const mem = hafizaKur(20, 20, 'BUY')
  for (const e of mem.events) {
    const shape = new Float32Array(16)
    const ret = new Float32Array(32)
    const ctx = new Float32Array(22)
    for (let i = 0; i < 16; i++) shape[i] = 1 - q.shape[i]
    for (let i = 0; i < 32; i++) ret[i] = -q.ret[i] * 20
    for (let i = 0; i < 22; i++) ctx[i] = -q.ctx[i]
    e.features = { shape, ret, ctx }
  }
  const s = evaluateTouch(dokunus('BUY'), q, mem, [], {}, null)
  assert.ok(s.bestSimilarity < 0.8, 'en iyi benzerlik esigin altinda olmali: ' + s.bestSimilarity)
  assert.equal(s.matchCount, 0)
  assert.equal(s.fired, false)
  assert.ok(s.reasons.some((r) => r.includes('Benzerlik eşiğini')))
})

test('BUY: tum esikler gecilince fired true ve plan yonu tp1 > entry > sl', () => {
  const t = dokunus('BUY')
  // Esikler acikca verilir: varsayilanlar (minMatches 15) gercek veriye gore
  // secildi, bu test ise 10 kayitlik sentetik hafizayla mekanigi dogruluyor.
  const esik = { minMatches: 5, minWinRate: 0.60 }
  const s = evaluateTouch(t, ozellik(), hafizaKur(10, 8, 'BUY'), [], esik, null)

  assert.equal(s.fired, true)
  assert.equal(s.direction, 'BUY')
  assert.equal(s.matchCount, 10)
  assert.ok(Math.abs(s.winRate - 0.8) < 1e-9)
  assert.ok(s.avgSimilarity > 0.99, 'birebir ayni ozelliklerde benzerlik 1 olmali: ' + s.avgSimilarity)
  assert.ok(s.bestSimilarity > 0.99)

  // Plan girisi bolge KENARIDIR (destekte zoneTop), dokunus barinin kapanisi
  // degil. Kapanis `price` alaninda korunur.
  assert.equal(s.price, t.price)
  assert.equal(s.entry, t.zoneTop, 'BUY icin plan girisi bolgenin ust kenari')
  assert.ok(s.tp1 > s.entry, 'BUY icin TP1 giristen yukarida olmali')
  assert.ok(s.tp2 >= s.tp1, 'TP2 TP1 ile ayni veya daha uzak olmali')
  assert.ok(s.sl < s.entry, 'BUY icin SL giristen asagida olmali')
  assert.ok(s.rr > 0)
  assert.ok(s.confidence >= 0 && s.confidence <= 1)
  assert.ok(s.expectedMfeAtr > 0)
  assert.ok(Array.isArray(s.topMatches) && s.topMatches.length > 0)
  assert.ok(s.reasons.length > 0)
})

test('SELL: plan yonu tersine doner, tp1 < entry < sl', () => {
  const t = dokunus('SELL')
  const esik = { minMatches: 5, minWinRate: 0.60 }
  const s = evaluateTouch(t, ozellik(), hafizaKur(10, 8, 'SELL'), [], esik, null)

  assert.equal(s.fired, true)
  assert.equal(s.direction, 'SELL')
  assert.ok(s.tp1 < s.entry, 'SELL icin TP1 giristen asagida olmali')
  assert.ok(s.tp2 <= s.tp1, 'SELL icin TP2 TP1 ile ayni veya daha asagida olmali')
  assert.ok(s.sl > s.entry, 'SELL icin SL giristen yukarida olmali')
  assert.ok(s.rr > 0)
})

test('SL carpani en az 0.3 ATR olacak sekilde tabanlanir', () => {
  const t = dokunus('BUY')
  // Hafiza tarafinda MAE cok kucuk olsun; taban yine de devreye girmeli.
  // useZoneStop kapatilinca plan MAE yuzdeliginden turetilir (sozlesme kurali).
  const mem = hafizaKur(10, 10, 'BUY')
  for (const e of mem.events) e.maeAtr = 0.01
  const s = evaluateTouch(t, ozellik(), mem, [], { useZoneStop: false }, null)
  const slAtr = Math.abs(s.entry - s.sl) / t.atr
  assert.ok(slAtr >= 0.3 - 1e-9, 'SL en az 0.3 ATR olmali, olculen: ' + slAtr)
  assert.ok(s.sl < s.entry, 'BUY icin SL giristen asagida olmali')
})

test('SAPMA NOTU: varsayilan stop bolgenin gecersizlik seviyesinden alinir', () => {
  // Sozlesme bolum 15 stop icin maeAtr yuzdeligini tarif ediyor; uygulama
  // varsayilan olarak (useZoneStop: true) bolge gecersizlik seviyesini
  // kullaniyor. Bu test mevcut davranisi kayit altina alir.
  const t = dokunus('BUY')
  const mem = hafizaKur(10, 8, 'BUY')
  const zonlu = evaluateTouch(t, ozellik(), mem, [], {}, null)
  const yuzdelikli = evaluateTouch(t, ozellik(), mem, [], { useZoneStop: false }, null)

  // Bolge alt kenari 1999, tampon 0.25 ATR (ATR 4) -> 1998
  assert.ok(Math.abs(zonlu.sl - 1998) < 1e-9, 'stop bolge gecersizlik seviyesinde olmali: ' + zonlu.sl)
  assert.notEqual(zonlu.sl, yuzdelikli.sl, 'iki yol farkli stop uretmeli')
  assert.ok(zonlu.sl < zonlu.entry && yuzdelikli.sl < yuzdelikli.entry)
})

test('yon filtresi: ters yondeki kayitlar eslesmeye girmez', () => {
  const s = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(10, 10, 'SELL'), [], {}, null)
  assert.equal(s.matchCount, 0)
  assert.equal(s.fired, false)
})

test('beforeTime verilince yalnizca oncesindeki kayitlar kullanilir', () => {
  const mem = hafizaKur(20, 20, 'BUY')
  const kesim = mem.events[10].time
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], {}, kesim)
  assert.equal(s.matchCount, 10, 'kesimden onceki 10 kayit kullanilmali')
  for (const m of s.topMatches) {
    assert.ok(m.time < kesim, 'gelecekteki kayit sinyale girmis: ' + m.time)
  }
  assert.ok(s.reasons.some((r) => r.includes('ileriye bakma yok')))
})

test('excludeWithinSec: sorguya cok yakin kayitlar elenir', () => {
  const mem = hafizaKur(10, 10, 'BUY')
  // Tum kayitlari sorgu zamaninin 1 gun oncesine tasi.
  for (const e of mem.events) e.time = T_SORGU - GUN
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], {}, null)
  assert.equal(s.matchCount, 0, '3 gunluk komsu dislama icindeki kayitlar elenmeli')
  assert.equal(s.fired, false)
})

test('Signal nesnesi sozlesmedeki tum alanlari tasir', () => {
  const s = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(10, 8, 'BUY'), [], {}, null)
  const alanlar = [
    'id', 'fired', 'time', 'bar', 'direction', 'price', 'zoneTop', 'zoneBottom',
    'matchCount', 'avgSimilarity', 'bestSimilarity', 'winRate', 'confidence',
    'expectedMfeAtr', 'expectedMaeAtr', 'entry', 'tp1', 'tp2', 'sl', 'rr',
    'prototypeId', 'prototypeSim', 'prototypeLabel', 'topMatches', 'reasons',
  ]
  for (const ad of alanlar) {
    assert.ok(ad in s, 'Signal alani eksik: ' + ad)
  }
  assert.equal(typeof s.id, 'string')
  assert.equal(typeof s.fired, 'boolean')
  assert.equal(s.prototypeId, null, 'prototip listesi bossa null olmali')
  assert.equal(typeof s.prototypeLabel, 'string')
  for (const m of s.topMatches) {
    for (const ad of ['id', 'time', 'similarity', 'success', 'mfeAtr', 'maeAtr', 'price']) {
      assert.ok(ad in m, 'topMatches alani eksik: ' + ad)
    }
  }
})

test('prototip verilirse eslesme bilgisi doldurulur', () => {
  const f = ozellik()
  const protos = [{
    id: 0, size: 30, winRate: 0.7, avgMfeAtr: 1.8, avgMaeAtr: 0.6,
    centroid: Float32Array.from(f.shape), label: 'Yukselen + genis + kirilma', memberIds: [],
  }]
  const s = evaluateTouch(dokunus('BUY'), f, hafizaKur(10, 8, 'BUY'), protos, {}, null)
  assert.equal(s.prototypeId, 0)
  assert.ok(s.prototypeSim > 0.99)
  assert.equal(s.prototypeLabel, 'Yukselen + genis + kirilma')
  assert.ok(s.reasons.some((r) => r.includes('ortak yapı')))
})

test('reasons metinlerinde em-dash kullanilmaz', () => {
  const durumlar = [
    evaluateTouch(dokunus('BUY'), ozellik(), { events: [] }, [], {}, null),
    evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(3, 3, 'BUY'), [], {}, null),
    evaluateTouch(dokunus('SELL'), ozellik(), hafizaKur(10, 8, 'SELL'), [], {}, null),
  ]
  for (const s of durumlar) {
    for (const r of s.reasons) {
      assert.equal(r.includes(EM_DASH), false, 'em-dash bulundu: ' + r)
    }
  }
})

test('confidence 0..1 arasinda kirpilir', () => {
  const uc = [hafizaKur(1, 1, 'BUY'), hafizaKur(10, 0, 'BUY'), hafizaKur(30, 30, 'BUY')]
  for (const mem of uc) {
    const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], {}, null)
    assert.ok(s.confidence >= 0 && s.confidence <= 1, 'confidence disari tasti: ' + s.confidence)
  }
})
