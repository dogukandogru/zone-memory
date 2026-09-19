'use strict'

// Y2 - src/core/calendar.js testleri.
//
// Iki kilit vardir:
//
// 1. TAKVIM YOKSA HICBIR SEY DEGISMEZ. Ozellik kullanicinin elle koydugu bir
//    CSV'ye bagli; dosya yoksa `loadCalendar` null doner, alt kume kirilimi
//    olusmaz ve testin ozeti birebir eskisi gibi kalir. Sessizce bozulan bir
//    ozellik, hic olmayan bir ozellikten kotudur.
//
// 2. KARAR ANI ISARETLIDIR. `deltaMin` pozitifse veri HENUZ GELMEDI (uyari
//    anlamli), negatifse gecti. Isaret karisirsa canlida "20 dk sonra NFP var"
//    uyarisi verinin gectigi anlarda cikar.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const calendar = require('../src/core/calendar')
const backtest = require('../src/core/learn/backtest')
const { evaluateTouch } = require('../src/core/learn/signal')
const fixtures = require('./helpers/fixtures')

const GUN = fixtures.GUN
const T_SORGU = 1700000000

/** Gecici klasore takvim dosyasi yazar, yolunu dondurur. */
function takvimYaz (icerik) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-cal-'))
  const dosya = path.join(dir, 'high_impact.csv')
  fs.writeFileSync(dosya, icerik, 'utf8')
  return dosya
}

test('takvim dosyasi yoksa null doner (ozellik sessizce kapali)', () => {
  assert.equal(calendar.loadCalendar('/olmayan/bir/yol/high_impact.csv'), null)
  // null takvimle sorgular guvenli: uyari yok, alt kume 'normal'.
  assert.equal(calendar.nearestEvent(null, T_SORGU), null)
  assert.equal(calendar.newsSubset(null, T_SORGU), 'normal')
})

test('CSV okunur, bas satir ve yorumlar atlanir, bozuk satir sayilir', () => {
  const dosya = takvimYaz([
    'timeUtc,code,currency',
    '# yorum satiri',
    '2024-07-05T12:30:00Z,NFP,USD',
    'bozuk satir',
    '2024-07-11T12:30:00Z,cpi,USD',
    '',
    '2024-07-31T18:00:00Z,FOMC,USD',
  ].join('\n'))
  const cal = calendar.loadCalendar(dosya)
  assert.equal(cal.count, 3)
  assert.equal(cal.skipped, 1, 'bozuk satir sayilmali')
  // Kodlar buyuk harfe cevrilir, kayitlar zamana gore sirali.
  assert.deepEqual(cal.codes, ['NFP', 'CPI', 'FOMC'])
  for (let i = 1; i < cal.times.length; i++) {
    assert.ok(cal.times[i] >= cal.times[i - 1], 'zamanlar artan sirada olmali')
  }
})

test('nearestEvent: deltaMin isaretlidir, +20 dk once ve -61 dk sonra', () => {
  const dosya = takvimYaz('2024-07-05T12:30:00Z,NFP,USD\n')
  const cal = calendar.loadCalendar(dosya)
  const nfp = Date.parse('2024-07-05T12:30:00Z') / 1000

  // 12:10 kararinda veri 20 dakika SONRA: pozitif.
  const once = calendar.nearestEvent(cal, nfp - 20 * 60)
  assert.equal(once.code, 'NFP')
  assert.ok(Math.abs(once.deltaMin - 20) < 1e-9, 'deltaMin +20 olmali: ' + once.deltaMin)

  // 13:31 kararinda veri 61 dakika ONCE: negatif.
  const sonra = calendar.nearestEvent(cal, nfp + 61 * 60)
  assert.ok(Math.abs(sonra.deltaMin + 61) < 1e-9, 'deltaMin -61 olmali: ' + sonra.deltaMin)

  // Alt kume kovalari: 30 ve 60 dakika.
  assert.equal(calendar.newsSubset(cal, nfp - 20 * 60), 'veri ±30 dk')
  assert.equal(calendar.newsSubset(cal, nfp + 45 * 60), 'veri ±60 dk')
  assert.equal(calendar.newsSubset(cal, nfp + 61 * 60), 'normal', '61 dk pencere disi')
  assert.equal(calendar.newsSubset(cal, nfp - 5 * 86400), 'normal')
})

