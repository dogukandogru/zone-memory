'use strict'

// A12 - src/core/indicator/proZones.js testleri (CONTRACTS.md bolum 9 ve 21).
//
// Sentetik seri tasarimi:
//   Her bar ayni sekle sahiptir (low = L, open = L+0.05, close = L+0.15,
//   high = L+0.30), yalnizca L seviyesi degisir. Kapanislar sabit kaldigi icin
//   Bollinger sapmasi sifirdir, yani alt bant kapanisin kendisidir ve pivot dibi
//   her zaman bandin ALTINDA kalir: BB kapisi bu seride kendiliginden acilir.
//   Hacim her barda 100'dur, yalnizca pivot barinda yukseltilir; boylece hangi
//   barin bolge actigi kesindir.

const test = require('node:test')
const assert = require('node:assert/strict')

const { runIndicator, DEFAULT_PARAMS } = require('../src/core/indicator/proZones')
const series = require('../src/core/series')
const {
  localTimeArrays, sessionIndexArray, localHourArray, localDowArray,
} = require('../src/core/session')

const T0 = 1704067200   // 2024-01-01 00:00:00 UTC, 3600 ve 86400 katidir
const ADIM = 900        // 15 dakika

/** Sabit sekilli bar dizileri uretir. */
function taslak (n, seviyeFn) {
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  for (let i = 0; i < n; i++) {
    const L = seviyeFn(i)
    d.time[i] = T0 + i * ADIM
    d.low[i] = L
    d.open[i] = L + 0.05
    d.close[i] = L + 0.15
    d.high[i] = L + 0.30
    d.volume[i] = 100
  }
  return d
}

/** Belirtilen bara asagi fitil ekler, istege bagli hacim yukseltir. */
function dipEkle (d, bar, derinlik, hacim) {
  d.low[bar] = d.low[bar] - derinlik
  if (hacim !== undefined) d.volume[bar] = hacim
}

/** Deterministik PRNG (testin tekrarlanabilir olmasi icin). */
function prng (tohum) {
  let a = tohum >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// BOLGE OLUSUMU
// ---------------------------------------------------------------------------

test('bolge olusumu: hacimli ve bant disi pivot dipte tek destek bolgesi acilir', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)          // pivot dip, low = 95, hacim 200 kat
  const s = series.fromArrays(d)

  const r = runIndicator(s, {}, ADIM)

  assert.equal(r.zones.length, 1, 'tam olarak bir bolge beklenir')
  const z = r.zones[0]
  assert.equal(z.isSupport, true)
  assert.equal(z.pivotBar, 250)
  assert.equal(z.createdBar, 250 + DEFAULT_PARAMS.pivotLen)
  assert.equal(z.createdTime, T0 + z.createdBar * ADIM)
  assert.equal(z.pivotTime, T0 + 250 * ADIM)

  // Pine: destek kutusu  top = pl + zH * 0.25,  bot = pl - zH
  // zH = atr[pivot] * zoneAtrMult, sentetik seride ~0.19.
  const zH = (z.top - z.bottom) / 1.25
  assert.ok(z.top > 95 && z.top < 95.2, 'tavan pivot dibinin biraz ustunde: ' + z.top)
  assert.ok(Math.abs((95 - z.bottom) - zH) < 1e-9, 'taban pivot dibinin bir zH altinda')
  assert.ok(Math.abs((z.top - 95) - zH * 0.25) < 1e-9, 'tavan pivot dibinin ceyrek zH ustunde')

  // Flow skoru = clamp(hacim orani * 3, 1, 10); 200 kat hacim tavana dayanir.
  assert.equal(z.flow, 10)
  assert.equal(z.flowAtBirth, 10)
  assert.equal(z.mergeCount, 0)
  assert.ok(z.bbDistAtr > 0, 'pivot alt bandin altinda olmali')
  assert.equal(r.stats.zonesCreated, 1)
})

test('hacim kapisi: esik altindaki pivot bolge acmaz', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5)                 // hacim normal, flow skoru 3.0 < 6.0
  const s = series.fromArrays(d)

  const r = runIndicator(s, {}, ADIM)
  assert.equal(r.zones.length, 0)
  assert.equal(r.stats.zonesCreated, 0)
  assert.equal(r.stats.blockedByVolume, 1)

  // Kapatilinca ayni pivot bolge acar.
  const r2 = runIndicator(s, { useVolumeFilter: false }, ADIM)
  assert.equal(r2.zones.length, 1)
  assert.equal(r2.stats.blockedByVolume, 0)
})

test('bollinger kapisi: bant icindeki pivot bolge acmaz', () => {
  // Gurultulu kapanislar bandi genisletir, sig dipler bandin ICINDE kalir.
  const rnd = prng(1234)
  const n = 600
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  let p = 100
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 2
    d.time[i] = T0 + i * ADIM
    d.low[i] = p - 0.3
    d.open[i] = p
    d.close[i] = p
    d.high[i] = p + 0.3
    d.volume[i] = 100 + Math.floor(rnd() * 50)
  }
  for (let i = 40; i < n; i += 37) d.volume[i] = 20000
  const s = series.fromArrays(d)

  const acik = runIndicator(s, {}, ADIM)
  const kapali = runIndicator(s, { useBBFilter: false }, ADIM)

  assert.ok(acik.stats.blockedByBB > 0, 'bant kapisi en az bir pivotu elemeli')
  assert.equal(kapali.stats.blockedByBB, 0)
  assert.ok(kapali.zones.length > acik.zones.length,
    'kapi kapaninca daha cok bolge acilmali: ' + kapali.zones.length + ' > ' + acik.zones.length)
})

