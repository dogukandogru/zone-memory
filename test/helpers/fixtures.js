'use strict'

/**
 * ORTAK TEST FIXTURE'LARI
 * ===========================================================================
 * Sentetik hafiza olaylari ve ozellik vektorleri uretir. Onceden ayni fixture
 * uc ayri test dosyasinda elle kuruluydu; sozlesme degistiginde (ornegin
 * CTX_NAMES uzunlugu 22'den 24'e cikinca) kopyalarin biri gunceleniyor digeri
 * eski kaliyordu. Tek kaynak oldugu icin artik boyle bir sapma olamaz.
 *
 * DIKKAT: BU DOSYA TEST ICERMEZ ve test TANIMLAMAMALIDIR. `npm test` artik
 * argumansiz `node --test` kullaniyor (Node 20 tirnakli globu, Node 24 dizin
 * argumanini reddediyordu), yani bu dosya da taraniyor. Icinde test
 * tanimlanirsa yardimcilarla testler birbirine karisir.
 *
 * Uretilen olaylar guncel sozlesmeye uyar:
 *   features.shape / ret / ctx  uzunluklari SHAPE_LEN / RET_LEN / CTX_NAMES.length
 *   parts                       flow / trend / session / rejection / volume, maxScore 5
 *   kind                        'form' | 'touch'
 *   sonuc alanlari              outcome, success, mfeAtr, maeAtr, mfeExitAtr,
 *                               maeExitAtr, riskAtr, rewardAtr, targetPrice,
 *                               invalidPrice, barsToOutcome, fwdReturnPct
 *   plan geometrisi             outcome.zoneLevels ile hesaplanir, yani
 *                               fixture ile etiketleme modulu ayni hedefi kullanir
 */

const { CTX_NAMES, SHAPE_LEN, RET_LEN } = require('../../src/core/learn/features')
const { zoneLevels, DEFAULT_OUTCOME_CFG } = require('../../src/core/learn/outcome')

/** Bir gun, saniye. */
const GUN = 86400
/** Varsayilan ilk olay zamani. */
const T0 = 1500000000

/** Sonlu sayi degilse varsayilana duser. */
function sayi (v, varsayilan) {
  return typeof v === 'number' && isFinite(v) ? v : varsayilan
}

/**
 * Deterministik PRNG (mulberry32, learn/cluster.js icindekiyle ayni).
 * Testlerde Math.random YASAK: ayni tohum her kosuda ayni diziyi vermelidir.
 * @param {number} tohum
 * @returns {() => number} 0..1 arasi sayi
 */
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

/**
 * Tohuma bagli, deterministik ozellik vektoru. Ayni tohum her zaman ayni
 * vektoru verir; diske yazip geri okuma testleri buna dayanir.
 * @param {number} tohum
 */
function ozellik (tohum) {
  const shape = new Float32Array(SHAPE_LEN)
  for (let i = 0; i < SHAPE_LEN; i++) shape[i] = ((tohum * 7 + i * 3) % 11) / 10
  const ret = new Float32Array(RET_LEN)
  for (let i = 0; i < RET_LEN; i++) ret[i] = (((tohum * 5 + i) % 9) - 4) / 4
  const ctx = new Float32Array(CTX_NAMES.length)
  for (let i = 0; i < CTX_NAMES.length; i++) ctx[i] = ((tohum + i * 2) % 5) / 4
  return { shape: shape, ret: ret, ctx: ctx }
}

/**
 * TUM olaylarda ayni olan, varyansli ozellik vektoru: benzerlik daima 1.0
 * cikar. Boylece esik davranisi ve yuruyen ileri test mekanigi benzerlik
 * gurultusunden bagimsiz olculebilir.
 */
