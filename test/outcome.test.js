'use strict'

// A12 - src/core/learn/outcome.js testleri (CONTRACTS.md bolum 10 ve 21).

const test = require('node:test')
const assert = require('node:assert/strict')

const { labelTouch, zoneLevels, DEFAULT_OUTCOME_CFG } = require('../src/core/learn/outcome')
const series = require('../src/core/series')

const T0 = 1704067200
const ADIM = 900

/**
 * Duz bir seri kurar; barlar varsayilan olarak 100 civarinda dar aralikta gezer.
 * ozel: { bar: {high, low, close} } ile tekil barlar degistirilir.
 */
function seriKur (n, ozel) {
  const time = new Array(n)
  const open = new Array(n)
  const high = new Array(n)
  const low = new Array(n)
  const close = new Array(n)
  const volume = new Array(n)
  for (let i = 0; i < n; i++) {
    time[i] = T0 + i * ADIM
    open[i] = 100
    high[i] = 100.4
    low[i] = 99.6
    close[i] = 100
    volume[i] = 10
  }
  const o = ozel || {}
  for (const k of Object.keys(o)) {
    const bar = k | 0
    const v = o[k]
    if (v.high !== undefined) high[bar] = v.high
    if (v.low !== undefined) low[bar] = v.low
    if (v.close !== undefined) close[bar] = v.close
    if (v.open !== undefined) open[bar] = v.open
  }
  return series.fromArrays({ time, open, high, low, close, volume })
}

// Bu blogun testleri ESKI 'atr' modunu dogrular; mod acikca verilir cunku
// varsayilan mod artik bolge tabanlidir.
const CFG = { mode: 'atr', horizonBars: 5, tpAtr: 1, slAtr: 1 }
const ALIS = { bar: 5, direction: 'BUY', isSupport: true }
const SATIS = { bar: 5, direction: 'SELL', isSupport: false }

// Bolge modu icin ornek dokunuslar.
//
// DIKKAT: DOKUNUS GIRIS MODELI DEGISTI. Varsayilan artik 'afterClose':
// karar dokunus barinin KAPANISINDA verilir, giris o kapanistan SONRA gelir.
// Kapanisin konumu giris modunu belirler:
//   kapanis kenarin LEHTE tarafinda  -> 'limitAfterClose' (kenara limit emir,
//                                       en erken bir sonraki barda dolar)
//   kapanis bolgenin ICINDE          -> 'close' (kapanistan girilir)
//   kapanis gecersizligin otesinde   -> olay etiketlenmez (null)
// Eski model (giris dokunus barinin ICINDE kenardan dolmus sayilir) bar ici
// ILERIYE BAKMA idi ve karsilastirma icin `touchEntryMode: 'zoneEdge'` ile
// hala secilebilir; asagidaki eski testler bu bayragi acikca veriyor.
//
// ALIS_BOLGE: kapanis 100, bolge 99.4 - 100.2, yani kapanis bolgenin ICINDE.
//   afterClose -> giris = 100 (kapanis), gecersizlik = 99.15, hedef = 101.20
//                 (hedef her zaman YAKIN KENARDAN olculur), risk 0.85, odul 1.20
//   zoneEdge   -> giris = 100.20, risk 1.05, odul 1.00
// SATIS_BOLGE: kapanis 100, bolge 99.8 - 100.6, kapanis yine bolgenin ICINDE.
const ALIS_BOLGE = {
  bar: 5, direction: 'BUY', isSupport: true,
  price: 100, zoneTop: 100.2, zoneBottom: 99.4,
}
const SATIS_BOLGE = {
  bar: 5, direction: 'SELL', isSupport: false,
  price: 100, zoneTop: 100.6, zoneBottom: 99.8,
}
const ZCFG = { horizonBars: 5, targetAtr: 1.0 }
/** Eski (bar ici) giris modelini acan ayar. */
const KENAR = { horizonBars: 5, targetAtr: 1.0, touchEntryMode: 'zoneEdge' }

test('DEFAULT_OUTCOME_CFG sozlesmedeki degerler', () => {
  assert.deepEqual(DEFAULT_OUTCOME_CFG, {
    mode: 'zone',
    horizonBars: 48,
    // Dokunus olayinda giris kararin verildigi kapanistan SONRA gelir.
    touchEntryMode: 'afterClose',
    // Limit emrin dolmus sayilmasi icin fiyatin kenari gecmesi gereken pay.
    fillOffsetAtr: 0.05,
    targetAtr: 1.0,
    breakBufferAtr: 0.25,
    minTargetAtr: 0.25,
    entryMode: 'zoneEdge',
    formTargetRr: 1.0,
    maxFormRiskAtr: 3.0,
    tpAtr: 1.0,
    slAtr: 1.0,
  })
})

