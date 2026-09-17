'use strict'

/**
 * Sinyal uretimi (A6, sozlesme bolum 15).
 *
 * Bir bolge olayini hafizadaki benzer gecmis kurulumlarla karsilastirir,
 * islem planini benzer orneklerin MFE/MAE dagilimindan cikarir ve her durumda
 * (sinyal uretilsin ya da uretilmesin) Turkce gerekcelerle dolu bir nesne doner.
 *
 * Olay iki turden biridir (bkz. indicator/proZones.js):
 *   kind = 'form'   kutu yeni dogdu, giris onay barinin kapanisi
 *   kind = 'touch'  fiyat kutuya geri dondu, giris bolgenin yakin kenari
 * Karsilastirma YALNIZCA ayni turdeki gecmis olaylarla yapilir; iki tur farkli
 * kurulumlardir ve istatistikleri karistirilirsa sonuc yaniltici olur.
 *
 * Sozlesme notlari:
 * - `knn` secenekleri arasinda sorgunun zamani yok ama `excludeWithinSec`
 *   "sorgu zamanina yakin kayitlari ele" diyor. Bu bosluk icin dokunus zamani
 *   `time` / `queryTime` alanlariyla ayrica gonderiliyor VE komsu dislama
 *   burada bir kez daha uygulaniyor. Boylece benzerlik modulunun yorumundan
 *   bagimsiz olarak kendi kendine eslesme onlenir.
 * - `beforeTime` verilmezse (undefined/null) sozlesmedeki knn tanimina uygun
 *   sekilde zaman filtresi UYGULANMAZ. Yuruyen ileri testte ve canli akista
 *   cagiran taraf bu degeri MUTLAKA gecmelidir, aksi halde ileriye bakma olur.
 *
 * MODULUN IKI ASAMASI (A2)
 * ---------------------------------------------------------------------------
 * `evaluateTouch` iki adimdir ve adimlar AYRI fonksiyonlardir:
 *   1. findCandidates       hafizadan komsulari bulur (PAHALI: knn)
 *   2. decideFromCandidates komsulardan karari ve plani uretir (UCUZ, saf)
 * Bunu ayirmanin tek nedeni parametre taramasidir: esik degistiginde
 * (minSimilarity / minMatches / minWinRate) KOMSULAR degismez, yalnizca karar
 * degisir. Komsular bir kez hesaplanip onbellege alinirsa (learn/candcache.js)
 * onlarca esik denemesi saniyeler icinde kosar.
 * `evaluateTouch` iki adimin BILESIMIDIR; karar mantigi baska hicbir yerde
 * tekrar yazilmaz, aksi halde onbellekli yol ile referans yol sessizce
 * ayrisirdi.
 */

const { knn, DEFAULT_WEIGHTS } = require('./similarity')
const { matchPrototype } = require('./cluster')
const { zoneLevels, DEFAULT_OUTCOME_CFG } = require('./outcome')

// Varsayilanlar gecmisin ILK YARISINDA (2009-2018) yapilan parametre
// taramasiyla secildi, sonra IKINCI YARIDA (2019-2026) dogrulandi. Secim
// dogrulama donemine bakilarak yapilmadi.
// 1 dakikalik, hedef 1.0 ATR, kenardan giris:
//   ayar donemi      n=366  isabet %68.9  beklenti +0.302 ATR  kar faktoru 1.78
//   dogrulama donemi n=478  isabet %72.0  beklenti +0.377 ATR  kar faktoru 2.10
//   ayni donemde secim yapilmasaydi taban isabet %52.4 idi.
const DEFAULT_SIGNAL_CFG = {
  k: 25,
  minSimilarity: 0.80,
  minMatches: 15,
  minWinRate: 0.62,
  excludeWithinSec: 86400 * 3,
  weights: { shape: 0.60, ctx: 0.25, dtw: 0.15 },
  tp1Pct: 40,
  tp2Pct: 70,
  slPct: 75,
  // Stop, bolgenin gecersizlik seviyesinden alinir. Bu, hafizanin ogrendigi
  // etiketle islem planini AYNI seye baglar: "bolge kirildi mi" sorusunun
  // cevabi ile stop'un vurulup vurulmadigi ayni olaydir.
  // false yapilirsa eski davranisa (MAE yuzdeligi) donulur.
  useZoneStop: true,
  outcomeCfg: null,
  // Asgari risk/odul orani. Giris dokunus barinin KAPANISI oldugu icin, kapanis
  // bolgeden uzaklastikca odul kuculur ve risk buyur; boyle kurulumlar yuksek
  // isabet oranina ragmen matematiksel olarak zararlidir.
  // Olculdu (1m, 2009-2026): bu filtre olmadan isabet %66.4 iken beklenti
  // -0.079 ATR cikiyordu, cunku kazananlarin odulu kucuk, kaybedenlerin riski
  // buyuktu. Filtre bu carpikligi keser.
  // Varsayilan 0: kapali. Tarama, bu filtrenin isabet oranini ve beklentiyi
  // DUSURDUGUNU gosterdi (1m dogrulama: 0.00 -> %72.0 / pf 2.10,
  // 0.90 -> %66.0 / pf 1.99, 1.10 -> n=43'e dusuyor). Kenardan giriste risk ve
  // odul zaten bolge geometrisine bagli oldugu icin ek bir oran filtresi
  // yalnizca ornek sayisini azaltiyor. Isteyen Ayarlar'dan acabilir.
  minRr: 0.0,
  // Asgari beklenen deger, risk birimi cinsinden:
  //   bd = winRate * rr - (1 - winRate)
  // Bu, isabet orani ile risk/odulu tek bir olcute baglar. 0 esigi baskabas,
  // pozitif esik pay birakir.
  minExpectancy: 0.10,
}