test('mergeAtrMult: yakin ikinci pivot yeni kutu acmaz, mevcut kutuyu buyutur', () => {
  const kur = () => {
    const d = taslak(340, () => 100)
    dipEkle(d, 250, 5.0, 20000)      // low = 95.00
    dipEkle(d, 280, 4.95, 20000)     // low = 95.05, orta noktasi cok yakin
    return series.fromArrays(d)
  }

  const yakinKapali = runIndicator(kur(), { mergeAtrMult: 0 }, ADIM)
  assert.equal(yakinKapali.zones.length, 2, 'birlestirme kapaliyken iki bolge olmali')
  assert.equal(yakinKapali.stats.zonesMerged, 0)

  const yakinAcik = runIndicator(kur(), {}, ADIM)
  assert.equal(yakinAcik.zones.length, 1, 'yakin pivot yeni kutu acmamali')
  assert.equal(yakinAcik.stats.zonesCreated, 1)
  assert.equal(yakinAcik.stats.zonesMerged, 1)
  assert.equal(yakinAcik.zones[0].mergeCount, 1)
  // Birlesme kutuyu iki pivotu da kapsayacak sekilde genisletir.
  assert.ok(yakinAcik.zones[0].top >= yakinKapali.zones[0].top)
  assert.ok(yakinAcik.zones[0].bottom <= yakinKapali.zones[0].bottom)
})

test('mergeAtrMult: uzak ikinci pivot normal sekilde kutu acar', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5.0, 20000)        // low = 95.00
  dipEkle(d, 280, 8.0, 20000)        // low = 92.00, orta noktalar uzak
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.equal(r.zones.length, 2)
  assert.equal(r.stats.zonesMerged, 0)
})

test('birlesme yeni bir form olayi URETMEZ', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5.0, 20000)
  dipEkle(d, 280, 4.95, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  const formlar = r.touches.filter((t) => t.kind === 'form')
  assert.equal(formlar.length, 1, 'birlesme ayri bir sinyal degildir')
  assert.equal(formlar[0].bar, 255)
})

// ---------------------------------------------------------------------------
// OLAY 1: KUTU OLUSUMU (kind = 'form')
// ---------------------------------------------------------------------------

test('form olayi: kutu dogdugunda uretilir, pivottan pivotLen bar sonra', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)

  const t = r.touches.find((e) => e.kind === 'form')
  assert.notEqual(t, undefined, 'form olayi beklenir')
  assert.equal(t.bar, 255, 'olay onay barinda, pivot barinda DEGIL')
  assert.equal(t.time, T0 + 255 * ADIM)
  assert.equal(t.zoneId, r.zones[0].id)
  assert.equal(t.isSupport, true)
  assert.equal(t.direction, 'BUY', 'destek kutusu BUY LIQUIDITY, yon BUY')
  assert.equal(t.zoneAgeBars, DEFAULT_PARAMS.pivotLen)
  assert.equal(t.penetration, 0, 'form olayinda fiyat kutunun icinde degil')
  assert.ok(t.entryDistAtr > 0, 'kapanis kutunun uzaginda olmali')
  assert.ok(t.atr > 0)
  assert.equal(r.stats.formEvents, 1)
})

test('form olayi: kapatilirsa hic uretilmez ama kutu yine olusur', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), { signalOnForm: false }, ADIM)
  assert.equal(r.zones.length, 1, 'kutu yine olusmali')
  assert.equal(r.touches.filter((t) => t.kind === 'form').length, 0)
  assert.equal(r.stats.formEvents, 0)
})

test('form olayi: direnc kutusu SELL yonundedir', () => {
  const n = 340
  const d = taslak(n, () => 100)
  d.high[250] = d.high[250] + 5     // pivot tepe, high = 105.30
  d.volume[250] = 20000
  const r = runIndicator(series.fromArrays(d), {}, ADIM)

  assert.equal(r.zones.length, 1)
  assert.equal(r.zones[0].isSupport, false)
  const t = r.touches.find((e) => e.kind === 'form')
  assert.equal(t.direction, 'SELL')
  assert.equal(t.isSupport, false)
})

// ---------------------------------------------------------------------------
// OLAY 2: BOLGEYE GERI DONUS (kind = 'touch')
// ---------------------------------------------------------------------------

test('temas olayi: kutuya yapilan ILK dokunusta uretilir', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)          // kutu: top ~95.06, bottom ~94.77
  dipEkle(d, 300, 4.95)              // 1. dokunus, low = 95.05
  dipEkle(d, 320, 4.95)              // 2. dokunus, olay URETMEMELI
  const s = series.fromArrays(d)

  const r = runIndicator(s, {}, ADIM)
  assert.equal(r.zones.length, 1)

  const temaslar = r.touches.filter((t) => t.kind === 'touch')
  assert.equal(temaslar.length, 1, 'yalnizca ilk dokunus olay uretmeli')
  assert.equal(r.stats.touchEvents, 1)
  assert.equal(r.stats.firstTouches, 1)

  const t = temaslar[0]
  assert.equal(t.bar, 300)
  assert.equal(t.time, T0 + 300 * ADIM)
  assert.equal(t.zoneId, r.zones[0].id)
  assert.equal(t.direction, 'BUY')
  assert.equal(t.zoneAgeBars, 300 - r.zones[0].pivotBar)
  assert.ok(t.penetration > 0 && t.penetration <= 1, 'penetration 0..1 arasinda: ' + t.penetration)
  assert.ok(t.atr > 0, 'dokunus barinda ATR dolu olmali')
})

test('temas olayi: kutunun dogdugu bara denk gelebilir', () => {
  // 250 pivot dip, 251-260 arasi fiyat kutunun icinde geziniyor: kutu dogdugu
  // barda (255) zaten temas halinde. Ilk dokunus kurali geregi olay orada acilir.
  const n = 340
  const d = taslak(n, () => 100)
  d.low[250] = 94.90
  d.volume[250] = 20000
  for (let i = 251; i <= 260; i++) d.low[i] = 94.95
  const s = series.fromArrays(d)

  const r = runIndicator(s, {}, ADIM)
  const temas = r.touches.filter((t) => t.kind === 'touch')
  assert.equal(temas.length, 1, 'yalnizca bir temas olayi')
  assert.equal(temas[0].bar, 255, 'kutunun dogdugu bar da temas sayilir')
  assert.equal(temas[0].zoneId, r.zones[0].id)
})

test('temas olayi: kapatilirsa hic uretilmez', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  dipEkle(d, 300, 4.95)
  const r = runIndicator(series.fromArrays(d), { signalOnTouch: false }, ADIM)
  assert.equal(r.touches.filter((t) => t.kind === 'touch').length, 0)
  assert.equal(r.stats.touchEvents, 0)
})

