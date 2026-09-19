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
const { zoneLevels, DEFAULT_OUTCOME_CFG } = require('./outcome')
const { wilson } = require('./stats')

// DIKKAT: Asagidaki varsayilanlar ESKI indikatorle (MASTER 1 TOUCH) ve ESKI
// giris modeliyle (bar ici kenardan dolum) secildi. Yontem gecerlidir ve
// aynen tekrarlanabilir: gecmisin ILK YARISINDA (2009-2018) parametre
// taramasi, IKINCI YARIDA (2019-2026) dogrulama. Ama SAYILAR yeni indikatore
// TASINAMAZ.
//   eski olcum, 1 dakikalik, hedef 1.0 ATR, bar ici kenardan giris:
//     ayar donemi      n=366  isabet %68.9  beklenti +0.302 ATR
//     dogrulama donemi n=478  isabet %72.0  beklenti +0.377 ATR
// Yeni indikatorun gercek olcumu README 1. bolumdedir (17 Eylul 2026):
// hicbir zaman diliminde kanitlanmis katma deger yok. Tekrar uretmek icin
// `node scripts/measure-all.mjs`.
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
  // KALIBRASYON ONSELI: gosterilen oran havuz tabanina dogru bu kadar sanal
  // gozlem agirliginda cekilir. 20, "20 kayitlik bir on bilgi" demektir;
  // 5 eslesmelik bir oranin neredeyse tamamen tabana yakin kalmasini saglar.
  priorStrength: 20,
  // KATMA DEGER KAPISI: kuculutulmus oranin havuz tabanindan farki bu esigin
  // altindaysa sinyal uretilmez. Varsayilan 0 (kapali): esik ancak
  // dogrulama doneminde olculup secilirse acilmalidir (bkz. A1).
  minLift: 0,
  // ZAMAN AGIRLIGI (yil cinsinden yariomur). null veya 0 ise kapali ve
  // davranis birebir eskisi gibi kalir. Acikken eski eslesmeler daha az
  // agirlik alir ve etkin orneklem (nEff) kucultme ile Wilson araliginda
  // matchCount yerine kullanilir. Varsayilan kapali: dogrulama doneminde
  // Brier iyilesmesi olculmeden acilmamali.
  halfLifeYears: null,
  // KALIBRASYON TABANININ PENCERESI (yil). null veya 0 ise tum gecmis.
  // Yillik taban belirgin oynuyor (15m dokunusta 2018'de %15,5, 2020'de
  // %33,1 ve araliklar ortusmuyor); pencere bunu sinirlar. Komsu secimini
  // DEGISTIRMEZ, yalnizca kuculutme tabanini degistirir.
  baseWindowYears: null,
  // YUKSEK ETKILI VERI PENCERESI (dakika). 0 ise kapali. Acikken karar ani
  // takvimdeki bir veriye bu kadar yakinsa sinyal uretilmez. Takvim dosyasi
  // yoksa ayar ne olursa olsun etkisizdir (bkz. src/core/calendar.js).
  newsBlackoutMin: 0,
  // Asgari beklenen deger, risk birimi cinsinden:
  //   bd = winRate * rr - (1 - winRate)
  // Bu, isabet orani ile risk/odulu tek bir olcute baglar. 0 esigi baskabas,
  // pozitif esik pay birakir.
  minExpectancy: 0.10,
}

/** Eslesme yokken kullanilan ATR tabanli varsayilan plan carpanlari. */
const FALLBACK_TP1_ATR = 1.0
const FALLBACK_SL_ATR = 1.0

/**
 * TP2 (uzatma hedefi) kurallari.
 *
 * TP2 uydurulmaz: yeterli sayida TUTMUS komsu yoksa ya da hesaplanan hedef
 * TP1'in hemen ustune dusuyorsa `tp2` null doner ve ekranda satir gosterilmez.
 * Eski davranis TP2'yi sessizce TP1'e esitliyordu.
 */