/** Eslesme yokken kullanilan ATR tabanli varsayilan plan carpanlari. */
const FALLBACK_TP1_ATR = 1.0
const FALLBACK_TP2_ATR = 1.0
const FALLBACK_SL_ATR = 1.0

/** SL carpaninin alt sinirlari: cok dar stop gurultude vurulur. */
const MIN_SL_ATR = 0.3

/** Detay listesinde gosterilecek azami benzer kayit sayisi. */
const MAX_TOP_MATCHES = 8

/** Sayi degilse veya sonlu degilse varsayilani dondurur. */
function num (v, def) {
  return typeof v === 'number' && isFinite(v) ? v : def
}

/** Degeri [lo, hi] araligina kirpar. */
function clamp (x, lo, hi) {
  if (!(typeof x === 'number' && isFinite(x))) return lo
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

/**
 * Klasik (dogrusal interpolasyonlu) yuzdelik. Dizi ARTAN sirali olmalidir.
 * p degeri 0..1 arasindadir.
 * @param {Float64Array} sorted
 * @param {number} p
 * @returns {number}
 */
function percentile (sorted, p) {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]
  const q = clamp(p, 0, 1)
  const pos = (n - 1) * q
  const lo = Math.floor(pos)
  const hi = lo + 1
  if (hi >= n) return sorted[n - 1]
  const w = pos - lo
  return sorted[lo] * (1 - w) + sorted[hi] * w
}

/**
 * Sirali Float64Array uretir. `key` alani yoksa (eski hafiza dosyalari)
 * `fallbackKey` kullanilir.
 */
function sortedValues (rows, key, fallbackKey) {
  const arr = new Float64Array(rows.length)
  let m = 0
  for (let i = 0; i < rows.length; i++) {
    const ev = rows[i].event
    let v = num(ev[key], NaN)
    if (!isFinite(v) && fallbackKey) v = num(ev[fallbackKey], NaN)
    if (isFinite(v)) arr[m++] = v
  }
  const out = arr.subarray(0, m)
  out.sort()
  return out
}

/** Orani yuzdeye cevirir: 0.723 -> 72 */
function toPct (x) {
  return Math.round(clamp(x, 0, 1) * 100)
}

/** UNIX saniyeyi YYYY-MM-DD metnine cevirir. */
function dateText (t) {
  if (!(typeof t === 'number' && isFinite(t))) return '-'
  return new Date(t * 1000).toISOString().slice(0, 10)
}

/**
 * Olayin yonu. Acik alan yoksa destek/direnc bilgisinden turetilir.
 * @param {Object} t
 * @returns {'BUY'|'SELL'}
 */
function yonBelirle (t) {
  if (!t) return 'BUY'
  if (t.direction === 'SELL') return 'SELL'
  if (t.direction === 'BUY') return 'BUY'
  return t.isSupport === false ? 'SELL' : 'BUY'
}

