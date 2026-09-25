'use strict'

/**
 * Benzerlik motoru (A5).
 *
 * Uc bilesenli benzerlik kullanir:
 *   shapeSim : sekil vektorleri arasinda Pearson korelasyonu (olcek ve kaydirma
 *              bagimsiz, "ayni patern farkli fiyat seviyesinde" durumunu yakalar)
 *   ctxSim   : baglam vektorleri arasinda kosinus benzerligi
 *   dtwSim   : z-score getiri vektorleri arasinda Sakoe-Chiba bantli DTW
 *
 * Referans: ../indicator2/backend/app/services/similarity.py
 * Fark: orada pgvector kosinus on-elemesi + DTW yeniden siralamasi vardi,
 * burada veritabani olmadigi icin on-eleme ucuz Pearson sekil benzerligiyle
 * bellek icinde yapilir.
 *
 * SOZLESME NOTU (CONTRACTS.md bolum 12): `knn` icin belgelenen opts alanlari
 * {k, direction, excludeWithinSec, beforeTime, weights}. Ancak `excludeWithinSec`
 * filtresinin uygulanabilmesi icin sorgunun kendi zamani gerekir ve Features
 * nesnesi zaman tasimaz. Bu yuzden ek olarak `opts.queryTime` okunur; verilmezse
 * komsu dislama filtresi UYGULANMAZ. Cagiran taraf (signal.js, backtest.js)
 * dokunus zamanini `queryTime` ile gecirmelidir.
 */

const DEFAULT_WEIGHTS = { shape: 0.60, ctx: 0.25, dtw: 0.15 }

/**
 * BENZERLIK ON AYARLARI.
 *
 * Benzerligin ne kadari GORSEL SEKIL olsun sorusunun hazir cevaplari.
 * Kullanici Ayarlar'dan secer; `ozel` secilirse `signalCfg.weights` icindeki
 * uc sayi aynen kullanilir.
 *
 * OLCULDU (secim ve dogrulama dilimleri ayri, esikler hic kullanilmadan,
 * olcut komsularin tutma oraninin gercek sonucu ayirt etme gucu = AUC):
 *
 *            5m dogrulama (8.651 olay)   15m dogrulama (3.362 olay)
 *   sekil            0,6155                      0,5899
 *   sekilAgirlikli   0,6196                      0,5993
 *   dengeli          0,6229                      0,6011
 *   baglamAgirlikli  0,6275                      0,6037
 *   baglam           0,6254                      0,6055
 *
 * Iki zaman diliminde de sira AYNI: baglam arttikca tahmin iyilesiyor,
 * yalniz sekil en kotusu. Aradaki fark kucuk (0,01 AUC bandi), yani hicbiri
 * otekini ezmiyor; yine de "yalniz sekil" olcumde en zayif secenektir.
 * Sebebi muhtemelen sekil vektorunun min-max normalize olmasi: hareketin
 * ATR'ye gore buyuklugu, kutu genisligi, hacim patlamasi ve seans bilgisi
 * sekilde YOKTUR, hepsi baglam tarafindadir.
 */
const AGIRLIK_ONAYARLARI = {
  sekil: { shape: 1.00, ctx: 0.00, dtw: 0.00 },
  sekilAgirlikli: { shape: 0.85, ctx: 0.10, dtw: 0.05 },
  dengeli: { shape: 0.40, ctx: 0.40, dtw: 0.20 },
  baglamAgirlikli: { shape: 0.20, ctx: 0.70, dtw: 0.10 },
  baglam: { shape: 0.00, ctx: 1.00, dtw: 0.00 },
}

/**
 * Sinyal ayarindan etkin agirliklari cozer.
 *
 * TEK KAYNAK: hem kNN hem aday onbellegi bunu cagirir. Onbellek anahtari da
 * cozulmus degerden uretilir, yoksa on ayar degistiginde eski onbellek
 * sessizce kullanilir ve olcum yanlis cikardi.
 *
 * @param {{weightPreset?:string, weights?:object}} [signalCfg]
 * @returns {{shape:number, ctx:number, dtw:number}}
 */
