'use strict'

// Y3 - src/core/learn/htfContext.js testleri.
//
// Buradaki tek konu ZAMANLAMADIR. Ust zaman dilimi bolgesini bir alt zaman
// dilimi olayina eklerken iki sessiz sizinti mumkundur:
//
//   1. Kutuyu barin ACILISINDAN itibaren bilmek. Kutu ust zaman dilimi bari
//      KAPANDIKTAN sonra onaylanir; daha once gormek ileriye bakmaktir.
//   2. Kutunun NIHAI sinirlarini bastan bilmek. Birlesme sinirlari genisletir;
//      genislemeden onceki kararlar eski sinirlari gormelidir.
//
// Olculdu: naif zamanlamayla 5m formda "aktif 1h kutusu yakini" %53,0'a karsi
// %45,8 gorunuyor (+7 puan); dogru zamanlamayla %48,1'e karsi %46,1 ve
// araliklar ortusuyor. Yani bu testler olmazsa var olmayan bir katki
// raporlanir.

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildHtfIndex, htfAt, htfSubset } = require('../src/core/learn/htfContext')
const { runIndicator } = require('../src/core/indicator/proZones')
const series = require('../src/core/series')

const SAAT = 3600
const T0 = 1600000000

test('kutu ust TF bari KAPANMADAN once gorunmez', () => {
  // 1h kutusu: bar 10:00'da acildi, 11:00'da kapandi. knownFrom 11:00 olmali.
  const kapanis = T0 + 11 * SAAT
  const idx = buildHtfIndex([
    { zoneId: 1, isSupport: true, top: 100, bottom: 99, knownFrom: kapanis, knownTo: null },
  ])

  // Karar ani kapanistan bir saniye ONCE: kutu bilinmiyor.
  const once = htfAt(idx, kapanis - 1, 99.5, 'BUY', { atr: 1 })
  assert.equal(once.same, false, 'kapanistan once kutu gorunmemeli')
  assert.equal(once.count, 0)

  // Kapanis aninda: biliniyor.
  const tam = htfAt(idx, kapanis, 99.5, 'BUY', { atr: 1 })
  assert.equal(tam.same, true)
  assert.equal(tam.sameInside, true, 'fiyat bolgenin icinde')
  assert.equal(tam.count, 1)
})

test('birlesmeden ONCEKI karar eski sinirlari gorur', () => {
  const t1 = T0 + 10 * SAAT   // ilk aralik burada acildi
  const t2 = T0 + 20 * SAAT   // birlesme: sinirlar genisledi
  const idx = buildHtfIndex([
    { zoneId: 1, isSupport: true, top: 100, bottom: 99, knownFrom: t1, knownTo: t2 },
    { zoneId: 1, isSupport: true, top: 100, bottom: 95, knownFrom: t2, knownTo: null },
  ])

  // 96 fiyati YALNIZCA genis sinirlarin icinde. Birlesmeden once, ATR payi
  // olmadan, bu fiyat bolgenin icinde SAYILMAMALI.
  const once = htfAt(idx, t2 - 1, 96, 'BUY', { atr: 0 })
  assert.equal(once.sameInside, false, 'birlesmeden once genis sinir bilinmiyordu')

  // Birlesmeden sonra ayni fiyat bolgenin icinde.
  const sonra = htfAt(idx, t2, 96, 'BUY', { atr: 0 })
  assert.equal(sonra.sameInside, true)
})

test('kirilma bari KAPANMADAN once kutu hala etkin sayilir', () => {
  const acilis = T0 + 5 * SAAT
  const kirilmaKapanis = T0 + 30 * SAAT
  const idx = buildHtfIndex([
    { zoneId: 1, isSupport: true, top: 100, bottom: 99, knownFrom: acilis, knownTo: kirilmaKapanis },
  ])

  // Kirilma barinin kapanisindan hemen once: kutu hala etkin.
  const once = htfAt(idx, kirilmaKapanis - 1, 99.5, 'BUY', { atr: 0 })
  assert.equal(once.same, true, 'kirilma kapanista bilinir, oncesinde kutu etkindir')

  // Kapanis aninda ve sonrasinda: artik etkin degil.
  assert.equal(htfAt(idx, kirilmaKapanis, 99.5, 'BUY', { atr: 0 }).same, false)
  assert.equal(htfAt(idx, kirilmaKapanis + SAAT, 99.5, 'BUY', { atr: 0 }).same, false)
})

test('yon ayrimi: BUY icin destek ayni yon, direnc ters yon', () => {
  const t = T0 + 10 * SAAT
  const idx = buildHtfIndex([
    { zoneId: 1, isSupport: true, top: 100, bottom: 99, knownFrom: t, knownTo: null },
    { zoneId: 2, isSupport: false, top: 105, bottom: 104, knownFrom: t, knownTo: null },
  ])

  const alis = htfAt(idx, t, 99.5, 'BUY', { atr: 0 })
  assert.equal(alis.same, true, 'BUY icin destek ayni yon')
  assert.equal(alis.opposite, false, 'direnc uzakta, yakin sayilmamali')
  assert.equal(htfSubset(alis), 'aynı yön yakın')

  const satis = htfAt(idx, t, 99.5, 'SELL', { atr: 0 })
  assert.equal(satis.same, false, 'SELL icin destek TERS yon')
  assert.equal(satis.opposite, true)
  assert.equal(htfSubset(satis), 'ters yön yakın')

  // Ikisinin arasinda ve ATR payi genisse ikisi de yakin.
  const ikisi = htfAt(idx, t, 102, 'BUY', { atr: 4, nearAtr: 1 })
  assert.equal(ikisi.same, true)
  assert.equal(ikisi.opposite, true)
  assert.equal(htfSubset(ikisi), 'ikisi de yakın')
})

