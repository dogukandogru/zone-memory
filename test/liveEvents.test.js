'use strict'

// A12 - src/core/learn/liveEvents.js testleri (CONTRACTS.md bolum 15).
//
// Kilitlenen hatalar:
//   1. Canli kontrol yalnizca SON olayi aliyordu. Ayni barda iki bolge olayi
//      olustugunda (bir kutu dogarken baska bir kutuya dokunulmasi gibi)
//      digerleri kalici olarak kayboluyordu, cunku `sinceTime` sonuncunun
//      zamanina cekiliyordu. Olculdu: 15m'de 5378 olayin 60'i ayni barda
//      baska bir olayla birlikte olusuyor.
//   2. Olay kimligi zoneId'ye GUVENEMEZ: proZones her calismada kutulari
//      sifirdan numaralandirir ve canli kuyruk her barda kaydigi icin ayni
//      bolge her tikte baska bir zoneId alir.

const test = require('node:test')
const assert = require('node:assert/strict')

const { selectNewEvents, eventKey } = require('../src/core/learn/liveEvents')

const T0 = 1700000000
const ADIM = 900

/** Kucuk bir olay nesnesi. */
function olay(sec) {
  const s = sec || {}
  return {
    id: s.id === undefined ? 0 : s.id,
    zoneId: s.zoneId === undefined ? 0 : s.zoneId,
    kind: s.kind === 'form' ? 'form' : 'touch',
    time: s.time === undefined ? T0 : s.time,
    zoneTop: s.zoneTop === undefined ? 2010 : s.zoneTop,
    zoneBottom: s.zoneBottom === undefined ? 2008 : s.zoneBottom,
    direction: s.direction === 'SELL' ? 'SELL' : 'BUY',
  }
}

test('selectNewEvents: AYNI BARDAKI iki olayin ikisi de doner', () => {
  const t = T0 + 5 * ADIM
  const liste = [
    olay({ id: 1, time: T0, zoneTop: 1990, zoneBottom: 1988 }),
    olay({ id: 2, kind: 'form', time: t, zoneTop: 2020, zoneBottom: 2018 }),
    olay({ id: 3, kind: 'touch', time: t, zoneTop: 1980, zoneBottom: 1978 }),
  ]
  const secilen = selectNewEvents(liste, T0, [])
  assert.equal(secilen.length, 2, 'ayni bardaki iki olay da degerlendirilmeli')
  assert.deepEqual(secilen.map((e) => e.id), [2, 3])
  // Ic sira indikatorun urettigi siradir.
  assert.equal(secilen[0].kind, 'form')
  assert.equal(secilen[1].kind, 'touch')
})

test('selectNewEvents: since degerine ESIT olay yeniden donmez', () => {
  const liste = [
    olay({ id: 1, time: T0 }),
    olay({ id: 2, time: T0 + ADIM, zoneTop: 2030, zoneBottom: 2028 }),
  ]
  assert.deepEqual(selectNewEvents(liste, T0, []).map((e) => e.id), [2])
  assert.deepEqual(selectNewEvents(liste, T0 + ADIM, []).map((e) => e.id), [])
  assert.deepEqual(selectNewEvents(liste, 0, []).map((e) => e.id), [1, 2])
})

test('selectNewEvents: gorulmus anahtar tekrar degerlendirilmez', () => {
  const a = olay({ id: 1, kind: 'form', time: T0 + ADIM, zoneTop: 2020, zoneBottom: 2018 })
  const b = olay({ id: 2, kind: 'touch', time: T0 + ADIM, zoneTop: 1980, zoneBottom: 1978 })
  const gorulen = new Set([eventKey(a)])

  const secilen = selectNewEvents([a, b], T0, gorulen)
  assert.deepEqual(secilen.map((e) => e.id), [2], 'gorulmus olay atlanmali')
  // Dizi de kabul edilir.
  assert.deepEqual(selectNewEvents([a, b], T0, [eventKey(b)]).map((e) => e.id), [1])
  // Cagiranin kumesi DEGISTIRILMEZ.
  assert.equal(gorulen.size, 1, 'gecilen Set degistirilmemeli')
})

test('selectNewEvents: ayni listede tekrarlanan anahtar bir kez doner', () => {
  const a = olay({ id: 1, kind: 'form', time: T0 + ADIM })
  // Baska zoneId, ayni tur / zaman / kenarlar: bu AYNI olaydir, cunku
  // zoneId her calismada sifirdan numaralanir.
  const kopya = Object.assign({}, a, { id: 7, zoneId: 99 })
  const secilen = selectNewEvents([a, kopya], T0, [])
  assert.equal(secilen.length, 1)
  assert.equal(secilen[0].id, 1, 'ilk gorulen kayit tutulur')
})

test('selectNewEvents: cikti zaman sirali, gecersiz kayitlar atilir', () => {
  const liste = [
    olay({ id: 3, time: T0 + 3 * ADIM, zoneTop: 2030, zoneBottom: 2028 }),
    null,
    olay({ id: 1, time: T0 + 1 * ADIM, zoneTop: 2010, zoneBottom: 2008 }),
    { kind: 'touch', zoneTop: 1, zoneBottom: 0 },
    olay({ id: 2, time: T0 + 2 * ADIM, zoneTop: 2020, zoneBottom: 2018 }),
  ]
  const secilen = selectNewEvents(liste, T0, null)
  assert.deepEqual(secilen.map((e) => e.id), [1, 2, 3])
  for (let i = 1; i < secilen.length; i++) {
    assert.ok(secilen[i].time >= secilen[i - 1].time, 'zaman sirali olmali')
  }
})

test('selectNewEvents: bos veya gecersiz girdide bos dizi doner', () => {
  assert.deepEqual(selectNewEvents(null, 0, []), [])
  assert.deepEqual(selectNewEvents([], 0, []), [])
  assert.deepEqual(selectNewEvents(undefined, 0, new Set()), [])
})

test('eventKey: zoneId ve bar degisse de ayni, kenar degisince farkli', () => {
  const a = olay({ id: 1, zoneId: 3, time: T0, zoneTop: 2010.123456, zoneBottom: 2008.5 })
  const b = Object.assign({}, a, { id: 9, zoneId: 41, bar: 900 })
  assert.equal(eventKey(a), eventKey(b), 'zoneId ve bar kimlige girmemeli')

  const c = Object.assign({}, a, { zoneTop: 2010.5 })
  assert.notEqual(eventKey(a), eventKey(c))
  const d = Object.assign({}, a, { kind: 'form' })
  assert.notEqual(eventKey(a), eventKey(d))
  const e = Object.assign({}, a, { time: T0 + ADIM })
  assert.notEqual(eventKey(a), eventKey(e))

  // Kenar sabit ondaliga indirgenir: kuyruk penceresi kaydikca ATR'nin son
  // basamaklari zerre oynayabilir, kimlik bundan etkilenmemeli.
  const f = Object.assign({}, a, { zoneTop: a.zoneTop + 1e-12 })
  assert.equal(eventKey(a), eventKey(f))
  assert.ok(eventKey(a).indexOf('2010.12346') > 0, 'kenar sabit ondalikla yazilir')
})