function agirlikCoz (signalCfg) {
  const c = signalCfg || {}
  const ad = typeof c.weightPreset === 'string' ? c.weightPreset : ''
  if (ad && Object.prototype.hasOwnProperty.call(AGIRLIK_ONAYARLARI, ad)) {
    return Object.assign({}, AGIRLIK_ONAYARLARI[ad])
  }
  // 'ozel' ya da taninmayan ad: elle verilen agirliklar gecerlidir.
  return Object.assign({}, DEFAULT_WEIGHTS, c.weights || {})
}

/** DTW icin varsayilan Sakoe-Chiba bant genisligi. */
const DEFAULT_BAND = 5
/** knn on-elemesinde k basina alinacak aday sayisi. */
const ADAY_CARPANI = 8
/** Sifira bolme korumasi. */
const EPS = 1e-12

/**
 * Pearson korelasyonu.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} -1..1, sabit (varyanssiz) seride 0
 */
function pearson (a, b) {
  if (!a || !b) return 0
  const n = a.length < b.length ? a.length : b.length
  if (n < 2) return 0

  let ta = 0
  let tb = 0
  for (let i = 0; i < n; i++) {
    ta += a[i]
    tb += b[i]
  }
  const ma = ta / n
  const mb = tb / n

  let pay = 0
  let ka = 0
  let kb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    pay += x * y
    ka += x * x
    kb += y * y
  }
  if (!(ka > EPS) || !(kb > EPS)) return 0

  const r = pay / Math.sqrt(ka * kb)
  if (!Number.isFinite(r)) return 0
  return r < -1 ? -1 : (r > 1 ? 1 : r)
}

/**
 * Kosinus benzerligi.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} -1..1, sifir normlu vektorde 0
 */
function cosine (a, b) {
  if (!a || !b) return 0
  const n = a.length < b.length ? a.length : b.length
  if (n < 1) return 0

  let nokta = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    nokta += x * y
    na += x * x
    nb += y * y
  }
  if (!(na > EPS) || !(nb > EPS)) return 0

  const c = nokta / (Math.sqrt(na) * Math.sqrt(nb))
  if (!Number.isFinite(c)) return 0
  return c < -1 ? -1 : (c > 1 ? 1 : c)
}

/**
 * Oklid mesafesi.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} 0 veya pozitif
 */
function euclidean (a, b) {
  if (!a || !b) return 0
  const n = a.length < b.length ? a.length : b.length
  let kare = 0
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i]
    kare += d * d
  }
  return Math.sqrt(kare)
}

/**
 * Sakoe-Chiba bantli DTW mesafesi. Sonuc (n + m)'ye bolunerek normalize edilir,
 * boylece farkli uzunluktaki seriler karsilastirilabilir kalir.
 *
 * Bellek icin tam matris yerine iki satir tutulur.
 * Not: bant, |n - m| farkindan kucuk olamaz; aksi halde sag alt koseye ulasan
 * yol kalmaz ve sonuc Infinity olurdu. Bu yuzden bant gerektiginde genisletilir.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {number} [band=5]
 * @returns {number}
 */
function dtwDistance (a, b, band) {
  if (!a || !b) return 0
  const n = a.length | 0
  const m = b.length | 0
  if (n === 0 || m === 0) return 0

  let w = band == null ? DEFAULT_BAND : (band | 0)
  if (w < 0) w = 0
  const fark = n > m ? n - m : m - n
  if (w < fark) w = fark

  const INF = Infinity
  let onceki = new Float64Array(m + 1)
  let simdiki = new Float64Array(m + 1)
  onceki.fill(INF)
  onceki[0] = 0

  for (let i = 1; i <= n; i++) {
    simdiki.fill(INF)
    const ai = a[i - 1]
    let lo = i - w
    if (lo < 1) lo = 1
    let hi = i + w
    if (hi > m) hi = m

    for (let j = lo; j <= hi; j++) {
      const d = Math.abs(ai - b[j - 1])
      const u = onceki[j]
      const sol = simdiki[j - 1]
      const capraz = onceki[j - 1]
      let en = u < sol ? u : sol
      if (capraz < en) en = capraz
      simdiki[j] = d + en
    }

    const gecici = onceki
    onceki = simdiki
    simdiki = gecici
  }

  const sonuc = onceki[m] / (n + m)
  return Number.isFinite(sonuc) ? sonuc : Infinity
}

/**
 * Agirliklari cozer ve toplami 1 olacak sekilde normalize eder.
 * Boylece sozlesmedeki "hepsi 0..1" garantisi ozel agirliklarda da bozulmaz.
 * @param {{shape?:number, ctx?:number, dtw?:number}} [weights]
 * @returns {{shape:number, ctx:number, dtw:number}}
 */
