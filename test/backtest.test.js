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

const { runBacktest, runBacktestFromCache, DEFAULT_BACKTEST_CFG } = require('../src/core/learn/backtest')
const candcache = require('../src/core/learn/candcache')
const fixtures = require('./helpers/fixtures')

const GUN = fixtures.GUN

/**
 * n olay uretir; ilk basariliAdet tanesi basarili, kalani basarisiz.
 * Olaylar 10 gun arayla, komsu dislama penceresinin (3 gun) disinda.
 * Ozellik vektoru hepsinde AYNI, yani benzerlik daima 1.0
 * (bkz. test/helpers/fixtures.js).
 */
function hafizaKur (n, basariliAdet) {
  return fixtures.hafizaKur({ adet: n, basarili: basariliAdet, tf: '15m' })
}

// Esikler acikca dusuruldu: uygulamanin varsayilanlari (minMatches 15,
// minWinRate 0.62) gercek veriye gore secildi, bu testler ise onlarca kayitlik
// sentetik hafizayla yuruyen ileri testin MEKANIGINI dogruluyor.
//
// `warmupPerBucket: 0` ZORUNLU: asil isinma olcutu artik "ayni tur ve yonden
// kac aday gorulduk" (varsayilan 100). Onlarca kayitlik sentetik hafizada bu
// esik hicbir islem birakmaz.
const CFG = {
  warmupEvents: 5,
  warmupPerBucket: 0,
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
    'profitFactor', 'maxDrawdownAtr', 'avgRr', 'baselineWinRate', 'rawWinRate',
    'baselineExpectancyAtr', 'edgePts', 'edgeNetAtr', 'timeouts', 'nofill',
    'warmupEvents', 'warmupPerBucket', 'evalFrom', 'evalTo', 'warning']) {
    assert.ok(ad in s, 'summary alani eksik: ' + ad)
  }
  assert.equal(s.wins + s.losses, s.fired)
  assert.ok(s.winRate >= 0 && s.winRate <= 1)
  assert.ok(s.maxDrawdownAtr >= 0)

  // HAM ORAN (bilgi amacli): tum etiketlenmis olaylar, tur ayrimi yok, 30/40.
  assert.ok(Math.abs(s.rawWinRate - 0.75) < 1e-9, 'rawWinRate 0.75 olmali: ' + s.rawWinRate)

  // TABAN artik ham oran DEGIL: isinma sonrasi donemde, TUR BAZINDA ve ayni
  // planla hesaplanir. Bu hafizada isinma ilk 5 olayi (hepsi basarili) disarida
  // biraktigi icin taban ham orandan farkli olmak zorundadir.
  assert.ok(s.baselineWinRate !== null, 'islem varken taban hesaplanmali')
  assert.ok(Math.abs(s.baselineWinRate - 25 / 35) < 1e-9,
    'taban isinma sonrasi donemden gelmeli (25/35): ' + s.baselineWinRate)
  assert.notEqual(s.baselineWinRate, s.rawWinRate)
  // Katki, isabet ile taban arasindaki puan farkidir.
  assert.ok(Math.abs(s.edgePts - (s.winRate - s.baselineWinRate) * 100) < 1e-9)
  assert.ok(Math.abs(s.edgeNetAtr - (s.expectancyAtr - s.baselineExpectancyAtr)) < 1e-9)
})

test('hic islem acilmazsa taban null doner (yaniltici sayi gosterilmez)', () => {
  // Tum kayitlar basarisiz: esikler gecilmez, islem yok.
  const r = runBacktest(hafizaKur(40, 0), [], CFG)
  assert.equal(r.summary.fired, 0)
  assert.equal(r.summary.baselineWinRate, null)
  assert.equal(r.summary.baselineExpectancyAtr, null)
  assert.equal(r.summary.edgePts, null)
  assert.equal(r.summary.edgeNetAtr, null)
})

test('isinma ve degerlendirilen donem ozete yazilir', () => {
  const mem = hafizaKur(40, 30)
  const r = runBacktest(mem, [], CFG)
  assert.equal(r.summary.warmupEvents, CFG.warmupEvents)
  assert.equal(r.summary.warmupPerBucket, 0)
  assert.equal(r.summary.total, 35, 'isinma disindaki olaylar degerlendirilir')
  // Degerlendirilen donem isinmadan SONRA baslar.
  assert.equal(r.summary.evalFrom, mem.events[5].time)
  assert.equal(r.summary.evalTo, mem.events[39].time)

  // Isinma degistiginde ozet de degisir.
  const genis = runBacktest(mem, [], Object.assign({}, CFG, { warmupEvents: 12 }))
  assert.equal(genis.summary.warmupEvents, 12)
  assert.equal(genis.summary.total, 28)
  assert.equal(genis.summary.evalFrom, mem.events[12].time)

  // Tur + yon bazli isinma olcutu: esik yukseltilince hicbir islem acilmaz.
  const kova = runBacktest(mem, [], Object.assign({}, CFG, { warmupPerBucket: 1000 }))
  assert.equal(kova.summary.total, 0)
  assert.equal(kova.summary.fired, 0)
  assert.equal(kova.summary.warmupPerBucket, 1000)
  assert.equal(kova.summary.warning, 'yetersiz hafıza')
})

