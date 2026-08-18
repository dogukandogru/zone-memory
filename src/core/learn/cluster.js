'use strict'

/**
 * Prototip cikarimi (A5).
 *
 * Hafizadaki sekil vektorlerini deterministik k-means ile kumeler ve her kumeye
 * okunabilir Turkce bir ad verir. Amac, "hangi kurulum tipleri gercekten
 * calisiyor" sorusunu tek bakista gorunur kilmaktir.
 *
 * Determinizm sarttir: ayni hafiza + ayni seed her zaman ayni prototipleri
 * uretir. Bu yuzden Math.random HICBIR YERDE kullanilmaz, mulberry32 kullanilir.
 *
 * SOZLESME NOTU (CONTRACTS.md bolum 13): sozlesme `size` alanini tanimlarken
 * hangi kumeyi saydigini belirtmiyor. Burada `size` = kumelemeye giren
 * (onlySuccess ise yalnizca basarili) uye sayisidir ve `memberIds.length` ile
 * birebir ayni deger olur. `winRate`, `avgMfeAtr`, `avgMaeAtr` ise prototipin
 * gercek ayirt ediciligini gostermek icin hafizadaki TUM olaylarin (basarisizlar
 * dahil) en yakin prototipe yeniden atanmasiyla hesaplanir.
 * Ayrica sozlesmedeki dort disa aktarima ek olarak `label` fonksiyonu da disa
 * aktarilir; arayuz tarafinda tek bir sekil vektorunu adlandirmak icin ise yarar.
 */

const { pearson } = require('./similarity')

/** k-means varsayilanlari. */
const DEFAULT_ITERS = 50
const DEFAULT_SEED = 42
/** Merkez kaymasi bu esigin altina inince yakinsamis sayilir. */
const YAKINSAMA_ESIGI = 1e-10

/* --- Etiket esikleri (sekil vektoru 0..1 arasinda min-max normalize oldugu
       icin bu esikler dogrudan "normalize edilmis yukseklik" birimindedir) --- */
/** Ilk ucte bir ile son ucte bir ortalamasi arasindaki fark bu kadarsa trend var. */
const EGIM_ESIGI = 0.12
/** Merkezdeki tepe-dip araligi bu esigin altindaysa fiyat sikismis demektir. */
const ARALIK_ESIGI = 0.50
/** V donus icin iki bacagin her birinin en az bu kadar hareket etmesi gerekir. */
const DONUS_ESIGI = 0.10
/** Son bacak ayni yonde bu kadar hareket ettiyse kirilma adayidir. */
const KIRILMA_ESIGI = 0.20
/** Kirilma sayilmasi icin son bacagin onceki bacaktan bu kat kadar guclu olmasi gerekir. */
const IVME_KATI = 1.3

/**
 * Deterministik PRNG (mulberry32). 32 bitlik tek bir durum tutar,
 * her cagrida [0, 1) araliginda sayi dondurur.
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32 (seed) {
  let a = (seed >>> 0)
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Duz dizide tutulan iki satir arasindaki karesel Oklid mesafesi.
 * @returns {number}
 */
function kareMesafe (a, ao, b, bo, dim) {
  let s = 0
  for (let d = 0; d < dim; d++) {
    const x = a[ao + d] - b[bo + d]
    s += x * x
  }
  return s
}

/**
 * k-means++ baslatmali, deterministik k-means.
 *
 * Bos kume olusursa merkezine, kendi merkezine en uzak nokta tasinir.
 * En fazla opts.iters yineleme yapilir; atamalar degismezse veya merkez kaymasi
 * yakinsama esiginin altina inerse erken cikilir.
 *
 * @param {Array<ArrayLike<number>>} vectors Ayni uzunlukta vektorler
 * @param {number} k
 * @param {{iters?:number, seed?:number}} [opts]
 * @returns {{centroids: Float32Array[], assignments: Int32Array, inertia: number}}
 */
