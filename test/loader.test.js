// Vekil kaynak duzeltmesi ve piyasa takvimi. Canli dongu bir donem basis
// hesaplanamadiginda HAM PAXG barlarini depoya yaziyordu; bir kez ham bar
// girdikten sonra basis 0 cikip duzeltme kalici olarak kapaniyordu.
const test = require('node:test')
const assert = require('node:assert')

const loader = require('../src/core/data/loader')
const series = require('../src/core/series')
const { createMarketCalendar } = require('../src/core/session')

const DK = 60

/** Duzenli araliklarla sentetik seri uretir. */
function seriUret(baslangic, adet, tfSec, fiyat, hacim) {
  const s = series.createSeries(adet)
  for (let i = 0; i < adet; i++) {
    const p = fiyat + i * 0.1
    s.time[i] = baslangic + i * tfSec
    s.open[i] = p
    s.high[i] = p + 0.5
    s.low[i] = p - 0.5
    s.close[i] = p
    s.volume[i] = hacim
  }
  return s
}

test('computeBasis: ortak bar yoksa veya cok azsa null doner', () => {
  const spot = seriUret(Date.UTC(2026, 0, 5, 10) / 1000, 100, DK, 2000, 90)
  // Hic ortak zaman damgasi yok (30 dakika kaydirilmis ve cok ileride).
  const uzak = seriUret(Date.UTC(2026, 5, 5, 10) / 1000, 100, DK, 1990, 0.4)
  assert.strictEqual(loader.computeBasis(spot, uzak, 400), null)

  // 10 ortak bar var ama esik 30.
  const az = seriUret(Date.UTC(2026, 0, 5, 11, 30) / 1000, 10, DK, 1990, 0.4)
  assert.strictEqual(loader.computeBasis(spot, az, 400), null)

  // 40 ortak barla gercek fark bulunur.
  const yeterli = seriUret(Date.UTC(2026, 0, 5, 10) / 1000, 40, DK, 1990, 0.4)
  assert.strictEqual(loader.computeBasis(spot, yeterli, 400), 10)
})

test('hacimOlcegi: ortak hacim yoksa null, varsa medyan oran', () => {
  const spot = seriUret(Date.UTC(2026, 0, 5, 10) / 1000, 100, DK, 2000, 90)
  const vekil = seriUret(Date.UTC(2026, 0, 5, 10) / 1000, 100, DK, 1990, 0.45)
  assert.strictEqual(loader.hacimOlcegi(spot, vekil), 200)

  const hacimsiz = seriUret(Date.UTC(2026, 0, 5, 10) / 1000, 100, DK, 1990, 0)
  assert.strictEqual(loader.hacimOlcegi(spot, hacimsiz), null)
})

test('normalizeProxy: duzeltme hesaplanamazsa ok:false doner', () => {
  const spot = seriUret(Date.UTC(2026, 0, 5, 10) / 1000, 100, DK, 2000, 90)
  const ortaksiz = seriUret(Date.UTC(2026, 5, 5, 10) / 1000, 100, DK, 1990, 0.4)
  const sonuc = loader.normalizeProxy(spot, ortaksiz)
  assert.strictEqual(sonuc.ok, false)
  assert.match(sonuc.reason, /ortak zaman/)

  const bos = loader.normalizeProxy(spot, series.emptySeries())
  assert.strictEqual(bos.ok, false)
})

test('normalizeProxy: fiyat ve hacim spot olcegine tasinir', () => {
  const bas = Date.UTC(2026, 0, 5, 10) / 1000 // Pazartesi, piyasa acik
  const spot = seriUret(bas, 120, DK, 2000, 90)
  const vekil = seriUret(bas, 120, DK, 1990, 0.45)
  const sonuc = loader.normalizeProxy(spot, vekil)
  assert.strictEqual(sonuc.ok, true)
  assert.strictEqual(sonuc.basis, 10)
  assert.strictEqual(sonuc.volScale, 200)
  assert.strictEqual(sonuc.series.close[0], spot.close[0])
  assert.strictEqual(sonuc.series.volume[0], 90)
  assert.strictEqual(sonuc.dropped, 0, 'acik saatte bar elenmemeli')
})