test('ATR payi: bolge disindaki fiyat yalnizca pay kadar yakinsa sayilir', () => {
  const t = T0 + 10 * SAAT
  const idx = buildHtfIndex([
    { zoneId: 1, isSupport: true, top: 100, bottom: 99, knownFrom: t, knownTo: null },
  ])
  // 0,5 ATR payi, ATR 2 => 1 birim pay. 100,5 yakin, 101,5 degil.
  assert.equal(htfAt(idx, t, 100.5, 'BUY', { atr: 2, nearAtr: 0.5 }).same, true)
  assert.equal(htfAt(idx, t, 101.5, 'BUY', { atr: 2, nearAtr: 0.5 }).same, false)
  // Pay yoksa yalnizca bolge ICI sayilir.
  assert.equal(htfAt(idx, t, 100.5, 'BUY', { atr: 0 }).same, false)
})

test('bos ya da bozuk cizelgede guvenli sonuc doner', () => {
  assert.equal(htfAt(buildHtfIndex([]), T0, 100, 'BUY', {}).same, false)
  assert.equal(htfAt(null, T0, 100, 'BUY', {}).count, 0)
  assert.equal(htfSubset(null), 'yok')
  const bozuk = buildHtfIndex([{ zoneId: 1, knownFrom: NaN, top: 1, bottom: 0 }, null])
  assert.equal(bozuk.rows.length, 0)
})

// ---------------------------------------------------------------------------
// INDIKATOR CIKTISIYLA UCTAN UCA
// ---------------------------------------------------------------------------

/** Hacim patlamasi ve fitille kutu doguran sentetik seri. */
function seriKur (n, adim) {
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  for (let i = 0; i < n; i++) {
    const L = 100
    d.time[i] = T0 + i * adim
    d.low[i] = L
    d.open[i] = L + 0.05
    d.close[i] = L + 0.15
    d.high[i] = L + 0.30
    d.volume[i] = 100
  }
  return d
}

test('recordTimeline: varsayilan kapali, acikken araliklar bar KAPANISINDAN baslar', () => {
  const adim = 900
  const d = seriKur(340, adim)
  // Iki dip: kutu dogurur.
  d.low[250] -= 5
  d.volume[250] = 20000
  d.low[300] -= 4.95
  const s = series.fromArrays(d)

  const kapali = runIndicator(s, {}, adim)
  assert.equal(kapali.timeline, null, 'varsayilan olarak cizelge tutulmaz')

  const acik = runIndicator(s, { recordTimeline: true }, adim)
  assert.ok(Array.isArray(acik.timeline), 'cizelge dizi olmali')
  assert.ok(acik.timeline.length > 0, 'en az bir aralik beklenir')
  // Kutu sayisi ve olaylar DEGISMEMELI: cizelge yalnizca kayittir.
  assert.equal(acik.zones.length, kapali.zones.length)
  assert.equal(acik.touches.length, kapali.touches.length)

  for (const a of acik.timeline) {
    assert.ok(Number.isFinite(a.knownFrom))
    assert.ok(a.knownTo === null || a.knownTo > a.knownFrom)
    assert.ok(a.top >= a.bottom)
    // Aralik BASLANGICI bir bar KAPANISIDIR, yani bar zamanina adim eklenmis
    // olmalidir: (knownFrom - T0) adimın katı ve sifirdan buyuk.
    assert.equal((a.knownFrom - T0) % adim, 0)
    assert.ok(a.knownFrom > T0)
  }

  // Ilk kutunun dogdugu olayla (form) cizelgenin ilk araligi tutarli olmali:
  // form olayinin karar ani da onay barinin kapanisidir.
  const form = acik.touches.find((t) => t.kind === 'form')
  if (form) {
    const eslesen = acik.timeline.find((a) => a.zoneId === form.zoneId)
    assert.ok(eslesen, 'form olayinin kutusu cizelgede olmali')
    assert.equal(eslesen.knownFrom, form.time + adim,
      'aralik onay barinin kapanisinda baslar')
  }
})

test('naif zamanlama (bar acilisi + nihai sinirlar) testi GECEMEZ', () => {
  const t1 = T0 + 10 * SAAT
  const t2 = T0 + 20 * SAAT
  // Dogru cizelge: birlesme oncesi dar, sonrasi genis.
  const dogru = buildHtfIndex([
    { zoneId: 1, isSupport: true, top: 100, bottom: 99, knownFrom: t1, knownTo: t2 },
    { zoneId: 1, isSupport: true, top: 100, bottom: 95, knownFrom: t2, knownTo: null },
  ])
  // NAIF cizelge: kutu bar ACILISINDAN itibaren NIHAI sinirlariyla bilinir.
  const naif = buildHtfIndex([
    { zoneId: 1, isSupport: true, top: 100, bottom: 95, knownFrom: t1 - SAAT, knownTo: null },
  ])

  const karar = t1 - SAAT / 2   // kutu daha onaylanmadi
  assert.equal(htfAt(dogru, karar, 96, 'BUY', { atr: 0 }).same, false,
    'dogru cizelgede kutu daha bilinmiyor')
  assert.equal(htfAt(naif, karar, 96, 'BUY', { atr: 0 }).same, true,
    'naif cizelge onaylanmamis kutuyu gosterir: bu tam olarak onlenen hata')
})
