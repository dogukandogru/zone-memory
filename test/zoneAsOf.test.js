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

/**
 * Ornek kutu.
 *
 * Pivot 95. saatte, ONAY 100. saatte (Pine: pivot ancak pivotLen bar sonra
 * kesinlesir), bitis 200. saatte. Iki zamanin AYRI olmasi onemli: kutu
 * pivottan CIZILIR ama ancak onaydan sonra GORUNUR.
 */
function kutu(ek) {
  return Object.assign({
    id: 1,
    isSupport: true,
    top: 2000,
    bottom: 1990,
    pivotTime: 95 * SAAT,
    createdTime: 100 * SAAT,
    endTime: 200 * SAAT,
    broken: false,
    brokenTime: null,
  }, ek || {})
}

test('zoneSpanAt: sol kenar PIVOT barindan baslar, onay barindan degil', async () => {
  const { zoneSpanAt } = await mod()
  const a = zoneSpanAt(kutu(), null)
  // Pine: box.new(left = bar_index - pivotLen) -> pivot bari.
  // Port bir donem onay barindan basliyordu ve kutular TradingView'a gore
  // soldan bes bar kirpik ciziliyordu.
  assert.deepStrictEqual(a, { start: 95 * SAAT, end: 200 * SAAT })

  // pivotTime tasimayan eski kayitlarda onay barina duser.
  const eski = kutu({ pivotTime: null })
  assert.strictEqual(zoneSpanAt(eski, null).start, 100 * SAAT)
})

test('zoneSpanAt: henuz ONAYLANMAMIS kutu HIC cizilmez', async () => {
  const { zoneSpanAt } = await mod()
  // Sinyal 90. saatte. Kutunun pivotu 95, onayi 100: o anda kutu BILINMIYOR.
  assert.strictEqual(zoneSpanAt(kutu(), 90 * SAAT), null)
  // Pivot gecmis olsa bile onay gelmediyse yine gorunmez. ILERIYE BAKMA
  // KORUMASI BURADA: pivot 95'te ama kutu 100'den once cizilemez.
  assert.strictEqual(zoneSpanAt(kutu(), 97 * SAAT), null)
  // Onay aninda gorunur ve sol kenari PIVOTA kadar uzanir.
  assert.deepStrictEqual(zoneSpanAt(kutu(), 100 * SAAT), { start: 95 * SAAT, end: 100 * SAAT })
})

test('zoneSpanAt: sag kenar o anda durur', async () => {
  const { zoneSpanAt } = await mod()
  const a = zoneSpanAt(kutu(), 150 * SAAT)
  assert.strictEqual(a.start, 95 * SAAT)
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
  assert.deepStrictEqual(zoneSpanAt(ters, null), { start: 95 * SAAT, end: 95 * SAAT })
  assert.strictEqual(zoneSpanAt({ createdTime: 'x', endTime: 'y' }, null), null)
  assert.strictEqual(zoneSpanAt(null, null), null)
})
