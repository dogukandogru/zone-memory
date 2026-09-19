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

// ---------------------------------------------------------------------------
// S6 - VARSAYILAN SAAT DILIMI: AYNI PIYASA ANI HER ZAMAN AYNI YEREL SAAT
// ---------------------------------------------------------------------------
// Turkiye 2016 Eylul'unde yaz saatini birakti. Varsayilan Europe/Istanbul
// oldugu surece Londra'nin 08:00 acilisi 2016 oncesi yerel 10:00, sonrasinda
// kislari yerel 11:00 oluyordu; kNN ayni piyasa anini iki farkli saat olarak
// goruyordu. Varsayilan Europe/Athens (kesintisiz AB kurali) bunu duzeltir.

test('varsayilan saat diliminde Londra acilisi her yil ayni yerel saate duser', () => {
  const durumlar = [
    { ad: '2012 kis', utc: Date.UTC(2012, 0, 15, 8) / 1000 },
    { ad: '2012 yaz', utc: Date.UTC(2012, 6, 15, 7) / 1000 },
    { ad: '2017 kis', utc: Date.UTC(2017, 0, 15, 8) / 1000 },
    { ad: '2017 yaz', utc: Date.UTC(2017, 6, 15, 7) / 1000 },
    { ad: '2024 kis', utc: Date.UTC(2024, 0, 15, 8) / 1000 },
    { ad: '2024 yaz', utc: Date.UTC(2024, 6, 15, 7) / 1000 },
  ]
  for (const d of durumlar) {
    const h = localHourArray(Float64Array.from([d.utc]))[0]
    assert.equal(h, 10, d.ad + ': Londra 08:00 yerel 10 olmali, bulunan ' + h)
  }

  // Eski varsayilan (Istanbul) 2016 SONRASI kislarda 11 verir: testin neyi
  // yakaladigi burada yazili.
  const istanbulKis = localHourArray(Float64Array.from([Date.UTC(2024, 0, 15, 8) / 1000]), 'Europe/Istanbul')[0]
  assert.equal(istanbulKis, 11, 'Istanbul 2024 kisinda 11 verir (bu yuzden varsayilan degil)')
})

// ---------------------------------------------------------------------------
// V6 - KOVA CAPASI: 4 saatlik ve gunluk kovalar seans acilisindan baslar
// ---------------------------------------------------------------------------
// Epoch katlarina hizali kovalar spot altinin gunuyle ortusmuyor. Olculdu
// (gercek 1 dakikalik depo, 6,1 milyon bar): 28.006 adet 4 saatlik kovanin
// 1.611'i iki saatten az veri iceriyor; seans capasiyla bu sayi 150'ye
// iniyor ve gunluk kova sayisi 5.445'ten 4.534'e duserek Pazar aksami
// acilisi Pazartesi barina katiliyor.

test('seans capasi: kovalar yerel 18:00 sinirindan sayilir', () => {
  const { createSessionAnchor } = require('../src/core/session')
  const capa = createSessionAnchor()

  // 2026-01-15 Persembe, New York kis saati (UTC-5).
  // Yerel 18:00 = 23:00 UTC. O andan itibaren gunun ilk 4 saatlik kovasi.
  const acilis = Date.UTC(2026, 0, 15, 23) / 1000
  assert.equal(capa(acilis, 4 * SAAT), acilis, 'acilis ani kendi kovasinin basidir')
  assert.equal(capa(acilis + 3599, 4 * SAAT), acilis, 'ilk saat ayni kovada')
  assert.equal(capa(acilis + 4 * SAAT, 4 * SAAT), acilis + 4 * SAAT, 'dort saat sonra yeni kova')
  // Acilistan bir saniye once ONCEKI seans gunune aittir.
  assert.ok(capa(acilis - 1, 4 * SAAT) < acilis)

  // Gunluk kova: acilistan sonraki 24 saat tek kovadir.
  assert.equal(capa(acilis, 86400), acilis)
  assert.equal(capa(acilis + 23 * SAAT, 86400), acilis)
  assert.equal(capa(acilis + 25 * SAAT, 86400), acilis + 86400)
})