function kmeans (vectors, k, opts) {
  const o = opts || {}
  const iters = Number.isFinite(o.iters) && o.iters > 0 ? Math.floor(o.iters) : DEFAULT_ITERS
  const seed = Number.isFinite(o.seed) ? o.seed : DEFAULT_SEED

  const n = vectors ? vectors.length : 0
  if (n === 0 || !(k > 0)) {
    return { centroids: [], assignments: new Int32Array(0), inertia: 0 }
  }

  const dim = vectors[0].length | 0
  if (dim === 0) {
    return { centroids: [], assignments: new Int32Array(n), inertia: 0 }
  }
  const kk = Math.min(Math.floor(k), n)

  // Onbellek dostu duz kopya.
  const veri = new Float64Array(n * dim)
  for (let i = 0; i < n; i++) {
    const v = vectors[i]
    const off = i * dim
    for (let d = 0; d < dim; d++) veri[off + d] = v[d]
  }

  const merkez = new Float64Array(kk * dim)
  const rnd = mulberry32(seed)

  // --- k-means++ baslatma ---
  let ilk = Math.floor(rnd() * n)
  if (ilk >= n) ilk = n - 1
  for (let d = 0; d < dim; d++) merkez[d] = veri[ilk * dim + d]

  const enYakinKare = new Float64Array(n)
  enYakinKare.fill(Infinity)

  for (let c = 1; c < kk; c++) {
    const oncekiOff = (c - 1) * dim
    let toplam = 0
    for (let i = 0; i < n; i++) {
      const d2 = kareMesafe(veri, i * dim, merkez, oncekiOff, dim)
      if (d2 < enYakinKare[i]) enYakinKare[i] = d2
      toplam += enYakinKare[i]
    }

    let secim
    if (!(toplam > 0)) {
      // Tum noktalar ayni; kalan merkezleri rastgele secmek yeterli.
      secim = Math.floor(rnd() * n)
      if (secim >= n) secim = n - 1
    } else {
      const hedef = rnd() * toplam
      let birikim = 0
      secim = n - 1
      for (let i = 0; i < n; i++) {
        birikim += enYakinKare[i]
        if (birikim >= hedef) { secim = i; break }
      }
    }
    const off = c * dim
    for (let d = 0; d < dim; d++) merkez[off + d] = veri[secim * dim + d]
  }

  // --- Lloyd yinelemeleri ---
  const atama = new Int32Array(n)
  atama.fill(-1)
  const noktaKare = new Float64Array(n)
  const toplamlar = new Float64Array(kk * dim)
  const sayilar = new Int32Array(kk)

  for (let it = 0; it < iters; it++) {
    let degisti = false
    for (let i = 0; i < n; i++) {
      const off = i * dim
      let enIyi = 0
      let enIyiD = Infinity
      for (let j = 0; j < kk; j++) {
        const d2 = kareMesafe(veri, off, merkez, j * dim, dim)
        if (d2 < enIyiD) { enIyiD = d2; enIyi = j }
      }
      noktaKare[i] = enIyiD
      if (atama[i] !== enIyi) { atama[i] = enIyi; degisti = true }
    }
    if (!degisti) break

    // Bos kume onarimi: en uzak noktayi bos kumenin merkezi yap.
    sayilar.fill(0)
    for (let i = 0; i < n; i++) sayilar[atama[i]]++
    for (let j = 0; j < kk; j++) {
      if (sayilar[j] !== 0) continue
      let aday = -1
      let enUzak = -1
      for (let i = 0; i < n; i++) {
        if (sayilar[atama[i]] <= 1) continue
        if (noktaKare[i] > enUzak) { enUzak = noktaKare[i]; aday = i }
      }
      if (aday < 0) break
      sayilar[atama[aday]]--
      atama[aday] = j
      sayilar[j] = 1
      noktaKare[aday] = 0
    }

    // Merkez guncelleme.
    toplamlar.fill(0)
    sayilar.fill(0)
    for (let i = 0; i < n; i++) {
      const j = atama[i]
      const off = i * dim
      const moff = j * dim
      for (let d = 0; d < dim; d++) toplamlar[moff + d] += veri[off + d]
      sayilar[j]++
    }

    let enBuyukKayma = 0
    for (let j = 0; j < kk; j++) {
      const adet = sayilar[j]
      if (adet === 0) continue
      const moff = j * dim
      for (let d = 0; d < dim; d++) {
        const yeni = toplamlar[moff + d] / adet
        const kayma = Math.abs(yeni - merkez[moff + d])
        if (kayma > enBuyukKayma) enBuyukKayma = kayma
        merkez[moff + d] = yeni
      }
    }
    if (enBuyukKayma < YAKINSAMA_ESIGI) break
  }

  // Son merkezlere gore atamalari ve ataleti tazele.
  let inertia = 0
  for (let i = 0; i < n; i++) {
    const off = i * dim
    let enIyi = 0
    let enIyiD = Infinity
    for (let j = 0; j < kk; j++) {
      const d2 = kareMesafe(veri, off, merkez, j * dim, dim)
      if (d2 < enIyiD) { enIyiD = d2; enIyi = j }
    }
    atama[i] = enIyi
    inertia += enIyiD
  }

  const centroids = new Array(kk)
  for (let j = 0; j < kk; j++) {
    const c = new Float32Array(dim)
    const moff = j * dim
    for (let d = 0; d < dim; d++) c[d] = merkez[moff + d]
    centroids[j] = c
  }

  return { centroids, assignments: atama, inertia }
}