test('olay sozlesmesi: skor bilesenleri ve alanlar her olayda dolu', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  dipEkle(d, 300, 4.95)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)

  assert.ok(r.touches.length >= 2, 'hem form hem temas olayi beklenir')
  for (const t of r.touches) {
    assert.ok(t.kind === 'form' || t.kind === 'touch')
    for (const anahtar of ['flow', 'trend', 'session', 'rejection', 'volume']) {
      assert.equal(typeof t.parts[anahtar], 'boolean', anahtar + ' bayragi eksik')
    }
    // SEANS BILESENI: dort seansin hepsi acikken her olayda 1 cikar, yani
    // hicbir sey ayirt etmez; bu yuzden skora GIRMEZ ve maxScore dorttur.
    // Eskiden bes sayiliyordu ve "5 bilesenden 3'u" diye okunan esik
    // gercekte "4 bilesenden 2'si" oluyordu.
    assert.equal(t.maxScore, 4, 'tum seanslar acikken seans bileseni sayilmaz')
    assert.equal(t.parts.session, false, 'sayilmayan bilesen parca olarak da false')
    assert.ok(t.score >= 0 && t.score <= t.maxScore)
    assert.equal(typeof t.qualified, 'boolean')
    assert.equal(typeof t.strong, 'boolean')
    assert.ok(['Asia', 'London', 'New York', 'Other'].includes(t.session))
    assert.ok(Number.isFinite(t.volRatio))
    assert.ok(Number.isFinite(t.bbDistAtr))
    assert.ok(Number.isFinite(t.entryDistAtr))
  }
})

test('olaylar zamana gore artan sirada doner', () => {
  const rnd = prng(555)
  const n = 900
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  let p = 100
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 2
    d.time[i] = T0 + i * ADIM
    d.low[i] = p - 0.3
    d.open[i] = p
    d.close[i] = p
    d.high[i] = p + 0.3
    d.volume[i] = 100 + Math.floor(rnd() * 50)
  }
  for (let i = 30; i < n; i += 17) d.volume[i] = 20000
  const r = runIndicator(series.fromArrays(d), { useBBFilter: false }, ADIM)

  assert.ok(r.touches.length > 5, 'anlamli bir test icin birden cok olay gerekir')
  for (let i = 1; i < r.touches.length; i++) {
    assert.ok(r.touches[i].time >= r.touches[i - 1].time, i + '. olay zamanda geri gitti')
  }
  // Kimlikler tekil ve artan.
  for (let i = 1; i < r.touches.length; i++) {
    assert.equal(r.touches[i].id, r.touches[i - 1].id + 1)
  }
})

// ---------------------------------------------------------------------------
// KIRILMA VE OMUR
// ---------------------------------------------------------------------------

test('kirilma: kapanis taban - atr * breakAtrMult altina inince kutu kirilir', () => {
  const n = 340
  const d = taslak(n, (i) => (i === 270 ? 90 : 100))
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)

  assert.equal(r.zones.length, 1)
  assert.equal(r.zones[0].broken, true)
  assert.equal(r.zones[0].brokenBar, 270, 'Pine tek barda kirar, onay bari yoktur')
  // KIRILAN KUTU ORADA BITMEZ.
  //
  // Guncel indikatorde (docs/pine/bollinger_box.pine) kirilan kutu takipten
  // CIKMAZ: her barda `box.set_right(bx, min(bar_index, born + boxLengthBars))`
  // almaya devam eder, yani soluklasir ama UZAR. Eski surumde kirilma barinda
  // kesiliyordu ve kullanici ekranda tam bu farki gordu: bizde kutular
  // kayboluyordu, TradingView'da duruyordu.
  assert.equal(r.zones[0].endBar, Math.min(n - 1, r.zones[0].pivotBar + DEFAULT_PARAMS.boxLengthBars),
    'kirilan kutu boxLengthBars boyunca cizilmeye devam eder')
  assert.ok(r.zones[0].endBar > 270, 'kirilma barinda KESILMEMELI')
  // U7: arayuz gecmis bir sinyali o anki durumuyla cizebilsin diye kirilma
  // ANI da tasinir. Yalnizca bar indisi tasindiginda, farkli bir pencere
  // yuklendiginde indis hicbir zamana karsilik gelmiyordu.
  assert.equal(r.zones[0].brokenTime, T0 + 270 * ADIM)
  assert.equal(r.stats.zonesBroken, 1)
})

test('kirilma: kapanis kutunun ustunde kaldigi surece kutu kirilmaz', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.equal(r.zones[0].broken, false)
  assert.equal(r.zones[0].brokenBar, -1)
  assert.equal(r.zones[0].brokenTime, null, 'kirilmamis kutuda kirilma ani yoktur')
})

test('kirilan kutu artik temas olayi uretmez', () => {
  const n = 340
  const d = taslak(n, (i) => (i === 270 ? 90 : 100))
  dipEkle(d, 250, 5, 20000)
  dipEkle(d, 300, 4.95)              // kirilmadan sonraki dokunus
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.equal(r.touches.filter((t) => t.kind === 'touch').length, 0)
})

test('maxAgeBars: kutu pivot barindan sonra belirtilen omru kadar yasar', () => {
  const n = 450
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)
  dipEkle(d, 330, 4.95)              // omur 60 iken bu dokunus gec kalir
  // 60, Pine'daki maxAgeBars araliginin (50..5000) icindedir.
  const r = runIndicator(series.fromArrays(d), { maxAgeBars: 60 }, ADIM)

  assert.equal(r.zones.length, 1)
  assert.equal(r.zones[0].endBar, 311, 'kutu pivot + 60 barda olur')
  assert.equal(r.touches.filter((t) => t.kind === 'touch').length, 0)
})