test('seans capasi: yaz saatinde acilis bir saat kayar', () => {
  const { createSessionAnchor } = require('../src/core/session')
  const capa = createSessionAnchor()

  // 2026-07-15 Carsamba, New York yaz saati (UTC-4): yerel 18:00 = 22:00 UTC.
  const yazAcilis = Date.UTC(2026, 6, 15, 22) / 1000
  assert.equal(capa(yazAcilis, 4 * SAAT), yazAcilis)
  assert.ok(capa(yazAcilis - 1, 4 * SAAT) < yazAcilis)

  // Kis ve yaz acilislarinin UTC karsiligi FARKLI olmali (epoch hizasi
  // olsaydi ikisi de ayni saatte baslardi).
  const kisAcilis = Date.UTC(2026, 0, 15, 23) / 1000
  const kisSod = kisAcilis % 86400
  const yazSod = yazAcilis % 86400
  assert.notEqual(kisSod, yazSod, 'UTC karsiligi yaz saatiyle kaymali')
})

test('seans capasi 4 saatlik kovalarda yarim kova sayisini dusurur', () => {
  const series = require('../src/core/series')
  const { createSessionAnchor } = require('../src/core/session')

  // Iki haftalik sentetik 1 dakikalik seri (piyasa saatleri suzulmemis).
  const bas = Date.UTC(2026, 0, 5, 0) / 1000
  const n = 14 * 24 * 60
  const s = series.createSeries(n)
  for (let i = 0; i < n; i++) {
    s.time[i] = bas + i * 60
    s.open[i] = 2000
    s.high[i] = 2001
    s.low[i] = 1999
    s.close[i] = 2000
    s.volume[i] = 1
  }

  const epoch = series.resample(s, 4 * SAAT)
  const seans = series.resample(s, 4 * SAAT, { capa: 'seans' })
  // Kesintisiz seride iki yontem de tam kovalar uretir; capali surumde
  // kovalarin BASLANGICI epoch katina denk GELMEZ.
  assert.ok(seans.length > 0)
  const epochHizali = epoch.time[0] % (4 * SAAT) === 0
  const seansHizali = seans.time[0] % (4 * SAAT) === 0
  assert.ok(epochHizali, 'varsayilan kovalar epoch katinda baslar')
  assert.ok(!seansHizali, 'seans capali kovalar epoch katinda BASLAMAZ')

  // Capa yalnizca 4 saat ve ustunde uygulanir: 15 dakikalik ayni kalir.
  const onbes = series.resample(s, 900, { capa: 'seans' })
  assert.equal(onbes.time[0] % 900, 0, '15 dakikalik kovalar epoch hizasinda kalir')

  // Gercek capa kullanildigi dogrulanir.
  const capa = createSessionAnchor()
  assert.equal(seans.time[0], capa(s.time[0], 4 * SAAT))
})

// ===========================================================================
// A4 EK KILIT - YAZ SAATI GECIS GUNLERI (Europe/Athens)
// ===========================================================================
// session.js yerel saat ve gun hesabini Europe/Athens ile yapar; kullaniciya
// gosterilen saat hala Europe/Istanbul'dur. Iki sey kilitlenir:
//
//   1. Athens gecis gunlerinde (AB kurali: Mart'in son Pazari 01:00 UTC ileri,
//      Ekim'in son Pazari 01:00 UTC geri) ofsetin ve yerel saatin gecisin
//      HEMEN oncesi ile sonrasinda dogru kaydigi. Beklenen degerler ELLE
//      YAZILMAZ: Intl.DateTimeFormat'in `timeZoneName: 'longOffset'` cikisindan
//      bagimsiz olarak cozulur. Bu, session.js'in kullandigi yoldan (yerel
//      takvim alanlarini UTC gibi yorumlayip fark almak) FARKLI bir yoldur,
//      yani test hesabin kendisini tekrarlamiyor.
//   2. Turkiye 2016 Eylul'unde yaz saatini kalici biraktigi icin ayni piyasa
//      ani Istanbul'da 2016 oncesi ve sonrasi FARKLI yerel saate duser, Athens
//      ise AB kuralini kesintisiz surdurdugu icin AYNI saate duser. Seans saati
//      referansinin neden Athens oldugunun olculmus gerekcesi budur.