test('piyasaSaatleriyleSuz: hafta sonu ve gunluk ara barlari elenir', () => {
  // 2026-09-05 Cumartesi 00:00 UTC'den itibaren bir hafta, 7/24 vekil.
  const bas = Date.UTC(2026, 8, 5, 0) / 1000
  const hafta = seriUret(bas, 7 * 24 * 60, DK, 2000, 1)
  const suzulmus = loader.piyasaSaatleriyleSuz(hafta)
  const piyasaAcikMi = createMarketCalendar()

  let kapaliKalan = 0
  for (let i = 0; i < suzulmus.length; i++) {
    if (!piyasaAcikMi(suzulmus.time[i])) kapaliKalan++
  }
  assert.strictEqual(kapaliKalan, 0, 'kapali saatten bar kalmamali')

  let acikAtilan = 0
  const kalanlar = new Set()
  for (let i = 0; i < suzulmus.length; i++) kalanlar.add(suzulmus.time[i])
  for (let i = 0; i < hafta.length; i++) {
    if (piyasaAcikMi(hafta.time[i]) && !kalanlar.has(hafta.time[i])) acikAtilan++
  }
  assert.strictEqual(acikAtilan, 0, 'acik saatten bar atilmamali')
  assert.ok(suzulmus.length < hafta.length, 'hafta sonu barlari elenmeli')
})

test('piyasa takvimi: New York kuralina gore acilis ve kapanis', () => {
  const acikMi = createMarketCalendar()
  // Eylul, ABD yaz saati (UTC-4).
  assert.strictEqual(acikMi(Date.UTC(2026, 8, 5, 12) / 1000), false, 'Cumartesi kapali')
  assert.strictEqual(acikMi(Date.UTC(2026, 8, 6, 20) / 1000), false, 'Pazar 16:00 ET kapali')
  assert.strictEqual(acikMi(Date.UTC(2026, 8, 6, 22, 30) / 1000), true, 'Pazar 18:30 ET acik')
  assert.strictEqual(acikMi(Date.UTC(2026, 8, 9, 21, 30) / 1000), false, 'gunluk ara 17:30 ET')
  assert.strictEqual(acikMi(Date.UTC(2026, 8, 11, 21, 30) / 1000), false, 'Cuma 17:30 ET kapali')
  assert.strictEqual(acikMi(Date.UTC(2026, 8, 11, 16) / 1000), true, 'Cuma 12:00 ET acik')
  assert.strictEqual(acikMi(Date.UTC(2026, 11, 25, 16) / 1000), false, 'Noel kapali')
  assert.strictEqual(acikMi(Date.UTC(2026, 0, 1, 16) / 1000), false, 'Yilbasi kapali')
})

// V2 - veri doktoru: ic bosluklari ve aylik kapsamayi raporlar.
test('veriDoktoru: acik saatlerdeki ic bosluklari bulur, hafta sonunu saymaz', () => {
  const { veriDoktoru } = require('../src/core/data/doctor')
  // Pazartesi 10:00 UTC'den itibaren 240 dakika, ortada 60 dakika eksik.
  const bas = Date.UTC(2026, 8, 7, 10, 0) / 1000
  const n = 240
  const s = series.createSeries(n - 60)
  let k = 0
  for (let i = 0; i < n; i++) {
    if (i >= 100 && i < 160) continue // 60 dakikalik bosluk
    const t = bas + i * DK
    s.time[k] = t
    s.open[k] = 2000; s.high[k] = 2001; s.low[k] = 1999; s.close[k] = 2000; s.volume[k] = 50
    k++
  }
  const rapor = veriDoktoru(s, DK, { minGapMinutes: 30 })
  assert.strictEqual(rapor.gaps.length, 1)
  assert.strictEqual(rapor.gaps[0].missingBars, 60)
  assert.strictEqual(rapor.weekendBars, 0)
  assert.strictEqual(rapor.duplicateTimes, 0)
  assert.ok(rapor.monthly.length >= 1)
})
