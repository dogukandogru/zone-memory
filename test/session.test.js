'use strict'

// A12 - src/core/session.js testleri (CONTRACTS.md bolum 8).
//
// Iki kilit vardir:
//
// 1. YAZ SAATI. Seans, Europe/Istanbul YEREL saatine gore belirlenir. Turkiye
//    2016 Eylul'unden beri sabit UTC+3 kullaniyor ama veri 2009'a kadar
//    gidiyor ve oncesinde yaz saati uygulaniyordu. Sabit ofset varsayimi
//    yapilirsa 2009-2016 arasindaki her yaz barinin seansi bir saat kayar,
//    yani hafizanin yarisi yanlis seansla etiketlenir. Ayrica bir UTC gunu
//    gecisi ortasinda barindirabilir; o gunde ofset gun icinde degisir.
//
// 2. PIYASA TAKVIMI. Vekil kaynaklar (PAXG, XAUT) 7/24 islem gorur, spot
//    XAUUSD gormez. Takvim ONCEDEN deponun son haftalarindan cikariliyordu;
//    depoya bir kez kirli (hafta sonu) bar girince o saatler "acik" sayiliyor
//    ve suzgec kendi kendini bozuyordu. Artik kural tabanli: New York yerel
//    saatiyle Pazar 18:00 acilis, Cuma 17:00 kapanis, her gun 17:00-18:00 ara,
//    Noel ve yilbasi kapali. Kural New York YEREL saatinde oldugu icin ABD
//    yaz saati degisimi UTC karsiliklarini kaydirir.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  SESSIONS,
  PIYASA_TZ,
  sessionName,
  sessionIndexArray,
  localHourArray,
  localDowArray,
  createOffsetLookup,
  createMarketCalendar,
} = require('../src/core/session')

const SAAT = 3600
/** UTC saniye kisayolu. */
const U = (y, m, d, h, dk) => Date.UTC(y, m, d, h || 0, dk || 0) / 1000

/** Verilen andan itibaren n saatlik zaman dizisi. */
function saatDizisi (bas, n) {
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = bas + i * SAAT
  return out
}

test('SESSIONS ve sessionName sozlesmedeki sinirlari tasir', () => {
  assert.deepEqual(SESSIONS, ['Asia', 'London', 'New York', 'Other'])
  assert.equal(PIYASA_TZ, 'America/New_York')
  for (let h = 0; h < 8; h++) assert.equal(sessionName(h), 'Asia', h + '. saat Asia olmali')
  for (let h = 8; h < 13; h++) assert.equal(sessionName(h), 'London')
  for (let h = 13; h < 21; h++) assert.equal(sessionName(h), 'New York')
  for (let h = 21; h < 24; h++) assert.equal(sessionName(h), 'Other')
})

// ---------------------------------------------------------------------------
// YAZ SAATI (Europe/Istanbul, 2016 oncesi)
// ---------------------------------------------------------------------------

test('Istanbul ofseti 2016 oncesinde yaz saatine gore degisir', () => {
  const off = createOffsetLookup('Europe/Istanbul')
  // Kis: UTC+2, yaz: UTC+3.
  assert.equal(off(U(2015, 0, 15, 12)), 2 * SAAT, 'Ocak 2015 UTC+2 olmali')
  assert.equal(off(U(2015, 6, 15, 12)), 3 * SAAT, 'Temmuz 2015 UTC+3 olmali')
  // 2016 Eylul'unden sonra sabit UTC+3: kis aylarinda da +3.
  assert.equal(off(U(2017, 0, 15, 12)), 3 * SAAT, 'Ocak 2017 sabit UTC+3 olmali')
  assert.equal(off(U(2026, 0, 15, 12)), 3 * SAAT)
  // 2016'nin sonbahar gecisi artik YOK: 30 Ekim 2016'da ofset degismez.
  assert.equal(off(U(2016, 9, 30, 0)), 3 * SAAT)
  assert.equal(off(U(2016, 9, 30, 2)), 3 * SAAT)
})