const ATHENS = 'Europe/Athens'
const ISTANBUL = 'Europe/Istanbul'

/** Verilen ayin (0 tabanli) son Pazar gununun ayin kacinci gunu oldugu. */
function sonPazar (yil, ayIdx) {
  // Ayin son gunu: bir sonraki ayin 0. gunu.
  const d = new Date(Date.UTC(yil, ayIdx + 1, 0))
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.getUTCDate()
}

const longOffsetFmt = new Map()

/**
 * Ofseti session.js'ten BAGIMSIZ yoldan cozer: Intl'in longOffset alani
 * ("GMT+03:00") dogrudan okunur.
 * @param {number} tSec
 * @param {string} tz
 * @returns {number} saniye
 */
function bagimsizOfset (tSec, tz) {
  let f = longOffsetFmt.get(tz)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    longOffsetFmt.set(tz, f)
  }
  let metin = ''
  for (const p of f.formatToParts(new Date(tSec * 1000))) {
    if (p.type === 'timeZoneName') metin = p.value
  }
  if (metin === 'GMT') return 0
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(metin)
  assert.ok(m !== null, 'Intl longOffset cozulemedi: ' + metin)
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60)
}

const saatFmt = new Map()

/**
 * Yerel saati (0..23) session.js'ten bagimsiz olarak Intl ile okur.
 * @param {number} tSec
 * @param {string} tz
 * @returns {number}
 */
function bagimsizYerelSaat (tSec, tz) {
  let f = saatFmt.get(tz)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit' })
    saatFmt.set(tz, f)
  }
  let h = -1
  for (const p of f.formatToParts(new Date(tSec * 1000))) {
    if (p.type === 'hour') h = +p.value
  }
  assert.ok(h >= 0, 'Intl saat alani okunamadi')
  return h === 24 ? 0 : h
}

test('Athens yaz saati gecis gunleri: gecisin hemen oncesi ve sonrasi dogru kayar', () => {
  const off = createOffsetLookup(ATHENS)
  const olcumler = []
  let kontrol = 0

  for (const yil of [2016, 2021, 2025]) {
    for (const ayIdx of [2, 9]) {              // Mart ve Ekim
      const gun = sonPazar(yil, ayIdx)
      // AB kurali gerceklesmis mi: gun Pazar olmali.
      assert.equal(new Date(Date.UTC(yil, ayIdx, gun)).getUTCDay(), 0,
        yil + '-' + (ayIdx + 1) + ' son Pazar hesabi bozuk: ' + gun)

      const gecis = Date.UTC(yil, ayIdx, gun, 1) / 1000   // 01:00 UTC
      const beklenenOnce = bagimsizOfset(gecis - 1, ATHENS)
      const beklenenSonra = bagimsizOfset(gecis, ATHENS)

      // 1. Ofset gecisin iki yaninda Intl ile birebir ayni.
      assert.equal(off(gecis - 1), beklenenOnce,
        yil + '-' + (ayIdx + 1) + ' gecisten bir saniye once ofset')
      assert.equal(off(gecis), beklenenSonra,
        yil + '-' + (ayIdx + 1) + ' gecis aninda ofset')
      // 2. Kayma tam bir saat ve dogru yonde.
      const fark = beklenenSonra - beklenenOnce
      assert.equal(fark, ayIdx === 2 ? SAAT : -SAAT,
        yil + '-' + (ayIdx + 1) + ' kayma bir saat olmali, olculen ' + fark)
      // 3. Gecis ANI gercekten burada: bir saat oncesi hala eski ofsette,
      //    gunun sonu yeni ofsette.
      assert.equal(off(gecis - SAAT), beklenenOnce)
      assert.equal(off(gecis + 20 * SAAT), beklenenSonra)

      // 4. Gecis gununun 24 UTC saatinin TAMAMI: yerel saat Intl ile birebir.
      //    Ayrica yapisal isaret: Athens gecisi yerel 03:00'te olur, yani Mart
      //    gununde yerel 03 HIC yasanmaz, Ekim gununde IKI KEZ yasanir.
      const gunBasi = Date.UTC(yil, ayIdx, gun) / 1000
      const zamanlar = saatDizisi(gunBasi, 24)
      const saatler = localHourArray(zamanlar, ATHENS)
      let ucSayisi = 0
      for (let i = 0; i < zamanlar.length; i++) {
        const beklenen = bagimsizYerelSaat(zamanlar[i], ATHENS)
        assert.equal(saatler[i], beklenen,
          yil + '-' + (ayIdx + 1) + '-' + gun + ' ' + i + '. UTC saatinde yerel saat ' +
          saatler[i] + ', Intl ' + beklenen + ' diyor')
        if (saatler[i] === 3) ucSayisi++
        kontrol++
      }
      assert.equal(ucSayisi, ayIdx === 2 ? 0 : 2,
        yil + '-' + (ayIdx + 1) + ': yerel 03 saati ' + ucSayisi + ' kez gorundu, ' +
        (ayIdx === 2 ? 'ileri gecis gununde hic gorunmemeli' : 'geri gecis gununde iki kez gorunmeli'))

      olcumler.push(yil + '-' + (ayIdx + 1) + '-' + gun +
        ' 01:00Z: UTC' + (beklenenOnce / SAAT >= 0 ? '+' : '') + (beklenenOnce / SAAT) +
        ' -> UTC' + (beklenenSonra / SAAT >= 0 ? '+' : '') + (beklenenSonra / SAAT))
    }
  }

  console.log('[session] Athens gecisleri: %s', olcumler.join(' | '))
  assert.equal(olcumler.length, 6, 'uc yil x iki gecis beklenir')
  assert.equal(kontrol, 6 * 24)
})