function sabitOzellik () {
  const shape = new Float32Array(SHAPE_LEN)
  for (let i = 0; i < SHAPE_LEN; i++) shape[i] = Math.sin(i / 2.5) * 0.5 + 0.5
  const ret = new Float32Array(RET_LEN)
  for (let i = 0; i < RET_LEN; i++) ret[i] = Math.sin(i / 3)
  const ctx = new Float32Array(CTX_NAMES.length)
  for (let i = 0; i < CTX_NAMES.length; i++) ctx[i] = (i % 5) / 4
  return { shape: shape, ret: ret, ctx: ctx }
}

/**
 * Verilen vektorun karsiti: sekil korelasyonu -1, baglam kosinusu -1 ve
 * getiri dizisi cok uzak olur, yani birlesik benzerlik esigin altina duser.
 * @param {{shape:ArrayLike<number>, ret:ArrayLike<number>, ctx:ArrayLike<number>}} q
 */
function tersOzellik (q) {
  const shape = new Float32Array(SHAPE_LEN)
  for (let i = 0; i < SHAPE_LEN; i++) shape[i] = 1 - q.shape[i]
  const ret = new Float32Array(RET_LEN)
  for (let i = 0; i < RET_LEN; i++) ret[i] = -q.ret[i] * 20
  const ctx = new Float32Array(CTX_NAMES.length)
  for (let i = 0; i < CTX_NAMES.length; i++) ctx[i] = -q.ctx[i]
  return { shape: shape, ret: ret, ctx: ctx }
}

/**
 * Rastgele ama tekrarlanabilir ozellik vektoru. PRNG disaridan verilir, yani
 * ayni tohumla kurulan hafiza her kosuda birebir aynidir.
 * @param {() => number} rnd
 */
function rastgeleOzellik (rnd) {
  const shape = new Float32Array(SHAPE_LEN)
  for (let i = 0; i < SHAPE_LEN; i++) shape[i] = rnd()
  const ret = new Float32Array(RET_LEN)
  for (let i = 0; i < RET_LEN; i++) ret[i] = rnd() * 4 - 2
  const ctx = new Float32Array(CTX_NAMES.length)
  for (let i = 0; i < CTX_NAMES.length; i++) ctx[i] = rnd()
  return { shape: shape, ret: ret, ctx: ctx }
}

/**
 * Tek bir hafiza olayi (Touch + Outcome + Features).
 *
 * Plan seviyeleri (targetPrice, invalidPrice, riskAtr, rewardAtr) elle
 * yazilmaz, `outcome.zoneLevels` ile hesaplanir: fixture ile etiketleme
 * modulu ayni hedefi kullanmak zorundadir.
 *
 * @param {Object} [sec] Ustune yazilacak alanlar. Taninan kisayollar:
 *        i (sira numarasi), basarili, yon ('BUY'|'SELL'), kind, time, bar,
 *        price, atr, zoneTop, zoneBottom, features, outcomeCfg.
 *        Geri kalan her alan dogrudan olaya kopyalanir.
 * @returns {Object}
 */
