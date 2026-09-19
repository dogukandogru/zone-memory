'use strict'

// U1 - Arayuzun gosterim istatistikleri (src/renderer/istatistik.js) ve
// metin uretimi (src/core/learn/signalText.js).
//
// Kilitlenen sorun: uygulamanin ana ciktisi "gecmiste bu yapi %X tuttu"
// cumlesi, ama 5 eslesmeli %60 ile 25 eslesmeli %60 ekranda AYNI gorunuyordu
// ve belirsizlik hicbir yerde yazmiyordu. Ustelik renkler risk/odulu hesaba
// katmadigi icin basabasi %31 olan bir dokunus kurulumu kirmizi, basabasi
// %50 olan bir olusum yesil gorunebiliyordu: kullanici en guvenilir GORUNEN
// sinyale en cok guvenip en kotu sonucu alabilirdi.

const test = require('node:test')
const assert = require('node:assert')

const signalText = require('../src/core/learn/signalText')

/** Renderer modulu ESM; dinamik import ile yuklenir. */
async function istatistik() {
  return await import('../src/renderer/istatistik.mjs')
}

test('wilsonAraligi: bilinen girdilerde beklenen aralik', async () => {
  const { wilsonAraligi } = await istatistik()

  // 3/5: cok genis aralik, cunku orneklem kucuk.
  const kucuk = wilsonAraligi(3, 5)
  assert.ok(Math.abs(kucuk.lo - 0.2306) < 0.002, 'alt sinir ~%23,1: ' + kucuk.lo)
  assert.ok(Math.abs(kucuk.hi - 0.8819) < 0.002, 'ust sinir ~%88,2: ' + kucuk.hi)

  // 9/15: ayni oran (%60) ama daha dar aralik. Bu testin butun konusu bu.
  const orta = wilsonAraligi(9, 15)
  assert.ok(Math.abs(orta.lo - 0.3591) < 0.005, 'alt sinir ~%36: ' + orta.lo)
  assert.ok(Math.abs(orta.hi - 0.8022) < 0.005, 'ust sinir ~%80: ' + orta.hi)
  assert.ok((orta.hi - orta.lo) < (kucuk.hi - kucuk.lo),
    'daha cok ornek daha dar aralik vermeli')

  // Sinirlar 0 ve 1 disina tasmaz.
  assert.strictEqual(wilsonAraligi(0, 5).lo, 0)
  assert.strictEqual(wilsonAraligi(5, 5).hi, 1)
  assert.strictEqual(wilsonAraligi(1, 0), null)
})

test('sinyalAraligi: sinyal tasiyorsa oradan, yoksa hesaplanir', async () => {
  const { sinyalAraligi } = await istatistik()

  // Yeni kayitlar araligi kendileri tasir.
  const yeni = sinyalAraligi({ winRateLo: 0.36, winRateHi: 0.8, winRate: 0.6, matchCount: 15 })
  assert.strictEqual(yeni.lo, 0.36)
  assert.strictEqual(yeni.hi, 0.8)

  // Eski kayitlarda oran ve eslesme sayisindan turetilir.
  const eski = sinyalAraligi({ winRate: 0.6, matchCount: 15 })
  assert.ok(Math.abs(eski.lo - 0.3591) < 0.005)
  assert.strictEqual(sinyalAraligi({ winRate: 0.6 }), null)
  assert.strictEqual(sinyalAraligi(null), null)
})

test('sinyalSayilari: kalibre oran degil HAM oran sayilir', async () => {
  const { sinyalSayilari } = await istatistik()

  // Kalibre edilmis oran 0,55 iken ham oran 0,6: "9/15" ham orandan gelmeli,
  // yoksa ekranda yazan sayim ile yuzde tutmaz.
  const s = sinyalSayilari({ winRate: 0.55, winRateRaw: 0.6, matchCount: 15 })
  assert.strictEqual(s.k, 9)
  assert.strictEqual(s.n, 15)

  // Ham oran yoksa gosterilen oran kullanilir.
  assert.deepStrictEqual(sinyalSayilari({ winRate: 0.5, matchCount: 10 }), { k: 5, n: 10 })
  assert.strictEqual(sinyalSayilari({ winRate: 0.5 }), null)
})