test('Athens gecis gunlerinde seans etiketi yerel saatle tutarli kalir', () => {
  // Gecis gunu seans siniflandirmasini bozmamali: her barin seansi o barin
  // Intl ile okunan yerel saatinden turemis olmali.
  for (const yil of [2016, 2021, 2025]) {
    for (const ayIdx of [2, 9]) {
      const gun = sonPazar(yil, ayIdx)
      const zamanlar = saatDizisi(Date.UTC(yil, ayIdx, gun) / 1000 - 2 * SAAT, 28)
      const seanslar = sessionIndexArray(zamanlar, ATHENS)
      for (let i = 0; i < zamanlar.length; i++) {
        const beklenen = sessionName(bagimsizYerelSaat(zamanlar[i], ATHENS))
        assert.equal(SESSIONS[seanslar[i]], beklenen,
          yil + '-' + (ayIdx + 1) + ' ' + i + '. barda seans ' + SESSIONS[seanslar[i]] +
          ', yerel saate gore ' + beklenen + ' olmali')
      }
      assert.ok(new Set(Array.from(seanslar)).size >= 3, 'gun icinde birkac seans beklenir')
    }
  }
})

test('seans referansi Athens: ayni piyasa ani Athens\'te sabit, Istanbul\'da kayar', () => {
  // Londra acilisi: kisin 08:00 UTC, yazin 07:00 UTC. AYNI piyasa anidir.
  const anlar = []
  for (const yil of [2010, 2012, 2015, 2017, 2021, 2025]) {
    anlar.push({ yil, mevsim: 'kis', t: Date.UTC(yil, 0, 15, 8) / 1000 })
    anlar.push({ yil, mevsim: 'yaz', t: Date.UTC(yil, 6, 15, 7) / 1000 })
  }

  const athensSaatleri = new Set()
  const istanbulSaatleri = new Set()
  const istanbulKis = new Map()
  for (const a of anlar) {
    const ath = localHourArray(Float64Array.from([a.t]), ATHENS)[0]
    const ist = localHourArray(Float64Array.from([a.t]), ISTANBUL)[0]
    // Ikisi de Intl ile bagimsiz dogrulanir.
    assert.equal(ath, bagimsizYerelSaat(a.t, ATHENS), a.yil + ' ' + a.mevsim + ' Athens')
    assert.equal(ist, bagimsizYerelSaat(a.t, ISTANBUL), a.yil + ' ' + a.mevsim + ' Istanbul')
    athensSaatleri.add(ath)
    istanbulSaatleri.add(ist)
    if (a.mevsim === 'kis') istanbulKis.set(a.yil, ist)
  }

  console.log('[session] Londra acilisi yerel saat kumesi -> Athens %j, Istanbul %j; ' +
    'Istanbul kis saatleri %j',
  Array.from(athensSaatleri).sort(), Array.from(istanbulSaatleri).sort(),
  Array.from(istanbulKis.entries()))

  // ATHENS: butun yillarda ve iki mevsimde de TEK bir yerel saat.
  assert.equal(athensSaatleri.size, 1,
    'Athens ayni piyasa anini tek yerel saate esler, bulunan: ' +
    Array.from(athensSaatleri).join(','))
  assert.ok(athensSaatleri.has(10), 'Athens icin beklenen yerel saat 10')

  // ISTANBUL: iki farkli yerel saat, ayrim tam 2016'dan geciyor.
  assert.equal(istanbulSaatleri.size, 2,
    'Istanbul iki farkli yerel saat vermeli, bulunan: ' +
    Array.from(istanbulSaatleri).join(','))
  for (const yil of [2010, 2012, 2015]) {
    assert.equal(istanbulKis.get(yil), 10, yil + ' kisinda Istanbul yerel 10 olmali')
  }
  for (const yil of [2017, 2021, 2025]) {
    assert.equal(istanbulKis.get(yil), 11,
      yil + ' kisinda Istanbul yerel 11 olmali (2016 Eylul kalici yaz saati)')
  }
  // Kayma tam bir saat.
  assert.equal(istanbulKis.get(2017) - istanbulKis.get(2015), 1)
})

