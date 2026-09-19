'use strict'

// A12 - src/core/learn/signal.js testleri (CONTRACTS.md bolum 15 ve 21).

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  evaluateTouch, findCandidates, decideFromCandidates, DEFAULT_SIGNAL_CFG,
} = require('../src/core/learn/signal')
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
  // TP2 ya yok (null) ya da TP1'den BELIRGIN olarak uzaktir; artik TP1'e
  // esitlenmiyor (bkz. "TP2 uydurulmaz" testi).
  assert.ok(s.tp2 === null || s.tp2 > s.tp1, 'TP2 ya null ya TP1 otesinde olmali')
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
  assert.ok(s.tp2 === null || s.tp2 < s.tp1, 'SELL icin TP2 ya null ya TP1 otesinde olmali')
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

// S8 - Sekil kumeleri karara KATILMAZ.
//
// Olculdu: kumelerin basari orani hafiza tabanindan ayirt edilemiyor
// (15m'de sekiz kumenin orani %31,2 - %35,5, taban %33,4). Gerekce
// cumlesindeki "En yakin ortak yapi" satiri olmayan bir dayanak hissi
// veriyordu; bu test o satirin GERI GELMEMESINI kilitler.
test('prototip verilse bile karara ve gerekceye girmez', () => {
  const f = ozellik()
  const protos = [{
    id: 0, size: 30, winRate: 0.7, avgMfeAtr: 1.8, avgMaeAtr: 0.6,
    centroid: Float32Array.from(f.shape), label: 'Yukselen + kirilma', memberIds: [],
  }]
  const s = evaluateTouch(dokunus('BUY'), f, hafizaKur(10, 8, 'BUY'), protos, {}, null)
  // Alanlar uyumluluk icin duruyor, ama bos.
  assert.equal(s.prototypeId, null)
  assert.equal(s.prototypeSim, 0)
  assert.equal(s.prototypeLabel, '')
  assert.ok(!s.reasons.some((r) => r.includes('ortak yapı')),
    'gerekcede ortak yapi satiri olmamali')

  // Prototip verilmesi karari HIC degistirmemeli.
  const protosuz = evaluateTouch(dokunus('BUY'), f, hafizaKur(10, 8, 'BUY'), [], {}, null)
  assert.equal(s.fired, protosuz.fired)
  assert.equal(s.winRate, protosuz.winRate)
  assert.deepEqual(s.reasons, protosuz.reasons)
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
      assert.ok(s.tp2 === null || s.tp2 > s.tp1, d.ad + ': TP2 ya null ya TP1 otesinde')
    } else {
      assert.ok(s.tp1 < s.entry, d.ad + ': TP1 giristen asagida olmali')
      assert.ok(s.entry < s.sl, d.ad + ': giris stoptan asagida olmali')
      assert.ok(s.tp2 === null || s.tp2 < s.tp1, d.ad + ': TP2 ya null ya TP1 otesinde')
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

// ---------------------------------------------------------------------------
// A2 - IKI ADIMA AYRILMA: findCandidates + decideFromCandidates
// ---------------------------------------------------------------------------
// Ayrimin tek amaci esik taramasini hizlandirmaktir; bu yuzden ayrimin
// KARARI DEGISTIRMEDIGI kanitlanmali. Asagidaki testler bilesimin
// `evaluateTouch` ile birebir ayni nesneyi urettigini ve komsularin esikten
// bagimsiz oldugunu gosterir.

test('evaluateTouch, iki adimin BILESIMINDEN farkli bir sonuc uretmez', () => {
  const mem = hafizaKur(30, 20, 'BUY')
  const t = dokunus('BUY')
  const f = ozellik()
  const ayar = { minMatches: 5, minWinRate: 0.5, minExpectancy: -Infinity }
  const bt = T_SORGU

  const butun = evaluateTouch(t, f, mem, [], ayar, bt)
  const adaylar = findCandidates(t, f, mem, ayar, bt)
  const parcali = decideFromCandidates(t, adaylar, undefined, ayar, {
    features: f, prototypes: [], scanned: mem.events.length, beforeTime: bt,
  })
  assert.deepEqual(parcali, butun, 'iki yol ayni Signal nesnesini vermeli')
  assert.ok(butun.matchCount > 0, 'test bosluga bakmamali')
})

test('KOMSULAR esikten bagimsizdir: esik degisince aday listesi degismez', () => {
  const mem = hafizaKur(30, 20, 'BUY')
  const t = dokunus('BUY')
  const f = ozellik()

  const gevsek = findCandidates(t, f, mem, { minSimilarity: 0.1, minMatches: 1, minWinRate: 0 }, T_SORGU)
  const siki = findCandidates(t, f, mem, { minSimilarity: 0.99, minMatches: 30, minWinRate: 0.99 }, T_SORGU)
  assert.equal(siki.length, gevsek.length, 'esik komsu sayisini degistirmemeli')
  for (let i = 0; i < gevsek.length; i++) {
    assert.equal(siki[i].event, gevsek[i].event, i + '. aday ayni olay olmali')
    assert.equal(siki[i].similarity, gevsek[i].similarity, i + '. adayin benzerligi ayni olmali')
  }

  // Ayni aday listesi, farkli esiklerle farkli KARAR verir.
  const a = decideFromCandidates(t, gevsek, undefined, { minMatches: 5, minWinRate: 0.5, minExpectancy: -Infinity }, { features: f })
  const b = decideFromCandidates(t, gevsek, undefined, { minMatches: 500, minWinRate: 0.5 }, { features: f })
  assert.equal(a.fired, true)
  assert.equal(b.fired, false)
})

test('decideFromCandidates hafizaya erismez: bos aday listesinde sinyal uretmez', () => {
  const t = dokunus('BUY')
  const s = decideFromCandidates(t, [], undefined, { minMatches: 1 }, { features: ozellik(), scanned: 100 })
  assert.equal(s.fired, false)
  assert.equal(s.matchCount, 0)
  assert.ok(s.reasons.some((r) => r.includes('uygun aday bulunamadı')),
    'gerekce aday bulunamadigini soylemeli: ' + JSON.stringify(s.reasons))
  for (const r of s.reasons) assert.ok(!r.includes(EM_DASH), 'gerekcede em-dash olmamali')
})

test('decideFromCandidates cagiranin aday dizisini BOZMAZ', () => {
  const mem = hafizaKur(30, 20, 'BUY')
  const t = dokunus('BUY')
  const f = ozellik()
  const adaylar = findCandidates(t, f, mem, { minMatches: 5 }, T_SORGU)
  const kopya = adaylar.slice()
  decideFromCandidates(t, adaylar, undefined, { minMatches: 5 }, { features: f })
  assert.deepEqual(adaylar, kopya, 'aday dizisi yerinde siralanmamali')
})

// ---------------------------------------------------------------------------
// S7 - TP2 UYDURULMAZ, BEKLENEN HAREKET SONUCA KADARKI OLCUDEN GELIR
// ---------------------------------------------------------------------------

test('TP2 yalnizca TUTMUS komsulardan gelir, yetersiz ornekte null doner', () => {
  const esik = { minMatches: 3, minWinRate: 0.30 }
  // On kayit, yalnizca IKISI tutmus: TP2 icin gereken en az bes tutmus komsu
  // yok, dolayisiyla uzatma hedefi uretilmez.
  const azTutan = evaluateTouch(dokunus('BUY'), ozellik(), hafizaKur(10, 2, 'BUY'), [], esik, null)
  assert.equal(azTutan.tp2, null, 'iki tutmus komsu ile TP2 uretilmemeli')
  assert.equal(azTutan.tp2Atr, 0)
  assert.ok(azTutan.reasons.some((r) => r.includes('uzatma hedefi yok')),
    'gerekce TP2 olmadigini soylemeli')

  // Tutmus komsularin lehte hareketi RISK BIRIMININ cok uzerindeyse TP2 olusur
  // ve TP1'in otesinde olur.
  const uzakGiden = fixtures.hafizaKur({
    adet: 12, basarili: 10, yon: 'BUY', ilkZaman: T_SORGU - 200 * GUN,
    alanlar: (i, basarili) => (basarili ? { mfeExitAtr: 6, riskAtr: 1 } : {}),
  })
  const genis = evaluateTouch(dokunus('BUY'), ozellik(), uzakGiden, [], esik, null)
  assert.ok(genis.tp2 !== null, 'yeterli tutmus komsu varken TP2 uretilmeli')
  assert.ok(genis.tp2 > genis.tp1, 'TP2 TP1 otesinde olmali: ' + genis.tp2 + ' / ' + genis.tp1)
  assert.ok(genis.tp2Atr >= genis.tp1Atr * 1.1, 'TP2 en az TP1 x 1,1 olmali')
})

test('TP2, TP1 ile ayni fiyata ESITLENMEZ', () => {
  const esik = { minMatches: 3, minWinRate: 0.30 }
  // Tutmus komsularin lehte hareketi risk birimi kadar: TP2 adayi TP1'in
  // hemen ustune dusuyor, bu yuzden hic gosterilmemeli.
  const dar = fixtures.hafizaKur({
    adet: 12, basarili: 10, yon: 'BUY', ilkZaman: T_SORGU - 200 * GUN,
    alanlar: (i, basarili) => (basarili ? { mfeExitAtr: 1, riskAtr: 1 } : {}),
  })
  const s = evaluateTouch(dokunus('BUY'), ozellik(), dar, [], esik, null)
  assert.ok(s.tp2 === null || s.tp2 !== s.tp1, 'TP2 TP1 ile ayni fiyat olmamali')
})

test('beklenen lehte/aleyhte hareket SONUCA KADARKI olcuden gelir', () => {
  const esik = { minMatches: 3, minWinRate: 0.30 }
  // Ham mfeAtr tum ufku olcer (buyuk), mfeExitAtr sonuca kadar olani (kucuk).
  // Gosterilen sayi kucuk olani olmali; aksi halde ekranda ulasilamayacak bir
  // hedef gorunuyordu (15m'de TP1'in 2,5 kati).
  const mem = fixtures.hafizaKur({
    adet: 10, basarili: 8, yon: 'BUY', ilkZaman: T_SORGU - 200 * GUN,
    alanlar: () => ({ mfeAtr: 9, mfeExitAtr: 1.5, maeAtr: 4, maeExitAtr: 0.4 }),
  })
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], esik, null)
  assert.ok(Math.abs(s.expectedMfeAtr - 1.5) < 1e-9,
    'lehte hareket mfeExitAtr ortalamasi olmali: ' + s.expectedMfeAtr)
  assert.ok(Math.abs(s.expectedMaeAtr - 0.4) < 1e-9,
    'aleyhte hareket maeExitAtr ortalamasi olmali: ' + s.expectedMaeAtr)
  // Aleyhte hareket PLAN RISKI DEGILDIR; ikisi ayri sayidir. Plan riski bolge
  // geometrisinden gelir (burada 0,5 ATR), aleyhte hareket komsulardan.
  assert.notEqual(s.expectedMaeAtr, s.slAtr)

  // Eski hafizada alan yoksa ham degere dusulur.
  const eski = fixtures.hafizaKur({
    adet: 10, basarili: 8, yon: 'BUY', ilkZaman: T_SORGU - 200 * GUN,
    alanlar: () => ({ mfeAtr: 3, maeAtr: 2, mfeExitAtr: NaN, maeExitAtr: NaN }),
  })
  for (const ev of eski.events) { delete ev.mfeExitAtr; delete ev.maeExitAtr }
  const e = evaluateTouch(dokunus('BUY'), ozellik(), eski, [], esik, null)
  assert.ok(Math.abs(e.expectedMfeAtr - 3) < 1e-9, 'alan yoksa ham mfeAtr kullanilmali')
})