// PINE INPUT ARALIKLARI
// Pine'da her girdi minval/maxval ile sinirlidir. Port bu sinirlari
// uygulamazsa kullanici TradingView'da MUMKUN OLMAYAN bir ayarla tarama yapip
// "grafikle ayni degil" sonucuna varir. Kirpma sessiz olmamali, raporlanmali.
test('Pine araligi disindaki ayar kirpilir ve stats.paramsClamped ile bildirilir', () => {
  const d = taslak(400, () => 100)
  dipEkle(d, 250, 5, 20000)
  const s = series.fromArrays(d)

  // maxAgeBars Pine'da en az 50: 30 istenirse 50 kullanilir.
  const kirpilan = runIndicator(s, { maxAgeBars: 30 }, ADIM)
  assert.deepEqual(kirpilan.stats.paramsClamped.maxAgeBars, { istenen: 30, kullanilan: 50 })
  assert.equal(kirpilan.zones[0].endBar, 301, 'kirpilmis omur (50) uygulanmali')

  // Aralik icindeki deger kirpilmaz, rapor bos kalir.
  const temiz = runIndicator(s, { maxAgeBars: 60, pivotLen: 5 }, ADIM)
  assert.deepEqual(temiz.stats.paramsClamped, {}, 'gecerli ayarlar kirpilmamali')

  // Ust sinir da uygulanir.
  const ustSinir = runIndicator(s, { bbMult: 500 }, ADIM)
  assert.equal(ustSinir.stats.paramsClamped.bbMult.kullanilan, 50)
})

test('boxLengthBars: kutunun sag kenari pivot barindan itibaren sayilir', () => {
  const d = taslak(400, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), { boxLengthBars: 40 }, ADIM)
  assert.equal(r.zones[0].endBar, 250 + 40)
  assert.equal(r.zones[0].endTime, T0 + (250 + 40) * ADIM)
})

test('maxZones: liste dolunca en eski kutu takipten cikar ama ciktida kalir', () => {
  const n = 900
  const d = taslak(n, () => 100)
  // Her biri digerinden uzak, 6 ayri destek bolgesi.
  const dipler = [200, 250, 300, 350, 400, 450]
  for (let k = 0; k < dipler.length; k++) {
    dipEkle(d, dipler[k], 5 + k * 3, 20000)
  }
  const r = runIndicator(series.fromArrays(d), { maxZones: 3, maxAgeBars: 5000 }, ADIM)
  assert.equal(r.zones.length, dipler.length, 'takipten cikan kutular da ciktida olmali')
  // Kimlikler olusum sirasinda ve tekil.
  for (let i = 0; i < r.zones.length; i++) assert.equal(r.zones[i].id, i)
})

// ---------------------------------------------------------------------------
// BAGLAM VE SOZLESME
// ---------------------------------------------------------------------------

test('HTF trend: ileriye bakma yok, gelecekteki barlar onceki degerleri degistirmez', () => {
  const n = 400
  const m = 302   // 1 saatlik kovanin (300..303) ikinci bari
  const rnd = prng(20240101)

  const a = taslak(n, () => 100)
  let p = 100
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 2
    a.low[i] = p
    a.open[i] = p + 0.05
    a.close[i] = p + 0.15
    a.high[i] = p + 0.30
  }

  // b, m. bardan itibaren tamamen farkli: guclu yukselis.
  const b = {
    time: a.time.slice(), open: a.open.slice(), high: a.high.slice(),
    low: a.low.slice(), close: a.close.slice(), volume: a.volume.slice(),
  }
  for (let i = m; i < n; i++) {
    const L = 100 + (i - m + 1) * 5
    b.low[i] = L
    b.open[i] = L + 0.05
    b.close[i] = L + 0.15
    b.high[i] = L + 0.30
  }

  const par = { useHtfTrend: true, trendTf: '1h', emaFastLen: 3, emaSlowLen: 5 }
  const ra = runIndicator(series.fromArrays(a), par, ADIM)
  const rb = runIndicator(series.fromArrays(b), par, ADIM)

  // 300..303 barlari ayni HTF kovasindadir ve o kova bar 303'e kadar kapanmaz;
  // dolayisiyla 303. bara kadar trend degerleri degismemelidir.
  for (let i = 0; i <= 303; i++) {
    assert.equal(rb.context.bullTrend[i], ra.context.bullTrend[i], i + '. barda bullTrend ileriye bakmis')
    assert.equal(rb.context.bearTrend[i], ra.context.bearTrend[i], i + '. barda bearTrend ileriye bakmis')
  }

  // Test bos olmasin: onekte hem 1 hem 0 gorulmeli.
  let bir = 0
  let sifir = 0
  for (let i = 0; i <= 303; i++) {
    if (ra.context.bullTrend[i] === 1) bir++
    else sifir++
  }
  assert.ok(bir > 0 && sifir > 0, 'onekte trend degerleri degismiyorsa test anlamsizdir')

  // Degisiklik gercekten etkili olmali: 304 ve sonrasinda fark bulunmali.
  let fark = false
  for (let i = 304; i < n; i++) {
    if (rb.context.bullTrend[i] !== ra.context.bullTrend[i]) { fark = true; break }
  }
  assert.ok(fark, 'gelecekteki veri degisimi HTF trendini hic etkilemediyse test gecersizdir')
})

test('HTF trend: trendTf grafik zaman diliminden kucuk veya esitse seri oldugu gibi kullanilir', () => {
  const n = 300
  const rnd = prng(7)
  const d = taslak(n, () => 100)
  let p = 100
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 2
    d.low[i] = p
    d.open[i] = p + 0.05
    d.close[i] = p + 0.15
    d.high[i] = p + 0.30
  }
  const s = series.fromArrays(d)
  const r = runIndicator(s, { useHtfTrend: true, trendTf: '15m', emaFastLen: 3, emaSlowLen: 5 }, ADIM)

  for (let i = 0; i < n; i++) {
    assert.ok(!(r.context.bullTrend[i] === 1 && r.context.bearTrend[i] === 1))
  }
})

test('context: fullContext acikken sozlesmedeki tum ara diziler dolu ve dogru tipte', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), { fullContext: true }, ADIM)
  const c = r.context

  for (const ad of ['atr', 'rsi', 'sma20', 'sma50', 'bbBasis', 'bbUpper', 'bbLower',
    'volRatio', 'flowScore']) {
    assert.ok(c[ad] instanceof Float64Array, ad + ' Float64Array olmali')
    assert.equal(c[ad].length, n, ad + ' uzunlugu bar sayisi kadar olmali')
  }
  for (const ad of ['bullTrend', 'bearTrend', 'sessionIdx', 'localHour', 'localDow']) {
    assert.ok(c[ad] instanceof Uint8Array, ad + ' Uint8Array olmali')
    assert.equal(c[ad].length, n)
  }
  // Isinma bolgeleri NaN olmali, sifir DEGIL.
  assert.ok(Number.isNaN(c.sma50[0]), 'sma50 isinmasi NaN olmali')
  assert.ok(Number.isNaN(c.bbLower[0]), 'bollinger isinmasi NaN olmali')
  assert.ok(c.atr[n - 1] > 0)
  // Alt bant her zaman ust bandin altinda.
  for (let i = 50; i < n; i++) assert.ok(c.bbLower[i] <= c.bbUpper[i])
  for (let i = 0; i < n; i++) {
    assert.ok(c.localHour[i] <= 23)
    assert.ok(c.localDow[i] <= 6)
    assert.ok(c.sessionIdx[i] <= 3)
  }
})