// ---------------------------------------------------------------------------
// KUTU OLUSUM (kind = 'form') OLAYLARI
// ---------------------------------------------------------------------------

// Destek kutusu 99.4 - 100.2 arasinda, kutu onaylandiginda fiyat 100.8'de.
// ATR 1 ve varsayilan ayarlarla:
//   giris   = 100.80 (onay barinin kapanisi, kenara limit emir konmaz)
//   gecersiz= 99.4 - 0.25 = 99.15
//   risk    = 1.65 ATR
//   hedef   = giris + formTargetRr * risk = 100.80 + 1.65 = 102.45
const FORM_ALIS = {
  bar: 5, kind: 'form', direction: 'BUY', isSupport: true,
  price: 100.8, zoneTop: 100.2, zoneBottom: 99.4,
}

test('form olayinda giris onay barinin kapanisidir, kenar degil', () => {
  const lv = zoneLevels(FORM_ALIS, 1, {})
  assert.notEqual(lv, null)
  assert.equal(lv.entryMode, 'close')
  assert.ok(Math.abs(lv.entry - 100.8) < 1e-9, 'giris kapanis olmali: ' + lv.entry)
  assert.ok(Math.abs(lv.invalid - 99.15) < 1e-9, 'gecersizlik uzak kenar olmali: ' + lv.invalid)
})

test('form olayinda hedef riskin kati kadar uzaktir (formTargetRr)', () => {
  const lv = zoneLevels(FORM_ALIS, 1, {})
  assert.ok(Math.abs(lv.riskAtr - 1.65) < 1e-9, 'risk: ' + lv.riskAtr)
  assert.ok(Math.abs(lv.rewardAtr - 1.65) < 1e-9, 'formTargetRr 1.0 ile odul riske esit olmali')
  assert.ok(Math.abs(lv.target - 102.45) < 1e-9, 'hedef: ' + lv.target)

  // formTargetRr = 2 ile odul riskin iki kati.
  const iki = zoneLevels(FORM_ALIS, 1, { formTargetRr: 2 })
  assert.ok(Math.abs(iki.rewardAtr - 3.3) < 1e-9, 'odul: ' + iki.rewardAtr)

  // 0 kapatir: hedef sabit targetAtr mesafesinde.
  const kapali = zoneLevels(FORM_ALIS, 1, { formTargetRr: 0, targetAtr: 1.0 })
  assert.ok(Math.abs(kapali.rewardAtr - 1.0) < 1e-9, 'odul: ' + kapali.rewardAtr)
})

test('form olayinda asiri risk maxFormRiskAtr ile elenir', () => {
  // Fiyat kutudan cok uzakta: risk 1 ATR'lik olcekte 10 birimin ustunde.
  const uzak = Object.assign({}, FORM_ALIS, { price: 110 })
  assert.equal(zoneLevels(uzak, 1, {}), null, 'esigi asan form olayi seviye uretmemeli')
  assert.notEqual(zoneLevels(uzak, 1, { maxFormRiskAtr: 0 }), null, '0 siniri kapatmali')
})

test('form olayinda giris gecersizligin ters tarafindaysa seviye kurulmaz', () => {
  // Destek kutusu ama kapanis kutunun ta altinda: ortada islem yok.
  const ters = Object.assign({}, FORM_ALIS, { price: 99 })
  assert.equal(zoneLevels(ters, 1, {}), null)
})

test('form olayi etiketlenir: hedef once vurulursa respect', () => {
  // Hedef 102.45; 8. barda 102.6 gorulur, gecersizlik (99.15) hic gorulmez.
  const s = seriKur(20, { 8: { high: 102.6 } })
  const o = labelTouch(s, FORM_ALIS, 1, { horizonBars: 5 })
  assert.notEqual(o, null)
  assert.equal(o.outcome, 'respect')
  assert.equal(o.success, true)
  assert.ok(Math.abs(o.entryPrice - 100.8) < 1e-9)
  assert.ok(Math.abs(o.targetPrice - 102.45) < 1e-9)
  assert.ok(Math.abs(o.invalidPrice - 99.15) < 1e-9)
})

