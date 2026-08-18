'use strict'

// A12 - src/core/learn/backtest.js testleri (CONTRACTS.md bolum 16 ve 21).
//
// Kritik test: yuruyen ileri testte GELECEKTEKI kayitlar kullanilmamalidir.
// Ispat yontemi: tum olaylarin ozellik vektoru birebir aynidir, dolayisiyla
// benzerlik her zaman 1.0'dir ve sinyalin ONGORDUGU winRate, o ana kadar
// gormus oldugu kayitlarin basari oranina esittir. Basarililari basa,
// basarisizlari sona koyarsak beklenen winRate zamanla DUSER. Ileriye bakma
// olsaydi bu oran bastan itibaren butun hafizanin ortalamasi cikardi.

const test = require('node:test')
const assert = require('node:assert/strict')

const { runBacktest, DEFAULT_BACKTEST_CFG } = require('../src/core/learn/backtest')

const GUN = 86400
const T0 = 1500000000

/** Tum olaylarda ayni ozellik vektoru: benzerlik daima 1.0. */
function ozellik () {
  const shape = new Float32Array(16)
  for (let i = 0; i < 16; i++) shape[i] = Math.sin(i / 2.5) * 0.5 + 0.5
  const ret = new Float32Array(32)
  for (let i = 0; i < 32; i++) ret[i] = Math.sin(i / 3)
  const ctx = new Float32Array(22)
  for (let i = 0; i < 22; i++) ctx[i] = (i % 5) / 4
  return { shape, ret, ctx }
}

/**
 * n olay uretir; ilk basariliAdet tanesi basarili, kalani basarisiz.
 * Olaylar 10 gun arayla, komsu dislama penceresinin (3 gun) disinda.
 */
function hafizaKur (n, basariliAdet) {
  const events = new Array(n)
  for (let i = 0; i < n; i++) {
    const basarili = i < basariliAdet
    events[i] = {
      id: i,
      zoneId: i,
      isSupport: true,
      direction: 'BUY',
      bar: 1000 + i,
      time: T0 + i * 10 * GUN,
      price: 2000,
      zoneTop: 2001,
      zoneBottom: 1999,
      zoneFlow: 2.5,
      zoneAgeBars: 20,
      penetration: 0.5,
      atr: 4,
      score: 5,
      maxScore: 8,
      qualified: true,
      strong: false,
      session: 'London',
      parts: { flow: true, trend: true, volatility: true, session: true, sweep: false, rejection: false, mss: false, fvg: false },
      outcome: basarili ? 'respect' : 'break',
      success: basarili,
      mfeAtr: basarili ? 2.5 : 0.2,
      maeAtr: basarili ? 0.3 : 1.2,
      fwdReturnPct: basarili ? 1 : -1,
      barsToOutcome: 20,
      features: ozellik(),
    }
  }
  return { tf: '15m', ctxNames: [], events }
}

// Esikler acikca dusuruldu: uygulamanin varsayilanlari (minMatches 15,
// minWinRate 0.62) gercek veriye gore secildi, bu testler ise onlarca kayitlik
// sentetik hafizayla yuruyen ileri testin MEKANIGINI dogruluyor.
const CFG = {
  warmupEvents: 5,
  embargoSec: 0,
  signalCfg: { minMatches: 3, minWinRate: 0.55, minExpectancy: -Infinity, minRr: 0 },
}

test('bos hafizada guvenli sonuc dondurur', () => {
  const r = runBacktest({ events: [] }, [], CFG)
  assert.deepEqual(r.trades, [])
  assert.deepEqual(r.equity, [])
  assert.deepEqual(r.byYear, [])
  assert.equal(r.summary.total, 0)
  assert.equal(r.summary.fired, 0)
})

test('YURUYEN ILERI TEST: gelecekteki kayitlar kullanilmaz', () => {
  // 20 basarili + 20 basarisiz. Ileriye bakma olsaydi her olayda ongorulen
  // basari orani ~0.50 cikardi.
  const mem = hafizaKur(40, 20)
  const r = runBacktest(mem, [], CFG)

  const islemler = new Map()
  for (const t of r.trades) islemler.set(t.eventId, t)

  // 10. olay: kendinden onceki 10 kayit (0..9) tamami basarili.
  const on = islemler.get(10)
  assert.ok(on, '10. olay icin islem uretilmeliydi')
  assert.equal(on.matchCount, 10, 'yalnizca kendinden onceki 10 kayit aday olmali')
  assert.equal(on.winRate, 1, 'gecmisi tamamen basariliyken ongoru 1.0 olmali')

  // 15. olay: 15 gecmis kaydin tamami basarili.
  const onbes = islemler.get(15)
  assert.ok(onbes)
  assert.equal(onbes.matchCount, 15)
  assert.equal(onbes.winRate, 1)

  // 25. olay: gecmiste 20 basarili + 5 basarisiz var. k = 25 oldugu icin
  // eslesme sayisi 25'te tavan yapar ve ongoru 20/25 = 0.80 olur.
  const yirmiBes = islemler.get(25)
  assert.ok(yirmiBes)
  assert.equal(yirmiBes.matchCount, 25)
  assert.ok(Math.abs(yirmiBes.winRate - 0.8) < 1e-9,
    'ongorulen basari orani gecmisten gelmeli, gelen: ' + yirmiBes.winRate)

  // Ilk 5 olay isinmadir, islem uretmemelidir.
  for (let i = 0; i < 5; i++) {
    assert.equal(islemler.has(i), false, i + '. olay isinmada oldugu icin islem uretmemeli')
  }
  assert.equal(r.summary.total, 35, 'isinma disindaki tum olaylar degerlendirilmeli')
})