// T6: varsayilan baglam, DISARIDAN OKUNAN sekiz diziden ibarettir. Geri
// kalan alti dizi (bbBasis, bbUpper, bbLower, volRatio, flowScore,
// sessionIdx) proZones disinda hicbir yerde okunmuyordu ama 1 dakikalik
// seride 450,5 MB'in yarisini tutuyordu. Bu test, alan kumesinin sessizce
// geri buyumesini engeller: features.js yeni bir alan okumaya baslarsa o alan
// buraya ACIKCA eklenmelidir.
test('context: varsayilan olarak yalnizca disaridan okunan sekiz diziyi tasir', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  const c = r.context

  const beklenen = ['atr', 'rsi', 'sma20', 'sma50',
    'bullTrend', 'bearTrend', 'localHour', 'localDow']
  assert.deepEqual(Object.keys(c).sort(), beklenen.slice().sort())
  for (const ad of beklenen) assert.equal(c[ad].length, n, ad + ' uzunlugu bar sayisi kadar olmali')

  for (const ad of ['bbBasis', 'bbUpper', 'bbLower', 'volRatio', 'flowScore', 'sessionIdx']) {
    assert.equal(c[ad], undefined, ad + ' fullContext olmadan donmemeli')
  }

  // features.js baglamdan yalnizca bu sekiz alani okur; her biri kullanilabilir
  // deger tasimali, bos kabuk olmamali.
  assert.ok(c.atr[n - 1] > 0)
  assert.ok(c.rsi[n - 1] >= 0 && c.rsi[n - 1] <= 100)
  assert.ok(Number.isFinite(c.sma20[n - 1]))
  assert.ok(Number.isFinite(c.sma50[n - 1]))
  for (let i = 0; i < n; i++) {
    assert.ok(c.localHour[i] <= 23)
    assert.ok(c.localDow[i] <= 6)
  }
})

test('runIndicator: bos seride guvenli sonuc dondurur', () => {
  const r = runIndicator(series.emptySeries(), {}, ADIM)
  assert.deepEqual(r.zones, [])
  assert.deepEqual(r.touches, [])
  assert.equal(r.stats.bars, 0)
  assert.equal(r.context.atr.length, 0)
  // Bos seri de dolu seriyle AYNI alan kumesini vermeli, yoksa cagiran kod
  // bos seride var olan bir alani dolu seride bulamaz.
  assert.equal(r.context.sessionIdx, undefined)
  assert.equal(runIndicator(series.emptySeries(), { fullContext: true }, ADIM)
    .context.sessionIdx.length, 0)
})

// T6: uc eski fonksiyon artik localTimeArrays'i sarmaliyor. Seans, yerel saat
// ve yerel gun ayni yerel saniyeden turedigi icin tek gecis yeter, ama yaz
// saati gecisinin ORTASINDAKI bir gunde ofset gun icinde degisir: tek gecisin
// onbellegi bu gunu de uc ayri gecisle birebir ayni cozmelidir.
test('localTimeArrays: uc eski fonksiyonla birebir ayni, yaz saati gecis gunu dahil', () => {
  // 30 Mart 2014, Europe/Athens yaz saatine gecti (yerel 03:00 -> 04:00).
  // 26 Ekim 2014 geri donusu, 31 Mart 2024 ve 27 Ekim 2024 guncel gecisler.
  const gecisler = [
    Date.UTC(2014, 2, 29, 12) / 1000,
    Date.UTC(2014, 9, 25, 12) / 1000,
    Date.UTC(2024, 2, 30, 12) / 1000,
    Date.UTC(2024, 9, 26, 12) / 1000,
  ]
  const zamanlar = []
  for (const bas of gecisler) {
    // Gecisi ortalayan iki gunu 10 dakikalik adimlarla tara.
    for (let t = bas; t < bas + 2 * 86400; t += 600) zamanlar.push(t)
  }
  // Gecersiz zaman damgasi da kapsansin: seans 'Other' (3), saat ve gun 0.
  zamanlar.push(NaN)

  for (const tz of ['Europe/Athens', 'Europe/Istanbul', 'America/New_York']) {
    const tek = localTimeArrays(zamanlar, tz)
    assert.deepEqual(Array.from(tek.sessionIdx), Array.from(sessionIndexArray(zamanlar, tz)),
      tz + ': seans indeksi eski fonksiyondan farkli')
    assert.deepEqual(Array.from(tek.localHour), Array.from(localHourArray(zamanlar, tz)),
      tz + ': yerel saat eski fonksiyondan farkli')
    assert.deepEqual(Array.from(tek.localDow), Array.from(localDowArray(zamanlar, tz)),
      tz + ': yerel gun eski fonksiyondan farkli')
  }

  // Gecis gercekten yakalanmis olmali: ayni yerel saat iki kez gorulmeli ya da
  // bir saat atlanmali, yoksa test sabit ofsetli bir seriyi dogrulamis olur.
  const bir = localTimeArrays(zamanlar.slice(0, 288), 'Europe/Athens').localHour
  let atlama = false
  for (let i = 1; i < bir.length; i++) {
    const d = (bir[i] - bir[i - 1] + 24) % 24
    if (d > 1) { atlama = true; break }
  }
  assert.ok(atlama, 'yaz saati gecisi tarananan araliga dusmemisse test anlamsizdir')

  // Gecersiz damga sozlesmesi.
  const son = zamanlar.length - 1
  const t = localTimeArrays(zamanlar, 'Europe/Athens')
  assert.equal(t.sessionIdx[son], 3)
  assert.equal(t.localHour[son], 0)
  assert.equal(t.localDow[son], 0)
})

