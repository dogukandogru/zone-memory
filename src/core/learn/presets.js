'use strict'

/**
 * Zaman dilimine gore olculmus hazir ayarlar.
 *
 * ----------------------------------------------------------------------------
 * BU DEGERLER TAHMIN DEGIL, OLCUM
 * ----------------------------------------------------------------------------
 * Yontem: 6.086.450 adet 1 dakikalik XAUUSD mumu (2009-03 .. 2026-07) uzerinde
 * yuruyen ileri test. Gecmis ikiye bolundu:
 *   ayar donemi      2009-2018  -> parametreler BURADAN secildi
 *   dogrulama donemi 2019-2026  -> secim BURAYA BAKILMADAN yapildi, sonra test edildi
 * Testin kendisi de ileriye bakmaz: her olay yalnizca kendinden en az 1 gun
 * once BITMIS kayitlarla karsilastirilir (bkz. backtest.js embargoSec).
 *
 * Dogrulama donemi sonuclari (islem maliyeti dahil, maliyet = fiyatin %0.0068'i,
 * yani 4400 dolarlik altinda 0.30 dolar gidis-donus):
 *
 *   tf    islem  isabet  taban   brut/islem  maliyet  NET/islem  kar fak.
 *   1m      478   %72.0  %52.4     +0.377    -0.265    +0.112     1.27
 *   5m      113   %57.5  %43.2     +0.293    -0.108    +0.184     1.30
 *   15m      18   %55.6  %38.4     +0.264    -0.054    +0.210     1.35
 *
 * "taban", hicbir secim yapmadan TUM ilk dokunuslari almanin isabet oranidir.
 * Sistemin katma degeri isabet ile taban arasindaki farktir: 1m'de +19.6,
 * 5m'de +14.3, 15m'de +17.2 puan. Uc zaman diliminde de ayni yonde ve ornek
 * disi donemde de gecerli.
 *
 * NEDEN VARSAYILAN 5 DAKIKA:
 *   1m  en yuksek isabeti ve en cok ornegi verir ama hareketler kucuk oldugu
 *       icin islem maliyeti edimin %70'ini yer (medyan ATR tum gecmiste yalnizca
 *       0.35 dolar). Net kalir ama pay cok incedir ve spread'e cok duyarlidir.
 *   15m en yuksek net getiriyi verir ama dogrulama doneminde yalnizca 18 islem
 *       urettigi icin bu sayiya guvenmek zordur.
 *   5m  ikisinin arasindadir: 113 islem, kar faktoru 1.30, maliyet edimin
 *       %37'sini yer. Pratikte en dengeli secim budur.
 *
 * Hedef (targetAtr) zaman dilimiyle birlikte buyur, cunku bolge genisligi
 * ATR'ye gore buyudukce 1.0 ATR'lik hedef yeterli risk/odul birakmaz.
 */

/** @type {Object<string, {targetAtr:number, minSimilarity:number, minMatches:number, minWinRate:number, note:string}>} */
const PRESETS = {
  '1m': {
    targetAtr: 1.0,
    minSimilarity: 0.80,
    minMatches: 15,
    minWinRate: 0.62,
    note: 'En yüksek isabet (%72) ve en çok örnek, ama hareketler küçük olduğu için ' +
      'işlem maliyeti edimin çoğunu yer. Düşük spreadli hesapta anlamlı.',
  },
  '5m': {
    targetAtr: 1.5,
    minSimilarity: 0.80,
    minMatches: 15,
    minWinRate: 0.55,
    note: 'Önerilen. Örnek sayısı ile işlem başına kazanç arasında en dengeli nokta.',
  },
  '15m': {
    targetAtr: 1.5,
    minSimilarity: 0.85,
    minMatches: 15,
    minWinRate: 0.55,
    note: 'İşlem başına en yüksek net kazanç, ama doğrulama döneminde yalnızca ' +
      '18 işlem üretti. Sinyal seyrek, istatistik zayıf.',
  },
  '30m': {
    targetAtr: 2.0,
    minSimilarity: 0.85,
    minMatches: 10,
    minWinRate: 0.55,
    note: 'Ölçülmedi, 15 dakikalıktan türetildi. Sinyal sayısı çok az kalır.',
  },
  '1h': {
    targetAtr: 2.0,
    minSimilarity: 0.85,
    minMatches: 10,
    minWinRate: 0.55,
    note: 'Ölçülmedi, 15 dakikalıktan türetildi. Sinyal sayısı çok az kalır.',
  },
  '4h': {
    targetAtr: 2.0,
    minSimilarity: 0.85,
    minMatches: 8,
    minWinRate: 0.55,
    note: 'Ölçülmedi. Bu zaman diliminde hafıza kuracak kadar olay oluşmaz.',
  },
}

/** Önerilen varsayılan zaman dilimi. */
const DEFAULT_TF = '5m'

/**
 * Zaman dilimi icin hazir ayari dondurur. Bilinmeyen zaman diliminde
 * varsayilan (5 dakika) ayara duser.
 * @param {string} tf
 * @returns {{targetAtr:number, minSimilarity:number, minMatches:number, minWinRate:number, note:string}}
 */
function presetFor (tf) {
  const p = PRESETS[tf] || PRESETS[DEFAULT_TF]
  return Object.assign({}, p)
}

/**
 * Hazir ayari sonuc ve sinyal ayarlarina uygular.
 * Cagiranin ACIKCA verdigi degerler hazir ayari EZER, yani kullanicinin
 * Ayarlar ekranindan girdigi degerler her zaman kazanir.
 *
 * @param {string} tf
 * @param {object} [outcomeCfg]  kullanicinin verdigi sonuc ayarlari
 * @param {object} [signalCfg]   kullanicinin verdigi sinyal ayarlari
 * @returns {{outcomeCfg: object, signalCfg: object, preset: object}}
 */
function applyPreset (tf, outcomeCfg, signalCfg) {
  const p = presetFor(tf)
  const o = Object.assign({ targetAtr: p.targetAtr }, outcomeCfg || {})
  const s = Object.assign({
    minSimilarity: p.minSimilarity,
    minMatches: p.minMatches,
    minWinRate: p.minWinRate,
  }, signalCfg || {})
  return { outcomeCfg: o, signalCfg: s, preset: p }
}

module.exports = {
  PRESETS,
  DEFAULT_TF,
  presetFor,
  applyPreset,
}
