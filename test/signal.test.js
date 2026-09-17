'use strict'

// A12 - src/core/learn/signal.js testleri (CONTRACTS.md bolum 15 ve 21).

const test = require('node:test')
const assert = require('node:assert/strict')

const { evaluateTouch, DEFAULT_SIGNAL_CFG } = require('../src/core/learn/signal')
const fixtures = require('./helpers/fixtures')

// Em-dash karakteri kodda yazilmaz, kod noktasindan uretilir.
const EM_DASH = String.fromCharCode(0x2014)
const GUN = fixtures.GUN
const T_SORGU = 1700000000

/** Sabit, varyansli ozellik vektoru (bkz. test/helpers/fixtures.js). */
function ozellik () {
  return fixtures.sabitOzellik()
}

/**
 * Sozlesmedeki tum alanlari tasiyan dokunus.
 * Kapanis (2000) bolgenin (1999 - 2001) ICINDEDIR, yani guncel giris modeli
 * ('afterClose') plan girisini KAPANISA koyar. Kenara limit emir konan durum
 * icin `dokunusLimit` kullanilir.
 */
function dokunus (yon) {
  return fixtures.dokunus({ id: 7, zoneId: 3, yon: yon, bar: 500, time: T_SORGU })
}

/** Kapanis kenarin lehte tarafinda: plan girisi bolge kenarina limit emir. */
function dokunusLimit (yon) {
  return fixtures.dokunus({
    id: 8, zoneId: 4, yon: yon, bar: 500, time: T_SORGU,
    // BUY'da kapanis ust kenarin uzerinde, SELL'de alt kenarin altinda.
    price: yon === 'BUY' ? 2002 : 1998,
    zoneTop: 2001, zoneBottom: 1999,
  })
}

/**
 * Sorguyla BIREBIR ayni ozellige sahip hafiza kayitlari uretir; boylece
 * benzerlik 1.0 olur ve esik davranisi net olcuulur.
 * Zamanlar 10 gun arayla, sorgudan cok once.
 */
function hafizaKur (adet, basariliAdet, yon) {
  return fixtures.hafizaKur({
    adet: adet,
    basarili: basariliAdet,
    yon: yon,
    ilkZaman: T_SORGU - adet * 10 * GUN,
  })
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
  for (const e of mem.events) e.features = fixtures.tersOzellik(q)
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

  // Plan girisi guncel giris modelinden gelir: kapanis bolgenin ICINDE
  // oldugu icin giris kapanistir. Kapanis `price` alaninda da korunur.
  assert.equal(s.price, t.price)
  assert.equal(s.entry, t.price, 'kapanis bolge icindeyken plan girisi kapanistir')
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

// ---------------------------------------------------------------------------
// GUVEN VE PLAN YONU
// ---------------------------------------------------------------------------

test('dusuk tutma oranli eslesme YUKSEK GUVEN almaz', () => {
  const esik = { minMatches: 5, minWinRate: 0.60 }
  // Ayni eslesme sayisi ve ayni benzerlik, yalnizca tutma orani farkli.
  const yazi = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(20, 10, 'BUY'), [], esik, null)
  const yuksek = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(20, 20, 'BUY'), [], esik, null)

  assert.ok(Math.abs(yazi.winRate - 0.5) < 1e-9, 'kurgu: tutma orani 0.50 olmali')
  assert.equal(yazi.fired, false, 'yazi tura kurulum sinyal uretmemeli')
  assert.ok(yazi.confidence < yuksek.confidence,
    'tutma orani dusukken guven daha yuksek cikmamali: ' + yazi.confidence + ' >= ' + yuksek.confidence)
  // Guven formulunun tutma orani terimi: 0.5 oraninda katkisi sifirdir.
  assert.ok(yazi.confidence <= 0.70,
    'yazi tura kurulumda guven yuksek gorunmemeli: ' + yazi.confidence)

  // Esigin hemen altindaki oran da yuksek guven vermemeli.
  const sinir = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(20, 11, 'BUY'), [], esik, null)
  assert.equal(sinir.fired, false)
  assert.ok(sinir.confidence < yuksek.confidence)
})