test('topMatches uc degerli sonucu ve sonuca kadarki hareketi tasir', () => {
  const esik = { minMatches: 3, minWinRate: 0.30 }
  const mem = fixtures.hafizaKur({
    adet: 9, basarili: 3, yon: 'BUY', ilkZaman: T_SORGU - 200 * GUN,
    // Ucu tuttu, ucu zaman asimi, ucu kirildi.
    alanlar: (i) => (i >= 3 && i < 6 ? { outcome: 'timeout', success: false } : {}),
  })
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], esik, null)
  const sonuclar = s.topMatches.map((m) => m.outcome)
  assert.ok(sonuclar.every((o) => typeof o === 'string' && o.length > 0),
    'her eslesme outcome tasimali: ' + JSON.stringify(sonuclar))
  assert.ok(sonuclar.includes('timeout'), 'zaman asimi ayri bir deger olarak gorunmeli')
  for (const m of s.topMatches) {
    assert.ok('mfeExitAtr' in m && 'maeExitAtr' in m,
      'eslesme sonuca kadarki hareket alanlarini tasimali')
  }
})

// ---------------------------------------------------------------------------
// S9 - ZAMAN AGIRLIGI (varsayilan KAPALI)
// ---------------------------------------------------------------------------

test('zaman agirligi kapaliyken davranis birebir ayni kalir', () => {
  const esik = { minMatches: 5, minWinRate: 0.30 }
  const mem = hafizaKur(20, 12, 'BUY')
  const kapali = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], esik, null)
  const acikAmaSifir = evaluateTouch(dokunus('BUY'), ozellik(), mem, [],
    Object.assign({}, esik, { halfLifeYears: 0 }), null)
  assert.equal(kapali.winRate, acikAmaSifir.winRate)
  assert.equal(kapali.winRateRaw, acikAmaSifir.winRateRaw)
  // Etkin orneklem, agirlik kapaliyken eslesme sayisina esittir.
  assert.equal(kapali.nEff, kapali.matchCount)
})