/**
 * Hafizadan prototip kutuphanesi cikarir.
 *
 * Akis:
 *   1. Ozelligi ve sonucu olan olaylar secilir.
 *   2. opts.onlySuccess ise yalnizca basarili olaylarin sekil vektorleri kumelenir.
 *   3. minSize altindaki kumeler elenir.
 *   4. Kalan merkezlere hafizadaki TUM olaylar (basarisizlar dahil) yeniden
 *      atanir ve winRate / avgMfeAtr / avgMaeAtr bu genis kumeden hesaplanir.
 *      Boylece prototipin gercek ayirt ediciligi gorunur: yalnizca basarililar
 *      sayilsaydi her prototipin basari orani 1.00 cikardi.
 *
 * Not: 4. adimdaki atama, kumelemeyle ayni olcut olan Oklid mesafesini kullanir;
 * matchPrototype ise Pearson tabanli benzerlik dondurur (olcek bagimsizligi
 * arayuzde daha anlamli oldugu icin).
 *
 * @param {{events:Array<Object>}|Array<Object>} memory
 * @param {{k?:number, minSize?:number, seed?:number, onlySuccess?:boolean, iters?:number}} [opts]
 * @returns {Array<{id:number, size:number, winRate:number, avgMfeAtr:number,
 *                  avgMaeAtr:number, centroid:Float32Array, label:string,
 *                  memberIds:number[]}>}
 */