test('form olayi etiketlenir: kutu kirilirsa break', () => {
  const s = seriKur(20, { 7: { low: 99.0 } })
  const o = labelTouch(s, FORM_ALIS, 1, { horizonBars: 5 })
  assert.notEqual(o, null)
  assert.equal(o.outcome, 'break')
  assert.equal(o.success, false)
  assert.equal(o.barsToOutcome, 2)
})

test('form olayinda olay barinin kendisi gecersizlik saymaz', () => {
  // Dokunus olayinda giris kenardan limit emirle DOLDUGU icin olay barinin
  // gecersizligi aninda kirilma sayilir. Form olayinda giris kapanistan
  // oldugu icin boyle bir kural yoktur: emir bar kapaninca dolar.
  const s = seriKur(20, { 5: { low: 99.0 } })
  const o = labelTouch(s, FORM_ALIS, 1, { horizonBars: 5 })
  assert.notEqual(o, null)
  assert.notEqual(o.barsToOutcome, 0, 'olay barinda aninda kirilma yazilmamali')
})

test('TP once vurulursa outcome respect olur', () => {
  // Giris 100, ATR 1 -> TP 101, SL 99. TP 8. barda vuruluyor.
  const s = seriKur(20, { 8: { high: 101.2 } })
  const o = labelTouch(s, ALIS, 1, CFG)
  assert.notEqual(o, null)
  assert.equal(o.outcome, 'respect')
  assert.equal(o.success, true)
  assert.equal(o.barsToOutcome, 3)
  assert.equal(o.atr, 1)
  assert.ok(o.mfeAtr >= 1.2 - 1e-9, 'mfeAtr ufkun tamamindan hesaplanmali: ' + o.mfeAtr)
})

test('SL once vurulursa outcome break olur', () => {
  const s = seriKur(20, { 7: { low: 98.5 }, 9: { high: 101.5 } })
  const o = labelTouch(s, ALIS, 1, CFG)
  assert.equal(o.outcome, 'break')
  assert.equal(o.success, false)
  assert.equal(o.barsToOutcome, 2)
  assert.ok(o.maeAtr >= 1.5 - 1e-9, 'maeAtr 1.5 ATR olmali: ' + o.maeAtr)
})

test('ayni barda hem TP hem SL vurulursa MUHAFAZAKAR davranilir (SL kazanir)', () => {
  const s = seriKur(20, { 6: { high: 101.5, low: 98.5 } })
  const o = labelTouch(s, ALIS, 1, CFG)
  assert.equal(o.outcome, 'break')
  assert.equal(o.success, false)
  assert.equal(o.barsToOutcome, 1)
})

test('hicbiri vurulmazsa outcome timeout olur', () => {
  const s = seriKur(20)
  const o = labelTouch(s, ALIS, 1, CFG)
  assert.equal(o.outcome, 'timeout')
  assert.equal(o.success, false)
  assert.equal(o.barsToOutcome, -1)
  assert.ok(o.mfeAtr < 1)
  assert.ok(o.maeAtr < 1)
})

test('SELL yonu simetriktir: asagi hareket TP, yukari hareket SL', () => {
  // Giris 100, TP 99, SL 101.
  const tp = labelTouch(seriKur(20, { 7: { low: 98.8 } }), SATIS, 1, CFG)
  assert.equal(tp.outcome, 'respect')
  assert.equal(tp.barsToOutcome, 2)

  const sl = labelTouch(seriKur(20, { 7: { high: 101.2 } }), SATIS, 1, CFG)
  assert.equal(sl.outcome, 'break')
  assert.equal(sl.barsToOutcome, 2)

  const ikisi = labelTouch(seriKur(20, { 6: { high: 101.2, low: 98.8 } }), SATIS, 1, CFG)
  assert.equal(ikisi.outcome, 'break', 'ayni barda ikisi de vurulursa SL kazanir')
})

test('ileri veri yetmiyorsa null doner', () => {
  const s = seriKur(20)
  // bar + horizonBars >= n  ->  15 + 5 = 20 >= 20
  assert.equal(labelTouch(s, { bar: 15, direction: 'BUY' }, 1, CFG), null)
  assert.equal(labelTouch(s, { bar: 19, direction: 'BUY' }, 1, CFG), null)
  // Son etiketlenebilir bar 14 olmali.
  assert.notEqual(labelTouch(s, { bar: 14, direction: 'BUY' }, 1, CFG), null)
})