test('islem uretilen her olayin eslesmeleri KENDINDEN ONCE gerceklesmis olmali', () => {
  const mem = hafizaKur(40, 20)
  const r = runBacktest(mem, [], CFG)
  assert.ok(r.trades.length > 0)

  const zamanlar = mem.events.map((e) => e.time)
  for (const t of r.trades) {
    // Aday havuzu, olay zamanindan KESIN once biten kayitlarla sinirlidir.
    const gecmisSayisi = zamanlar.filter((z) => z < t.time).length
    assert.ok(t.matchCount <= gecmisSayisi,
      'eslesme sayisi gecmis kayit sayisini asamaz: ' + t.matchCount + ' > ' + gecmisSayisi)
  }
})

test('ambargo penceresi eslesme havuzunu daraltir', () => {
  const mem = hafizaKur(40, 40)
  const ambargosuz = runBacktest(mem, [], Object.assign({}, CFG, { embargoSec: 0 }))
  const ambargolu = runBacktest(mem, [], Object.assign({}, CFG, { embargoSec: 25 * GUN }))

  const a = new Map(ambargosuz.trades.map((t) => [t.eventId, t]))
  const b = new Map(ambargolu.trades.map((t) => [t.eventId, t]))
  const x = a.get(10)
  const y = b.get(10)
  assert.ok(x && y)
  assert.equal(x.matchCount, 10)
  // 25 gunluk ambargo, 10 gun arayla gelen son 2 kaydi eler.
  assert.equal(y.matchCount, 8, 'ambargo icindeki kayitlar aday olmamali')
  assert.equal(ambargolu.summary.embargoSec, 25 * GUN)
})

test('esikler saglanmayinca islem acilmaz', () => {
  // Tum kayitlar basarisiz -> ongorulen basari orani 0, minWinRate 0.60.
  const mem = hafizaKur(40, 0)
  const r = runBacktest(mem, [], CFG)
  assert.equal(r.trades.length, 0)
  assert.equal(r.summary.fired, 0)
  assert.equal(r.summary.winRate, 0)
  assert.ok(r.summary.total > 0)
})

test('summary alanlari ve baz cizgi hesabi', () => {
  const mem = hafizaKur(40, 30)
  const r = runBacktest(mem, [], CFG)
  const s = r.summary

  for (const ad of ['total', 'fired', 'wins', 'losses', 'winRate', 'expectancyAtr',
    'profitFactor', 'maxDrawdownAtr', 'avgRr', 'baselineWinRate']) {
    assert.ok(ad in s, 'summary alani eksik: ' + ad)
  }
  assert.equal(s.wins + s.losses, s.fired)
  assert.ok(s.winRate >= 0 && s.winRate <= 1)
  assert.ok(s.maxDrawdownAtr >= 0)
  // Baz cizgi: tum etiketlenmis olaylarin ham basari orani, 30/40.
  assert.ok(Math.abs(s.baselineWinRate - 0.75) < 1e-9, 'baselineWinRate 0.75 olmali: ' + s.baselineWinRate)
})

test('equity birikimli toplamdir ve islem sayisiyla ayni uzunluktadir', () => {
  const mem = hafizaKur(40, 30)
  const r = runBacktest(mem, [], CFG)
  assert.equal(r.equity.length, r.trades.length)

  let birikim = 0
  for (let i = 0; i < r.trades.length; i++) {
    birikim += r.trades[i].pnlAtr
    assert.ok(Math.abs(r.equity[i].value - birikim) < 1e-9, i + '. adimda sermaye egrisi tutmuyor')
    assert.equal(r.equity[i].time, r.trades[i].time)
    assert.ok(Math.abs(r.trades[i].equityAtr - birikim) < 1e-9)
    if (i > 0) assert.ok(r.equity[i].time >= r.equity[i - 1].time, 'sermaye egrisi zaman sirali olmali')
  }
})

test('byYear kirilimi yila gore sirali ve toplamlari tutarli', () => {
  const mem = hafizaKur(60, 45)
  const r = runBacktest(mem, [], CFG)
  let toplamFired = 0
  for (let i = 0; i < r.byYear.length; i++) {
    const y = r.byYear[i]
    assert.equal(y.wins + y.losses, y.fired)
    assert.ok(y.winRate >= 0 && y.winRate <= 1)
    if (i > 0) assert.ok(r.byYear[i - 1].year < y.year, 'yillar artan sirali olmali')
    toplamFired += y.fired
  }
  assert.equal(toplamFired, r.summary.fired)
})