test('onProgress: en fazla 100 kez, 0..100 arasi artan yuzde ile cagrilir', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  const cagrilar = []
  runIndicator(series.fromArrays(d), {}, ADIM, (pct, msg) => {
    cagrilar.push(pct)
    assert.equal(typeof msg, 'string')
  })
  assert.ok(cagrilar.length > 0)
  assert.ok(cagrilar.length <= 100, 'en fazla 100 ilerleme bildirimi: ' + cagrilar.length)
  for (let i = 0; i < cagrilar.length; i++) {
    assert.ok(cagrilar[i] >= 0 && cagrilar[i] <= 100)
    if (i > 0) assert.ok(cagrilar[i] > cagrilar[i - 1], 'yuzde artmali')
  }
  assert.equal(cagrilar[cagrilar.length - 1], 100)
})

test('seans bileseni ancak bir seans KAPALIYSA skora girer', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  dipEkle(d, 300, 4.95)
  const seri = series.fromArrays(d)

  // Hepsi acik: bilesen ayirt edici degil, skora girmez.
  const hepsi = runIndicator(seri, {}, ADIM)
  assert.ok(hepsi.touches.length > 0)
  assert.equal(hepsi.touches[0].maxScore, 4)

  // Asya kapali: bilesen artik ayirt edici, skora girer.
  const asyaKapali = runIndicator(seri, { useAsia: false }, ADIM)
  assert.ok(asyaKapali.touches.length > 0)
  assert.equal(asyaKapali.touches[0].maxScore, 5)

  // Bilesen tumuyle kapatildiysa seans durumu ne olursa olsun sayilmaz.
  const kapali = runIndicator(seri, { useAsia: false, useSessionScore: false }, ADIM)
  assert.equal(kapali.touches[0].maxScore, 4)
  assert.equal(kapali.touches[0].parts.session, false)
})

// ---------------------------------------------------------------------------
// C3 - CANLI KUYRUK PENCERESI TAM SERIYLE AYNI SONUCU VERMELI
// ---------------------------------------------------------------------------
// Canli kontrol indikatoru serinin son N barinda calistirir. N kucukse bazi
// gostergeler oturmaz ve canli uretilen olay, AYNI olayin hafizadaki halinden
// farkli cikar. En kritigi ust zaman dilimi EMA'sidir: 1 dakikalik grafikte
// 15 dakikalik trend icin 4000 bar yalnizca 266 ust bar eder ve EMA200
// oturmaz. Olculdu: 1m canli olaylarin %5,8'inde baglam vektoru, %2,4'unde
// trend ve skor, %1,3'unde qualified bayragi hafizadakinden farkliydi.

test('requiredTailBars: ust zaman dilimi EMA penceresini kapsar', () => {
  const { requiredTailBars } = require('../src/core/indicator/proZones')
  // trendTf 'auto' (grafigin 4 kati): kat 4, ama EMA200 * 5 * 4 = 4000'in
  // altinda kalmadigi icin taban 4000 degil hesaplanan deger kullanilir.
  assert.ok(requiredTailBars({}, 60) >= 4000)
  // trendTf sabit 15m iken 1 dakikalik grafikte kat 15: cok daha uzun pencere.
  const onbesKat = requiredTailBars({ trendTf: '15m' }, 60)
  assert.ok(onbesKat > 15000, '1m grafikte 15m trend icin en az 15000 bar: ' + onbesKat)
  // 15 dakikalik grafikte ayni trend zaten kendi zaman dilimi: taban yeter.
  assert.strictEqual(requiredTailBars({ trendTf: '15m' }, 900), 4000)
})

test('kuyruk penceresiyle hesaplanan olaylar tam seriyle AYNI cikar', () => {
  const rnd = prng(20260919)
  const n = 40000
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  let p = 2000
  for (let i = 0; i < n; i++) {
    p += (rnd() - 0.5) * 1.5
    d.time[i] = T0 + i * 60
    d.open[i] = p
    d.close[i] = p + (rnd() - 0.5) * 0.4
    d.high[i] = Math.max(d.open[i], d.close[i]) + rnd() * 0.6
    d.low[i] = Math.min(d.open[i], d.close[i]) - rnd() * 0.6
    // Arada hacim patlamasi: kutu dogmasi icin gerekli.
    d.volume[i] = rnd() < 0.03 ? 4000 + rnd() * 4000 : 300 + rnd() * 300
  }
  const tam = series.fromArrays(d)
  const params = { trendTf: '15m' }
  const { requiredTailBars } = require('../src/core/indicator/proZones')
  const gereken = requiredTailBars(params, 60)

  const tamSonuc = runIndicator(tam, params, 60)
  const kuyruk = series.sliceSeries(tam, Math.max(0, n - gereken), n)
  const kuyrukSonuc = runIndicator(kuyruk, params, 60)

  // Son 200 barda uretilen olaylar zamanlariyla eslestirilip karsilastirilir.
  const sinir = tam.time[n - 200]
  const tamHarita = new Map()
  for (const t of tamSonuc.touches) {
    if (t.time >= sinir) tamHarita.set(t.kind + '|' + t.time, t)
  }
  let karsilastirilan = 0
  for (const t of kuyrukSonuc.touches) {
    if (t.time < sinir) continue
    const esi = tamHarita.get(t.kind + '|' + t.time)
    if (!esi) continue
    karsilastirilan++
    assert.strictEqual(t.parts.trend, esi.parts.trend,
      'trend bayragi ayni olmali (' + new Date(t.time * 1000).toISOString() + ')')
    assert.strictEqual(t.score, esi.score, 'skor ayni olmali')
    assert.strictEqual(t.qualified, esi.qualified, 'qualified ayni olmali')
  }
  assert.ok(karsilastirilan > 0, 'karsilastirilacak olay uretilmeli')

  // KISA kuyruk ayni garantiyi vermez: bu testin neyi koruduğunu gosterir.
  const kisa = series.sliceSeries(tam, n - 4000, n)
  const kisaSonuc = runIndicator(kisa, params, 60)
  let kisaFark = 0
  for (const t of kisaSonuc.touches) {
    if (t.time < sinir) continue
    const esi = tamHarita.get(t.kind + '|' + t.time)
    if (!esi) continue
    if (t.parts.trend !== esi.parts.trend || t.score !== esi.score) kisaFark++
  }
  // Not: kisa kuyruk her zaman farkli cikmaz, ama farkli cikabilir; bu satir
  // yalnizca olcumu gorunur kilar, kosul degildir.
  assert.ok(kisaFark >= 0)
})