test('gecersiz girdilerde null doner', () => {
  const s = seriKur(20)
  assert.equal(labelTouch(null, ALIS, 1, CFG), null)
  assert.equal(labelTouch(s, null, 1, CFG), null)
  assert.equal(labelTouch(s, { bar: -1, direction: 'BUY' }, 1, CFG), null)
  assert.equal(labelTouch(s, ALIS, 0, CFG), null, 'ATR sifirsa etiketlenemez')
  assert.equal(labelTouch(s, ALIS, NaN, CFG), null)
})

test('mfeAtr / maeAtr ATR biriminde ve negatif degil', () => {
  const s = seriKur(20, { 6: { high: 100.9 }, 7: { low: 99.2 } })
  const o = labelTouch(s, ALIS, 2, CFG)   // ATR = 2
  assert.equal(o.outcome, 'timeout')
  assert.ok(o.mfeAtr >= 0 && o.maeAtr >= 0)
  assert.ok(Math.abs(o.mfeAtr - 0.9 / 2) < 1e-9, 'mfeAtr = 0.9 / 2: ' + o.mfeAtr)
  assert.ok(Math.abs(o.maeAtr - 0.8 / 2) < 1e-9, 'maeAtr = 0.8 / 2: ' + o.maeAtr)
})

test('fwdReturnPct ufkun sonundaki yonlu getiridir', () => {
  const s = seriKur(20, { 10: { close: 101, high: 101 } })
  const alis = labelTouch(s, ALIS, 1, CFG)   // son bar = 5 + 5 = 10
  assert.ok(Math.abs(alis.fwdReturnPct - 1) < 1e-9, 'BUY icin +%1 beklenir: ' + alis.fwdReturnPct)

  const satis = labelTouch(s, SATIS, 1, CFG)
  assert.ok(Math.abs(satis.fwdReturnPct + 1) < 1e-9, 'SELL icin -%1 beklenir: ' + satis.fwdReturnPct)
})

test('isSupport alani direction yerine kullanilabilir', () => {
  const s = seriKur(20, { 7: { high: 101.2 } })
  const o = labelTouch(s, { bar: 5, isSupport: true }, 1, CFG)
  assert.equal(o.outcome, 'respect')
})

test('cfg verilmezse DEFAULT_OUTCOME_CFG kullanilir (48 bar ufuk, 1.0 ATR hedef)', () => {
  // 48 barlik ufuk icin yeterli veri yoksa null donmeli.
  const kisa = seriKur(50)
  assert.equal(labelTouch(kisa, ALIS_BOLGE, 1), null)

  // Varsayilan targetAtr 1.0 -> hedef = 100.2 + 1.0 = 101.20
  const yetmez = seriKur(200, { 50: { high: 101.0 } })
  assert.equal(labelTouch(yetmez, ALIS_BOLGE, 1).outcome, 'timeout',
    '101.0 varsayilan 101.20 hedefine yetmez')

  const uzun = seriKur(200, { 50: { high: 101.3 } })
  const o = labelTouch(uzun, ALIS_BOLGE, 1)
  assert.equal(o.mode, 'zone')
  assert.equal(o.outcome, 'respect')
  assert.equal(o.barsToOutcome, 45)
  // Kapanis (100) bolgenin ICINDE oldugu icin giris kapanistir; kenara limit
  // emir konmaz, cunku fiyat zaten kenarin ic tarafindadir.
  assert.equal(o.entryMode, 'close')
  assert.equal(o.entryPrice, 100, 'giris dokunus barinin kapanisi')
  // Hedef yine YAKIN KENARDAN olculur, giristen degil.
  assert.ok(Math.abs(o.targetPrice - 101.2) < 1e-9, 'hedef = zoneTop + 1.0 ATR')
})

// ===========================================================================
// BOLGE MODU (varsayilan): "bolge gercekten tuttu mu"
// ===========================================================================