function agirliklariCoz (weights) {
  const w = weights || DEFAULT_WEIGHTS
  let ws = Number.isFinite(w.shape) ? w.shape : DEFAULT_WEIGHTS.shape
  let wc = Number.isFinite(w.ctx) ? w.ctx : DEFAULT_WEIGHTS.ctx
  let wd = Number.isFinite(w.dtw) ? w.dtw : DEFAULT_WEIGHTS.dtw
  if (ws < 0) ws = 0
  if (wc < 0) wc = 0
  if (wd < 0) wd = 0

  const toplam = ws + wc + wd
  if (!(toplam > 0)) return { shape: DEFAULT_WEIGHTS.shape, ctx: DEFAULT_WEIGHTS.ctx, dtw: DEFAULT_WEIGHTS.dtw }
  return { shape: ws / toplam, ctx: wc / toplam, dtw: wd / toplam }
}

/**
 * Merkezlenmis sorgu sekliyle bir adayin Pearson benzerligi, 0..1 araliginda.
 * Hem on elemede hem ikinci asamada ayni hesap kullanilir.
 * @param {Float64Array} qMerkez Sorgunun ortalamadan farklari
 * @param {number} qNorm Sorgunun normu
 * @param {Float32Array|Float64Array} cs Aday sekil vektoru
 * @returns {number}
 */
function sekilBenzerligi (qMerkez, qNorm, cs) {
  const sl = qMerkez.length | 0
  if (!cs || cs.length !== sl) return 0
  let ct = 0
  for (let d = 0; d < sl; d++) ct += cs[d]
  const cOrt = ct / sl
  let pay = 0
  let cKare = 0
  for (let d = 0; d < sl; d++) {
    const y = cs[d] - cOrt
    pay += qMerkez[d] * y
    cKare += y * y
  }
  let r = 0
  if (qNorm > 0 && cKare > EPS) {
    r = pay / (qNorm * Math.sqrt(cKare))
    if (!Number.isFinite(r)) r = 0
    else if (r < -1) r = -1
    else if (r > 1) r = 1
  }
  return (r + 1) / 2
}

/**
 * Iki ozellik vektorunun benzerligi. Tum degerler 0..1 arasindadir.
 * Eksik bir alt vektor varsa o bilesenin benzerligi 0 sayilir.
 *
 * @param {{shape:ArrayLike<number>, ret:ArrayLike<number>, ctx:ArrayLike<number>}} qa
 * @param {{shape:ArrayLike<number>, ret:ArrayLike<number>, ctx:ArrayLike<number>}} qb
 * @param {{shape?:number, ctx?:number, dtw?:number}} [weights]
 * @returns {{shapeSim:number, ctxSim:number, dtwSim:number, score:number}}
 */
function similarity (qa, qb, weights) {
  const w = agirliklariCoz(weights)
  if (!qa || !qb) return { shapeSim: 0, ctxSim: 0, dtwSim: 0, score: 0 }

  const shapeSim = qa.shape && qb.shape ? (pearson(qa.shape, qb.shape) + 1) / 2 : 0
  const ctxSim = qa.ctx && qb.ctx ? (cosine(qa.ctx, qb.ctx) + 1) / 2 : 0

  let dtwSim = 0
  if (qa.ret && qb.ret) {
    const d = dtwDistance(qa.ret, qb.ret, DEFAULT_BAND)
    dtwSim = Number.isFinite(d) ? 1 / (1 + d) : 0
  }

  const score = w.shape * shapeSim + w.ctx * ctxSim + w.dtw * dtwSim
  return { shapeSim, ctxSim, dtwSim, score }
}

/* ---------------------------------------------------------------------------
 * En kucuk oncelikli yigin (min-heap). On-elemede en iyi M adayi tutmak icin
 * kullanilir: kokte en dusuk benzerlik durur, yeni aday kokten iyiyse kok atilir.
 * ------------------------------------------------------------------------- */

/** Yigina yeni eleman ekler ve yukari tasir. */
function yiginEkle (hSim, hIdx, boyut, sim, idx) {
  let i = boyut
  hSim[i] = sim
  hIdx[i] = idx
  while (i > 0) {
    const p = (i - 1) >> 1
    if (hSim[p] <= hSim[i]) break
    const ts = hSim[p]; hSim[p] = hSim[i]; hSim[i] = ts
    const ti = hIdx[p]; hIdx[p] = hIdx[i]; hIdx[i] = ti
    i = p
  }
}