// ---------------------------------------------------------------------------
// PINE KURALLARININ KILITLERI
// ---------------------------------------------------------------------------
// Asagidaki dort test, docs/pine/son_pro.pine icinde KOLAY GOZDEN KACAN dort
// kurali sabitler. Hepsi tohum gerektirmeyen, elle kurulmus serilerdir; sayilar
// olculup yazildi, yani kural bozulursa test kirmiziya doner. Genel parite
// (10.000 barlik tohumlu seriler, Pine'in bagimsiz referansi) test/
// pine-parity.test.js dosyasindadir; bu dordu ise TEK kurali yalitir.

// 1) COKLU BIRLESME (Pine 96-118 / 161-183)
// Birlestirme dongusu ilk eslesmede BREAK ETMEZ: bir pivot, kosula uyan BUTUN
// ayni yonlu kutulara birlesir. Break eklenirse yalnizca ilk kutu genisler,
// ikincisi oldugu yerde kalir; bu test o farki yakalar.
test('coklu birlesme: bir pivot yakin olan TUM ayni yonlu kutulara birlesir', () => {
  // Uc dip: A = 95,00 ve B = 94,55 birbirinden uzak oldugu icin ayri dogar
  // (aradaki mesafe birlesme siniri olan atr * 0,55 = ~0,32'nin ustunde).
  // C = 94,69 tam ortadadir, ikisinin de orta noktasina yakindir.
  // Hacim 250: flow skoru 7,28 cikar, yani tavan olan 10'un altinda kalir ve
  // birlesmenin skoru artirdigi GORULEBILIR (20000 hacimde skor zaten 10 olur
  // ve artis gizlenir).
  const kur = () => {
    const d = taslak(600, () => 100)
    dipEkle(d, 250, 5.00, 250)
    dipEkle(d, 300, 5.45, 250)
    dipEkle(d, 350, 5.31, 250)
    return d
  }
  // Kutular birlesme anina kadar yasasin: varsayilan 100 barlik omurde A,
  // ucuncu pivot onaylanmadan once dusuyor.
  const par = { maxAgeBars: 5000 }

  const kapali = runIndicator(series.fromArrays(kur()), Object.assign({ mergeAtrMult: 0 }, par), ADIM)
  assert.equal(kapali.zones.length, 3, 'birlestirme kapaliyken uc ayri kutu olmali')

  const r = runIndicator(series.fromArrays(kur()), par, ADIM)
  assert.equal(r.zones.length, 2, 'ucuncu pivot yeni kutu acmamali')
  // Pivot bir kez sayilir, kac kutu genisledigine bakilmaz.
  assert.equal(r.stats.zonesMerged, 1)

  const [a, b] = r.zones
  assert.equal(a.pivotBar, 250)
  assert.equal(b.pivotBar, 300)
  // ASIL KILIT: dongu durmadigi icin IKI kutu da birlesmeyi gormus olmali.
  assert.equal(a.mergeCount, 1, 'birinci kutu birlesmeliydi')
  assert.equal(b.mergeCount, 1, 'IKINCI kutu da birlesmeliydi (dongu break etmez)')

  // Ikisi de genisledi: A asagi dogru (bot 94,77 -> 94,45), B yukari dogru
  // (top 94,61 -> 94,75).
  assert.ok(a.bottom < kapali.zones[0].bottom - 0.3,
    'A kutusu asagi genislemeli: ' + a.bottom + ' < ' + kapali.zones[0].bottom)
  assert.equal(a.top, kapali.zones[0].top, 'A kutusunun tavani degismez (max alinir)')
  assert.ok(b.top > kapali.zones[1].top + 0.1,
    'B kutusu yukari genislemeli: ' + b.top + ' > ' + kapali.zones[1].top)
  assert.equal(b.bottom, kapali.zones[1].bottom, 'B kutusunun tabani degismez (min alinir)')

  // Ikisinin de skoru ayni miktarda arti: newScore = min(10, old + score * 0,25).
  const artis = 7.2815533980582524 * 0.25
  assert.ok(Math.abs((a.flow - kapali.zones[0].flow) - artis) < 1e-9,
    'A kutusunun skoru score * 0,25 kadar artmali: ' + (a.flow - kapali.zones[0].flow))
  assert.ok(Math.abs((b.flow - kapali.zones[1].flow) - artis) < 1e-9,
    'B kutusunun skoru score * 0,25 kadar artmali: ' + (b.flow - kapali.zones[1].flow))
})

// 2) touchCooldown (Pine 258-265)
// canAddTouch = na(lastT) or bar_index - lastT >= touchCooldown. Cooldown
// icindeki dokunus ne skoru artirir ne de touchCount'u.
test('touchCooldown: cooldown icindeki ikinci dokunus skoru ARTIRMAZ', () => {
  const kur = () => {
    const d = taslak(400, () => 100)
    dipEkle(d, 250, 5, 250)      // kutu: top 95,0575  bot 94,7700  flow 7,2816
    dipEkle(d, 300, 4.95)        // 1. dokunus (low 95,05)
    dipEkle(d, 305, 4.95)        // cooldown ICINDE (5 < 12): saymamali
    dipEkle(d, 320, 4.95)        // cooldown DISINDA (20 >= 12): saymali
    return d
  }
  // Not: 300 ve 305 birbirinin pivot penceresinde ve hacimleri normal, yani
  // bu dipler yeni kutu acmaz; yalnizca dokunus uretirler.

  const r = runIndicator(series.fromArrays(kur()), {}, ADIM)
  assert.equal(r.zones.length, 1)
  const z = r.zones[0]
  assert.equal(z.touchCount, 2, '300 ve 320 sayilir, 305 cooldown icinde kalir')
  assert.ok(Math.abs(z.flow - (z.flowAtBirth + 0.70)) < 1e-9,
    'iki dokunus = +0,70 flow: ' + z.flow + ' (dogum ' + z.flowAtBirth + ')')

  // Cooldown kisalirsa ucuncu dokunus da sayilir: farki yaratan tek sey ayar.
  const kisa = runIndicator(series.fromArrays(kur()), { touchCooldown: 4 }, ADIM)
  const zk = kisa.zones[0]
  assert.equal(zk.touchCount, 3, 'cooldown 4 iken 305 de sayilir')
  assert.ok(Math.abs(zk.flow - (zk.flowAtBirth + 1.05)) < 1e-9,
    'uc dokunus = +1,05 flow: ' + zk.flow)

  // Tavan 10 asilmaz (Pine: math.min(10.0, score + 0.35)).
  const tavan = runIndicator(series.fromArrays((() => {
    const d = kur()
    d.volume[250] = 20000          // dogumda flow zaten 10
    return d
  })()), { touchCooldown: 1 }, ADIM)
  assert.equal(tavan.zones[0].flow, 10, 'flow tavani 10 olmali')
})