test('yaz saatine GECIS gunu: gun icinde ofset degisir, gecis ani dogru bulunur', () => {
  const off = createOffsetLookup('Europe/Istanbul')
  // 29 Mart 2015 Pazar: yerel 03:00'te saat 04:00 olur, yani 01:00 UTC.
  const gecis = U(2015, 2, 29, 1)
  assert.equal(off(gecis - 1), 2 * SAAT, 'gecisten bir saniye once UTC+2')
  assert.equal(off(gecis), 3 * SAAT, 'gecis aninda UTC+3')
  assert.equal(off(U(2015, 2, 29, 23)), 3 * SAAT, 'gunun kalani UTC+3')
})

test('yaz saatinden DONUS gunu: ayni yerel saat iki kez yasanir', () => {
  const off = createOffsetLookup('Europe/Istanbul')
  // 26 Ekim 2014 Pazar: yerel 04:00'te saat 03:00 olur, yani 01:00 UTC.
  const gecis = U(2014, 9, 26, 1)
  assert.equal(off(gecis - 1), 3 * SAAT)
  assert.equal(off(gecis), 2 * SAAT)

  const saatler = Array.from(localHourArray(saatDizisi(U(2014, 9, 25, 22), 8)))
  assert.deepEqual(saatler, [1, 2, 3, 3, 4, 5, 6, 7],
    'donus gununde yerel 03:00 iki kez gorulur')
})

test('yaz saatine gecis gununde bir yerel saat ATLANIR', () => {
  const saatler = Array.from(localHourArray(saatDizisi(U(2015, 2, 28, 22), 8)))
  assert.deepEqual(saatler, [0, 1, 2, 4, 5, 6, 7, 8],
    'gecis gununde yerel 03:00 hic yasanmaz')
})

test('seans dizisi yerel saatle birebir tutarlidir (gecis gunu dahil)', () => {
  // Gecis gununun tamami ve ertesi gun: 48 bar.
  const zamanlar = saatDizisi(U(2015, 2, 28, 22), 48)
  const saatler = localHourArray(zamanlar)
  const seanslar = sessionIndexArray(zamanlar)
  assert.equal(seanslar.length, zamanlar.length)
  for (let i = 0; i < zamanlar.length; i++) {
    assert.equal(SESSIONS[seanslar[i]], sessionName(saatler[i]),
      i + '. barda seans yerel saatle tutmuyor (saat ' + saatler[i] + ')')
  }
  // Test bos olmasin: gecis gunu birden fazla seans gormeli.
  assert.ok(new Set(Array.from(seanslar)).size >= 3, 'gun icinde birkac seans beklenir')
})

test('yaz saati gormezden gelinirse seans kayar: yaz ve kis ayni UTC saatinde farkli', () => {
  // 07:30 UTC yazin yerel 10:30 (London), kisin 09:30 (yine London) olur;
  // 12:30 UTC ise yazin 15:30 (New York), kisin 14:30 (New York).
  // Sinir saatini secelim: 05:30 UTC yazin 08:30 (London), kisin 07:30 (Asia).
  const yaz = sessionIndexArray([U(2015, 6, 15, 5, 30)])
  const kis = sessionIndexArray([U(2015, 0, 15, 5, 30)])
  assert.equal(SESSIONS[yaz[0]], 'London', 'yazin 05:30 UTC yerel 08:30 = London')
  assert.equal(SESSIONS[kis[0]], 'Asia', 'kisin 05:30 UTC yerel 07:30 = Asia')
})

test('haftanin gunu yerel saate gore hesaplanir', () => {
  // 2015-03-29 Pazar. Yerel gun donumunden hemen once ve sonra.
  const dow = localDowArray([U(2015, 2, 28, 21, 30), U(2015, 2, 28, 22, 30)])
  assert.equal(dow[0], 6, 'yerel 23:30 Cumartesi')
  assert.equal(dow[1], 0, 'yerel 00:30 Pazar')
})

test('gecersiz zaman damgasi Other seansina duser', () => {
  const s = sessionIndexArray([NaN, Infinity, U(2020, 0, 6, 12)])
  assert.equal(s[0], 3)
  assert.equal(s[1], 3)
  assert.equal(SESSIONS[s[2]], 'New York', '12:00 UTC yerel 15:00')
  assert.deepEqual(Array.from(sessionIndexArray([])), [])
  assert.deepEqual(Array.from(localHourArray([])), [])
})

// ---------------------------------------------------------------------------
// PIYASA TAKVIMI (America/New_York kurali)
// ---------------------------------------------------------------------------