/** Yigin kokunu degistirir ve asagi tasir. */
function yiginKokDegistir (hSim, hIdx, boyut, sim, idx) {
  hSim[0] = sim
  hIdx[0] = idx
  let i = 0
  for (;;) {
    const sol = 2 * i + 1
    const sag = sol + 1
    let en = i
    if (sol < boyut && hSim[sol] < hSim[en]) en = sol
    if (sag < boyut && hSim[sag] < hSim[en]) en = sag
    if (en === i) break
    const ts = hSim[en]; hSim[en] = hSim[i]; hSim[i] = ts
    const ti = hIdx[en]; hIdx[en] = hIdx[i]; hIdx[i] = ti
    i = en
  }
}

/**
 * Hafizadaki en benzer k kaydi bulur.
 *
 * Iki asamalidir:
 *   1. Tum uygun adaylarda yalnizca ucuz sekil Pearson'u hesaplanir ve
 *      en iyi k * 8 aday bir min-heap ile tutulur.
 *   2. Sadece o adaylarda pahali kosinus ve DTW hesaplanip birlesik skor
 *      uretilir, azalan siralanip ilk k dondurulur.
 * Bu sayede 20 bin kayitlik hafizada tek sorgu 50 ms altinda kalir.
 *
 * Filtreler:
 *   opts.direction        Yalnizca ayni yondeki kayitlar
 *   opts.kind             Yalnizca ayni turdeki olaylar ('form' | 'touch').
 *                         Kutunun DOGDUGU an ile fiyatin ona GERI DONDUGU an
 *                         iki farkli kurulumdur: girisleri, riskleri ve tipik
 *                         sonuclari ayridir. Karistirilirsa "gecmiste bu yapi
 *                         %78 tuttu" cumlesi baska bir kurulumun istatistigini
 *                         tasir. Kayitta `kind` yoksa 'touch' kabul edilir
 *                         (eski hafiza dosyalari).
 *   opts.beforeTime       Yalnizca bu zamandan ONCEKI kayitlar (ileriye bakma yasagi)
 *   opts.excludeWithinSec opts.queryTime ile birlikte, sorgu zamanina bu kadar
 *                         yakin kayitlari eler (komsu dislama)
 * Sonucu hesaplanmamis (outcome tanimsiz) veya ozellik vektoru olmayan kayitlar
 * hicbir zaman aday degildir.
 *
 * @param {{shape:ArrayLike<number>, ret:ArrayLike<number>, ctx:ArrayLike<number>}} query
 * @param {{events:Array<Object>}|Array<Object>} memory
 * @param {{k?:number, direction?:string, kind?:string, excludeWithinSec?:number,
 *          beforeTime?:number|null, queryTime?:number|null, weights?:Object}} [opts]
 * @returns {Array<{event:Object, shapeSim:number, ctxSim:number, dtwSim:number, similarity:number}>}
 */