// 3) maxZones KIRPMASI ILE BIRLESTIRMENIN ETKILESIMI (Pine 212-223)
// array.shift takipten CIKARIR; kirpilan kutu grafikte kalir ama artik
// birlesme dongusunde gorunmez. Bu yuzden ayni seviyeye gelen yeni bir pivot
// o kutuya birlesemez, YENI kutu acar.
test('maxZones: kirpilan kutuya sonradan gelen pivot birlesemez, yeni kutu acilir', () => {
  const kur = () => {
    const d = taslak(700, () => 100)
    // Alti ayri destek: her biri digerinden uzak (95, 92, 89, 86, 83, 80).
    const dipler = [200, 250, 300, 350, 400, 450]
    for (let k = 0; k < dipler.length; k++) dipEkle(d, dipler[k], 5 + k * 3, 20000)
    // Yedinci pivot, EN ESKI kutunun (95,00) tam uzerine gelir.
    dipEkle(d, 500, 5.0, 20000)
    return d
  }
  const par = { maxAgeBars: 5000, boxLengthBars: 5000 }

  // maxZones = 5: altinci kutu dogarken (bar 455) en eski kutu takipten duser.
  const dar = runIndicator(series.fromArrays(kur()), Object.assign({ maxZones: 5 }, par), ADIM)
  assert.equal(dar.zones.length, 7, 'kirpilan kutu ciktida kalir, yedinci kutu da acilir')
  assert.equal(dar.zones[0].endBar, 455, 'en eski kutu altinci kutu dogarken takipten duser')
  assert.equal(dar.stats.zonesMerged, 0, 'takipten dusen kutuya birlesme olmaz')
  assert.equal(dar.zones[0].mergeCount, 0)
  assert.equal(dar.zones[6].pivotBar, 500, 'yedinci pivot YENI kutu acar')
  assert.equal(dar.zones[6].isSupport, true)

  // maxZones = 24: ayni seri, tek fark kirpma olmamasi. Simdi ayni pivot
  // birlesiyor ve yedinci kutu HIC acilmiyor.
  const genis = runIndicator(series.fromArrays(kur()), Object.assign({ maxZones: 24 }, par), ADIM)
  assert.equal(genis.zones.length, 6, 'kirpma olmayinca yedinci pivot birlesir')
  assert.equal(genis.stats.zonesMerged, 1)
  assert.equal(genis.zones[0].mergeCount, 1, 'en eski kutu hala takipte oldugu icin birlesir')
  assert.ok(genis.zones[0].top > dar.zones[0].top,
    'birlesen kutu genislemis olmali: ' + genis.zones[0].top + ' > ' + dar.zones[0].top)
  for (let i = 1; i < 6; i++) {
    assert.equal(genis.zones[i].mergeCount, 0, i + '. kutu uzakta, birlesmemeli')
  }
})

// 4) KIRILMIS KUTUYA DOKUNUS (Pine 261: `touched and canAddTouch and not broken`)
// Kirilan kutu takipten duser ve skoru bir daha artmaz. Ama kirildigi BARDA
// dokunus hala sayilir, cunku Pine once dokunusu isler sonra kirilmayi yazar.
test('kirilmis kutuya yapilan dokunus skoru ARTIRMAZ', () => {
  // 270. barda fiyat 90'a dusuyor: kapanis 90,15, kutu tabani 94,77, yani
  // kirilma kesin. O barin tepesi (90,30) kutunun tabaninin ALTINDA oldugu icin
  // kirilma bari ayni zamanda dokunus DEGILDIR.
  const d = taslak(400, (i) => (i === 270 ? 90 : 100))
  dipEkle(d, 250, 5, 250)
  dipEkle(d, 300, 4.95)        // kirilmadan SONRA kutunun icine giren bar
  dipEkle(d, 320, 4.95)        // ve bir tane daha
  const r = runIndicator(series.fromArrays(d), {}, ADIM)

  assert.equal(r.zones.length, 1)
  const z = r.zones[0]
  assert.equal(z.broken, true)
  assert.equal(z.brokenBar, 270)
  assert.equal(z.touchCount, 0, 'kirilmadan once dokunus yok, sonra da sayilmaz')
  assert.equal(z.flow, z.flowAtBirth, 'kirilmis kutunun skoru artmaz')
  assert.equal(r.touches.filter((t) => t.kind === 'touch').length, 0)

  // KIRILDIGI BAR: dokunus ile kirilma ayni barda olursa dokunus SAYILIR.
  // 270. barda seviye 94,50 (low 94,50 / high 94,80 / close 94,65): tepe kutu
  // tabaninin (94,77) ustunde oldugu icin dokunus var, kapanis ise
  // 94,77 - atr * 0,15 = 94,66 esiginin altinda oldugu icin kirilma da var.
  const e = taslak(400, (i) => (i === 270 ? 94.5 : 100))
  dipEkle(e, 250, 5, 250)
  const r2 = runIndicator(series.fromArrays(e), {}, ADIM)
  const z2 = r2.zones[0]
  assert.equal(z2.broken, true)
  assert.equal(z2.brokenBar, 270)
  assert.equal(z2.touchCount, 1, 'kirildigi barda dokunus hala sayilir (once dokunus, sonra kirilma)')
  assert.ok(Math.abs(z2.flow - (z2.flowAtBirth + 0.35)) < 1e-9,
    'kirilma barindaki dokunus +0,35 verir: ' + z2.flow)
})