test('zaman agirligi: eski eslesmeler daha az agirlik alir, etkin orneklem duser', () => {
  const esik = { minMatches: 3, minWinRate: 0.30, halfLifeYears: 4 }
  const YIL = 365.25 * 86400
  // Iki eslesme: biri BUGUN kazandi, biri 4 YIL once kaybetti. Yariomur 4 yil
  // oldugu icin eski kaydin agirligi tam yarim olur, yani oran 1/(1+0,5) = 2/3.
  const mem = {
    tf: '15m',
    events: [
      // Zamanlar `excludeWithinSec` (varsayilan 3 gun) penceresinin DISINDA:
      // sorguya cok yakin kayitlar kendi kendine eslesmeyi onlemek icin elenir.
      fixtures.olay({ i: 0, basarili: false, yon: 'BUY', time: T_SORGU - 4 * YIL, features: ozellik() }),
      fixtures.olay({ i: 1, basarili: true, yon: 'BUY', time: T_SORGU - 10 * 86400, features: ozellik() }),
      fixtures.olay({ i: 2, basarili: true, yon: 'BUY', time: T_SORGU - 20 * 86400, features: ozellik() }),
    ],
  }
  const s = evaluateTouch(dokunus('BUY'), ozellik(), mem, [], esik, null)
  assert.equal(s.matchCount, 3)
  // Ham oran agirlikli: iki yeni kazanan (w~1) ve bir eski kaybeden (w=0,5).
  assert.ok(s.winRateRaw > 2 / 3 - 0.02 && s.winRateRaw < 0.82,
    'agirlikli oran 0,67 ile 0,82 arasinda olmali: ' + s.winRateRaw)
  // Etkin orneklem 3'ten KUCUK: agirliklar esit degil.
  assert.ok(s.nEff < 3 && s.nEff > 2, 'etkin orneklem 2 ile 3 arasinda olmali: ' + s.nEff)

  // Ayni hafiza, agirlik kapali: ham oran tam 2/3 (uc kayittan ikisi).
  const kapali = evaluateTouch(dokunus('BUY'), ozellik(), mem, [],
    Object.assign({}, esik, { halfLifeYears: null }), null)
  assert.ok(Math.abs(kapali.winRateRaw - 2 / 3) < 1e-9)
  assert.equal(kapali.nEff, 3)
  assert.ok(s.winRateRaw > kapali.winRateRaw,
    'eski kaybeden hafifledigi icin agirlikli oran daha yuksek olmali')
})
