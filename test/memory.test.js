'use strict'

// A12 - src/core/learn/memory.js testleri (CONTRACTS.md bolum 14 ve 21).
//
// Bu dosya OLCUMU BOZAN hatalara karsi kilit kurar:
//   1. Ozellik vektoru ileriye bakarsa hafiza gecmiste bilinmeyen bir seyi
//      ogrenir; testte seri olay barinda kesilip ayni vektor bekleniyor.
//   2. Etiketin hedefi ile planin hedefi ayrilirsa "bolge tuttu" ile "TP1
//      vuruldu" ayni olay olmaktan cikar; testte olayin targetPrice degeri
//      outcome.zoneLevels ile karsilastiriliyor.
//   3. Ayni barda dogan iki olay turunden biri digerini dusurmemeli.
//   4. Veri boslugunun icinde kalan olay hafizaya girmemeli, ama piyasanin
//      KAPALI oldugu saatlerden dogan zaman atlamasi bosluk sayilmamali
//      (bu ayrim yapilmadiginda 15 dakikalikta 6890 olayin 6485'i atiliyordu).
//
// Sentetik seri tasarimi (indicator.test.js ile ayni fikir):
//   Her bar ayni sekle sahiptir (low = L, open = L+0.05, close = L+0.15,
//   high = L+0.30). Kapanislar sabit oldugu icin Bollinger sapmasi sifira
//   yakindir ve pivot dibi bandin ALTINDA kalir, yani BB kapisi acilir.
//   Hacim yalnizca pivot barinda yukseltilir: hangi barin kutu actigi kesindir.
//   Pivot dipten SONRA fiyat kutunun hemen ustunde kalir; boylece kutu
//   olusum olayinda risk maxFormRiskAtr esigini asmaz ve olay etiketlenir.

const test = require('node:test')
const assert = require('node:assert/strict')

const series = require('../src/core/series')
const { buildMemory, summarize } = require('../src/core/learn/memory')
const { runIndicator } = require('../src/core/indicator/proZones')
const { buildFeatures, CTX_NAMES } = require('../src/core/learn/features')
const { zoneLevels, DEFAULT_OUTCOME_CFG } = require('../src/core/learn/outcome')
const { createMarketCalendar } = require('../src/core/session')

/** 15 dakika. */
const ADIM = 900
/**
 * 2024-01-07 23:00 UTC: Pazar 18:00 New York, yani piyasanin haftalik
 * acilisi. 400 barlik seri (100 saat) boylece Cuma kapanisindan once biter ve
 * tamami islem haftasinin icinde kalir; olay penceresine dusen zaman
 * atlamalarini testin kendisi kuruyor.
 */
const T0 = Date.UTC(2024, 0, 7, 23) / 1000
/** Pivot dibin bari. Ozellik penceresi (32 bar) ve isinma icin yeterince ileride. */
const PIVOT = 250
/** Kutunun dogdugu bar: pivot + pivotLen (varsayilan 5). */
const OLAY_BAR = 255

/**
 * Sentetik seri. `zamanlar` verilmezse barlar ADIM araliklidir.
 * @param {number} n
 * @param {number[]} [zamanlar]
 */
function seriKur (n, zamanlar) {
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  for (let i = 0; i < n; i++) {
    // Pivot barinda dip, sonrasinda fiyat kutunun hemen ustunde kalir.
    const L = i === PIVOT ? 95 : (i > PIVOT ? 95.2 : 100)
    d.time[i] = zamanlar ? zamanlar[i] : T0 + i * ADIM
    d.low[i] = L
    d.open[i] = L + 0.05
    d.close[i] = L + 0.15
    d.high[i] = L + 0.30
    d.volume[i] = i === PIVOT ? 20000 : 100
  }
  // Kutunun dogdugu barda fiyat kutuya deger: ayni barda temas olayi da acilir.
  d.low[OLAY_BAR] = 95.05
  return series.fromArrays(d)
}

/** Piyasa takvimine uyan zaman dizisi: kapali saatler ATLANIR. */
function takvimZamanlari (n, bas) {
  const acikMi = createMarketCalendar()
  const out = []
  let t = bas
  while (out.length < n) {
    if (acikMi(t)) out.push(t)
    t += ADIM
  }
  return out
}

/** Iki ozellik vektorunu birebir (bit duzeyinde) karsilastirir. */
function ozellikEsit (a, b, ad) {
  for (const alan of ['shape', 'ret', 'ctx']) {
    assert.equal(a[alan].length, b[alan].length, ad + ': ' + alan + ' uzunlugu degisti')
    for (let i = 0; i < a[alan].length; i++) {
      assert.equal(a[alan][i], b[alan][i], ad + ': ' + alan + '[' + i + '] birebir ayni olmali')
    }
  }
}