test('Athens ile Istanbul ofset farki 2016 Eylul\'unden sonra kislari 1 saat acilir', () => {
  const athens = createOffsetLookup(ATHENS)
  const istanbul = createOffsetLookup(ISTANBUL)
  const satirlar = []

  // Kis (Ocak) ve yaz (Temmuz) icin ofset farki. 2016 oncesi iki ulke ayni
  // kurali uyguluyordu, fark her mevsimde 0'di.
  const beklenen = {
    2015: { kis: 0, yaz: 0 },
    2016: { kis: 0, yaz: 0 },     // Eylul'den ONCE, Ocak ve Temmuz hala ayni
    2017: { kis: SAAT, yaz: 0 },  // Istanbul kalici +3, Athens kisin +2
    2025: { kis: SAAT, yaz: 0 },
  }
  for (const yil of Object.keys(beklenen).map(Number)) {
    const kis = U(yil, 0, 15, 12)
    const yaz = U(yil, 6, 15, 12)
    const kisFark = istanbul(kis) - athens(kis)
    const yazFark = istanbul(yaz) - athens(yaz)
    // Bagimsiz dogrulama.
    assert.equal(kisFark, bagimsizOfset(kis, ISTANBUL) - bagimsizOfset(kis, ATHENS))
    assert.equal(yazFark, bagimsizOfset(yaz, ISTANBUL) - bagimsizOfset(yaz, ATHENS))
    assert.equal(kisFark, beklenen[yil].kis, yil + ' kis ofset farki')
    assert.equal(yazFark, beklenen[yil].yaz, yil + ' yaz ofset farki')
    satirlar.push(yil + ': kis ' + (kisFark / SAAT) + 'sa, yaz ' + (yazFark / SAAT) + 'sa')
  }
  console.log('[session] Istanbul - Athens ofset farki -> %s', satirlar.join(' | '))

  // Turkiye'nin 2016 Ekim'inde ARTIK gecis yapmadigi, Athens'in yaptigi.
  const ekim2016 = Date.UTC(2016, 9, sonPazar(2016, 9), 1) / 1000
  assert.equal(istanbul(ekim2016 - 1), istanbul(ekim2016),
    'Istanbul 2016 Ekim\'inde geri donmez')
  assert.notEqual(athens(ekim2016 - 1), athens(ekim2016),
    'Athens 2016 Ekim\'inde geri doner')
})