function buildPrototypes (memory, opts) {
  const o = opts || {}
  const k = Number.isFinite(o.k) && o.k > 0 ? Math.floor(o.k) : 8
  const minSize = Number.isFinite(o.minSize) && o.minSize > 0 ? Math.floor(o.minSize) : 15
  const seed = Number.isFinite(o.seed) ? o.seed : DEFAULT_SEED
  const iters = Number.isFinite(o.iters) && o.iters > 0 ? Math.floor(o.iters) : DEFAULT_ITERS
  const onlySuccess = o.onlySuccess === undefined ? true : !!o.onlySuccess

  const kaynak = Array.isArray(memory) ? memory : (memory && memory.events ? memory.events : null)
  if (!kaynak || kaynak.length === 0) return []

  // Sonucu hesaplanmis ve sekil vektoru olan olaylar.
  const tumu = []
  let dim = 0
  for (let i = 0; i < kaynak.length; i++) {
    const ev = kaynak[i]
    if (!ev || ev.outcome === undefined || ev.outcome === null) continue
    const f = ev.features
    if (!f || !f.shape || f.shape.length === 0) continue
    if (dim === 0) dim = f.shape.length | 0
    if (f.shape.length !== dim) continue
    tumu.push(ev)
  }
  if (tumu.length === 0) return []

  const temel = onlySuccess ? tumu.filter(secBasarili) : tumu
  if (temel.length === 0) return []

  const vektorler = new Array(temel.length)
  for (let i = 0; i < temel.length; i++) vektorler[i] = temel[i].features.shape

  const kk = Math.min(k, temel.length)
  const km = kmeans(vektorler, kk, { iters, seed })
  const merkezSayisi = km.centroids.length
  if (merkezSayisi === 0) return []

  // Kumeleme uyeleri.
  const uyeler = new Array(merkezSayisi)
  for (let j = 0; j < merkezSayisi; j++) uyeler[j] = []
  for (let i = 0; i < temel.length; i++) uyeler[km.assignments[i]].push(temel[i])

  // minSize filtresi.
  const tutulan = []
  for (let j = 0; j < merkezSayisi; j++) {
    if (uyeler[j].length >= minSize) tutulan.push(j)
  }
  if (tutulan.length === 0) return []

  // Buyukten kucuge sirala; id'ler bu sirayla verilir.
  tutulan.sort(function (a, b) {
    const fark = uyeler[b].length - uyeler[a].length
    return fark !== 0 ? fark : a - b
  })

  const p = tutulan.length
  const merkezler = new Array(p)
  for (let x = 0; x < p; x++) merkezler[x] = km.centroids[tutulan[x]]

  // Tum olaylari en yakin tutulan merkeze ata ve gercek istatistikleri topla.
  const toplamSayi = new Int32Array(p)
  const basariSayi = new Int32Array(p)
  const mfeToplam = new Float64Array(p)
  const mfeSayi = new Int32Array(p)
  const maeToplam = new Float64Array(p)
  const maeSayi = new Int32Array(p)

  for (let i = 0; i < tumu.length; i++) {
    const sekil = tumu[i].features.shape
    let enIyi = 0
    let enIyiD = Infinity
    for (let x = 0; x < p; x++) {
      const c = merkezler[x]
      let s = 0
      for (let d = 0; d < dim; d++) {
        const fark = sekil[d] - c[d]
        s += fark * fark
      }
      if (s < enIyiD) { enIyiD = s; enIyi = x }
    }

    const ev = tumu[i]
    toplamSayi[enIyi]++
    if (ev.success === true) basariSayi[enIyi]++
    const mfe = +ev.mfeAtr
    if (Number.isFinite(mfe)) { mfeToplam[enIyi] += mfe; mfeSayi[enIyi]++ }
    const mae = +ev.maeAtr
    if (Number.isFinite(mae)) { maeToplam[enIyi] += mae; maeSayi[enIyi]++ }
  }

  const prototipler = new Array(p)
  for (let x = 0; x < p; x++) {
    const grup = uyeler[tutulan[x]]
    const memberIds = new Array(grup.length)
    for (let i = 0; i < grup.length; i++) memberIds[i] = grup[i].id

    prototipler[x] = {
      id: x,
      size: grup.length,
      winRate: toplamSayi[x] > 0 ? basariSayi[x] / toplamSayi[x] : 0,
      avgMfeAtr: mfeSayi[x] > 0 ? mfeToplam[x] / mfeSayi[x] : 0,
      avgMaeAtr: maeSayi[x] > 0 ? maeToplam[x] / maeSayi[x] : 0,
      centroid: merkezler[x],
      label: label(merkezler[x]),
      memberIds,
    }
  }

  return prototipler
}

/** Basarili olay suzgeci. */
function secBasarili (ev) {
  return ev.success === true
}

/**
 * Sekil vektorunden okunabilir Turkce ad uretir.
 *
 * Vektor uc dilime bolunur (bas, orta, son) ve uc bilesen uretilir:
 *   1. Egim      : son dilim ortalamasi eksi bas dilim ortalamasi.
 *                  +EGIM_ESIGI ustu "Yukselen", -EGIM_ESIGI alti "Dusen",
 *                  arasi "Yatay".
 *   2. Oynaklik  : vektordeki tepe-dip araligi. ARALIK_ESIGI altinda "sikisik",
 *                  ustunde "genis".
 *   3. Son hareket: ilk bacak (orta eksi bas) ile son bacak (son eksi orta).
 *                  Isaretleri zit ve ikisi de DONUS_ESIGI'ni asiyorsa "V donus"
 *                  (pencerenin ortasinda yon degistirmis, klasik tepki hareketi),
 *                  ayni yonde ve son bacak hem KIRILMA_ESIGI'ni hem de ilk
 *                  bacagin IVME_KATI katini asiyorsa "kirilma" (sona dogru
 *                  ivmelenme), aksi halde "duz" (duzgun veya kararsiz seyir).
 *
 * Ornek cikti: 'Dusen + sikisik + V donus'
 *
 * @param {ArrayLike<number>} centroid
 * @returns {string}
 */