/**
 * Olayin turu. Eski hafiza dosyalarinda `kind` yoktur, o kayitlar dokunus
 * sayilir.
 * @param {Object} t
 * @returns {'form'|'touch'}
 */
function turBelirle (t) {
  return (t && t.kind === 'form') ? 'form' : 'touch'
}

/**
 * Ayarlari varsayilanlarla birlestirir. Agirliklar ayri birlestirilir, cunku
 * kullanici yalnizca bir bileseni verdiginde digerleri varsayilanda kalmali.
 * @param {Object} [cfg]
 * @returns {Object}
 */
function ayarCoz (cfg) {
  const conf = Object.assign({}, DEFAULT_SIGNAL_CFG, cfg || {})
  conf.weights = Object.assign({}, DEFAULT_WEIGHTS || DEFAULT_SIGNAL_CFG.weights, (cfg && cfg.weights) || {})
  return conf
}

/**
 * ADIM 1: hafizadan komsulari bulur (PAHALI kisim).
 *
 * Donen liste esiklerden BAGIMSIZDIR: yalnizca k, agirliklar, yon, tur, zaman
 * filtresi ve komsu dislama belirler. Bu yuzden onbellege alinabilir; esik
 * taramasi ayni listeyi tekrar tekrar kullanir (learn/candcache.js).
 *
 * @param {Object} touch Touch (sorgu olayi)
 * @param {Object|null} features Features (sorgunun ozellik vektoru)
 * @param {{events:Object[]}} memory
 * @param {Object} [cfg]
 * @param {number|null} [beforeTime]
 * @returns {Array<{event:Object, similarity:number}>} Benzerlige gore azalan
 */
function findCandidates (touch, features, memory, cfg, beforeTime) {
  const t = touch || {}
  const conf = ayarCoz(cfg)
  const excludeWithinSec = Math.max(0, num(conf.excludeWithinSec, 0))
  const bt = (beforeTime === undefined || beforeTime === null) ? null : num(beforeTime, null)
  const direction = yonBelirle(t)
  const kind = turBelirle(t)
  const time = num(t.time, 0)
  const events = (memory && Array.isArray(memory.events)) ? memory.events : []

  const candidates = []
  if (!(features && features.shape && events.length > 0)) return candidates

  const opts = {
    k: Math.max(1, Math.round(num(conf.k, 25))),
    direction: direction,
    kind: kind,
    excludeWithinSec: excludeWithinSec,
    beforeTime: bt,
    weights: conf.weights,
    // Sozlesmede yok ama komsu dislama icin gerekli: sorgunun zamani.
    time: time,
    queryTime: time,
  }
  const raw = knn(features, memory, opts) || []
  // Komsu dislama ve zaman filtresi burada bir kez daha uygulanir.
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    if (!r || !r.event) continue
    const ev = r.event
    if (ev.direction && ev.direction !== direction) continue
    if ((ev.kind || 'touch') !== kind) continue
    if (bt !== null && !(num(ev.time, Infinity) < bt)) continue
    if (excludeWithinSec > 0 && Math.abs(num(ev.time, 0) - time) < excludeWithinSec) continue
    candidates.push(r)
  }
  return candidates
}

/**
 * ADIM 2: komsulardan karari ve islem planini uretir (UCUZ, saf fonksiyon).
 *
 * Hafizaya ERISMEZ; yalnizca verilen aday listesine bakar. Esikleri gecemezse
 * yine bir nesne doner ama `fired: false` olur; boylece arayuz "neden sinyal
 * olmadi" bilgisini gosterebilir.
 *
 * @param {Object} ev Touch (sorgu olayi)
 * @param {Array<{event:Object, similarity:number}>} candidates Adaylar
 * @param {Object|null|undefined} [levels] Bolge seviyeleri. `undefined` ise
 *        burada hesaplanir; `null` ACIKCA "seviye yok" demektir.
 * @param {Object} [cfg]
 * @param {{features?:Object|null, prototypes?:Object[], scanned?:number,
 *          beforeTime?:number|null}} [ek] Gerekce metinleri ve prototip
 *        eslesmesi icin ek baglam. `scanned` taranan hafiza kaydi sayisidir
 *        (gerekce cumlesinde gecer), verilmezse aday sayisi kullanilir.
 * @returns {Object} Signal
 */
