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
    assert.equal(t.maxScore, 5, 'varsayilanda bes skor bileseni acik')
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
  assert.equal(r.zones[0].endBar, 270, 'kirilan kutu orada biter')
  assert.equal(r.stats.zonesBroken, 1)
})

test('kirilma: kapanis kutunun ustunde kaldigi surece kutu kirilmaz', () => {
  const d = taslak(340, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
  assert.equal(r.zones[0].broken, false)
  assert.equal(r.zones[0].brokenBar, -1)
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

test('context: sozlesmedeki tum ara diziler dolu ve dogru tipte', () => {
  const n = 340
  const d = taslak(n, () => 100)
  dipEkle(d, 250, 5, 20000)
  const r = runIndicator(series.fromArrays(d), {}, ADIM)
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

test('runIndicator: bos seride guvenli sonuc dondurur', () => {
  const r = runIndicator(series.emptySeries(), {}, ADIM)
  assert.deepEqual(r.zones, [])
  assert.deepEqual(r.touches, [])
  assert.equal(r.stats.bars, 0)
  assert.equal(r.context.atr.length, 0)
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