test('basabasOran ve aralikSinifi: renk risk/odulu hesaba katar', async () => {
  const { basabasOran, aralikSinifi } = await istatistik()

  // R/R 2 olan bir plan %33,3 isabetle basabas eder.
  assert.ok(Math.abs(basabasOran(2) - 1 / 3) < 1e-9)
  // R/R 1 olan plan %50 ister.
  assert.strictEqual(basabasOran(1), 0.5)
  // Gecersiz R/R'de temkinli varsayilan.
  assert.strictEqual(basabasOran(0), 0.5)

  // Aralik tamamen basabasin USTUNDE: yesil.
  assert.strictEqual(aralikSinifi({ lo: 0.4, hi: 0.7 }, 0.333), 'up')
  // Aralik tamamen ALTINDA: kirmizi.
  assert.strictEqual(aralikSinifi({ lo: 0.1, hi: 0.3 }, 0.333), 'down')
  // Aralik basabasi ICERIYOR: notr. "Karli oldugu soylenemez" demektir.
  assert.strictEqual(aralikSinifi({ lo: 0.2, hi: 0.5 }, 0.333), 'muted')
  assert.strictEqual(aralikSinifi(null, 0.5), 'muted')

  // ESKI DAVRANISIN YAKALADIGI HATA: %31 basabasli bir kurulum, sabit %50
  // esigiyle KIRMIZI gorunuyordu; simdi yesil.
  const dokunus = { lo: 0.35, hi: 0.55 }
  assert.strictEqual(aralikSinifi(dokunus, basabasOran(2.2)), 'up')
})

test('ornekRozeti: az orneklem gorunur olsun', async () => {
  const { ornekRozeti } = await istatistik()
  assert.strictEqual(ornekRozeti(5).sinif, 'down')
  assert.match(ornekRozeti(5).metin, /çok az/)
  assert.strictEqual(ornekRozeti(15).sinif, 'warn')
  assert.strictEqual(ornekRozeti(30), null, '30 ve ustu rozet gostermez')
})

test('signalText: metinlerde "güven" gecmez, sayim ve aralik gecer', async () => {
  const s = {
    kind: 'form',
    direction: 'BUY',
    matchCount: 15,
    winRate: 0.55,
    winRateRaw: 0.6,
    winRateLo: 0.36,
    winRateHi: 0.8,
    baseRate: 0.4,
    confidence: 0.59,
  }
  const ozet = signalText.sinyalOzeti(s)
  assert.match(ozet, /9\/15 tuttu/)
  assert.match(ozet, /%36-80/)
  assert.match(ozet, /tür tabanı %40/)
  assert.ok(!/güven/i.test(ozet), 'metinde "güven" gecmemeli: ' + ozet)

  assert.strictEqual(signalText.isaretMetni(s), 'OL 9/15')
  assert.strictEqual(signalText.isaretMetni({ kind: 'touch', matchCount: 4, winRate: 0.5 }), 'DK 2/4')
  assert.match(signalText.sinyalBasligi(s, '15m'), /AL, kutu oluşumu \(15m\)/)

  // Arayuz kopyasi AYNI bicimi uretmeli (iki dosya birlikte degismeli).
  const { sinyalOzetiMetni, isaretMetni } = await istatistik()
  assert.strictEqual(sinyalOzetiMetni(s), ozet)
  assert.strictEqual(isaretMetni(s), signalText.isaretMetni(s))
})

test('sinyal gerekcesinde "güven" ifadesi kalmadi', () => {
  const { evaluateTouch } = require('../src/core/learn/signal')
  const fixtures = require('./helpers/fixtures')
  const mem = fixtures.hafizaKur({ adet: 20, basarili: 16, yon: 'BUY' })
  const t = fixtures.dokunus({ id: 7, zoneId: 3, yon: 'BUY', bar: 500, time: fixtures.T0 + 400 * fixtures.GUN })
  const s = evaluateTouch(t, fixtures.sabitOzellik(), mem, [], { minMatches: 5, minWinRate: 0.3 }, null)
  for (const r of s.reasons) {
    assert.ok(!/güven/i.test(r), 'gerekcede "güven" gecmemeli: ' + r)
  }
  if (s.fired) {
    assert.ok(s.reasons.some((r) => /tuttu/.test(r) && /alt sınır/.test(r)),
      'gerekce sayim ve alt siniri yazmali')
  }
})