const MIN_TP2_MATCHES = 5
const TP2_MIN_KAT = 1.1

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

/**
 * GOSTERIM ICIN tarih bicimleyici: Istanbul saati (Europe/Istanbul).
 *
 * Kullanici Turkiye'de; UTC'ye gore bicimlenen bir tarih gece yarisina yakin
 * olaylarda bir gun geride gorunuyordu. YALNIZCA GOSTERIM degisir: hesaplarda
 * kullanilan zaman damgasi (UNIX saniye) hicbir yerde donusturulmez ve
 * seans/saat OZELLIKLERI kendi zaman dilimini (bkz. core/session.js)
 * kullanmaya devam eder.
 */
const ISTANBUL_TARIH = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** UNIX saniyeyi Istanbul saatine gore YYYY-MM-DD metnine cevirir. */
function dateText (t) {
  if (!(typeof t === 'number' && isFinite(t))) return '-'
  const parcalar = {}
  for (const p of ISTANBUL_TARIH.formatToParts(new Date(t * 1000))) parcalar[p.type] = p.value
  return parcalar.year + '-' + parcalar.month + '-' + parcalar.day
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
    // TABAN PENCERESI (S9, varsayilan kapali): havuz orani yalnizca son N yila
    // bakilarak hesaplanir. Komsu SECIMINI etkilemez, yalnizca kalibrasyon
    // tabanini etkiler; bu yuzden onbellek anahtarina girmez.
    baseWindowYears: num(conf.baseWindowYears, 0),
  }
  // Havuzun kendi basari orani: secimin katma degeri ancak buna gore olculur.
  const taban = { n: 0, wins: 0 }
  opts.baseOut = taban
  const raw = knn(features, memory, opts) || []
  // Havuz bilgisi diziye SAYILAMAZ alan olarak takilir: cagiranlar diziyi
  // kopyalayip karsilastiriyor, gorunur bir alan esitligi bozardi.
  Object.defineProperty(candidates, 'baseRate', {
    value: taban.n > 0 ? taban.wins / taban.n : null,
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(candidates, 'baseN', {
    value: taban.n, enumerable: false, configurable: true,
  })
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
 * @param {{features?:Object|null, scanned?:number, baseRate?:number|null,
 *          baseN?:number|null, beforeTime?:number|null}} [ek] Gerekce
 *        metinleri ve kalibrasyon icin ek baglam. `scanned` taranan hafiza
 *        kaydi sayisidir (gerekce cumlesinde gecer), verilmezse aday sayisi
 *        kullanilir. `prototypes` artik okunmaz (bkz. asagidaki not).
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
    // Skor SINYAL KARARINA GIRMEZ, yalnizca indikatorun kendi etiketidir.
    // Olculdu: esigi gecen olaylar gecmeyenlerden daha iyi degil (15m
    // dokunusta %15,9'a karsi %20,8), bu yuzden cumle bir kalite iddiasi
    // tasimiyor.
    reasons.push('İndikatör skoru ' + Math.round(num(t.score, 0)) + '/' + Math.round(maxScore) +
      (t.qualified ? ', indikatör eşiği geçildi' : ', indikatör eşiği geçilmedi') +
      ' (bilgi amaçlı, sinyal kararına girmez)')
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
  // ZAMAN AGIRLIGI (S9, varsayilan KAPALI).
  //
  // knn zamani yalnizca filtre olarak kullaniyor: 2023 sonrasi sorgularda
  // eslesmelerin ortalama yasi 15m'de 8,2 yil ve yarisi 8 yildan eski.
  // Yillik taban da belirgin oynuyor (15m dokunusta 2018'de %15,5, 2020'de
  // %33,1 ve araliklar ortusmuyor), yani eski donemin istatistigi hem canli
  // sinyali hem kalibrasyon tabanini baskiliyor.
  //
  // `halfLifeYears` verilirse her eslesme yariomurlu bir agirlik alir. Etkin
  // orneklem nEff = (Σw)² / Σw² olur ve kuculutme ile Wilson araligi bu
  // sayiyi kullanir; boylece "10 eslesme ama hepsi 10 yillik" durumu
  // istatistikte de zayif gorunur.
  //
  // Varsayilan null: DOGRULAMA doneminde olculup Brier iyilesmesi
  // gosterilmeden acilmamali (bkz. scripts/search-params.mjs --ablation).
  const yariomur = num(conf.halfLifeYears, 0)
  const agirlikli = yariomur > 0
  const yariomurSn = yariomur * 365.25 * 86400
  let sumSim = 0
  let wins = 0
  let sumMfe = 0
  let sumMae = 0
  // Agirlikli toplamlar: agirlik kapaliyken her w = 1 olur ve bu sayilar
  // ham sayimlarla BIREBIR ayni cikar.
  let wToplam = 0
  let wKareToplam = 0
  let wWins = 0
  // Sonuc dagilimi: tutma, kirilma ve zaman asimi ORANLARI ayri tutulur.
  // Beklenen deger hesabinda zaman asimini tam zarar saymak yanlisti; o
  // olaylarda ufuk sonunda cikiliyor ve ortalama sonuc sifira yakin.
  let timeouts = 0
  let sumTimeoutR = 0
  for (let i = 0; i < matchCount; i++) {
    const m = matches[i]
    sumSim += num(m.similarity, 0)
    const ev = m.event
    const yas = agirlikli ? Math.max(0, time - num(ev.time, time)) : 0
    const w = agirlikli ? Math.pow(0.5, yas / yariomurSn) : 1
    wToplam += w
    wKareToplam += w * w
    const kazandi = ev.success === true || ev.outcome === 'respect'
    if (kazandi) wWins += w
    if (kazandi) wins++
    else if (ev.outcome === 'timeout') {
      timeouts++
      sumTimeoutR += num(ev.realizedR, 0)
    }
    // SONUCA KADAR olan hareket (mfeExitAtr / maeExitAtr). Ham mfeAtr tum
    // ufku olcer, yani stop vurulduktan SONRAKI hareketi de sayar: 15m'de
    // "beklenen lehte hareket" boylece TP1'in 2,5 katina cikiyordu
    // (4,68 ATR'ye karsi 1,81 ATR) ve okuyan kisi ulasilamayacak bir hedef
    // gordugunu sanmiyordu. Eski hafizada alan yoksa ham degere dusulur.
    const mfeCikis = num(ev.mfeExitAtr, NaN)
    sumMfe += isFinite(mfeCikis) ? mfeCikis : num(ev.mfeAtr, 0)
    const maeCikis = num(ev.maeExitAtr, NaN)
    sumMae += isFinite(maeCikis) ? maeCikis : num(ev.maeAtr, 0)
  }

  const avgSimilarity = matchCount > 0 ? sumSim / matchCount : 0
  const bestSimilarity = matchCount > 0
    ? num(matches[0].similarity, 0)
    : (adaylar.length > 0 ? num(adaylar[0].similarity, 0) : 0)
  // KALIBRASYON
  // Ham oran (wins / matchCount) kucuk orneklemde gurultudur: 5 eslesmede
  // %60 demek 3 kayit demektir. Olculdu (gercek hafiza, 15m): sistem
  // %70-80 dediginde gerceklesen %37,5; Brier skoru sabit taban tahmininden
  // KOTU. Bu yuzden gosterilen oran, HAVUZUN taban oranina dogru
  // kuculutulur (Beta onseli): az kayit varsa taban orana yakin kalir, cok
  // kayit varsa ham orana yaklasir.
  //   winRate = (wins + a * taban) / (matchCount + a)
  // `a` (priorStrength) kac sanal gozlem kadar guvendigimizdir.
  // Etkin orneklem: agirlik kapaliyken matchCount'a esittir.
  const nEff = wKareToplam > 0 ? (wToplam * wToplam) / wKareToplam : 0
  const winRateRaw = matchCount > 0 ? (agirlikli ? wWins / wToplam : wins / matchCount) : 0
  // NOT: `adaylar` bir kopya (slice) oldugu icin ozel alanlar orada olmaz;
  // havuz orani ORIJINAL aday listesinden okunur. `ek.baseRate` ile de
  // verilebilir (onbellekli test yolu boyle gecer).
  const havuzTabaniHam = candidates && Number.isFinite(candidates.baseRate)
    ? candidates.baseRate
    : (baglam && Number.isFinite(baglam.baseRate) ? baglam.baseRate : null)
  const havuzTabani = havuzTabaniHam === null ? 0.5 : havuzTabaniHam
  const onsel = Math.max(0, num(conf.priorStrength, DEFAULT_SIGNAL_CFG.priorStrength))
  // Kuculutme ve guven araligi ETKIN orneklemi kullanir: agirlikli modda
  // "10 eslesme ama hepsi cok eski" durumu burada zayif gorunmeli.
  const etkinN = agirlikli ? nEff : matchCount
  const etkinWins = agirlikli ? winRateRaw * etkinN : wins
  const winRate = matchCount > 0
    ? (etkinWins + onsel * havuzTabani) / (etkinN + onsel)
    : 0
  // Ham oranin %95 Wilson araligi: belirsizlik ekranda da gorunur.
  const aralik = matchCount > 0
    ? wilson(Math.round(etkinWins), Math.max(1, Math.round(etkinN)))
    : null
  const winRateLo = aralik ? aralik.lo : 0
  const winRateHi = aralik ? aralik.hi : 0
  // Katma deger: kuculutulmus oranin havuz tabanindan farki.
  const lift = matchCount > 0 ? winRate - havuzTabani : 0

  const expectedMfeAtr = matchCount > 0 ? sumMfe / matchCount : 0
  const expectedMaeAtr = matchCount > 0 ? sumMae / matchCount : 0

  // Plan hedefleri: benzer kayitlarin SONUCA KADAR olan lehte hareketinin
  // (mfeExitAtr) yuzdelikleri. Ham mfeAtr tum ufku olctugu icin stop vurulduktan
  // sonraki hareketi de icerir ve hedefleri gercekci olmayacak kadar buyutur.
  let tp1Atr = FALLBACK_TP1_ATR
  let slAtr = FALLBACK_SL_ATR
  let planFromMemory = false
  if (matchCount > 0) {
    const mfes = sortedValues(matches, 'mfeExitAtr', 'mfeAtr')
    if (mfes.length > 0) {
      tp1Atr = num(percentile(mfes, num(conf.tp1Pct, 40) / 100), FALLBACK_TP1_ATR)
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
  // Cok dar stop gurultuye takilir, en az 0.3 ATR.
  if (!(slAtr > MIN_SL_ATR)) slAtr = MIN_SL_ATR

  // Plan girisi zoneLevels'tan gelir ve DOKUNUS GIRIS MODELINE uyar:
  // kapanis kenarin lehte tarafindaysa giris o kenara konan limit emirdir
  // (dolum bir sonraki barlarda, dolmazsa islem yoktur), kapanis bolgenin
  // icindeyse giris kapanistir. "Dokunus tanimi geregi emir dolar" varsayimi
  // ARTIK GECERLI DEGILDIR: o varsayim bar ici ileriye bakma uretiyordu
  // (olculdu: 5m fitil reddi alt kumesi %58.4 isabet gosteriyor, gercekci
  // giriste %30.9).
  const planEntry = zoneStopUsed ? seviyeler.entry : entry

  const tp1 = zoneStopUsed ? seviyeler.target : planEntry + sign * tp1Atr * atr
  const sl = zoneStopUsed ? seviyeler.invalid : planEntry - sign * slAtr * atr

  // ------------------------------------------------------------------------
  // TP2 (UZATMA HEDEFI): VARSA GOSTERILIR, YOKSA null
  // ------------------------------------------------------------------------
  // Eski hesap TP2'yi tum komsularin lehte hareket yuzdeliginden aliyordu.
  // Iki sorunu vardi: (1) lehte hareket hedefle sinirli oldugu icin yuzdelik
  // de hedefin otesine cikamiyordu, (2) `tp2 < tp1` durumunda TP2 sessizce
  // TP1'e esitleniyordu ve 5m'de tetiklenen formlarin %19,6'sinda ekranda
  // ayni fiyat iki kez goruluyordu.
  //
  // Yeni hesap: yalnizca BOLGEYI TUTMUS komsularin sonuca kadarki lehte
  // hareketi, RISK BIRIMINE bolunerek toplanir (mfeExitAtr / riskAtr), bu
  // oranin tp2Pct yuzdeligi sorgunun kendi risk mesafesiyle carpilir. Boylece
  // TP2 "bu kurulum tuttugunda tipik olarak kac risk birimi gitti" sorusunun
  // cevabi olur. Yeterli ornek yoksa (5'ten az) ya da sonuc TP1'in 1,1
  // katina ulasmiyorsa TP2 YOKTUR; uydurmak yerine null donuyor.
  const tp2Oranlari = []
  for (let i = 0; i < matchCount; i++) {
    const ev = matches[i].event
    if (ev.outcome !== 'respect') continue
    const riskAtr = num(ev.riskAtr, NaN)
    if (!(riskAtr > 0)) continue
    const mfeCikis = num(ev.mfeExitAtr, NaN)
    const mfe = isFinite(mfeCikis) ? mfeCikis : num(ev.mfeAtr, NaN)
    if (!isFinite(mfe) || mfe <= 0) continue
    tp2Oranlari.push(mfe / riskAtr)
  }
  let tp2 = null
  let tp2Atr = 0
  if (tp2Oranlari.length >= MIN_TP2_MATCHES) {
    const sirali = Float64Array.from(tp2Oranlari)
    sirali.sort()
    const oran = num(percentile(sirali, num(conf.tp2Pct, 70) / 100), NaN)
    const planRiskAtr = zoneStopUsed ? seviyeler.riskAtr : slAtr
    const aday = oran * planRiskAtr
    if (isFinite(aday) && aday >= tp1Atr * TP2_MIN_KAT) {
      tp2Atr = aday
      tp2 = planEntry + sign * aday * atr
    }
  }
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

  // PROTOTIP (sekil kumeleri) SINYALE KATILMIYOR.
  //
  // Olculdu: kumelerin basari orani tabandan ayirt edilemiyor (15m'de sekiz
  // kumenin orani %31,2 - %35,5, taban %33,4; prototip orani basarili ve
  // basarisiz olaylarda 0,3343'e karsi 0,3336). Buna ragmen gerekce
  // cumlesinde "En yakin ortak yapi" diye gorunuyor ve okuyan kisiye
  // olmayan bir dayanak hissi veriyordu. Alanlar uyumluluk icin bos
  // degerlerle doluyor; kumeler yalnizca Hafiza panelinde bilgi olarak
  // duruyor (bkz. cluster.js).
  const prototypeId = null
  const prototypeSim = 0
  const prototypeLabel = ''

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
      // UC DEGERLI SONUC. `success` ikili oldugu icin arayuz zaman asimina
      // ugramis kayitlari "Kirilim" diye gosteriyordu; oysa 15m'de form
      // basarisizliklarinin %26'si zaman asimidir, yani bolge kirilmadi.
      outcome: typeof ev.outcome === 'string' ? ev.outcome : '',
      mfeAtr: num(ev.mfeAtr, 0),
      maeAtr: num(ev.maeAtr, 0),
      // Sonuca kadar olan hareket: ekranda gosterilen "lehte / aleyhte"
      // sayilarinin plan hedefleriyle ayni olcuden gelmesi icin.
      mfeExitAtr: num(ev.mfeExitAtr, NaN),
      maeExitAtr: num(ev.maeExitAtr, NaN),
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
  // Oranlar KUCULUTULMUS orandan turetilir (bkz. kalibrasyon): ham oran
  // kucuk orneklemde beklentinin isaretini bile degistirebiliyor.
  const pR = matchCount > 0 ? winRate : 0
  const pT = matchCount > 0 ? timeouts / matchCount : 0
  const pB = matchCount > 0 ? Math.max(0, 1 - pR - pT) : 0
  const mT = timeouts > 0 ? sumTimeoutR / timeouts : 0
  // MALIYET: beklenen deger risk birimindedir, maliyet de oyle olmali.
  // Maliyet fiyata oranli verilir, risk ise giris ile stop arasidir.
  const maliyetOran = Math.max(0, num(conf.costPct, 0))
  const maliyetSabit = Math.max(0, num(conf.costUsd, 0))
  const riskFiyat = Math.abs(planEntry - sl)
  const maliyetFiyat = maliyetOran > 0 ? Math.abs(planEntry) * maliyetOran : maliyetSabit
  const kaymaR = Math.max(0, num(conf.slippageAtr, 0)) * atr
  const costR = riskFiyat > 0 ? (maliyetFiyat + kaymaR) / riskFiyat : 0
  const expectancyGross = matchCount > 0
    ? pR * rr - pB + pT * mT
    : winRate * rr - (1 - winRate)
  const expectancy = expectancyGross - costR
  const rrOk = rr >= minRr
  const evOk = expectancy >= minExpectancy
  // KATMA DEGER KAPISI: kuculutulmus oranin havuz tabanindan farki.
  // Mutlak bir oran esigi turler arasinda anlamsizdir (olculdu: olusum
  // tabani %39-50, dokunus tabani %23-28), fark ise karsilastirilabilir.
  const minLift = num(conf.minLift, 0)
  const liftOk = lift >= minLift

  // YUKSEK ETKILI VERI PENCERESI (Y2, varsayilan KAPALI).
  //
  // Olculdu: yaklasik NFP penceresinde 15m dokunus isabeti %15,3 (n=59),
  // diger zamanlarda %28,1; bir bar icinde kirilma %79,7 ile %54,0. Orneklem
  // kucuk ve guven araliklari ortusuyor, yani filtrenin faydasi KANITLI
  // DEGIL. Bu yuzden varsayilan 0'dir (kapali) ve kapiyi acmak kullanicinin
  // kararidir; ozellik vektorune yeni bir boyut EKLENMEDI, cunku tek ikili
  // boyut kNN mesafesinde kaybolur ve tum hafizalari gecersiz kilardi.
  //
  // `ek.news` cagiran taraftan gelir (takvim yoksa null) ve
  // {code, deltaMin} tasir.
  const haberDk = Math.max(0, num(conf.newsBlackoutMin, 0))
  const haber = baglam.news && typeof baglam.news === 'object' ? baglam.news : null
  const haberEngeli = haberDk > 0 && haber !== null &&
    Number.isFinite(haber.deltaMin) && Math.abs(haber.deltaMin) <= haberDk

  const fired = matchCount >= minMatches && winRate >= minWinRate && liftOk && rrOk && evOk &&
    !formRiskBlocked && !haberEngeli

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
      // Yuzde ekini Turkce yazim kuralina uygun yazariz: "%56'sında". Sayiya
      // gore ek degistirmeye gerek yok, "'sında" her yuzde degerinde dogrudur.
      reasons.push('Bu kurulumların %' + toPct(winRateRaw) + "'sında bölge tuttu (ham oran), " +
        'havuz ortalaması %' + toPct(havuzTabani) + ', kalibre edilmiş oran %' + toPct(winRate))
      reasons.push('Kalibre oranın %95 alt sınırı %' + toPct(winRateLo) +
        ', tabana göre fark ' + (lift >= 0 ? '+' : '') + toPct(lift) + ' puan')
      reasons.push('Ortalama benzerlik ' + avgSimilarity.toFixed(2) + ', en yüksek ' + bestSimilarity.toFixed(2))
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
    reasons.push('Plan: TP1 ' + tp1Atr.toFixed(2) + ' ATR, ' +
      (tp2 === null
        ? 'uzatma hedefi yok (yeterli sayıda tutmuş benzer kayıt bulunamadı)'
        : 'TP2 ' + tp2Atr.toFixed(2) + ' ATR') +
      ', SL ' + slAtr.toFixed(2) + ' ATR, R/R ' + rr.toFixed(2))
  } else {
    reasons.push('Benzer kayıt olmadığı için plan varsayılan ' + FALLBACK_TP1_ATR.toFixed(1) +
      ' ATR hedef ve ' + FALLBACK_SL_ATR.toFixed(1) + ' ATR zararla dolduruldu')
  }

  if (haberEngeli) {
    reasons.push('Yüksek etkili veri penceresi (' + String(haber.code || 'veri') + ', ' +
      (haber.deltaMin >= 0 ? Math.round(haber.deltaMin) + ' dk sonra' : Math.round(-haber.deltaMin) + ' dk önce') +
      '), sinyal üretilmedi')
  }

  if (formRiskBlocked) {
    reasons.push('Kutu onaylanana kadar fiyat çok uzağa kaçtı, giriş ile geçersizlik ' +
      'arası kabul edilen azami riski aşıyor, sinyal üretilmedi')
  }

  if (fired) {
    // "Guven" bir OLASILIK DEGIL, uc bilesenin agirlikli toplamiydi; olculdu,
    // guven yukseldikce GERCEKLESEN oran dusuyordu. Gerekce artik orneklem
    // buyuklugunu ve araligi soyluyor.
    reasons.push('Tüm eşikler geçildi, sinyal üretildi (' +
      Math.round(winRateRaw * matchCount) + '/' + matchCount + ' tuttu, ' +
      '%95 alt sınır %' + toPct(winRateLo) + ')')
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
    // Kalibrasyon alanlari: ham oran, havuz tabani, kuculutulmus oranin
    // guven araligi ve tabana gore fark. Arayuz bunlari birlikte gosterir;
    // tek bir yuzde, belirsizligi gizliyordu.
    winRateRaw: winRateRaw,
    // Etkin orneklem: zaman agirligi kapaliyken matchCount ile ayni.
    nEff: etkinN,
    winRateLo: winRateLo,
    winRateHi: winRateHi,
    // Karar anina en yakin yuksek etkili veri (takvim varsa). Kapi kapali
    // olsa bile tasinir: arayuz uyari gosterir.
    news: haber,
    newsBlocked: haberEngeli,
    baseRate: havuzTabani,
    baseN: candidates && Number.isFinite(candidates.baseN) ? candidates.baseN : null,
    lift: lift,
    expectancyGross: expectancyGross,
    costR: costR,
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
 * @param {Object[]} [prototypes] YOK SAYILIR; imza eski cagiranlar icin duruyor
 * @param {Object} [cfg]
 * @param {number|null} [beforeTime]
 * @param {{news?:{code:string, deltaMin:number}|null}} [ek] Karar aninin ek
 *        baglami. Su an yalnizca `news` okunur (yuksek etkili veri penceresi);
 *        verilmezse ozellik kapali kalir.
 * @returns {Object} Signal
 */
function evaluateTouch (touch, features, memory, prototypes, cfg, beforeTime, ek) {
  const events = (memory && Array.isArray(memory.events)) ? memory.events : []
  const candidates = findCandidates(touch, features, memory, cfg, beforeTime)
  return decideFromCandidates(touch, candidates, undefined, cfg, {
    // `|| null`: arguman hic verilmediyse `undefined` gelir ve o durumda
    // "olayin kendi vektorune duse" davranisi ISTENMEZ, ozellik yok sayilir.
    features: features || null,
    scanned: events.length,
    beforeTime: beforeTime,
    news: ek && ek.news ? ek.news : null,
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