function label (centroid) {
  const n = centroid ? centroid.length | 0 : 0
  if (n < 3) return 'Belirsiz'

  // Uc dilim: [0, ucteBir), [ucteBir, n - ucteBir), [n - ucteBir, n)
  const ucteBir = Math.max(1, Math.floor(n / 3))
  const ortaBas = ucteBir
  const ortaSon = Math.max(ortaBas + 1, n - ucteBir)

  let basToplam = 0
  for (let i = 0; i < ucteBir; i++) basToplam += centroid[i]
  const basOrt = basToplam / ucteBir

  let ortaToplam = 0
  for (let i = ortaBas; i < ortaSon; i++) ortaToplam += centroid[i]
  const ortaOrt = ortaToplam / (ortaSon - ortaBas)

  let sonToplam = 0
  for (let i = n - ucteBir; i < n; i++) sonToplam += centroid[i]
  const sonOrt = sonToplam / ucteBir

  // 1. Egim
  const egim = sonOrt - basOrt
  let egimAdi
  if (egim > EGIM_ESIGI) egimAdi = 'Yukselen'
  else if (egim < -EGIM_ESIGI) egimAdi = 'Dusen'
  else egimAdi = 'Yatay'

  // 2. Oynaklik
  let enAz = centroid[0]
  let enCok = centroid[0]
  for (let i = 1; i < n; i++) {
    const v = centroid[i]
    if (v < enAz) enAz = v
    if (v > enCok) enCok = v
  }
  const oynaklikAdi = (enCok - enAz) < ARALIK_ESIGI ? 'sikisik' : 'genis'

  // 3. Son hareket
  const ilkBacak = ortaOrt - basOrt
  const sonBacak = sonOrt - ortaOrt
  const ilkBuyukluk = Math.abs(ilkBacak)
  const sonBuyukluk = Math.abs(sonBacak)

  let hareketAdi
  if (ilkBacak * sonBacak < 0 && sonBuyukluk >= DONUS_ESIGI && ilkBuyukluk >= DONUS_ESIGI) {
    hareketAdi = 'V donus'
  } else if (sonBuyukluk >= KIRILMA_ESIGI && sonBuyukluk > ilkBuyukluk * IVME_KATI) {
    hareketAdi = 'kirilma'
  } else {
    hareketAdi = 'duz'
  }

  return egimAdi + ' + ' + oynaklikAdi + ' + ' + hareketAdi
}

/**
 * Bir sekil vektorunun en yakin prototipini bulur.
 * Benzerlik Pearson tabanlidir: (pearson + 1) / 2, yani 0..1 arasi.
 *
 * @param {ArrayLike<number>} shape
 * @param {Array<Object>} prototypes
 * @returns {{prototype:Object, similarity:number}|null}
 */
function matchPrototype (shape, prototypes) {
  if (!shape || !prototypes || prototypes.length === 0) return null

  let enIyi = null
  let enIyiSim = -Infinity
  for (let i = 0; i < prototypes.length; i++) {
    const p = prototypes[i]
    if (!p || !p.centroid) continue
    const sim = (pearson(shape, p.centroid) + 1) / 2
    if (sim > enIyiSim) { enIyiSim = sim; enIyi = p }
  }
  if (!enIyi) return null

  return { prototype: enIyi, similarity: enIyiSim }
}

module.exports = {
  mulberry32,
  kmeans,
  buildPrototypes,
  matchPrototype,
  label,
}