test('buildMemory: sentetik seri tek kutu ve iki olay uretir', () => {
  const m = buildMemory(seriKur(400), { tf: '15m' })
  assert.equal(m.tf, '15m')
  assert.deepEqual(m.ctxNames, CTX_NAMES)
  assert.equal(m.zones.length, 1)
  assert.equal(m.stats.totalEvents, 2, 'bir form bir temas olayi beklenir')
  assert.equal(m.stats.stored, m.events.length)
  assert.equal(m.stats.formStored + m.stats.touchStored, m.stats.stored)
  for (const e of m.events) {
    assert.equal(e.features.ctx.length, CTX_NAMES.length, 'baglam vektoru guncel uzunlukta olmali')
    assert.equal(typeof e.outcome, 'string')
    assert.ok(e.atr > 0)
  }
})

// ILERIYE BAKMA YASAGI
// Olayin ozellik vektoru yalnizca olay barina KADARKI veriden uretilmelidir.
// Seri olay barinda kesildiginde ayni olay ayni vektoru vermelidir; vermiyorsa
// hafiza gecmiste bilinmeyen bir bilgiyle ogrenmis olur.
test('buildMemory: olay ozellikleri ILERIYE BAKMAZ (seri olay barinda kesilince ayni)', () => {
  const s = seriKur(400)
  const tam = runIndicator(s, {}, ADIM)
  assert.ok(tam.touches.length >= 2)

  for (const olay of tam.touches) {
    const kesik = series.sliceSeries(s, 0, olay.bar + 1)
    assert.equal(kesik.length, olay.bar + 1)

    const kesikTarama = runIndicator(kesik, {}, ADIM)
    const kesikOlay = kesikTarama.touches.find(
      (t) => t.kind === olay.kind && t.bar === olay.bar
    )
    assert.ok(kesikOlay, olay.kind + ' olayi kesik seride de uretilmeli (bar ' + olay.bar + ')')

    // Olayin kendisi de ileriye bakmamali: gelecek barlar olmadan ayni alanlar.
    for (const alan of ['bar', 'time', 'price', 'zoneTop', 'zoneBottom', 'atr',
      'penetration', 'entryDistAtr', 'bbDistAtr', 'volRatio', 'score', 'maxScore',
      'zoneAgeBars', 'direction', 'isSupport']) {
      assert.equal(kesikOlay[alan], olay[alan], olay.kind + ' olayinin ' + alan + ' alani degisti')
    }

    const tamOzellik = buildFeatures(s, olay, tam.context)
    const kesikOzellik = buildFeatures(kesik, kesikOlay, kesikTarama.context)
    assert.ok(tamOzellik && kesikOzellik, 'iki tarafta da ozellik vektoru uretilmeli')
    ozellikEsit(tamOzellik, kesikOzellik, olay.kind + ' olayi')
  }
})

// ETIKET ILE PLAN AYNI HEDEFI KULLANIR
// targetPrice / invalidPrice elle hesaplanmaz, bolge geometrisinden gelir.
// Ayrilirlarsa "gecmiste %X tuttu" cumlesi ekrandaki TP1'e ait olmaktan cikar.
test('buildMemory: outcome.targetPrice bolge geometrisindeki hedefle AYNI', () => {
  const m = buildMemory(seriKur(400), { tf: '15m' })
  assert.ok(m.events.length > 0)

  for (const e of m.events) {
    const lv = zoneLevels(e, e.atr, DEFAULT_OUTCOME_CFG)
    assert.ok(lv, e.kind + ' olayinda bolge seviyeleri kurulabilmeli')
    assert.equal(e.targetPrice, lv.target, e.kind + ': hedef bolge hedefinden gelmeli')
    assert.equal(e.invalidPrice, lv.invalid, e.kind + ': gecersizlik bolge gecersizliginden gelmeli')
    assert.equal(e.entryPrice, lv.entry, e.kind + ': giris plandaki girisle ayni olmali')
    assert.ok(Math.abs(e.riskAtr - lv.riskAtr) < 1e-12, e.kind + ': riskAtr tutmuyor')
    assert.ok(Math.abs(e.rewardAtr - lv.rewardAtr) < 1e-12, e.kind + ': rewardAtr tutmuyor')

    // Yon tutarliligi: destek olayinda hedef yukarida, gecersizlik asagida.
    if (e.direction === 'BUY') {
      assert.ok(e.targetPrice > e.entryPrice, 'BUY hedefi giristen yukarida olmali')
      assert.ok(e.invalidPrice < e.entryPrice, 'BUY gecersizligi giristen asagida olmali')
    } else {
      assert.ok(e.targetPrice < e.entryPrice, 'SELL hedefi giristen asagida olmali')
      assert.ok(e.invalidPrice > e.entryPrice, 'SELL gecersizligi giristen yukarida olmali')
    }
  }
})