function decideFromCandidates (ev, candidates, levels, cfg, ek) {
  const t = ev || {}
  const conf = ayarCoz(cfg)
  const baglam = ek || {}

  const minSimilarity = clamp(num(conf.minSimilarity, 0.8), 0, 0.999999)
  const minMatches = Math.max(0, Math.round(num(conf.minMatches, 5)))
  const minWinRate = clamp(num(conf.minWinRate, 0.6), 0, 1)
  const btHam = baglam.beforeTime
  const bt = (btHam === undefined || btHam === null) ? null : num(btHam, null)

  const features = baglam.features === undefined ? t.features : baglam.features
  const prototypes = baglam.prototypes
  const direction = yonBelirle(t)
  const sign = direction === 'BUY' ? 1 : -1
  const entry = num(t.price, 0)
  const time = num(t.time, 0)
  const kind = turBelirle(t)
  const form = kind === 'form'
  const reasons = []

  if (form) {
    reasons.push(direction === 'BUY'
      ? 'Hacimli aşırılıkta destek kutusu oluştu, yön BUY'
      : 'Hacimli aşırılıkta direnç kutusu oluştu, yön SELL')
    reasons.push('Kutu pivot barından ' + Math.max(0, num(t.zoneAgeBars, 0)) +
      ' bar sonra onaylandı, ileriye bakma yok')
  } else {
    reasons.push(direction === 'BUY'
      ? 'Destek bölgesine geri dönüş, ilk dokunuş, yön BUY'
      : 'Direnç bölgesine geri dönüş, ilk dokunuş, yön SELL')
  }

  const maxScore = num(t.maxScore, 0)
  if (maxScore > 0) {
    reasons.push('Olay skoru ' + Math.round(num(t.score, 0)) + '/' + Math.round(maxScore) +
      (t.qualified ? ', indikatör eşiğini geçti' : ', indikatör eşiğini geçmedi'))
  }

  // ATR yoksa plan fiyata cevrilemez; bolge genisligi makul bir vekildir.
  let atr = num(t.atr, NaN)
  if (!(atr > 0)) {
    const width = num(t.zoneTop, NaN) - num(t.zoneBottom, NaN)
    atr = width > 0 ? width : Math.abs(entry) * 0.001
    if (!(atr > 0)) atr = 1
    reasons.push('Dokunuş barında geçerli ATR yok, plan bölge genişliğinden tahmin edildi')
  }

  // Taranan hafiza kaydi sayisi: yalnizca gerekce cumlesinde kullanilir.
  // Onbellekli yolda cagiran taraf o andaki aday havuzunun boyunu gecer,
  // boylece gerekceler referans yolla birebir ayni kalir.
  const scannedCount = Math.max(0, Math.round(num(
    baglam.scanned, Array.isArray(candidates) ? candidates.length : 0
  )))

  // Cagiranin dizisini bozmamak icin kopya uzerinde siralanir. knn zaten
  // azalan sirada doner, bu yuzden siralama pratikte bir seyi degistirmez;
  // yine de onbellekten gelen liste icin garanti olarak durur.
  const adaylar = (Array.isArray(candidates) ? candidates : []).slice()
  adaylar.sort(function (a, b) { return num(b.similarity, 0) - num(a.similarity, 0) })

  // Yalnizca benzerlik esigini gecen kayitlar plana ve orana girer.
  const matches = []
  for (let i = 0; i < adaylar.length; i++) {
    const aday = adaylar[i]
    // Dolmamis limit emirler (nofill) islem uretmedigi icin oran hesabina
    // girmez; knn zaten filtreliyor, bu ek koruma eski hafizalar icin.
    if (aday && aday.event && aday.event.outcome === 'nofill') continue
    if (num(aday.similarity, 0) >= minSimilarity) matches.push(aday)
  }

  const matchCount = matches.length
  let sumSim = 0
  let wins = 0
  let sumMfe = 0
  let sumMae = 0
  // Sonuc dagilimi: tutma, kirilma ve zaman asimi ORANLARI ayri tutulur.
  // Beklenen deger hesabinda zaman asimini tam zarar saymak yanlisti; o
  // olaylarda ufuk sonunda cikiliyor ve ortalama sonuc sifira yakin.
  let breaks = 0
  let timeouts = 0
  let sumTimeoutR = 0
  for (let i = 0; i < matchCount; i++) {
    const m = matches[i]
    sumSim += num(m.similarity, 0)
    const ev = m.event
    if (ev.success === true || ev.outcome === 'respect') wins++
    else if (ev.outcome === 'timeout') {
      timeouts++
      sumTimeoutR += num(ev.realizedR, 0)
    } else breaks++
    sumMfe += num(ev.mfeAtr, 0)
    sumMae += num(ev.maeAtr, 0)
  }

  const avgSimilarity = matchCount > 0 ? sumSim / matchCount : 0
  const bestSimilarity = matchCount > 0
    ? num(matches[0].similarity, 0)
    : (adaylar.length > 0 ? num(adaylar[0].similarity, 0) : 0)
  const winRate = matchCount > 0 ? wins / matchCount : 0
  const expectedMfeAtr = matchCount > 0 ? sumMfe / matchCount : 0
  const expectedMaeAtr = matchCount > 0 ? sumMae / matchCount : 0

  // Plan hedefleri: benzer kayitlarin SONUCA KADAR olan lehte hareketinin
  // (mfeExitAtr) yuzdelikleri. Ham mfeAtr tum ufku olctugu icin stop vurulduktan
  // sonraki hareketi de icerir ve hedefleri gercekci olmayacak kadar buyutur.
  let tp1Atr = FALLBACK_TP1_ATR
  let tp2Atr = FALLBACK_TP2_ATR
  let slAtr = FALLBACK_SL_ATR
  let planFromMemory = false
  if (matchCount > 0) {
    const mfes = sortedValues(matches, 'mfeExitAtr', 'mfeAtr')
    if (mfes.length > 0) {
      tp1Atr = num(percentile(mfes, num(conf.tp1Pct, 40) / 100), FALLBACK_TP1_ATR)
      tp2Atr = num(percentile(mfes, num(conf.tp2Pct, 70) / 100), FALLBACK_TP2_ATR)
      planFromMemory = true
    }
  }

  // ------------------------------------------------------------------------
  // BIRINCIL PLAN BOLGE GEOMETRISINDEN GELIR
  // ------------------------------------------------------------------------
  // TP1 = bolgenin hedef seviyesi, SL = bolgenin gecersizlik seviyesi.
  // Ikisi de outcome.js'in etiket uretirken kullandigi seviyelerin AYNISIDIR.
  // Bunun onemi: hafizanin ogrendigi "bolge tuttu" etiketi ile plandaki
  // "TP1 vuruldu" olayi ayni seydir. Ayri tanimlar kullanilirsa (orn. TP1'i
  // benzer kayitlarin MFE yuzdeliginden almak) sistem bir seyi ogrenip baska
  // bir seyi islemeye kalkar; olculdu: 15m'de secimin kazandirdigi +5.1 puanlik
  // fayda bu tutarsizlik yuzunden -11.5 puanlik zarara donuyordu.
  //
  // TP2 yine benzer kayitlarin dagilimindan gelir ve yalnizca "uzatma hedefi"
  // olarak bilgilendirme amaclidir.
  //
  // Seviyeler cagiran taraftan HAZIR gelebilir (`levels` argumani). `undefined`
  // ise burada hesaplanir; `null` acikca "seviye yok" demektir ve oldugu gibi
  // kullanilir (useZoneStop kapaliyken bu olur).
  const seviyeler = levels !== undefined
    ? levels
    : (conf.useZoneStop === false
      ? null
      : zoneLevels(
        { price: entry, zoneTop: t.zoneTop, zoneBottom: t.zoneBottom, direction: direction, kind: kind },
        atr,
        Object.assign({}, DEFAULT_OUTCOME_CFG, conf.outcomeCfg || {})
      ))
  // Form olayinda seviyeler kurulamadiysa (fiyat pivottan cok kacti, risk
  // maxFormRiskAtr esigini asti) ortada islenebilir bir kurulum yoktur.
  // Hafiza da bu olayi etiketlemedi, yani boyle bir olay ogrenilmedi bile.
  const formRiskBlocked = form && conf.useZoneStop !== false && !seviyeler

  let zoneStopUsed = false
  if (seviyeler && isFinite(seviyeler.invalid) && isFinite(seviyeler.target) &&
      seviyeler.riskAtr > 0 && seviyeler.rewardAtr > 0) {
    slAtr = seviyeler.riskAtr
    tp1Atr = seviyeler.rewardAtr
    zoneStopUsed = true
  } else if (matchCount > 0) {
    // Yedek yol: benzer kayitlarin sonuca kadarki aleyhte hareketinin yuzdeligi.
    const maes = sortedValues(matches, 'maeExitAtr', 'maeAtr')
    if (maes.length > 0) slAtr = num(percentile(maes, num(conf.slPct, 75) / 100), FALLBACK_SL_ATR)
  }

  if (!(tp1Atr > 0)) tp1Atr = FALLBACK_TP1_ATR
  if (!(tp2Atr > 0)) tp2Atr = FALLBACK_TP2_ATR
  if (tp2Atr < tp1Atr) tp2Atr = tp1Atr
  // Cok dar stop gurultuye takilir, en az 0.3 ATR.
  if (!(slAtr > MIN_SL_ATR)) slAtr = MIN_SL_ATR

  // Plan girisi: bolge modunda bolgenin YAKIN kenarina limit emir
  // (destekte zoneTop, dirençte zoneBottom). Dokunus tanimi geregi fiyat o
  // kenari gectigi icin emir dolar. Dokunus barinin kapanisi giris olarak
  // kullanilmaz, cunku kapanisin bolge icindeki konumu risk/odulu carpitir.
  const planEntry = zoneStopUsed ? seviyeler.entry : entry

  const tp1 = zoneStopUsed ? seviyeler.target : planEntry + sign * tp1Atr * atr
  const tp2 = planEntry + sign * tp2Atr * atr
  const sl = zoneStopUsed ? seviyeler.invalid : planEntry - sign * slAtr * atr
  const risk = Math.abs(planEntry - sl)
  const rr = risk > 0 ? Math.abs(tp1 - planEntry) / risk : 0

  // Sozlesmedeki guven formulu, sonuc 0..1 arasina kirpilir.
  const simSpan = 1 - minSimilarity
  const confidence = clamp(
    0.4 * Math.min(matchCount / 20, 1) +
    0.35 * Math.abs(winRate - 0.5) * 2 +
    0.25 * (simSpan > 0 ? (avgSimilarity - minSimilarity) / simSpan : 0),
    0, 1
  )

  // En yakin ortak yapi (prototip).
  let prototypeId = null
  let prototypeSim = 0
  let prototypeLabel = ''
  if (features && features.shape && Array.isArray(prototypes) && prototypes.length > 0) {
    const pm = matchPrototype(features.shape, prototypes)
    if (pm && pm.prototype) {
      prototypeId = num(pm.prototype.id, null)
      prototypeSim = num(pm.similarity, 0)
      prototypeLabel = typeof pm.prototype.label === 'string' ? pm.prototype.label : ''
    }
  }

  const topMatches = []
  const topN = Math.min(matchCount, MAX_TOP_MATCHES)
  for (let i = 0; i < topN; i++) {
    const m = matches[i]
    const ev = m.event
    topMatches.push({
      id: num(ev.id, i),
      time: num(ev.time, 0),
      similarity: num(m.similarity, 0),
      success: ev.success === true || ev.outcome === 'respect',
      mfeAtr: num(ev.mfeAtr, 0),
      maeAtr: num(ev.maeAtr, 0),
      price: num(ev.price, 0),
    })
  }

  // Risk/odul ve beklenen deger kapilari: yuksek isabet orani tek basina
  // yeterli degil, kurulumun matematigi de olumlu olmali.
  const minRr = Math.max(0, num(conf.minRr, 0))
  const minExpectancy = num(conf.minExpectancy, -Infinity)
  // BEKLENEN DEGER (risk birimi cinsinden)
  //   pR * rr - pB + pT * mT
  // pR tutma, pB kirilma, pT zaman asimi orani; mT zaman asimina ugrayan
  // komsularin ortalama gerceklesen R'si. Eski formul (winRate * rr -
  // (1 - winRate)) zaman asimini TAM ZARAR sayiyordu, yani ufuk sonunda
  // sifira yakin kapanan islemler -1R gibi goruluyordu. Alan tasimayan eski
  // hafizada eski formule dusulur.
  const pR = matchCount > 0 ? wins / matchCount : 0
  const pB = matchCount > 0 ? breaks / matchCount : 0
  const pT = matchCount > 0 ? timeouts / matchCount : 0
  const mT = timeouts > 0 ? sumTimeoutR / timeouts : 0
  const expectancy = matchCount > 0
    ? pR * rr - pB + pT * mT
    : winRate * rr - (1 - winRate)
  const rrOk = rr >= minRr
  const evOk = expectancy >= minExpectancy

  const fired = matchCount >= minMatches && winRate >= minWinRate && rrOk && evOk &&
    !formRiskBlocked

  // Gerekceler: sinyalin neden olustugu veya neden olusmadigi.
  if (!features || !features.shape) {
    reasons.push('Özellik vektörü çıkarılamadı (yeterli geçmiş bar yok), sinyal üretilmedi')
  } else if (scannedCount === 0) {
    reasons.push('Hafızada karşılaştırılacak kayıt yok, sinyal üretilmedi')
  } else {
    if (bt !== null) {
      reasons.push('Yalnızca ' + dateText(bt) + ' öncesindeki kayıtlar kullanıldı, ileriye bakma yok')
    }
    if (adaylar.length === 0) {
      reasons.push('Hafızada ' + scannedCount + ' kayıt tarandı, aynı yönde ve aynı türde (' +
        (form ? 'kutu oluşumu' : 'bölge dokunuşu') + ') uygun aday bulunamadı')
    } else if (matchCount === 0) {
      reasons.push('Benzerlik eşiğini (' + minSimilarity.toFixed(2) + ') geçen kayıt yok, en yüksek benzerlik ' +
        bestSimilarity.toFixed(2))
    } else {
      reasons.push(matchCount + ' benzer geçmiş kurulum bulundu (eşik ' + minMatches + ')')
      reasons.push('Bu kurulumların %' + toPct(winRate) + ' sinde bölge tuttu')
      reasons.push('Ortalama benzerlik ' + avgSimilarity.toFixed(2) + ', en yüksek ' + bestSimilarity.toFixed(2))
    }
    if (prototypeLabel) {
      reasons.push('En yakın ortak yapı: ' + prototypeLabel + ' (benzerlik ' + prototypeSim.toFixed(2) + ')')
    }
  }

  if (zoneStopUsed) {
    if (form) {
      reasons.push('Giriş onay barının kapanışı: ' + planEntry.toFixed(2) +
        ' (fiyat henüz kutuya dönmediği için kenara limit emir konmaz)')
    } else {
      reasons.push('Giriş bölge kenarına limit emirle: ' + planEntry.toFixed(2) +
        ' (dokunuş barı kapanışı ' + entry.toFixed(2) + ')')
    }
    reasons.push('Hedef ' + tp1.toFixed(2) + ' (' + (form ? 'girişten ' : 'kenardan ') +
      tp1Atr.toFixed(2) + ' ATR), zarar durdur ' + sl.toFixed(2) + ' (' + slAtr.toFixed(2) +
      ' ATR), bölge orada kırılmış sayılır. R/R ' + rr.toFixed(2))
    reasons.push('Hafızanın öğrendiği "bölge tuttu" etiketi ile bu TP1/SL ikilisi aynı olaydır')
  }

  if (planFromMemory) {
    reasons.push('Plan: TP1 ' + tp1Atr.toFixed(2) + ' ATR, TP2 ' + tp2Atr.toFixed(2) +
      ' ATR, SL ' + slAtr.toFixed(2) + ' ATR, R/R ' + rr.toFixed(2))
  } else {
    reasons.push('Benzer kayıt olmadığı için plan varsayılan ' + FALLBACK_TP1_ATR.toFixed(1) +
      ' ATR hedef ve ' + FALLBACK_SL_ATR.toFixed(1) + ' ATR zararla dolduruldu')
  }

  if (formRiskBlocked) {
    reasons.push('Kutu onaylanana kadar fiyat çok uzağa kaçtı, giriş ile geçersizlik ' +
      'arası kabul edilen azami riski aşıyor, sinyal üretilmedi')
  }

  if (fired) {
    reasons.push('Tüm eşikler geçildi, sinyal üretildi (güven %' + toPct(confidence) + ')')
  } else {
    if (matchCount < minMatches) {
      reasons.push('Yeterli benzer kayıt yok (' + matchCount + ' < ' + minMatches + '), sinyal üretilmedi')
    }
    if (matchCount > 0 && winRate < minWinRate) {
      reasons.push('Başarı oranı yetersiz (%' + toPct(winRate) + ' < %' + toPct(minWinRate) + '), sinyal üretilmedi')
    }
    if (matchCount >= minMatches && winRate >= minWinRate && !rrOk) {
      reasons.push('Risk/ödül yetersiz (' + rr.toFixed(2) + ' < ' + minRr.toFixed(2) +
        '), kapanış bölgeden uzak kaldığı için kurulum matematiksel olarak zararlı')
    }
    if (form && matchCount >= minMatches && winRate >= minWinRate && rrOk && !evOk) {
      reasons.push('Kutu oluşumunda giriş kapanıştan olduğu için risk, fiyatın pivottan ' +
        'kaçtığı kadar büyür; bu kurulumda geçersizlik seviyesi ' + slAtr.toFixed(2) + ' ATR uzakta')
    }
    if (matchCount >= minMatches && winRate >= minWinRate && rrOk && !evOk) {
      reasons.push('Beklenen değer yetersiz (' + expectancy.toFixed(2) + ' < ' +
        minExpectancy.toFixed(2) + ' risk birimi), sinyal üretilmedi')
    }
  }

  return {
    id: 'sig-' + kind + '-' + num(t.zoneId, 0) + '-' + time,
    fired: fired,
    kind: kind,
    time: time,
    bar: num(t.bar, -1),
    direction: direction,
    price: entry,
    zoneTop: num(t.zoneTop, entry),
    zoneBottom: num(t.zoneBottom, entry),
    matchCount: matchCount,
    avgSimilarity: avgSimilarity,
    bestSimilarity: bestSimilarity,
    winRate: winRate,
    confidence: confidence,
    expectedMfeAtr: expectedMfeAtr,
    expectedMaeAtr: expectedMaeAtr,
    // Islem plani girisi: dokunus olayinda bolge kenari, form olayinda onay
    // barinin kapanisi. Olay barinin kapanisi her durumda `price` alanindadir.
    entry: planEntry,
    tp1: tp1,
    tp2: tp2,
    sl: sl,
    rr: rr,
    prototypeId: prototypeId,
    prototypeSim: prototypeSim,
    prototypeLabel: prototypeLabel,
    topMatches: topMatches,
    reasons: reasons,
    atr: atr,
    tp1Atr: tp1Atr,
    tp2Atr: tp2Atr,
    slAtr: slAtr,
    // Risk birimi cinsinden beklenen deger: winRate * rr - (1 - winRate).
    // Pozitifse kurulumun matematigi lehte.
    expectancy: expectancy,
    // Eslesmelerin sonuc dagilimi: tutma, kirilma, zaman asimi oranlari ve
    // zaman asimlarinin ortalama gerceklesen R'si.
    respectRate: pR,
    breakRate: pB,
    timeoutRate: pT,
    timeoutAvgR: mT,
  }
}