test('zoneLevels kenardan giriste seviyeleri bolge geometrisinden uretir', () => {
  // ESKI MODEL (touchEntryMode: 'zoneEdge'). Karsilastirma icin korundu.
  const lv = zoneLevels(ALIS_BOLGE, 1, { targetAtr: 1.0, touchEntryMode: 'zoneEdge' })
  assert.equal(lv.sign, 1)
  assert.equal(lv.entryMode, 'zoneEdge')
  assert.ok(Math.abs(lv.entry - 100.2) < 1e-9, 'giris = zoneTop')
  assert.ok(Math.abs(lv.invalid - 99.15) < 1e-9, 'gecersizlik = zoneBottom - 0.25 ATR')
  assert.ok(Math.abs(lv.target - 101.2) < 1e-9, 'hedef = zoneTop + 1.0 ATR')
  assert.ok(Math.abs(lv.riskAtr - 1.05) < 1e-9)
  assert.ok(Math.abs(lv.rewardAtr - 1.0) < 1e-9, 'kenardan giriste odul tam targetAtr')

  const sv = zoneLevels(SATIS_BOLGE, 1, { targetAtr: 1.0, touchEntryMode: 'zoneEdge' })
  assert.equal(sv.sign, -1)
  assert.ok(Math.abs(sv.entry - 99.8) < 1e-9, 'giris = zoneBottom')
  assert.ok(Math.abs(sv.invalid - 100.85) < 1e-9, 'gecersizlik = zoneTop + 0.25 ATR')
  assert.ok(Math.abs(sv.target - 98.8) < 1e-9, 'hedef = zoneBottom - 1.0 ATR')
  assert.ok(Math.abs(sv.rewardAtr - 1.0) < 1e-9)
})

test('kenardan giriste risk/odul kapanisin konumundan BAGIMSIZDIR', () => {
  // Ayni bolge, kapanis cok farkli iki yerde. Kenardan giriste risk ve odul
  // ayni kalmali; ters secim sorunu bu yuzden ortadan kalkar.
  const a = zoneLevels({ direction: 'BUY', price: 100.19, zoneTop: 100.2, zoneBottom: 99.4 }, 1, { touchEntryMode: 'zoneEdge' })
  const b = zoneLevels({ direction: 'BUY', price: 99.45, zoneTop: 100.2, zoneBottom: 99.4 }, 1, { touchEntryMode: 'zoneEdge' })
  assert.ok(Math.abs(a.riskAtr - b.riskAtr) < 1e-12)
  assert.ok(Math.abs(a.rewardAtr - b.rewardAtr) < 1e-12)

  // Kapanistan giriste ise risk kapanisla birlikte carpilir.
  const ka = zoneLevels({ direction: 'BUY', price: 100.19, zoneTop: 100.2, zoneBottom: 99.4 }, 1, { entryMode: 'close' })
  const kb = zoneLevels({ direction: 'BUY', price: 99.45, zoneTop: 100.2, zoneBottom: 99.4 }, 1, { entryMode: 'close' })
  assert.ok(ka.riskAtr - kb.riskAtr > 0.5, 'kapanistan giriste risk kapanisa gore cok degisir')
})

test('kapanistan giriste hedef en az minTargetAtr kadar uzaga konur', () => {
  // Kapanis bolgenin cok ustunde: ham hedef girisin altinda kalirdi.
  const t = { direction: 'BUY', price: 105, zoneTop: 100.2, zoneBottom: 99.4 }
  const lv = zoneLevels(t, 1, { entryMode: 'close' })
  assert.ok(lv.target >= 105 + 0.25 - 1e-9, 'hedef en az giris + 0.25 ATR olmali')
})

test('kenardan giriste dokunus barinda gecersizlik gorulduyse ANINDA kirilma', () => {
  // ESKI MODEL: emir dokunus bari icinde dolar; ayni bar gecersizligi de
  // gordiyse bar ici sirayi bilemeyiz, muhafazakar davranilir.
  const s = seriKur(20, { 5: { low: 99.0 } })
  const o = labelTouch(s, ALIS_BOLGE, 1, KENAR)
  assert.equal(o.outcome, 'break')
  assert.equal(o.barsToOutcome, 0)
})

test('bolge modu: hedef once gelirse bolge TUTTU', () => {
  const s = seriKur(20, { 8: { high: 101.3 } })
  const o = labelTouch(s, ALIS_BOLGE, 1, ZCFG)
  assert.equal(o.mode, 'zone')
  assert.equal(o.outcome, 'respect')
  assert.equal(o.success, true)
  assert.equal(o.barsToOutcome, 3)
})

test('bolge modu: gecersizlik once gelirse bolge KIRILDI', () => {
  const s = seriKur(20, { 7: { low: 99.1 } })
  const o = labelTouch(s, ALIS_BOLGE, 1, ZCFG)
  assert.equal(o.outcome, 'break')
  assert.equal(o.success, false)
  assert.equal(o.barsToOutcome, 2)
})

