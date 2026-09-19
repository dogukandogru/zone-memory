'use strict'

// U7 - GORSEL ILERIYE BAKMA
//
// Kilitlenen sorun: gecmis bir sinyale tiklandiginda grafik, o sinyalden
// SONRASINI da gosteriyordu. En sinsi hali kutulardi: sinyal aninda saglam
// olan bir destek, iki hafta sonra kirildigi icin kesikli ve solgun
// ciziliyordu. Ekrana bakan kisi "zaten kirilacakmis" diye okuyup kendi
// degerlendirmesini gecmise uyduruyordu.
//
// Bu dosya, "o anda ne gorunurdu" kuralini kilitler.

const test = require('node:test')
const assert = require('node:assert')

/** Renderer modulu ESM; dinamik import ile yuklenir. */
async function mod() {
  return await import('../src/renderer/zoneAsOf.mjs')
}

const SAAT = 3600

/** Ornek kutu: 100. saatte dogar, 200. saatte biter. */
function kutu(ek) {
  return Object.assign({
    id: 1,
    isSupport: true,
    top: 2000,
    bottom: 1990,
    createdTime: 100 * SAAT,
    endTime: 200 * SAAT,
    broken: false,
    brokenTime: null,
  }, ek || {})
}

test('zoneSpanAt: kisit yokken kutu kendi araligiyla gelir', async () => {
  const { zoneSpanAt } = await mod()
  const a = zoneSpanAt(kutu(), null)
  assert.deepStrictEqual(a, { start: 100 * SAAT, end: 200 * SAAT })
})

test('zoneSpanAt: o andan sonra dogan kutu HIC cizilmez', async () => {
  const { zoneSpanAt } = await mod()
  // Sinyal 90. saatte; kutu 100. saatte dogacak. O anda ekranda yoktur.
  assert.strictEqual(zoneSpanAt(kutu(), 90 * SAAT), null)
  // Tam dogus aninda gorunur (sinyal cogu zaman kutunun dogdugu bardadir).
  assert.deepStrictEqual(zoneSpanAt(kutu(), 100 * SAAT), { start: 100 * SAAT, end: 100 * SAAT })
})

test('zoneSpanAt: sag kenar o anda durur', async () => {
  const { zoneSpanAt } = await mod()
  const a = zoneSpanAt(kutu(), 150 * SAAT)
  assert.strictEqual(a.start, 100 * SAAT)
  assert.strictEqual(a.end, 150 * SAAT, 'kutu gelecege dogru uzatilmamali')

  // An, kutunun bitisinden sonraysa kirpma olmaz.
  assert.strictEqual(zoneSpanAt(kutu(), 500 * SAAT).end, 200 * SAAT)
})

test('zoneBrokenAt: kirilma o andan SONRAYSA kutu saglam gorunur', async () => {
  const { zoneBrokenAt } = await mod()
  // Cekirdek, kirilan kutuyu o barda kapatir: endTime == kirilma ani.
  const kirik = kutu({ broken: true, endTime: 180 * SAAT, brokenTime: 180 * SAAT })

  // BU TESTIN BUTUN KONUSU: sinyal 120. saatte, kirilma 180. saatte.
  assert.strictEqual(zoneBrokenAt(kirik, 120 * SAAT), false,
    'sinyal aninda kutu henuz kirilmamisti')
  assert.strictEqual(zoneBrokenAt(kirik, 180 * SAAT), true, 'kirilma aninda kirik')
  assert.strictEqual(zoneBrokenAt(kirik, 190 * SAAT), true)
  // Kisit yoksa son durum gecerlidir.
  assert.strictEqual(zoneBrokenAt(kirik, null), true)
  // Hic kirilmamis kutu hicbir anda kirik gorunmez.
  assert.strictEqual(zoneBrokenAt(kutu(), 500 * SAAT), false)
})

test('zoneBrokenAt: brokenTime tasimayan eski kayitlarda sag kenar kullanilir', async () => {
  const { zoneBrokenAt } = await mod()
  const eski = kutu({ broken: true, endTime: 180 * SAAT, brokenTime: null })
  assert.strictEqual(zoneBrokenAt(eski, 120 * SAAT), false)
  assert.strictEqual(zoneBrokenAt(eski, 185 * SAAT), true)
})

test('zoneRightTime: bitis yoksa dogus anina duser, gecersizde NaN', async () => {
  const { zoneRightTime } = await mod()
  assert.strictEqual(zoneRightTime(kutu({ endTime: null })), 100 * SAAT)
  assert.ok(Number.isNaN(zoneRightTime({ createdTime: null, endTime: undefined })))
  assert.ok(Number.isNaN(zoneRightTime(null)))
})

test('zoneSpanAt: ters aralik duzeltilir, gecersiz kutu null doner', async () => {
  const { zoneSpanAt } = await mod()
  const ters = kutu({ endTime: 50 * SAAT })
  assert.deepStrictEqual(zoneSpanAt(ters, null), { start: 100 * SAAT, end: 100 * SAAT })
  assert.strictEqual(zoneSpanAt({ createdTime: 'x', endTime: 'y' }, null), null)
  assert.strictEqual(zoneSpanAt(null, null), null)
})
