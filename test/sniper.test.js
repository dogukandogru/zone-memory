'use strict'

// SNIPER SINYALI (docs/pine/bollinger_box.pine, satir 336-372)
//
// Guncel indikator kendi sinyalini uretiyor. Eski surumde Pine hic sinyal
// uretmiyordu; `form` ve `touch` olaylari bu portun ekiydi.
//
// Sinyal COK secici: fiyatin kutunun disina sarkip ICINE kapanmasi
// (likidite supurmesi), fitil reddi, yapi kirilimi (MSS), EMA trend uyumu
// ve bilesik skor esigi birlikte aranir. Burada her kosul TEK TEK kilitlenir,
// cunku bir kosulun sessizce kalkmasi sinyal sayisini yuzlerce kat degistirir
// (olculdu: MSS kapatilinca 20 yillik seride 7 yerine 332 sinyal).
//
// KAYITTA AYRI BIR TUR DEGILDIR. Sniper, `kind: 'touch'` olarak yazilir ve
// `sniper: true` bayragini tasir. Bir donem `kind: 'sniper'` yaziliyordu ve
// bu kayitlar hafizada OLU kaliyordu: komsu suzgeci ham turu karsilastirdigi
// icin hicbir komsuyla eslesmiyor, buna karsilik olcumde dokunus kovasina
// giriyorlardi. 20 yilda 15m'de 7, 5m'de 2 sniper var; kendi kovasini kuracak
// sayi degil.

const test = require('node:test')
const assert = require('node:assert')

const { runIndicator, DEFAULT_PARAMS } = require('../src/core/indicator/proZones')
const series = require('../src/core/series')

const T0 = 1704067200
const ADIM = 900

/** Sabit sekilli bar dizisi (indicator.test.js ile ayni tasarim). */
function taslak(n, seviyeFn) {
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [] }
  for (let i = 0; i < n; i++) {
    const L = seviyeFn(i)
    d.time.push(T0 + i * ADIM)
    d.low.push(L)
    d.open.push(L + 0.05)
    d.close.push(L + 0.15)
    d.high.push(L + 0.30)
    d.volume.push(100)
  }
  return d
}

test('sniper varsayilan olarak acik ve Pine girdileriyle ayni', () => {
  assert.strictEqual(DEFAULT_PARAMS.signalOnSniper, true)
  assert.strictEqual(DEFAULT_PARAMS.mssLen, 8)
  assert.strictEqual(DEFAULT_PARAMS.useMSS, true)
  assert.strictEqual(DEFAULT_PARAMS.wickRejectMin, 0.42)
  assert.strictEqual(DEFAULT_PARAMS.sniperEmaFastLen, 21)
  assert.strictEqual(DEFAULT_PARAMS.sniperEmaSlowLen, 55)
  assert.strictEqual(DEFAULT_PARAMS.useTrendFilter, true)
  assert.strictEqual(DEFAULT_PARAMS.minSniperScore, 7.2)
  assert.strictEqual(DEFAULT_PARAMS.signalOnceZone, true)
  assert.strictEqual(DEFAULT_PARAMS.useFVGBonus, true)
})

/**
 * Destek kutusu dogurup ustunde bir SUPURME bari kuran seri.
 *
 * Supurme: bar kutunun ALTINA sarkar ama ICINE kapanir. Ayrica uzun alt
 * fitil (fitil reddi) ve yapi kirilimi (kapanis onceki 8 barin en yuksegini
 * asar) gerekir.
 */
function supurmeSerisi(opts) {
  const o = opts || {}
  const n = 340
  const d = taslak(n, () => 100)
  // Hacimli ve bant disi pivot dip: kutu dogar (indicator.test.js ile ayni).
  d.low[250] = 95
  d.volume[250] = 20000

  const bar = o.bar === undefined ? 300 : o.bar
  // Kutu yaklasik 94,x - 95,y araliginda olur. Supurme bari: alti delip
  // icine kapanir, uzun alt fitil birakir ve onceki barlarin ustune cikar.
  d.low[bar] = 93
  d.open[bar] = 99.9
  d.close[bar] = o.kapanis === undefined ? 101.0 : o.kapanis
  d.high[bar] = o.yuksek === undefined ? 101.1 : o.yuksek
  d.volume[bar] = 5000
  return { d: d, bar: bar }
}

test('supurme + fitil + MSS + trend saglaninca sniper sinyali uretilir', () => {
  const { d, bar } = supurmeSerisi({})
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  const sn = r.touches.filter((x) => x.sniper)
  assert.ok(sn.length >= 1, 'en az bir sniper sinyali bekleniyordu, stats: ' +
    JSON.stringify({ supurme: r.stats.sniperSweeps, fitil: r.stats.sniperBlockedWick,
      mss: r.stats.sniperBlockedMss, trend: r.stats.sniperBlockedTrend,
      skor: r.stats.sniperBlockedScore }))
  assert.strictEqual(sn[0].direction, 'BUY', 'destek kutusunda sinyal ALIS yonunde olmali')
  assert.strictEqual(sn[0].bar, bar)
  assert.ok(sn[0].sniperScore >= DEFAULT_PARAMS.minSniperScore,
    'olay kaydi Pine skorunu tasimali: ' + sn[0].sniperScore)
})