function olay (sec) {
  const s = sec || {}
  const i = Math.round(sayi(s.i, 0))
  const basarili = s.basarili === undefined ? true : !!s.basarili
  const yon = s.yon === 'SELL' ? 'SELL' : 'BUY'
  const kind = s.kind === 'form' ? 'form' : 'touch'
  const price = sayi(s.price, 2000)
  const atr = sayi(s.atr, 4)
  const zoneTop = sayi(s.zoneTop, price + 1)
  const zoneBottom = sayi(s.zoneBottom, price - 1)
  const outcome = typeof s.outcome === 'string' ? s.outcome : (basarili ? 'respect' : 'break')
  const success = s.success === undefined ? outcome === 'respect' : !!s.success
  const mfeAtr = sayi(s.mfeAtr, success ? 2.5 : 0.2)
  const maeAtr = sayi(s.maeAtr, success ? 0.3 : 1.2)

  // Plan geometrisi etiketleme modulunden gelir. Dejenere kurulumda (form
  // olayinda fiyat kutunun obur tarafinda) null doner; o zaman kaba bir vekil
  // kullanilir, cunku fixture'in kendisi etiketleme kurallarini sinamaz.
  const yukari = yon === 'BUY'
  const lv = zoneLevels(
    { price: price, zoneTop: zoneTop, zoneBottom: zoneBottom, direction: yon, kind: kind },
    atr,
    s.outcomeCfg || DEFAULT_OUTCOME_CFG
  )
  const entryPrice = lv ? lv.entry : price
  const targetPrice = lv ? lv.target : price + (yukari ? atr : -atr)
  const invalidPrice = lv ? lv.invalid : price - (yukari ? atr : -atr)
  const riskAtr = lv ? lv.riskAtr : 1
  const rewardAtr = lv ? lv.rewardAtr : 1

  const e = {
    id: Math.round(sayi(s.id, i)),
    zoneId: Math.round(sayi(s.zoneId, i)),
    kind: kind,
    isSupport: s.isSupport === undefined ? yukari : !!s.isSupport,
    direction: yon,
    bar: Math.round(sayi(s.bar, 1000 + i)),
    time: sayi(s.time, T0 + i * 10 * GUN),
    price: price,
    zoneTop: zoneTop,
    zoneBottom: zoneBottom,
    zoneFlow: sayi(s.zoneFlow, 6.5),
    zoneAgeBars: Math.round(sayi(s.zoneAgeBars, 20)),
    penetration: sayi(s.penetration, kind === 'form' ? 0 : 0.5),
    entryDistAtr: sayi(s.entryDistAtr, kind === 'form' ? 1.2 : 0.1),
    bbDistAtr: sayi(s.bbDistAtr, 0.8),
    volRatio: sayi(s.volRatio, 2.4),
    atr: atr,
    score: Math.round(sayi(s.score, 3)),
    maxScore: Math.round(sayi(s.maxScore, 5)),
    qualified: s.qualified === undefined ? true : !!s.qualified,
    strong: s.strong === undefined ? false : !!s.strong,
    session: typeof s.session === 'string' ? s.session : 'London',
    // Skor bilesenleri guncel indikatorun urettigi anahtarlardir.
    parts: s.parts || { flow: true, trend: true, session: true, rejection: false, volume: true },
    outcome: outcome,
    success: success,
    // mfe/mae ufkun TAMAMINI, mfeExit/maeExit yalnizca SONUCA kadarki kismi
    // olcer. Varsayilanda ikisi esittir; testler gerekirse ayirir.
    mfeAtr: mfeAtr,
    maeAtr: maeAtr,
    mfeExitAtr: sayi(s.mfeExitAtr, mfeAtr),
    maeExitAtr: sayi(s.maeExitAtr, maeAtr),
    fwdReturnPct: sayi(s.fwdReturnPct, success ? 1 : -1),
    barsToOutcome: Math.round(sayi(s.barsToOutcome, 20)),
    // Sonucun BELLI OLDUGU zaman. Ambargo ve aday havuzu olay zamanina degil
    // buna bakar: sonucu henuz cozulmemis bir olay komsu olarak kullanilamaz.
    resolvedTime: sayi(s.resolvedTime, sayi(s.time, T0 + i * 10 * GUN) +
      (Math.round(sayi(s.barsToOutcome, 20)) + 1) * sayi(s.barSec, 900)),
    // Limit emrin dolup dolmadigi. 'nofill' disindaki sonuclarda emir dolar.
    filled: s.filled === undefined ? outcome !== 'nofill' : !!s.filled,
    // Risk birimi cinsinden gerceklesen sonuc: tutmada rewardAtr/riskAtr,
    // kirilmada -1, zaman asiminda ufuk sonu kapanisindan.
    realizedR: sayi(s.realizedR, outcome === 'respect'
      ? (riskAtr > 0 ? rewardAtr / riskAtr : 0)
      : (outcome === 'break' ? -1 : 0)),
    mode: typeof s.mode === 'string' ? s.mode : 'zone',
    entryMode: typeof s.entryMode === 'string' ? s.entryMode : (lv ? lv.entryMode : 'close'),
    entryPrice: sayi(s.entryPrice, entryPrice),
    targetPrice: sayi(s.targetPrice, targetPrice),
    invalidPrice: sayi(s.invalidPrice, invalidPrice),
    riskAtr: sayi(s.riskAtr, riskAtr),
    rewardAtr: sayi(s.rewardAtr, rewardAtr),
    features: s.features || sabitOzellik(),
  }

  // Kisayol olmayan alanlar (ornegin arayuzun bekledigi ek bir alan) oldugu
  // gibi eklenir.
  const bilinen = new Set(['i', 'basarili', 'yon', 'outcomeCfg'])
  for (const k of Object.keys(s)) {
    if (bilinen.has(k)) continue
    if (!(k in e)) e[k] = s[k]
  }
  return e
}