function knn (query, memory, opts) {
  const o = opts || {}
  const events = Array.isArray(memory) ? memory : (memory && memory.events ? memory.events : null)
  if (!query || !query.shape || !events || events.length === 0) return []

  const k = Number.isFinite(o.k) && o.k > 0 ? Math.floor(o.k) : 25
  const w = agirliklariCoz(o.weights)
  const yon = o.direction ? o.direction : null
  const tur = o.kind ? o.kind : null
  const oncesi = Number.isFinite(o.beforeTime) ? o.beforeTime : null
  const sorguZamani = Number.isFinite(o.queryTime) ? o.queryTime : null
  const komsuSec = sorguZamani !== null && Number.isFinite(o.excludeWithinSec) && o.excludeWithinSec > 0
    ? o.excludeWithinSec
    : 0

  // Sorgu sekil vektorunu bir kez ortala; her aday icin yeniden hesaplamayiz.
  const qs = query.shape
  const sl = qs.length | 0
  if (sl < 2) return []
  let toplam = 0
  for (let i = 0; i < sl; i++) toplam += qs[i]
  const qOrt = toplam / sl
  const qMerkez = new Float64Array(sl)
  let qKare = 0
  for (let i = 0; i < sl; i++) {
    const d = qs[i] - qOrt
    qMerkez[i] = d
    qKare += d * d
  }
  const qNorm = qKare > EPS ? Math.sqrt(qKare) : 0

  // Cagiran `baseOut` verirse havuz sayaclari doldurulur (bkz. asagisi).
  const tabanCikti = o.baseOut && typeof o.baseOut === 'object' ? o.baseOut : null
  /**
   * BENZER KAYIT SAYACI.
   *
   * `k` yalnizca EN BENZER kac tanesinin dondurulecegini belirler; "gecmiste
   * kac benzer kurulum var" sorusu bundan bagimsizdir ve k'ya takilmamalidir.
   * Sayim, zaten tum havuzu gezen on eleme gecisinde yapilir, yani ek maliyet
   * yoktur.
   *
   * DIKKAT: sayim ON PUAN uzerinden yapilir (sekil + baglam), DTW haric.
   * Varsayilan agirlikta DTW'nin pay i SIFIRDIR, yani sayim tam dogrudur.
   * DTW agirligi verilirse sayim YAKLASIKTIR; tam olmasi icin her aday icin
   * DTW hesaplanmasi gerekirdi ve bu, sayimi kNN kadar pahali yapardi.
   */
  const sayacCikti = o.countOut && typeof o.countOut === 'object' ? o.countOut : null
  const sayimEsigi = Number.isFinite(o.countThreshold) ? o.countThreshold : null
  // TABAN PENCERESI (S9, varsayilan kapali): havuz oranini yalnizca son N yila
  // bakarak hesaplar. Rejim degistiginde (yillik taban 15m dokunusta 2018'de
  // %15,5, 2020'de %33,1) eski donemin orani kalibrasyon tabanini baskiliyor.
  const tabanPencereYil = Number.isFinite(o.baseWindowYears) && o.baseWindowYears > 0
    ? o.baseWindowYears
    : 0
  const tabanEnErken = (tabanPencereYil > 0 && Number.isFinite(o.queryTime))
    ? o.queryTime - tabanPencereYil * 365.25 * 86400
    : null
  if (sayacCikti) {
    sayacCikti.benzer = 0
    sayacCikti.havuz = 0
  }
  if (tabanCikti) {
    tabanCikti.n = 0
    tabanCikti.wins = 0
  }

  const n = events.length
  const M = Math.min(n, k * ADAY_CARPANI)
  if (M <= 0) return []
  const hSim = new Float64Array(M)
  const hIdx = new Int32Array(M)
  const hSekil = new Float64Array(M)
  const hCtx = new Float64Array(M)
  let hBoyut = 0

  // 1. asama: TAM benzerligin UCUZ kismiyla on eleme.
  //
  // Onceden on eleme yalnizca sekil benzerligine bakiyordu. Sekil skorun
  // %60'ini alsa da basariyi ayirt etmiyor (olculdu: AUC 0.50), bilgi
  // baglam vektorunde. Yalnizca sekle gore elemek, tam siralamada ilk k'ya
  // girecek adaylarin bir kismini daha ilk adimda atiyordu (olculdu: %21).
  // Artik on eleme sekil VE baglam bileseniyle yapilir; pahali olan DTW
  // yalnizca hayatta kalanlarda hesaplanir (DTW'nin skora etkisi zaten
  // olculdu: p01-p99 araligi 0.11, yani en fazla 0.016 puan).
  for (let i = 0; i < n; i++) {
    const ev = events[i]
    if (!ev) continue
    if (ev.outcome === undefined || ev.outcome === null) continue
    // 'nofill': kenara konan limit emir hic dolmadi, yani bu olaydan gercekte
    // bir islem cikmadi. Aday havuzunda tutmak isabet oranini yanlis
    // hesaplatir (ne kazanc ne kayip), bu yuzden komsu olarak kullanilmaz.
    if (ev.outcome === 'nofill') continue
    const f = ev.features
    if (!f || !f.shape) continue
    if (yon !== null && ev.direction !== yon) continue
    if (tur !== null && (ev.kind || 'touch') !== tur) continue

    const t = ev.time
    if (oncesi !== null && !(t < oncesi)) continue
    if (komsuSec > 0) {
      const uzaklik = t > sorguZamani ? t - sorguZamani : sorguZamani - t
      if (uzaklik < komsuSec) continue
    }

    const cs = f.shape
    if (cs.length !== sl) continue

    let ct = 0
    for (let d = 0; d < sl; d++) ct += cs[d]
    const cOrt = ct / sl

    let pay = 0
    let cKare = 0
    for (let d = 0; d < sl; d++) {
      const y = cs[d] - cOrt
      pay += qMerkez[d] * y
      cKare += y * y
    }

    let r = 0
    if (qNorm > 0 && cKare > EPS) {
      r = pay / (qNorm * Math.sqrt(cKare))
      if (!Number.isFinite(r)) r = 0
      else if (r < -1) r = -1
      else if (r > 1) r = 1
    }
    // HAVUZUN TABAN ORANI
    // Bu olay tum suzgeclerden gecti, yani kNN'in secim yaptigi HAVUZA
    // girdi. Havuzun kendi basari orani, secimin katma degerini olcmek icin
    // dogru karsilastirma noktasidir: "gecmiste bu yapi %X tuttu" cumlesi
    // ancak havuz orani %Y iken anlam tasir.
    if (tabanCikti && (tabanEnErken === null || Number(ev.time) >= tabanEnErken)) {
      tabanCikti.n++
      if (ev.success === true || ev.outcome === 'respect') tabanCikti.wins++
    }

    const shapeSim = (r + 1) / 2
    const ctxSim = query.ctx && f.ctx ? (cosine(query.ctx, f.ctx) + 1) / 2 : 0
    // On eleme puani: skorun DTW disindaki kismi.
    const onPuan = w.shape * shapeSim + w.ctx * ctxSim

    // Havuzun tamami ve esigi gecenler burada sayilir (bkz. sayacCikti).
    if (sayacCikti) {
      sayacCikti.havuz++
      if (sayimEsigi === null || onPuan >= sayimEsigi) sayacCikti.benzer++
    }

    if (hBoyut < M) {
      yiginEkle(hSim, hIdx, hBoyut, onPuan, i)
      hSekil[hBoyut] = shapeSim
      hCtx[hBoyut] = ctxSim
      hBoyut++
      // Yigin siralamasi degistigi icin bileseni indeksle birlikte tasimak
      // yerine 2. asamada yeniden okunur; bu yuzden burada yalnizca
      // buyume anindaki degerleri tutariz ve asagida indeksten okuruz.
    } else if (onPuan > hSim[0]) {
      yiginKokDegistir(hSim, hIdx, hBoyut, onPuan, i)
    }
  }

  if (hBoyut === 0) return []

  // 2. asama: yalnizca on elemeyi gecen adaylarda baglam ve DTW.
  const sonuc = new Array(hBoyut)
  for (let h = 0; h < hBoyut; h++) {
    const ev = events[hIdx[h]]
    const f = ev.features
    // Bilesenler yeniden hesaplanir: yigin islemleri sirayi degistirdigi icin
    // 1. asamadaki degerleri indeksle tasimak hataya acik olurdu, maliyeti
    // ise yalnizca hayatta kalan k*8 aday kadardir.
    const shapeSim = sekilBenzerligi(qMerkez, qNorm, f.shape)
    const ctxSim = query.ctx && f.ctx ? (cosine(query.ctx, f.ctx) + 1) / 2 : 0

    let dtwSim = 0
    if (query.ret && f.ret) {
      const d = dtwDistance(query.ret, f.ret, DEFAULT_BAND)
      dtwSim = Number.isFinite(d) ? 1 / (1 + d) : 0
    }

    sonuc[h] = {
      event: ev,
      shapeSim,
      ctxSim,
      dtwSim,
      similarity: w.shape * shapeSim + w.ctx * ctxSim + w.dtw * dtwSim,
    }
  }

  sonuc.sort(azalanBenzerlik)
  return sonuc.length > k ? sonuc.slice(0, k) : sonuc
}

/** Benzerlige gore azalan siralama; esitlikte eski kayit once gelir. */
function azalanBenzerlik (a, b) {
  if (b.similarity !== a.similarity) return b.similarity - a.similarity
  return a.event.time - b.event.time
}

module.exports = {
  AGIRLIK_ONAYARLARI,
  agirlikCoz,
  DEFAULT_WEIGHTS,
  pearson,
  cosine,
  euclidean,
  dtwDistance,
  similarity,
  knn,
}