test('trades alanlari sozlesmedeki plan ile tutarli', () => {
  const mem = hafizaKur(40, 30)
  const r = runBacktest(mem, [], CFG)
  assert.ok(r.trades.length > 0)
  for (const t of r.trades) {
    assert.equal(t.direction, 'BUY')
    assert.ok(t.tp1 > t.entry, 'BUY icin TP1 giristen yukarida olmali')
    assert.ok(t.sl < t.entry, 'BUY icin SL giristen asagida olmali')
    assert.ok(t.tp1Atr > 0 && t.slAtr > 0)
    assert.ok(Math.abs(t.tp1Atr - Math.abs(t.tp1 - t.entry) / t.atr) < 1e-9)
    assert.ok(Math.abs(t.slAtr - Math.abs(t.entry - t.sl) / t.atr) < 1e-9)
    // Brut sonuc plandan gelir, net sonuc brutten islem maliyeti dusulerek.
    assert.equal(t.grossAtr, t.win ? t.tp1Atr : -t.slAtr)
    assert.ok(Math.abs(t.pnlAtr - (t.grossAtr - t.costAtr)) < 1e-12)
    assert.ok(t.costAtr >= 0)
    assert.equal(typeof t.win, 'boolean')
    assert.ok(['respect', 'break', 'timeout'].includes(t.outcome))
  }
})

test('islem maliyeti brut sonuctan dusulur ve ozette raporlanir', () => {
  const mem = hafizaKur(40, 30)
  const maliyetsiz = runBacktest(mem, [], Object.assign({}, CFG, { costUsd: 0, costPct: 0 }))
  const maliyetli = runBacktest(mem, [], Object.assign({}, CFG, { costUsd: 1, costPct: 0 }))

  assert.equal(maliyetsiz.summary.fired, maliyetli.summary.fired,
    'maliyet sinyal secimini DEGISTIRMEZ, yalnizca sonucu etkiler')
  assert.equal(maliyetsiz.summary.winRate, maliyetli.summary.winRate,
    'isabet orani maliyetten bagimsizdir')

  assert.equal(maliyetsiz.summary.costTotalAtr, 0)
  assert.ok(maliyetli.summary.costTotalAtr > 0)
  assert.ok(maliyetli.summary.expectancyAtr < maliyetsiz.summary.expectancyAtr,
    'maliyet beklentiyi dusurmeli')

  // Brut beklenti iki kosuda da ayni olmali.
  assert.ok(Math.abs(maliyetli.summary.grossExpectancyAtr - maliyetsiz.summary.grossExpectancyAtr) < 1e-12)

  // Net = brut - maliyet.
  const s = maliyetli.summary
  assert.ok(Math.abs(s.expectancyAtr - (s.grossExpectancyAtr - s.costPerTradeAtr)) < 1e-12)

  // Sentetik hafizada ATR 4 ve maliyet 1 dolar -> islem basina 0.25 ATR.
  assert.ok(Math.abs(s.costPerTradeAtr - 0.25) < 1e-9, 'maliyet ATR birimine cevrilmeli')
})

test('negatif veya gecersiz maliyet sifira cekilir', () => {
  const mem = hafizaKur(40, 30)
  const a = runBacktest(mem, [], Object.assign({}, CFG, { costUsd: -5, costPct: 0 }))
  const b = runBacktest(mem, [], Object.assign({}, CFG, { costUsd: 0, costPct: 0 }))
  assert.equal(a.summary.costTotalAtr, 0)
  assert.equal(a.summary.expectancyAtr, b.summary.expectancyAtr)
})

test('onProgress 0..100 arasi degerlerle cagrilir', () => {
  const mem = hafizaKur(40, 30)
  const cagrilar = []
  runBacktest(mem, [], CFG, (pct, msg) => {
    cagrilar.push(pct)
    assert.equal(typeof msg, 'string')
    assert.ok(pct >= 0 && pct <= 100, 'yuzde disari tasti: ' + pct)
  })
  assert.ok(cagrilar.length > 0)
  assert.equal(cagrilar[cagrilar.length - 1], 100)
})

test('DEFAULT_BACKTEST_CFG makul varsayilanlar tasir', () => {
  assert.ok(DEFAULT_BACKTEST_CFG.warmupEvents >= 0)
  assert.ok(DEFAULT_BACKTEST_CFG.embargoSec >= 0)
})

test('negatif ambargo sifira cekilir (ileriye bakma olamaz)', () => {
  const mem = hafizaKur(20, 20)
  const r = runBacktest(mem, [], { warmupEvents: 2, embargoSec: -100000 })
  assert.equal(r.summary.embargoSec, 0)
})