test('plan fiyatlari yon olarak dogru: BUY tp1 > entry > sl, SELL tersi', () => {
  const esik = { minMatches: 5, minWinRate: 0.60 }
  const durumlar = [
    { ad: 'BUY kapanis bolge icinde', t: dokunus('BUY'), yon: 'BUY' },
    { ad: 'BUY kenara limit emir', t: dokunusLimit('BUY'), yon: 'BUY' },
    { ad: 'SELL kapanis bolge icinde', t: dokunus('SELL'), yon: 'SELL' },
    { ad: 'SELL kenara limit emir', t: dokunusLimit('SELL'), yon: 'SELL' },
  ]
  for (const d of durumlar) {
    const s = evaluateTouch(d.t, ozellik(), hafizaKur(10, 9, d.yon), [], esik, null)
    assert.equal(s.fired, true, d.ad + ': sinyal beklenir')
    assert.equal(s.direction, d.yon)
    assert.ok(Number.isFinite(s.entry) && Number.isFinite(s.tp1) && Number.isFinite(s.sl))
    if (d.yon === 'BUY') {
      assert.ok(s.tp1 > s.entry, d.ad + ': TP1 giristen yukarida olmali')
      assert.ok(s.entry > s.sl, d.ad + ': giris stoptan yukarida olmali')
      assert.ok(s.tp2 >= s.tp1)
    } else {
      assert.ok(s.tp1 < s.entry, d.ad + ': TP1 giristen asagida olmali')
      assert.ok(s.entry < s.sl, d.ad + ': giris stoptan asagida olmali')
      assert.ok(s.tp2 <= s.tp1)
    }
    assert.ok(s.rr > 0, d.ad + ': risk/odul pozitif olmali')
    assert.ok(Math.abs(s.tp1Atr - Math.abs(s.tp1 - s.entry) / s.atr) < 1e-9)
    assert.ok(Math.abs(s.slAtr - Math.abs(s.entry - s.sl) / s.atr) < 1e-9)
  }
})

test('kenara limit emirde plan girisi bolgenin yakin kenaridir', () => {
  const esik = { minMatches: 5, minWinRate: 0.60 }
  const t = dokunusLimit('BUY')
  const s = evaluateTouch(t, ozellik(), hafizaKur(10, 9, 'BUY'), [], esik, null)
  assert.equal(s.entry, t.zoneTop, 'kapanis kenarin uzerindeyse giris kenara konur')
  assert.equal(s.price, t.price, 'olay barinin kapanisi price alaninda korunur')
})

// ---------------------------------------------------------------------------
// SONUC DAGILIMI VE BEKLENEN DEGER
// ---------------------------------------------------------------------------

test('dolmayan limit emirler (nofill) orana ve plana GIRMEZ', () => {
  const mem = hafizaKur(20, 20, 'BUY')
  // Yarisini "emir hic dolmadi" yap: bunlar ne kazanc ne kayiptir.
  for (let i = 0; i < 10; i++) {
    mem.events[i].outcome = 'nofill'
    mem.events[i].success = false
    mem.events[i].filled = false
    mem.events[i].realizedR = 0
  }
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], { minMatches: 5, minWinRate: 0.60 }, null)
  assert.equal(s.matchCount, 10, 'yalnizca dolan emirler eslesme sayilir')
  assert.equal(s.winRate, 1, 'nofill kayitlari orani bozmamali')
  for (const m of s.topMatches) {
    const ev = mem.events.find((e) => e.id === m.id)
    assert.notEqual(ev.outcome, 'nofill', 'nofill kaydi eslesme listesine girmis')
  }
})

test('sonuc dagilimi alanlari doludur ve toplami 1 olur', () => {
  const mem = hafizaKur(30, 10, 'BUY')
  // 10 tutma, 10 kirilma, 10 zaman asimi.
  for (let i = 10; i < 20; i++) {
    mem.events[i].outcome = 'break'
    mem.events[i].success = false
    mem.events[i].realizedR = -1
  }
  for (let i = 20; i < 30; i++) {
    mem.events[i].outcome = 'timeout'
    mem.events[i].success = false
    mem.events[i].realizedR = 0.2
  }
  // k varsayilani 25, otuz kaydin tamami degerlendirilsin diye acikca verilir.
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], { k: 40, minMatches: 5, minWinRate: 0.30 }, null)
  assert.equal(s.matchCount, 30)
  assert.ok(Math.abs(s.respectRate - 1 / 3) < 1e-9)
  assert.ok(Math.abs(s.breakRate - 1 / 3) < 1e-9)
  assert.ok(Math.abs(s.timeoutRate - 1 / 3) < 1e-9)
  assert.ok(Math.abs(s.respectRate + s.breakRate + s.timeoutRate - 1) < 1e-12)
  assert.ok(Math.abs(s.timeoutAvgR - 0.2) < 1e-9, 'zaman asimlarinin ortalama R degeri')

  // Beklenen deger: pR * rr - pB + pT * mT
  const beklenen = s.respectRate * s.rr - s.breakRate + s.timeoutRate * s.timeoutAvgR
  assert.ok(Math.abs(s.expectancy - beklenen) < 1e-9, 'beklenti formulu: ' + s.expectancy)
})

test('zaman asimi TAM ZARAR sayilmaz: beklenti eski formulden yuksek cikar', () => {
  // Tum eslesmeler zaman asimi ve ufuk sonunda hafif lehte kapanmis.
  const mem = hafizaKur(20, 0, 'BUY')
  for (const e of mem.events) {
    e.outcome = 'timeout'
    e.success = false
    e.realizedR = 0.1
  }
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], { minMatches: 5, minWinRate: 0 }, null)
  assert.equal(s.matchCount, 20)
  assert.equal(s.winRate, 0)
  // Eski formul: winRate * rr - (1 - winRate) = -1
  assert.ok(Math.abs(s.expectancy - 0.1) < 1e-9, 'beklenti zaman asimi R ortalamasi olmali: ' + s.expectancy)
  assert.ok(s.expectancy > -1, 'zaman asimi tam zarar yazilmamali')
})