test('degerlendirme penceresi olcumu daraltir, hafizayi daraltmaz', () => {
  const mem = hafizaKur(40, 30)
  const tam = runBacktest(mem, [], CFG)
  const kesme = mem.events[20].time

  // ILK YARI: pencere sonu verilince yalnizca o ana kadarki olaylar olculur.
  const ilk = runBacktest(mem, [], Object.assign({}, CFG, { evalToTime: kesme }))
  assert.equal(ilk.summary.evalFrom, mem.events[5].time)
  assert.equal(ilk.summary.evalTo, kesme)
  assert.ok(ilk.summary.total < tam.summary.total)

  // IKINCI YARI: pencere basi verilince oncesi yalnizca hafiza olarak kalir.
  const son = runBacktest(mem, [], Object.assign({}, CFG, { evalFromTime: kesme + 1 }))
  assert.ok(son.summary.evalFrom > kesme)
  assert.equal(son.summary.evalTo, mem.events[39].time)
  // Iki dilim, isinma disindaki olaylarin tamamini boler.
  assert.equal(ilk.summary.total + son.summary.total, tam.summary.total)

  // null "sinir yok" demektir; Number(null) sifir oldugu icin bu bir donem
  // butun olaylari eliyordu.
  const acik = runBacktest(mem, [], Object.assign({}, CFG, { evalFromTime: null, evalToTime: null }))
  assert.equal(acik.summary.total, tam.summary.total)
  assert.equal(acik.summary.fired, tam.summary.fired)
})