test('bolge modu: ayni barda ikisi de olursa MUHAFAZAKAR davranilir (kirildi)', () => {
  const s = seriKur(20, { 7: { high: 101.3, low: 99.1 } })
  const o = labelTouch(s, ALIS_BOLGE, 1, ZCFG)
  assert.equal(o.outcome, 'break')
})

test('bolge modu: hicbiri olmazsa timeout', () => {
  const o = labelTouch(seriKur(20), ALIS_BOLGE, 1, ZCFG)
  assert.equal(o.outcome, 'timeout')
  assert.equal(o.barsToOutcome, -1)
})

test('bolge modu SELL yonu simetriktir', () => {
  // gecersizlik 100.85, hedef 98.8
  const tuttu = labelTouch(seriKur(20, { 8: { low: 98.7 } }), SATIS_BOLGE, 1, ZCFG)
  assert.equal(tuttu.outcome, 'respect')

  const kirildi = labelTouch(seriKur(20, { 7: { high: 100.9 } }), SATIS_BOLGE, 1, ZCFG)
  assert.equal(kirildi.outcome, 'break')

  const ikisi = labelTouch(seriKur(20, { 7: { high: 100.9, low: 98.7 } }), SATIS_BOLGE, 1, ZCFG)
  assert.equal(ikisi.outcome, 'break', 'ayni barda ikisi de varsa kirilma kazanir')
})

test('mfeExitAtr yalnizca SONUCA kadar olan hareketi olcer', () => {
  // 7. barda gecersizlik vurulur, 9. barda buyuk lehte hareket olur.
  // mfeAtr bu hareketi gorur, mfeExitAtr GORMEZ.
  // Giris 100.2 (bolge kenari). 7. barda gecersizlik (99.15) vurulur,
  // 9. barda 105'e cikilir. mfeAtr bu hareketi gorur, mfeExitAtr GORMEZ.
  const s = seriKur(20, { 7: { low: 99.1 }, 9: { high: 105 } })
  const o = labelTouch(s, ALIS_BOLGE, 1, ZCFG)
  assert.equal(o.outcome, 'break')
  assert.ok(o.mfeAtr >= 4.7, 'mfeAtr tum ufku olcer, buyuk hareketi icerir: ' + o.mfeAtr)
  assert.ok(o.mfeExitAtr <= 0.5, 'mfeExitAtr sonuc barindan sonrasini saymaz: ' + o.mfeExitAtr)
  assert.ok(o.mfeExitAtr <= o.mfeAtr, 'mfeExitAtr her zaman mfeAtr kadar veya daha kucuk')
})

test('bolge modu bolge bilgisi olmayan dokunusta null doner', () => {
  const s = seriKur(20)
  assert.equal(labelTouch(s, { bar: 5, direction: 'BUY' }, 1, ZCFG), null)
})

test('riskAtr ve rewardAtr plan ile ayni seviyeleri tasir', () => {
  const s = seriKur(20)
  // Varsayilan model: kapanis bolgenin icinde, giris kapanistan (100).
  const o = labelTouch(s, ALIS_BOLGE, 1, ZCFG)
  assert.ok(Math.abs(o.entryPrice - 100) < 1e-9)
  assert.ok(Math.abs(o.invalidPrice - 99.15) < 1e-9)
  assert.ok(Math.abs(o.targetPrice - 101.2) < 1e-9)
  assert.ok(Math.abs(o.riskAtr - 0.85) < 1e-9, 'risk = |giris - gecersizlik|: ' + o.riskAtr)
  assert.ok(Math.abs(o.rewardAtr - 1.2) < 1e-9, 'odul = |hedef - giris|: ' + o.rewardAtr)

  // Eski model: giris kenardan, risk/odul bolge geometrisinden.
  const k = labelTouch(s, ALIS_BOLGE, 1, KENAR)
  assert.ok(Math.abs(k.entryPrice - 100.2) < 1e-9)
  assert.ok(Math.abs(k.riskAtr - 1.05) < 1e-9)
  assert.ok(Math.abs(k.rewardAtr - 1.0) < 1e-9)
})

// ===========================================================================
// DOKUNUS GIRIS MODELI: 'afterClose' (VARSAYILAN)
// ===========================================================================
// Eski model girisi dokunus barinin ICINDE, kenardan dolmus sayiyordu. Karar
// ise bar KAPANISINDAKI bilgiyle (fitil reddi, penetration, hacim) veriliyor.
// Yani islem, kararin dayandigi bilgi olusmadan onceki bir fiyattan
// yaziliyordu: bar ici ileriye bakma. Olculdu (5m fitil reddi alt kumesi):
// eski modelde %58.4 isabet / +0.490 ATR, gerceklestirilebilir modelde
// %30.9 / -0.117 ATR. Asagidaki testler yeni modeli kilitler.