test('piyasa takvimi: Cuma 17:00 ET kapanisi ve Pazar 18:00 ET acilisi', () => {
  const acik = createMarketCalendar()
  // Ocak 2026, ABD kis saati (UTC-5). Cuma 9 Ocak, Pazar 11 Ocak.
  assert.equal(acik(U(2026, 0, 9, 21, 59)), true, 'Cuma 16:59 ET acik')
  assert.equal(acik(U(2026, 0, 9, 22, 0)), false, 'Cuma 17:00 ET kapali')
  assert.equal(acik(U(2026, 0, 10, 12)), false, 'Cumartesi tam gun kapali')
  assert.equal(acik(U(2026, 0, 11, 22, 59)), false, 'Pazar 17:59 ET kapali')
  assert.equal(acik(U(2026, 0, 11, 23, 0)), true, 'Pazar 18:00 ET acik')
  assert.equal(acik(U(2026, 0, 12, 3)), true, 'Pazartesi 22:00 ET (Pazar gecesi) acik')
})

test('piyasa takvimi: her gun 17:00-18:00 ET arasi kapali', () => {
  const acik = createMarketCalendar()
  // Carsamba 14 Ocak 2026, kis saati.
  assert.equal(acik(U(2026, 0, 14, 21, 59)), true, 'Carsamba 16:59 ET acik')
  assert.equal(acik(U(2026, 0, 14, 22, 0)), false, 'Carsamba 17:00 ET ara')
  assert.equal(acik(U(2026, 0, 14, 22, 59)), false, 'Carsamba 17:59 ET ara')
  assert.equal(acik(U(2026, 0, 14, 23, 0)), true, 'Carsamba 18:00 ET acik')
})

test('piyasa takvimi New York YEREL saatini kullanir, sabit UTC ofseti degil', () => {
  const acik = createMarketCalendar()
  // 21:30 UTC: kisin 16:30 ET (acik), yazin 17:30 EDT (gunluk ara).
  assert.equal(acik(U(2026, 0, 14, 21, 30)), true, 'kisin 21:30 UTC acik')
  assert.equal(acik(U(2026, 5, 10, 21, 30)), false, 'yazin 21:30 UTC gunluk ara')
  // Yaz saatinde kapanis ve acilis bir saat once (UTC olarak) olur.
  assert.equal(acik(U(2026, 5, 12, 21, 0)), false, 'yazin Cuma 17:00 EDT kapali')
  assert.equal(acik(U(2026, 5, 14, 22, 0)), true, 'yazin Pazar 18:00 EDT acik')
  assert.equal(acik(U(2026, 5, 14, 21, 30)), false, 'yazin Pazar 17:30 EDT henuz kapali')
})

test('piyasa takvimi: Noel ve yilbasi tam gun kapali', () => {
  const acik = createMarketCalendar()
  // 25 Aralik 2026 Cuma, 1 Ocak 2027 Cuma.
  assert.equal(acik(U(2026, 11, 25, 16)), false, 'Noel kapali')
  assert.equal(acik(U(2026, 11, 25, 5)), false, 'Noel gecesi de kapali')
  assert.equal(acik(U(2027, 0, 1, 16)), false, 'Yilbasi kapali')
  // Komsu is gunleri acik: 24 Aralik Persembe ve 4 Ocak Pazartesi.
  assert.equal(acik(U(2026, 11, 24, 16)), true, '24 Aralik acik')
  assert.equal(acik(U(2027, 0, 4, 16)), true, '4 Ocak acik')
})

test('piyasa takvimi: gecersiz zaman icin kapali doner', () => {
  const acik = createMarketCalendar()
  assert.equal(acik(NaN), false)
  assert.equal(acik(undefined), false)
  assert.equal(acik(Infinity), false)
})

test('piyasa takvimi: bir haftada acik saatler makul araliktadir', () => {
  const acik = createMarketCalendar()
  // 5 Ocak 2026 Pazartesi 00:00 UTC'den itibaren bir hafta, saat basi.
  let acikSayi = 0
  const bas = U(2026, 0, 5, 0)
  for (let i = 0; i < 7 * 24; i++) {
    if (acik(bas + i * SAAT)) acikSayi++
  }
  // Haftada 5 gun x 23 saat = 115 saatin biraz altinda (hafta sonu kapali).
  assert.ok(acikSayi > 100 && acikSayi < 120, 'haftalik acik saat sayisi: ' + acikSayi)
})