/**
 * Bir dokunusu hafizayla karsilastirip sinyal uretir.
 *
 * Iki adimin BILESIMIDIR: komsulari bul, sonra karar ver. Karar mantigi burada
 * TEKRAR YAZILMAZ; onbellekli yol (learn/backtest.js runBacktestFromCache) ayni
 * `decideFromCandidates` fonksiyonunu cagirir, boylece iki yol ayrisamaz.
 *
 * @param {Object} touch Touch
 * @param {Object|null} features Features
 * @param {{events:Object[]}} memory
 * @param {Object[]} prototypes
 * @param {Object} [cfg]
 * @param {number|null} [beforeTime]
 * @returns {Object} Signal
 */
function evaluateTouch (touch, features, memory, prototypes, cfg, beforeTime) {
  const events = (memory && Array.isArray(memory.events)) ? memory.events : []
  const candidates = findCandidates(touch, features, memory, cfg, beforeTime)
  return decideFromCandidates(touch, candidates, undefined, cfg, {
    // `|| null`: arguman hic verilmediyse `undefined` gelir ve o durumda
    // "olayin kendi vektorune duse" davranisi ISTENMEZ, ozellik yok sayilir.
    features: features || null,
    prototypes: prototypes,
    scanned: events.length,
    beforeTime: beforeTime,
  })
}

module.exports = {
  DEFAULT_SIGNAL_CFG,
  evaluateTouch,
  findCandidates,
  decideFromCandidates,
  // Yon ve tur tanimlari: onbellek (learn/candcache.js) aday havuzlarini
  // bunlara gore boldugu icin kural iki modulde ayri yazilamaz.
  yonBelirle,
  turBelirle,
}