/** Kapanis kenarin lehte tarafinda: kenara limit emir konur. */
const ALIS_LIMIT = {
  bar: 5, direction: 'BUY', isSupport: true,
  price: 100.5, zoneTop: 100.2, zoneBottom: 99.4,
}

test('afterClose: kapanis kenarin lehte tarafindaysa kenara limit emir konur', () => {
  const lv = zoneLevels(ALIS_LIMIT, 1, {})
  assert.notEqual(lv, null)
  assert.equal(lv.entryMode, 'limitAfterClose')
  assert.ok(Math.abs(lv.entry - 100.2) < 1e-9, 'giris bolgenin yakin kenari')
})

test('afterClose: kapanis bolge icindeyse giris KAPANISTAN olur', () => {
  const lv = zoneLevels(ALIS_BOLGE, 1, {})
  assert.equal(lv.entryMode, 'close')
  assert.ok(Math.abs(lv.entry - 100) < 1e-9)
})

test('afterClose: kapanis gecersizligin otesindeyse olay ETIKETLENMEZ', () => {
  // Kapanis 99.1, gecersizlik 99.15: bolge o barda zaten kirilmis.
  const kirik = Object.assign({}, ALIS_BOLGE, { price: 99.1 })
  assert.equal(zoneLevels(kirik, 1, {}), null)
  assert.equal(labelTouch(seriKur(20), kirik, 1, ZCFG), null)
})

// (a) Dokunus barinin high/low degeri artik dolumu ve sonucu ETKILEMEZ:
// karar kapanista verilir, emir sonraki barlarda dolar.
test('afterClose: dokunus barinin high/low degeri dolumu ve sonucu ETKILEMEZ', () => {
  // Ayni kapanis, olay barinda cok farkli fitiller. Bar 6'da dolum, bar 8'de hedef.
  const temiz = seriKur(20, { 5: { close: 100.5, high: 100.6 }, 6: { low: 100.1 }, 8: { high: 101.3 } })
  const fitilli = seriKur(20, {
    5: { close: 100.5, high: 104, low: 99.0 },   // olay barinda hem hedef hem gecersizlik seviyesi
    6: { low: 100.1 },
    8: { high: 101.3 },
  })

  const a = labelTouch(temiz, ALIS_LIMIT, 1, ZCFG)
  const b = labelTouch(fitilli, ALIS_LIMIT, 1, ZCFG)
  assert.notEqual(a, null)
  assert.notEqual(b, null)
  assert.equal(a.outcome, 'respect')
  assert.equal(b.outcome, a.outcome, 'olay barinin fitili sonucu degistirmemeli')
  assert.equal(b.barsToFill, a.barsToFill)
  assert.equal(b.barsToOutcome, a.barsToOutcome)
  assert.equal(b.entryPrice, a.entryPrice)
})

// (b) Dolum en erken BIR SONRAKI barda olur.
test('afterClose: limit emir en erken bir sonraki barda dolar', () => {
  // Dolum fiyati = kenar - 0.05 ATR = 100.15. Bar 6 bunu gorur.
  const s = seriKur(20, { 5: { close: 100.5, low: 100.1 }, 6: { low: 100.1 }, 8: { high: 101.3 } })
  const o = labelTouch(s, ALIS_LIMIT, 1, ZCFG)
  assert.equal(o.filled, true)
  assert.ok(o.barsToFill >= 1, 'dolum olay barinda olamaz: ' + o.barsToFill)
  assert.equal(o.barsToFill, 1)
  assert.equal(o.entryMode, 'limitAfterClose')
})

// (c) Dolmadan hedefe giden olay 'nofill' olur ve kazanc sayilmaz.
test('afterClose: dolmadan hedefe gidilirse sonuc nofill olur, kazanc degil', () => {
  // Fiyat kenara hic donmez, dogruca hedefe (101.2) gider.
  const s = seriKur(20, { 5: { close: 100.5, low: 100.4 }, 6: { low: 100.4, high: 101.3 } })
  const o = labelTouch(s, ALIS_LIMIT, 1, ZCFG)
  assert.notEqual(o, null)
  assert.equal(o.outcome, 'nofill')
  assert.equal(o.success, false, 'dolmayan emir kazanc sayilmaz')
  assert.equal(o.filled, false)
  assert.equal(o.realizedR, 0, 'islem acilmadigi icin sonuc sifir')
  assert.equal(o.missedTarget, true, 'hedefe dolmadan gidildigi isaretlenmeli')
  assert.equal(o.mfeAtr, 0)
  assert.equal(o.barsToOutcome, -1)
})