test('signalOnSniper kapaliyken hic sniper olayi uretilmez', () => {
  const { d } = supurmeSerisi({})
  const r = runIndicator(series.fromArrays(d), { signalOnSniper: false }, ADIM)
  assert.strictEqual(r.touches.filter((x) => x.sniper).length, 0)
  assert.strictEqual(r.stats.sniperEvents, 0)
})

// HER KOSUL AYRI AYRI KILITLENIR.
//
// Bir kosulun sessizce kalkmasi sinyal sayisini yuzlerce kat degistirir.
// Asagidaki her test, TEK bir kosulu saglanamaz hale getirip sinyalin
// kayboldugunu ve DOGRU sayacin arttigini dogrular.

test('supurme yoksa sinyal yok: fiyat kutunun altina sarkmali', () => {
  const { d, bar } = supurmeSerisi({})
  // Alt fitili kutunun icinde birak: artik supurme degil.
  d.low[bar] = 95.5
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.strictEqual(r.touches.filter((x) => x.sniper).length, 0)
})

test('fitil reddi esigin altindaysa sinyal yok', () => {
  const { d } = supurmeSerisi({})
  const r = runIndicator(series.fromArrays(d), { wickRejectMin: 0.99 }, ADIM)
  assert.strictEqual(r.touches.filter((x) => x.sniper).length, 0)
  assert.ok(r.stats.sniperBlockedWick > 0, 'fitil sayaci artmali')
})

test('MSS saglanmazsa sinyal yok, useMSS kapatilinca geri gelir', () => {
  const { d, bar } = supurmeSerisi({})
  // Onceki barlarin yuksegini kapanisin USTUNE cikar: yapi kirilimi olmaz.
  for (let j = bar - 8; j < bar; j++) d.high[j] = 200
  const kapali = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.strictEqual(kapali.touches.filter((x) => x.sniper).length, 0)
  assert.ok(kapali.stats.sniperBlockedMss > 0, 'MSS sayaci artmali')

  const acik = runIndicator(series.fromArrays(d), { useMSS: false }, ADIM)
  assert.ok(acik.touches.filter((x) => x.sniper).length >= 1,
    'useMSS kapatilinca ayni seride sinyal cikmali')
})

test('minSniperScore cok yuksekse sinyal yok', () => {
  const { d } = supurmeSerisi({})
  const r = runIndicator(series.fromArrays(d), { minSniperScore: 99 }, ADIM)
  assert.strictEqual(r.touches.filter((x) => x.sniper).length, 0)
  assert.ok(r.stats.sniperBlockedScore > 0, 'skor sayaci artmali')
})

test('signalOnceZone: ayni bolge ikinci kez sinyal vermez', () => {
  const { d, bar } = supurmeSerisi({})
  // Ayni kutuda ikinci bir supurme bari kur.
  const ikinci = bar + 20
  d.low[ikinci] = 93
  d.open[ikinci] = 99.9
  d.close[ikinci] = 101.0
  d.high[ikinci] = 101.1
  d.volume[ikinci] = 5000

  const tek = runIndicator(series.fromArrays(d), {}, ADIM)
  const cok = runIndicator(series.fromArrays(d), { signalOnceZone: false }, ADIM)
  const s1 = tek.touches.filter((x) => x.sniper)
  const s2 = cok.touches.filter((x) => x.sniper)
  assert.strictEqual(s1.length, 1, 'signalOnceZone acikken bolge basina tek sinyal')
  assert.ok(s2.length > s1.length, 'kapatilinca ikinci sinyal de cikmali')
})

test('kirilmis kutu sniper sinyali uretmez', () => {
  const { d, bar } = supurmeSerisi({})
  // Supurmeden ONCE kutuyu kir: kapanis tabanin cok altina insin.
  d.close[bar - 5] = 80
  d.low[bar - 5] = 79
  d.open[bar - 5] = 81
  d.high[bar - 5] = 81
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.strictEqual(r.touches.filter((x) => x.sniper).length, 0,
    'kirilan kutu listede kalsa bile sinyal vermemeli')
})

test('sniper kayitta AYRI TUR degil, nitelenmis dokunustur', () => {
  const { d } = supurmeSerisi({})
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  const sn = r.touches.filter((x) => x.sniper)
  assert.ok(sn.length >= 1, 'once sinyal uretilmeli')
  for (const e of sn) {
    // Ayri tur yazilsaydi komsu aramasinda hicbir zaman eslesmezdi.
    assert.strictEqual(e.kind, 'touch', 'sniper dokunus kovasinda kalmali')
  }
  assert.strictEqual(r.touches.filter((x) => x.kind === 'sniper').length, 0,
    "'sniper' diye bir olay turu artik yazilmiyor")
})

test('ayni bar + ayni kutuda IKIZ kayit acilmaz, mevcut dokunus nitelenir', () => {
  const { d } = supurmeSerisi({})
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  // Ayni piyasa aninin iki kez sayilmasi olcumu bozardi: olculdu, 15m'de
  // 7 sniperin 3'u zaten bir dokunus olayinin ustune denk geliyordu.
  const sayac = new Map()
  for (const e of r.touches) {
    if (e.kind !== 'touch') continue
    const anahtar = e.bar + '|' + e.zoneId
    sayac.set(anahtar, (sayac.get(anahtar) || 0) + 1)
  }
  for (const [anahtar, adet] of sayac) {
    assert.strictEqual(adet, 1, 'ayni bar/kutu icin tek dokunus kaydi olmali: ' + anahtar)
  }
})