test('equity birikimli toplamdir ve islem sayisiyla ayni uzunluktadir', () => {
  const mem = hafizaKur(40, 30)
  const r = runBacktest(mem, [], CFG)
  assert.equal(r.equity.length, r.trades.length)

  let birikim = 0
  for (let i = 0; i < r.trades.length; i++) {
    birikim += r.trades[i].pnlAtr
    assert.ok(Math.abs(r.equity[i].value - birikim) < 1e-9, i + '. adimda sermaye egrisi tutmuyor')
    // Egri noktasi islemin ACILDIGI zamana degil, SONUCUN BELLI OLDUGU
    // zamana yazilir (O7): kar acilista degil kapanista gerceklesir.
    assert.ok(r.equity[i].time >= r.trades[i].time,
      i + '. adimda egri noktasi islem zamanindan once')
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
  assert.ok(DEFAULT_BACKTEST_CFG.warmupPerBucket >= 0)
})

test('negatif ambargo sifira cekilir (ileriye bakma olamaz)', () => {
  const mem = hafizaKur(20, 20)
  const r = runBacktest(mem, [], { warmupEvents: 2, warmupPerBucket: 0, embargoSec: -100000 })
  assert.equal(r.summary.embargoSec, 0)
})

// ---------------------------------------------------------------------------
// OLAY TURU KIRILIMI
// ---------------------------------------------------------------------------
// Iki sinyal turunun (kutu olusumu / bolgeye geri donus) taban oranlari cok
// farklidir. Toplam rakam ikisini birbirine gizler, bu yuzden kirilim ozetin
// zorunlu parcasidir.

/** Karisik hafiza: cift indeksler form, tek indeksler dokunus. */
function karisikHafiza (n, formBasariliMod, touchBasariliMod) {
  return fixtures.hafizaKur({
    adet: n,
    kind: (i) => (i % 2 === 0 ? 'form' : 'touch'),
    alanlar: (i) => ({
      basarili: i % 2 === 0 ? i % formBasariliMod === 0 : i % touchBasariliMod === 1,
    }),
  })
}

test('karisik hafizada byKind dogru kirilim verir', () => {
  const mem = karisikHafiza(80, 2, 4)
  const r = runBacktest(mem, [], Object.assign({}, CFG, {
    warmupEvents: 0,
    signalCfg: { minMatches: 3, minWinRate: 0.40, minExpectancy: -Infinity, minRr: 0 },
  }))
  const s = r.summary
  const kirilim = new Map(s.byKind.map((k) => [k.kind, k]))
  assert.equal(s.byKind.length, 2, 'iki tur da her zaman listelenir')
  assert.ok(kirilim.has('form') && kirilim.has('touch'))

  // Toplamlar tutarli: degerlendirilen olaylar ve islemler turlere dagilir.
  // byKind.total ile summary.total ayni seyi sayar: degerlendirilen olaylar.
  // Dolmayan limit emirler (nofill) ikisinde de yer almaz, ayri sayilir.
  assert.equal(kirilim.get('form').total + kirilim.get('touch').total, s.total)
  assert.equal(kirilim.get('form').fired + kirilim.get('touch').fired, s.fired)
  assert.equal(kirilim.get('form').wins + kirilim.get('touch').wins, s.wins)
  assert.equal(kirilim.get('form').losses + kirilim.get('touch').losses, s.losses)
  assert.ok(Math.abs(
    kirilim.get('form').totalPnlAtr + kirilim.get('touch').totalPnlAtr - s.totalPnlAtr
  ) < 1e-9)

  // Her tur yalnizca KENDI turunden olay sayar.
  const formIslem = r.trades.filter((t) => t.kind === 'form').length
  const temasIslem = r.trades.filter((t) => t.kind === 'touch').length
  assert.equal(kirilim.get('form').fired, formIslem)
  assert.equal(kirilim.get('touch').fired, temasIslem)
  for (const k of s.byKind) {
    assert.equal(k.wins + k.losses, k.fired)
    assert.ok(k.winRate >= 0 && k.winRate <= 1)
  }
})

// (e) Taban AYNI TURUN tabanidir: karisik taban sahte katki gosteriyordu.
test('taban TUR BAZINDA hesaplanir: yalnizca form tetiklenirse taban form tabanidir', () => {
  // form: %50 basarili, dokunus: %25 basarili. Esik 0.45 oldugu icin yalnizca
  // form olaylari sinyal uretir (dokunus gecmisi esigi hicbir noktada gecemez;
  // en yuksek degeri bes adaylik havuzda 0.40'tir).
  const mem = karisikHafiza(80, 4, 8)
  const r = runBacktest(mem, [], Object.assign({}, CFG, {
    warmupEvents: 0,
    signalCfg: { minMatches: 3, minWinRate: 0.45, minExpectancy: -Infinity, minRr: 0 },
  }))
  const s = r.summary
  const kirilim = new Map(s.byKind.map((k) => [k.kind, k]))

  assert.ok(kirilim.get('form').fired > 0, 'form olaylari islem uretmeli')
  assert.equal(kirilim.get('touch').fired, 0, 'dokunus olaylari esigi gecmemeli')

  // Ham oran iki turun karisimi (%50 ve %25 -> ~%37.5), taban ise FORM tabani.
  assert.ok(Math.abs(s.rawWinRate - 0.375) < 1e-9, 'ham oran: ' + s.rawWinRate)
  assert.ok(Math.abs(kirilim.get('form').baselineWinRate - 0.5) < 1e-9,
    'form tabani: ' + kirilim.get('form').baselineWinRate)
  assert.ok(Math.abs(kirilim.get('touch').baselineWinRate - 0.25) < 1e-9,
    'dokunus tabani: ' + kirilim.get('touch').baselineWinRate)
  assert.ok(Math.abs(s.baselineWinRate - kirilim.get('form').baselineWinRate) < 1e-9,
    'tetiklenen islemlerin tamami form oldugu icin taban form tabani olmali: ' + s.baselineWinRate)
  assert.notEqual(s.baselineWinRate, s.rawWinRate)

  // Karisik taban kullanilsaydi katki yapay olarak buyurdu.
  assert.ok(Math.abs(s.edgePts - (s.winRate - 0.5) * 100) < 1e-9)
  assert.ok(s.edgePts < (s.winRate - s.rawWinRate) * 100 + 1e-9,
    'tur bazli taban, karisik tabandan daha durust (daha kucuk katki) olmali')

  // byKind satirlari da kendi tabanini ve katkisini tasir.
  for (const k of s.byKind) {
    for (const ad of ['baseN', 'baselineWinRate', 'baselineExpectancyAtr', 'edgePts', 'edgeNetAtr']) {
      assert.ok(ad in k, 'byKind alani eksik: ' + ad)
    }
    if (k.fired === 0) assert.equal(k.edgePts, null, 'islem yoksa katki null olmali')
  }
})

// (f) ADAY OLABILMEK ICIN OLAY SORGUDAN ONCE BITMIS OLMALI
// Olayin BASLADIGI zaman degil, SONUCUNUN BELLI OLDUGU zaman (resolvedTime)
// olcuttur: ufuk dolmadan etiketi bilinemeyen bir olay komsu olamaz.
test('aday havuzu resolvedTime kuralina uyar: sonucu daha bilinmeyen olay aday olmaz', () => {
  const T = fixtures.T0
  const SAAT = 3600
  // Olaylar 1 saat arayla, her olayin sonucu 12 saat sonra belli oluyor.
  const mem = fixtures.hafizaKur({
    adet: 40,
    aralik: SAAT,
    ilkZaman: T,
    alanlar: (i) => ({ resolvedTime: T + i * SAAT + 12 * SAAT }),
  })
  const r = runBacktest(mem, [], {
    warmupEvents: 0,
    warmupPerBucket: 0,
    embargoSec: 0,
    signalCfg: {
      minMatches: 1, minWinRate: 0, minExpectancy: -Infinity, minRr: 0,
      // Komsu dislama KAPALI: kural yalnizca resolvedTime uzerinden islemeli.
      excludeWithinSec: 0,
    },
  })
  assert.ok(r.trades.length > 0, 'islem uretilmeliydi')

  const zamanlar = new Map(mem.events.map((e) => [e.id, e]))
  for (const t of r.trades) {
    // Olay i icin aday sayisi: sonucu t.time'dan ONCE belli olan olaylar,
    // yani i - 12'den eski olanlar (k tavani 25).
    const beklenen = Math.min(25, Math.max(0, t.eventId - 12))
    assert.equal(t.matchCount, beklenen,
      t.eventId + '. olayda aday sayisi sonuc zamanina gore sinirli olmali')
    for (const m of t.topMatches) {
      const ev = zamanlar.get(m.id)
      assert.ok(ev.resolvedTime < t.time,
        'sonucu henuz belli olmayan olay aday olmus: id=' + m.id)
    }
  }

  // Sorgudan once BASLAYAN ama sonra SONUCLANAN olaylar gercekten var, yani
  // test bos degil: 20. olayin aday sayisi 8, oysa 20 olay daha once baslamis.
  const yirmi = r.trades.find((t) => t.eventId === 20)
  assert.ok(yirmi, '20. olay icin islem beklenir')
  assert.equal(yirmi.matchCount, 8)
})

// ---------------------------------------------------------------------------
// ZAMAN ASIMI VE DOLMAYAN EMIRLER
// ---------------------------------------------------------------------------

test('tradeResult: zaman asimi TAM STOP ZARARI yazmaz, ufuk sonundan degerlenir', () => {
  const { tradeResult, baseResult } = require('../src/core/learn/backtest')
  const plan = (e) => ({ entry: e.entryPrice, tp1: e.targetPrice, sl: e.invalidPrice })
  const bedava = { costPct: 0, costUsd: 0 }

  // Lehte kapanan zaman asimi: sonuc pozitif.
  const lehte = fixtures.olay({ outcome: 'timeout', success: false, realizedR: 0.4 })
  const a = tradeResult(lehte, plan(lehte), bedava)
  assert.equal(a.ok, true)
  assert.equal(a.timeout, true)
  assert.equal(a.win, false, 'zaman asimi isabet sayilmaz')
  assert.ok(Math.abs(a.grossAtr - 0.4 * lehte.riskAtr) < 1e-12,
    'sonuc gerceklesen R ile riskin carpimi olmali: ' + a.grossAtr)
  assert.ok(a.grossAtr > 0, 'lehte kapanan zaman asimi zarar yazmamali')
  assert.notEqual(a.grossAtr, -a.slAtr)

  // Aleyhte kapanan zaman asimi: negatif ama tam stop DEGIL.
  const aleyhte = fixtures.olay({ outcome: 'timeout', success: false, realizedR: -0.3 })
  const b = tradeResult(aleyhte, plan(aleyhte), bedava)
  assert.ok(b.grossAtr < 0)
  assert.ok(b.grossAtr > -b.slAtr, 'zaman asimi tam stop zararindan kucuk olmali')

  // Kirilma tam stop zarari yazar (karsilastirma).
  const kirik = fixtures.olay({ basarili: false })
  const c = tradeResult(kirik, plan(kirik), bedava)
  assert.equal(c.timeout, false)
  assert.ok(Math.abs(c.grossAtr + c.slAtr) < 1e-12, 'kirilma -slAtr yazar')

  // Asiri gerceklesen R plan sinirlarina kirpilir.
  const asiri = fixtures.olay({ outcome: 'timeout', success: false, realizedR: 50 })
  const d = tradeResult(asiri, plan(asiri), bedava)
  assert.ok(Math.abs(d.grossAtr - d.tp1Atr) < 1e-12, 'kazanc TP1 carpanini asamaz')

  // Taban islemi olayin KENDI seviyelerini kullanir.
  const taban = baseResult(lehte, bedava)
  assert.equal(taban.ok, true)
  assert.ok(Math.abs(taban.tp1Atr - Math.abs(lehte.targetPrice - lehte.entryPrice) / lehte.atr) < 1e-12)
})

test('zaman asimi islemleri ozette ayri raporlanir', () => {
  const mem = fixtures.hafizaKur({
    adet: 40,
    basarili: 0,
    alanlar: () => ({ outcome: 'timeout', success: false, realizedR: 0.3 }),
  })
  const r = runBacktest(mem, [], {
    warmupEvents: 2,
    warmupPerBucket: 0,
    embargoSec: 0,
    costUsd: 0,
    costPct: 0,
    signalCfg: { minMatches: 3, minWinRate: 0, minExpectancy: -Infinity, minRr: 0 },
  })
  assert.ok(r.summary.fired > 0, 'islem uretilmeliydi')
  assert.equal(r.summary.timeouts, r.summary.fired, 'tum islemler zaman asimi')
  assert.equal(r.summary.wins, 0, 'zaman asimi isabet degildir')
  assert.ok(r.summary.timeoutPnlAtr > 0, 'lehte kapanan zaman asimlari toplami pozitif')
  assert.ok(r.summary.expectancyAtr > 0, 'beklenti tam stop zarari ile hesaplanmamali')
  for (const t of r.trades) {
    assert.equal(t.outcome, 'timeout')
    assert.equal(t.win, false)
    assert.ok(t.pnlAtr > 0, 'ufuk sonu lehte kapandiysa sonuc pozitif olmali')
    assert.ok(Math.abs(t.pnlAtr + t.slAtr) > 1e-9, 'tam stop zarari yazilmis')
  }
})

test('dolmayan limit emirler (nofill) islem ve taban sayilmaz, ayrica raporlanir', () => {
  // Yarisi dolmus (respect), yarisi hic dolmamis dokunus olaylari.
  const mem = fixtures.hafizaKur({
    adet: 40,
    alanlar: (i) => (i % 2 === 1
      ? { outcome: 'nofill', success: false, filled: false, realizedR: 0 }
      : {}),
  })
  const r = runBacktest(mem, [], Object.assign({}, CFG, { warmupEvents: 0 }))
  const s = r.summary
  const temas = s.byKind.find((k) => k.kind === 'touch')

  assert.equal(s.nofill, 20, 'dolmayan emirler sayilmali')
  assert.equal(temas.nofill, 20)
  assert.ok(Math.abs(s.fillRate - 0.5) < 1e-9, 'dolum orani: ' + s.fillRate)
  assert.equal(s.total, 20, 'yalnizca dolan emirler degerlendirilir')
  for (const t of r.trades) {
    assert.notEqual(t.outcome, 'nofill', 'dolmayan emirden islem yazilmis')
  }
  // Taban da yalnizca dolan emirlerden birikir.
  assert.equal(temas.baseN, 20)
})

// O9 - istatistik alanlari: nokta tahmin tek basina yaniltir.
test('ozet Wilson araligi, p degeri, bootstrap araligi ve kalibrasyon tasir', () => {
  const mem = fixtures.hafizaKur({ adet: 120 })
  const r = runBacktest(mem, [], Object.assign({}, CFG, { warmupEvents: 0, warmupPerBucket: 0 }))
  const s = r.summary
  if (s.fired === 0) return // esikler tutmadiysa alanlar null olur, bu da gecerli

  assert.ok(s.winRateCI && s.winRateCI.lo <= s.winRate && s.winRate <= s.winRateCI.hi,
    'isabet orani kendi guven araliginin icinde olmali')
  assert.ok(s.baselinePValue === null || (s.baselinePValue >= 0 && s.baselinePValue <= 1))
  assert.ok(s.expectancyCI && s.expectancyCI.lo <= s.expectancyAtr && s.expectancyAtr <= s.expectancyCI.hi,
    'net beklenti kendi araliginin icinde olmali')
  assert.ok(s.permHitP === null || (s.permHitP >= 0 && s.permHitP <= 1))
  assert.ok(Array.isArray(s.calibration) && s.calibration.length === 7)
  const kalibToplam = s.calibration.reduce((t, k) => t + k.n, 0)
  assert.equal(kalibToplam, s.fired, 'kalibrasyon kovalarinin toplami islem sayisina esit olmali')
  assert.ok(s.brier && (s.brier.model === null || s.brier.model >= 0))
  // R birimi: her islem kendi riskine bolunur.
  assert.ok(Number.isFinite(s.expectancyR))
  assert.ok(s.maxDrawdownR >= 0)
  for (const t of r.trades) {
    assert.ok(Math.abs(t.pnlR - t.pnlAtr / t.slAtr) < 1e-9, 'pnlR = pnlAtr / slAtr olmali')
  }
})

test('istatistik: bilinen girdilerde Wilson ve binom degerleri', () => {
  const stats = require('../src/core/learn/stats')
  const w = stats.wilson(890, 1840)
  assert.ok(Math.abs(w.lo - 0.4606) < 0.001 && Math.abs(w.hi - 0.5068) < 0.001,
    'Wilson araligi: ' + JSON.stringify(w))
  assert.ok(Math.abs(stats.binomTwoSided(60, 100, 0.5) - 0.0569) < 0.001)
  assert.equal(stats.binomTwoSided(50, 100, 0.5), 1)
  assert.equal(stats.wilson(0, 0), null)
  // Permutasyon: havuzun tamami 1 ise rastgele secim de her zaman 1 verir.
  assert.equal(stats.permutationP([1, 1, 1, 1], 2, 1, { reps: 50 }), 1)
  assert.equal(stats.permutationP([0, 0, 0, 0], 2, 0.5, { reps: 50 }), 0)
})

test('istatistik: AUC ayirt etme gucunu olcer, kalibrasyonu olcmez', () => {
  const stats = require('../src/core/learn/stats')
  // Kusursuz ayirma: her kazananin puani her kaybedenden yuksek.
  const tam = stats.auc([
    { pred: 0.9, win: true }, { pred: 0.8, win: true },
    { pred: 0.3, win: false }, { pred: 0.2, win: false },
  ])
  assert.equal(tam.auc, 1)
  assert.equal(tam.nWin, 2)
  assert.equal(tam.nLoss, 2)

  // Tam ters siralama: 0.
  assert.equal(stats.auc([
    { pred: 0.1, win: true }, { pred: 0.9, win: false },
  ]).auc, 0)

  // Hepsi ayni puan: esitlikler yarim sayilir, 0.5 cikar.
  assert.equal(stats.auc([
    { pred: 0.5, win: true }, { pred: 0.5, win: true },
    { pred: 0.5, win: false }, { pred: 0.5, win: false },
  ]).auc, 0.5)

  // KALIBRASYONDAN BAGIMSIZ: puanlarin tamamini kaydirmak AUC'yi degistirmez,
  // Brier'i degistirir. Agirlik secmek icin dogru olcut budur.
  const kayit = [
    { pred: 0.55, win: true }, { pred: 0.54, win: true },
    { pred: 0.53, win: false }, { pred: 0.52, win: false },
  ]
  const kaydirilmis = kayit.map((k) => ({ pred: k.pred - 0.3, win: k.win }))
  assert.equal(stats.auc(kayit).auc, stats.auc(kaydirilmis).auc)
  assert.notEqual(stats.brier(kayit, 0.5).model, stats.brier(kaydirilmis, 0.5).model)

  // Tek sinif varsa AUC tanimsizdir.
  assert.equal(stats.auc([{ pred: 0.6, win: true }]), null)
  assert.equal(stats.auc([]), null)
})

// ---------------------------------------------------------------------------
// A2 - KOMSU ONBELLEGI (src/core/learn/candcache.js)
// ---------------------------------------------------------------------------
// Onbellegin tek iddiasi var: AYNI sonucu daha hizli uretmek. Bu yuzden asil
// test hiz degil ESDEGERLIKTIR. Esik degistiginde komsular degismedigi icin
// onbellek BIR KEZ kurulur ve butun esik denemeleri ondan kosar; asagidaki
// test tam olarak bunu yapar ve her denemede referans yolla (runBacktest)
// birebir ayni cikti bekler.

/** Onbellek testleri icin taban ayarlar. */
const ONBELLEK_CFG = { warmupEvents: 5, warmupPerBucket: 0, embargoSec: 0 }

/**
 * Karisik (form/dokunus, BUY/SELL) ve RASTGELE ozellik vektorlu hafiza.
 * Sabit vektorle benzerlik hep 1.0 cikar ve esik taramasi hicbir seyi
 * ayirt edemezdi; rastgele vektor benzerlikleri esige yayar.
 */
function onbellekHafizasi (tohum) {
  const rnd = fixtures.prng(tohum === undefined ? 4242 : tohum)
  return fixtures.hafizaKur({
    adet: 200,
    basarili: 120,
    tf: '15m',
    aralik: 5 * GUN,
    kind: (i) => (i % 3 === 0 ? 'form' : 'touch'),
    yon: (i) => (i % 2 === 0 ? 'BUY' : 'SELL'),
    ozellik: () => fixtures.rastgeleOzellik(rnd),
  })
}

/** Esik uclusunu tam test ayarina cevirir. */
function esikCfg (esik) {
  return Object.assign({}, ONBELLEK_CFG, {
    signalCfg: Object.assign({ minExpectancy: -Infinity, minRr: 0 }, esik),
  })
}

// Esikler bilerek genis secildi: bir kismi bol islem uretir, sonuncusu hic
// islem uretmez. Onbellek "hicbir sey olusmadi" durumunda da ayni davranmali.
const ESIKLER = [
  { minSimilarity: 0.50, minMatches: 3, minWinRate: 0.40 },
  { minSimilarity: 0.60, minMatches: 5, minWinRate: 0.50 },
  { minSimilarity: 0.55, minMatches: 1, minWinRate: 0.00 },
  { minSimilarity: 0.70, minMatches: 2, minWinRate: 0.30 },
  { minSimilarity: 0.00, minMatches: 10, minWinRate: 0.60 },
  { minSimilarity: 0.95, minMatches: 20, minWinRate: 0.90 },
]

test('ESDEGERLIK: onbellekli test her esik kombinasyonunda referans yolla ayni sonucu verir', () => {
  const mem = onbellekHafizasi()
  // Onbellek BIR KEZ kurulur; butun esikler ayni komsulari kullanir.
  const cache = candcache.buildCandidates(mem, Object.assign({}, ONBELLEK_CFG, { signalCfg: {} }))
  assert.equal(cache.version, candcache.CANDCACHE_VERSION)
  assert.equal(cache.n, mem.events.length)
  assert.ok(cache.k > 0)

  let islemliDeneme = 0
  for (const esik of ESIKLER) {
    const cfg = esikCfg(esik)
    const etiket = JSON.stringify(esik)
    const referans = runBacktest(mem, [], cfg)
    const onbellekli = runBacktestFromCache(mem, cache, [], cfg)

    assert.equal(onbellekli.trades.length, referans.trades.length,
      'islem sayisi ayni olmali, esik ' + etiket)
    for (let i = 0; i < referans.trades.length; i++) {
      const a = referans.trades[i]
      const b = onbellekli.trades[i]
      assert.equal(b.eventId, a.eventId, i + '. islemin olayi ayni olmali, esik ' + etiket)
      assert.equal(b.win, a.win, i + '. islemin sonucu ayni olmali, esik ' + etiket)
      assert.equal(b.pnlAtr, a.pnlAtr, i + '. islemin kazanci ayni olmali, esik ' + etiket)
    }

    for (const alan of ['fired', 'wins', 'winRate', 'expectancyAtr', 'baselineWinRate']) {
      assert.equal(onbellekli.summary[alan], referans.summary[alan],
        'summary.' + alan + ' ayni olmali, esik ' + etiket)
    }
    if (referans.trades.length > 0) islemliDeneme++
  }
  // Hicbir esik islem uretmeseydi test bosluga bakiyor olurdu.
  assert.ok(islemliDeneme >= 4, 'esiklerin cogu islem uretmeliydi: ' + islemliDeneme)
})

test('onbellek diske yazilip geri okundugunda ayni sonucu verir', () => {
  const mem = onbellekHafizasi()
  const cfg = esikCfg(ESIKLER[1])
  const cache = candcache.buildCandidates(mem, Object.assign({}, ONBELLEK_CFG, { signalCfg: {} }))

  const buf = candcache.serialize(cache)
  assert.ok(Buffer.isBuffer(buf))
  const geri = candcache.deserialize(buf)
  assert.equal(geri.n, cache.n)
  assert.equal(geri.k, cache.k)
  assert.equal(geri.key, cache.key)
  assert.deepEqual(Array.from(geri.idx), Array.from(cache.idx), 'aday indeksleri bozulmamali')
  assert.deepEqual(Array.from(geri.sim), Array.from(cache.sim), 'benzerlikler bozulmamali')

  const referans = runBacktest(mem, [], cfg)
  const diskten = runBacktestFromCache(mem, geri, [], cfg)
  assert.equal(diskten.trades.length, referans.trades.length)
  assert.equal(diskten.summary.fired, referans.summary.fired)
  assert.equal(diskten.summary.expectancyAtr, referans.summary.expectancyAtr)
})

test('bozuk veya yanlis onbellek SESSIZCE yok sayilmaz, hata firlatir', () => {
  const mem = onbellekHafizasi()
  const cache = candcache.buildCandidates(mem, Object.assign({}, ONBELLEK_CFG, { signalCfg: {} }))

  // Sihirli sayisi bozuk dosya.
  const buf = candcache.serialize(cache)
  buf.writeUInt32LE(0, 0)
  assert.throws(() => candcache.deserialize(buf), /sihirli sayi/)

  // Baska boyutta bir hafiza icin kurulmus onbellek.
  const kucuk = fixtures.hafizaKur({ adet: 20, tf: '15m' })
  assert.throws(() => runBacktestFromCache(kucuk, cache, [], esikCfg(ESIKLER[0])), /olay/)
  assert.throws(() => runBacktestFromCache(mem, null, [], esikCfg(ESIKLER[0])), /onbellegi/)
})

test('onbellek anahtari yalnizca komsulari etkileyen ayarlarla degisir', () => {
  const mem = onbellekHafizasi()
  const taban = candcache.cacheKey(mem, { signalCfg: {} })
  // Esikler komsulari degistirmez, anahtar ayni kalmalidir.
  assert.equal(candcache.cacheKey(mem, { signalCfg: { minSimilarity: 0.1, minMatches: 1 } }), taban)
  // k, agirliklar ve komsu dislama komsulari degistirir.
  assert.notEqual(candcache.cacheKey(mem, { signalCfg: { k: 10 } }), taban)
  assert.notEqual(candcache.cacheKey(mem, { signalCfg: { weights: { shape: 0.9 } } }), taban)
  assert.notEqual(candcache.cacheKey(mem, { signalCfg: { excludeWithinSec: 1 } }), taban)
  // Hafizanin kendisi buyuyunce de anahtar degisir.
  const buyuk = { tf: mem.tf, ctxNames: mem.ctxNames, events: mem.events.concat(mem.events[0]) }
  assert.notEqual(candcache.cacheKey(buyuk, { signalCfg: {} }), taban)
})

test('bos hafizada onbellek kurulabilir ve testle uyumludur', () => {
  const bos = { tf: '15m', ctxNames: [], events: [] }
  const cache = candcache.buildCandidates(bos, ONBELLEK_CFG)
  assert.equal(cache.n, 0)
  assert.equal(cache.idx.length, 0)
  const geri = candcache.deserialize(candcache.serialize(cache))
  assert.equal(geri.n, 0)
  const r = runBacktestFromCache(bos, cache, [], esikCfg(ESIKLER[0]))
  assert.deepEqual(r.trades, [])
  assert.equal(r.summary.fired, 0)
})

test('yonu yalnizca isSupport ile belli olan olaylarda da onbellek ayni sonucu verir', () => {
  // TUZAK: aday havuzlari tur + yon bazinda bolunuyor. Yon kurali onbellekte
  // yeniden yazilsaydi, `direction` alani olmayip yalnizca `isSupport` tasiyan
  // bir sorgu YANLIS kovaya bakar ve hicbir komsu bulamazdi.
  const rnd = fixtures.prng(99)
  const mem = fixtures.hafizaKur({
    adet: 120, basarili: 80, tf: '15m', aralik: 5 * GUN,
    yon: (i) => (i % 2 === 0 ? 'BUY' : 'SELL'),
    ozellik: () => fixtures.rastgeleOzellik(rnd),
  })
  for (let i = 40; i < 60; i++) {
    mem.events[i].isSupport = mem.events[i].direction === 'BUY'
    delete mem.events[i].direction
  }

  const cfg = esikCfg({ minSimilarity: 0.5, minMatches: 2, minWinRate: 0.3 })
  const cache = candcache.buildCandidates(mem, cfg)
  const referans = runBacktest(mem, [], cfg)
  const onbellekli = runBacktestFromCache(mem, cache, [], cfg)

  assert.ok(referans.trades.length > 0, 'test bosluga bakmamali')
  assert.equal(onbellekli.trades.length, referans.trades.length)
  for (let i = 0; i < referans.trades.length; i++) {
    assert.equal(onbellekli.trades[i].eventId, referans.trades[i].eventId)
    assert.equal(onbellekli.trades[i].matchCount, referans.trades[i].matchCount)
    assert.equal(onbellekli.trades[i].pnlAtr, referans.trades[i].pnlAtr)
  }
})