test('afterClose: ufuk boyunca hic dolum olmazsa sonuc nofill olur', () => {
  // Fiyat ne kenara doner ne hedefe gider.
  const s = seriKur(20, { 5: { close: 100.5, low: 100.45 } })
  for (let i = 6; i <= 10; i++) s.low[i] = 100.45
  const o = labelTouch(s, ALIS_LIMIT, 1, ZCFG)
  assert.equal(o.outcome, 'nofill')
  assert.equal(o.filled, false)
  assert.equal(o.missedTarget, false)
})

test('afterClose: dolum barinda gecersizlik de gorulduyse MUHAFAZAKAR kirilma', () => {
  // Bar 6 hem dolum fiyatini (100.15) hem gecersizligi (99.15) gorur.
  const s = seriKur(20, { 5: { close: 100.5 }, 6: { low: 99.0 } })
  const o = labelTouch(s, ALIS_LIMIT, 1, ZCFG)
  assert.equal(o.outcome, 'break')
  assert.equal(o.filled, true)
  assert.equal(o.realizedR, -1)
  assert.equal(o.barsToOutcome, 1)
})

test('afterClose: sonuc alanlari sozlesmeyi tasir (entryMode, filled, resolvedBar, exitPrice, realizedR)', () => {
  const tuttu = labelTouch(
    seriKur(20, { 5: { close: 100.5 }, 6: { low: 100.1 }, 8: { high: 101.3 } }),
    ALIS_LIMIT, 1, ZCFG
  )
  assert.equal(tuttu.outcome, 'respect')
  assert.equal(tuttu.entryMode, 'limitAfterClose')
  assert.equal(tuttu.filled, true)
  assert.equal(tuttu.exitPrice, tuttu.targetPrice, 'tutan islem hedeften cikar')
  assert.ok(Math.abs(tuttu.realizedR - tuttu.rewardAtr / tuttu.riskAtr) < 1e-12,
    'gerceklesen R odul/risk olmali: ' + tuttu.realizedR)
  assert.equal(tuttu.resolvedBar, 8, 'sonuc hedefin vuruldugu barda bellidir')

  const zamanAsimi = labelTouch(
    seriKur(20, { 5: { close: 100.5 }, 6: { low: 100.1 } }),
    ALIS_LIMIT, 1, ZCFG
  )
  assert.equal(zamanAsimi.outcome, 'timeout')
  assert.equal(zamanAsimi.resolvedBar, 10, 'zaman asiminda sonuc ufuk sonunda bellidir')
  assert.equal(zamanAsimi.exitPrice, 100, 'ufuk sonu kapanisindan cikilir')
})

// (d) Zaman asimi TAM STOP ZARARI DEGIL: ufuk sonu kapanisindan degerlenir.
test('zaman asiminda gerceklesen R ufuk sonu kapanisindan hesaplanir', () => {
  // Giris 100.2 (eski kenar modeli ile sabit), gecersizlik 99.15 -> risk 1.05.
  // Ufuk sonunda kapanis 100.62: lehte 0.42 ATR, yani +0.4 risk birimi.
  const s = seriKur(20, { 10: { close: 100.62 } })
  const o = labelTouch(s, ALIS_BOLGE, 1, KENAR)
  assert.equal(o.outcome, 'timeout')
  assert.ok(o.realizedR > 0, 'lehte kapanan zaman asimi zarar yazmamali: ' + o.realizedR)
  assert.ok(Math.abs(o.realizedR - 0.42 / 1.05) < 1e-9, 'gerceklesen R: ' + o.realizedR)
  assert.equal(o.exitPrice, 100.62)

  // Aleyhte kapanista sonuc negatif ama -1 (tam stop) DEGIL.
  const aleyhte = labelTouch(seriKur(20, { 10: { close: 99.8 } }), ALIS_BOLGE, 1, KENAR)
  assert.equal(aleyhte.outcome, 'timeout')
  assert.ok(aleyhte.realizedR < 0)
  assert.ok(aleyhte.realizedR > -1, 'zaman asimi tam stop zarari olmamali: ' + aleyhte.realizedR)
})