test('buildMemory: ayni barda olusan form ve touch olaylarinin IKISI de saklanir', () => {
  const m = buildMemory(seriKur(400), { tf: '15m' })

  const ayniBar = m.events.filter((e) => e.bar === OLAY_BAR)
  assert.equal(ayniBar.length, 2, 'ayni barda iki olay da hafizada olmali')
  const turler = ayniBar.map((e) => e.kind).sort()
  assert.deepEqual(turler, ['form', 'touch'], 'her iki olay turu de saklanmali')
  assert.equal(m.stats.formStored, 1)
  assert.equal(m.stats.touchStored, 1)

  // Kimlikler ayri, yani biri digerinin uzerine yazilmis degil.
  assert.notEqual(ayniBar[0].id, ayniBar[1].id)
  // Iki tur ayni bolgeden dogar ama ayri kurulumlardir: girisleri farklidir.
  const form = ayniBar.find((e) => e.kind === 'form')
  const temas = ayniBar.find((e) => e.kind === 'touch')
  assert.notEqual(form.entryPrice, temas.entryPrice,
    'kutu olusumunda giris kapanis, temasta bolge kenaridir')

  // Ozet de iki turu ayri sayar.
  const ozet = summarize(m)
  assert.equal(ozet.byKind.form.total, 1)
  assert.equal(ozet.byKind.touch.total, 1)
})

// DUSUK KAPSAMA KORUMASI
// Depoda gercek bosluklar var (olculdu: 2023-02..07 arasi ~479 acik saat
// eksik). Boyle bir pencerede ATR, hacim ortalamasi ve 48 barlik sonuc ufku
// bambaska bir zamana yayilir; olay hafizaya farkli bir sey olcen kayit olarak
// girer. Bu yuzden olay ALINMAZ, yalnizca sayilir.
test('buildMemory: penceresinde GERCEK veri boslugu olan olay hafizaya girmez', () => {
  const acikMi = createMarketCalendar()
  const n = 400
  // Bosluk olay penceresinin (bar 205..303) icinde ve piyasa ACIK saatte.
  const boslukBar = 270
  const zamanlar = new Array(n)
  for (let i = 0; i < n; i++) zamanlar[i] = T0 + i * ADIM + (i >= boslukBar ? 6 * ADIM : 0)

  // Testin dayanagi: atlanan barlar gercekten acik saatte olmali.
  let acikEksik = 0
  for (let t = zamanlar[boslukBar - 1] + ADIM; t < zamanlar[boslukBar]; t += ADIM) {
    if (acikMi(t)) acikEksik++
  }
  assert.ok(acikEksik > 0, 'kurgu gecersiz: atlanan barlar piyasa kapaliya dusmus')

  const bosluklu = buildMemory(seriKur(n, zamanlar), { tf: '15m' })
  assert.equal(bosluklu.stats.totalEvents, 2, 'olaylar yine uretilir')
  assert.equal(bosluklu.stats.labeled, 2, 'olaylar yine etiketlenir')
  assert.equal(bosluklu.stats.lowCoverage, 2, 'iki olay da dusuk kapsama sayilmali')
  assert.equal(bosluklu.stats.stored, 0, 'bosluk icindeki olay hafizaya girmemeli')
  assert.equal(bosluklu.events.length, 0)

  // Kontrol: ayni seride bosluk olmadan olaylar saklanir.
  const saglam = buildMemory(seriKur(n), { tf: '15m' })
  assert.equal(saglam.stats.lowCoverage, 0)
  assert.equal(saglam.stats.stored, 2)
})

// Hafta sonu ve gunluk ara (New York 17:00-18:00) zaman atlamasi yaratir ama
// veri boslugu DEGILDIR. Bu ayrim yapilmadiginda neredeyse tum olaylar
// atiliyordu; bu test o ayrimi kilitler.
test('buildMemory: piyasa KAPALI oldugu icin olusan atlama dusuk kapsama saymaz', () => {
  const n = 400
  // Persembe 12:00 UTC'den itibaren, kapali saatler atlanmis zaman dizisi.
  const zamanlar = takvimZamanlari(n, Date.UTC(2024, 0, 4, 12) / 1000)
  const s = seriKur(n, zamanlar)

  // Testin dayanagi: olay penceresinde en az bir zaman atlamasi bulunmali,
  // yoksa test hicbir sey kanitlamaz.
  let atlama = 0
  for (let i = OLAY_BAR - 49; i <= OLAY_BAR + 48; i++) {
    if (s.time[i] - s.time[i - 1] > 2 * ADIM) atlama++
  }
  assert.ok(atlama > 0, 'kurgu gecersiz: pencerede hic kapali saat atlamasi yok')

  const m = buildMemory(s, { tf: '15m' })
  assert.equal(m.stats.lowCoverage, 0, 'piyasa kapali atlamasi bosluk sayilmamali')
  assert.equal(m.stats.stored, 2, 'olaylar hafizaya girmeli')
})

test('buildMemory: bos seride guvenli sonuc dondurur', () => {
  const m = buildMemory(series.emptySeries(), { tf: '15m' })
  assert.deepEqual(m.events, [])
  assert.equal(m.stats.stored, 0)
  assert.equal(m.stats.lowCoverage, 0)
  assert.deepEqual(m.ctxNames, CTX_NAMES)
})