test('bySubset: kanca verilmezse alan null kalir, verilirse tur bazinda dolar', () => {
  const mem = fixtures.hafizaKur({
    adet: 120, basarili: 70, kind: (i) => (i % 3 === 0 ? 'form' : 'touch'),
  })
  const cfg = { warmupEvents: 10, warmupPerBucket: 0, signalCfg: { minMatches: 3, minWinRate: 0.3, minExpectancy: -1 } }

  // Kanca yok: ozet birebir eskisi gibi.
  const kancasiz = backtest.runBacktest(mem, [], cfg)
  assert.equal(kancasiz.summary.bySubset, null)

  // Kanca var: alt kume x tur kirilimi dolar ve toplamlar ozetle tutarlidir.
  const kancali = backtest.runBacktest(mem, [], Object.assign({}, cfg, {
    subsetOf: (ev) => (ev.id % 4 === 0 ? 'veri ±30 dk' : 'normal'),
  }))
  const ak = kancali.summary.bySubset
  assert.ok(Array.isArray(ak) && ak.length > 0)
  // Alt kume kirilimi KARARI degistirmez: ayni islem sayisi.
  assert.equal(kancali.summary.fired, kancasiz.summary.fired)
  let toplamOlay = 0
  let toplamSinyal = 0
  for (const g of ak) {
    assert.ok(g.subset === 'normal' || g.subset === 'veri ±30 dk')
    assert.ok(g.kind === 'form' || g.kind === 'touch')
    toplamOlay += g.total
    toplamSinyal += g.fired
    if (g.fired > 0) assert.ok(g.winRateCI && g.winRateCI.lo <= g.winRate && g.winRate <= g.winRateCI.hi)
  }
  assert.equal(toplamOlay, kancali.summary.total, 'alt kume toplamlari ozetle ayni olmali')
  assert.equal(toplamSinyal, kancali.summary.fired)
})

test('haber kapisi: varsayilan kapali, acilinca sinyal uretilmez', () => {
  const mem = fixtures.hafizaKur({
    adet: 20, basarili: 16, yon: 'BUY', ilkZaman: T_SORGU - 20 * 10 * GUN,
  })
  const t = fixtures.dokunus({ id: 7, zoneId: 3, yon: 'BUY', bar: 500, time: T_SORGU })
  const ozellik = fixtures.sabitOzellik()
  const esik = { minMatches: 5, minWinRate: 0.30 }
  const haber = { code: 'NFP', deltaMin: 12 }

  // Haber bilgisi verilse bile kapi KAPALI oldugu icin sinyal uretilir.
  const kapali = evaluateTouch(t, ozellik, mem, [], esik, null, { news: haber })
  assert.equal(kapali.fired, true)
  assert.deepEqual(kapali.news, haber, 'haber bilgisi kapi kapaliyken de tasinmali')
  assert.equal(kapali.newsBlocked, false)

  // Kapi acik ve karar ani pencere icinde: sinyal uretilmez, gerekce yazilir.
  const acik = evaluateTouch(t, ozellik, mem, [], Object.assign({}, esik, { newsBlackoutMin: 30 }),
    null, { news: haber })
  assert.equal(acik.fired, false)
  assert.equal(acik.newsBlocked, true)
  assert.ok(acik.reasons.some((r) => r.includes('Yüksek etkili veri penceresi')))

  // Pencere disindaysa kapi acik olsa bile engellemez.
  const uzak = evaluateTouch(t, ozellik, mem, [], Object.assign({}, esik, { newsBlackoutMin: 30 }),
    null, { news: { code: 'NFP', deltaMin: 95 } })
  assert.equal(uzak.fired, true)
  assert.equal(uzak.newsBlocked, false)

  // Takvim yoksa (news null) kapi ayari ne olursa olsun etkisizdir.
  const takvimsiz = evaluateTouch(t, ozellik, mem, [], Object.assign({}, esik, { newsBlackoutMin: 30 }),
    null, { news: null })
  assert.equal(takvimsiz.fired, true)
  assert.equal(takvimsiz.news, null)
})