/**
 * Sentetik hafiza. Varsayilanda tum olaylarin ozellik vektoru AYNIDIR, yani
 * benzerlik 1.0 olur.
 *
 * @param {Object} [sec]
 *   adet       kac olay
 *   basarili   ilk kac olay basarili (varsayilan: hepsi)
 *   yon        'BUY' | 'SELL' | (i) => yon
 *   kind       'form' | 'touch' | (i) => kind
 *   tf         zaman dilimi etiketi
 *   ilkZaman   ilk olayin zamani
 *   aralik     olaylar arasi saniye (varsayilan 10 gun, komsu dislamanin disi)
 *   ozellik    (i) => Features
 *   alanlar    nesne veya (i, basarili) => nesne, her olayin ustune yazilir
 * @returns {{tf:string, ctxNames:string[], events:Object[]}}
 */
function hafizaKur (sec) {
  const s = sec || {}
  const adet = Math.max(0, Math.round(sayi(s.adet, 0)))
  const basariliAdet = Math.max(0, Math.round(sayi(s.basarili, adet)))
  const aralik = sayi(s.aralik, 10 * GUN)
  const ilkZaman = sayi(s.ilkZaman, T0)
  const ozellikUret = typeof s.ozellik === 'function' ? s.ozellik : function () { return sabitOzellik() }
  const kindUret = typeof s.kind === 'function' ? s.kind : function () { return s.kind || 'touch' }
  const yonUret = typeof s.yon === 'function' ? s.yon : function () { return s.yon || 'BUY' }
  const ekUret = typeof s.alanlar === 'function' ? s.alanlar : function () { return s.alanlar || {} }

  const events = new Array(adet)
  for (let i = 0; i < adet; i++) {
    const basarili = i < basariliAdet
    events[i] = olay(Object.assign({
      i: i,
      basarili: basarili,
      kind: kindUret(i),
      yon: yonUret(i),
      time: ilkZaman + i * aralik,
      features: ozellikUret(i),
    }, ekUret(i, basarili)))
  }
  return { tf: s.tf || '15m', ctxNames: CTX_NAMES.slice(), events: events }
}

/**
 * Henuz ETIKETLENMEMIS olay (Touch). Sinyal katmani sorgu tarafinda boyle bir
 * nesne gorur: sonuc ve plan alanlari yoktur, cunku sonuc daha bilinmiyor.
 * Ozellik vektoru de ayri bir argumanla gectigi icin dondurulen nesneye
 * konmaz.
 * @param {Object} [sec] `olay` ile ayni kisayollar
 */
function dokunus (sec) {
  const e = olay(sec)
  for (const alan of ['outcome', 'success', 'mfeAtr', 'maeAtr', 'mfeExitAtr', 'maeExitAtr',
    'fwdReturnPct', 'barsToOutcome', 'resolvedTime', 'filled', 'realizedR', 'mode',
    'entryMode', 'entryPrice', 'targetPrice', 'invalidPrice',
    'riskAtr', 'rewardAtr', 'features']) {
    delete e[alan]
  }
  return e
}

module.exports = {
  GUN,
  T0,
  prng,
  ozellik,
  sabitOzellik,
  tersOzellik,
  rastgeleOzellik,
  olay,
  dokunus,
  hafizaKur,
}
