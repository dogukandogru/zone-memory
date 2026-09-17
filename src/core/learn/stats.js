'use strict'

/**
 * Kucuk istatistik yardimcilari (harici bagimlilik yok).
 *
 * Neden gerekli: test ozeti bir donem yalnizca nokta tahmin gosteriyordu.
 * "124 islemde %39,5 isabet, tabana gore +0,3 puan" cumlesi tek basina
 * sansla ayni sonucu verebilir; bu yuzden her sayinin yaninda belirsizligi
 * de raporlanir. Kullanilan yontemler:
 *   - Wilson araligi: kucuk orneklemde normal yaklasimdan daha dogru.
 *   - Iki yonlu binom testi: gozlenen isabet, taban oranla acikilanabilir mi.
 *   - Blok onyukleme (bootstrap): islem sonuclari gun icinde bagimli oldugu
 *     icin gunluk bloklar halinde yeniden orneklenir.
 *   - Permutasyon: ayni donemden ayni SAYIDA rastgele olay secmek ne kadar
 *     iyi sonuc verirdi.
 */

/** Deterministik PRNG (cluster.js ile ayni yontem). */
function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Wilson skor araligi (varsayilan %95).
 * @param {number} k Basari sayisi
 * @param {number} n Deneme sayisi
 * @param {number} [z] 1.959964 = %95
 * @returns {{lo:number, hi:number}|null}
 */
function wilson (k, n, z) {
  if (!(n > 0)) return null
  const zz = Number.isFinite(z) ? z : 1.959964
  const p = k / n
  const payda = 1 + (zz * zz) / n
  const merkez = p + (zz * zz) / (2 * n)
  const yayilim = zz * Math.sqrt((p * (1 - p)) / n + (zz * zz) / (4 * n * n))
  return { lo: (merkez - yayilim) / payda, hi: (merkez + yayilim) / payda }
}

/** log(n!) icin Lanczos yaklasimi (buyuk n'de tasma olmasin diye). */
function logFaktoriyel (n) {
  if (n < 2) return 0
  // Stirling + duzeltme terimleri, n >= 2 icin yeterince hassas.
  return (n + 0.5) * Math.log(n) - n + 0.9189385332046727 +
    1 / (12 * n) - 1 / (360 * n * n * n)
}

/** Binom olasiligi P(X = k), log uzayinda hesaplanir. */
function binomPmf (k, n, p) {
  if (p <= 0) return k === 0 ? 1 : 0
  if (p >= 1) return k === n ? 1 : 0
  const logC = logFaktoriyel(n) - logFaktoriyel(k) - logFaktoriyel(n - k)
  return Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p))
}

/**
 * Iki yonlu binom testi: n denemede k basari, taban oran p.
 * Yontem: gozlenen olasiliktan daha olasi OLMAYAN tum sonuclarin toplami.
 * @returns {number|null} p degeri
 */
function binomTwoSided (k, n, p) {
  if (!(n > 0) || !Number.isFinite(p) || p < 0 || p > 1) return null
  const gozlenen = binomPmf(k, n, p)
  const esik = gozlenen * (1 + 1e-9)
  let toplam = 0
  for (let i = 0; i <= n; i++) {
    const olasilik = binomPmf(i, n, p)
    if (olasilik <= esik) toplam += olasilik
  }
  return Math.min(1, toplam)
}

/**
 * Gunluk blok onyukleme ile ortalama icin %95 guven araligi.
 * Islemler gun icinde bagimli oldugu icin tek tek degil, GUN bloklari
 * halinde yeniden orneklenir.
 * @param {Array<{value:number, day:number}>} kayitlar
 * @param {{reps?:number, seed?:number}} [opts]
 * @returns {{lo:number, hi:number, mean:number}|null}
 */
function blockBootstrapMean (kayitlar, opts) {
  const o = opts || {}
  const reps = Number.isFinite(o.reps) ? o.reps : 1000
  const rnd = mulberry32(Number.isFinite(o.seed) ? o.seed : 12345)
  if (!Array.isArray(kayitlar) || kayitlar.length === 0) return null

  // Gunlere grupla.
  const gunler = new Map()
  let toplam = 0
  for (const kayit of kayitlar) {
    const g = kayit.day
    let dizi = gunler.get(g)
    if (!dizi) {
      dizi = []
      gunler.set(g, dizi)
    }
    dizi.push(kayit.value)
    toplam += kayit.value
  }
  const bloklar = Array.from(gunler.values())
  const ortalama = toplam / kayitlar.length
  if (bloklar.length < 2) return { lo: ortalama, hi: ortalama, mean: ortalama }

  const ortalamalar = new Float64Array(reps)
  for (let r = 0; r < reps; r++) {
    let s = 0
    let adet = 0
    for (let b = 0; b < bloklar.length; b++) {
      const blok = bloklar[(rnd() * bloklar.length) | 0]
      for (let i = 0; i < blok.length; i++) {
        s += blok[i]
        adet++
      }
    }
    ortalamalar[r] = adet > 0 ? s / adet : 0
  }
  const sirali = Array.from(ortalamalar).sort((a, b) => a - b)
  const alt = sirali[Math.floor(0.025 * (reps - 1))]
  const ust = sirali[Math.ceil(0.975 * (reps - 1))]
  return { lo: alt, hi: ust, mean: ortalama }
}

/**
 * Permutasyon testi: ayni havuzdan ayni SAYIDA rastgele secim yapildiginda
 * sistemin sonucuna ulasma olasiligi.
 * @param {number[]} havuz Tum uygun olaylarin degerleri (isabet 0/1 veya net)
 * @param {number} secilenAdet
 * @param {number} sistemOrtalamasi
 * @param {{reps?:number, seed?:number}} [opts]
 * @returns {number|null} P(rastgele >= sistem)
 */
function permutationP (havuz, secilenAdet, sistemOrtalamasi, opts) {
  const o = opts || {}
  const reps = Number.isFinite(o.reps) ? o.reps : 1000
  const rnd = mulberry32(Number.isFinite(o.seed) ? o.seed : 12345)
  const n = havuz.length
  if (!(n > 0) || !(secilenAdet > 0) || secilenAdet > n) return null

  let enAzKadarIyi = 0
  for (let r = 0; r < reps; r++) {
    // Ornekleme yerine koymadan (partial Fisher-Yates) yapilir.
    let s = 0
    const secilen = new Set()
    let alinan = 0
    while (alinan < secilenAdet) {
      const idx = (rnd() * n) | 0
      if (secilen.has(idx)) continue
      secilen.add(idx)
      s += havuz[idx]
      alinan++
    }
    if (s / secilenAdet >= sistemOrtalamasi - 1e-12) enAzKadarIyi++
  }
  return enAzKadarIyi / reps
}

/**
 * Kalibrasyon tablosu: tahmin edilen basari orani kovalara bolunur ve her
 * kovada GERCEKLESEN oran ile karsilastirilir. Iyi kalibre bir sistemde
 * ikisi birbirine yakindir.
 * @param {Array<{pred:number, win:boolean}>} kayitlar
 * @returns {Array<{from:number, to:number, n:number, predMean:number, actual:number}>}
 */
function calibration (kayitlar) {
  const kovalar = [
    [0, 0.4], [0.4, 0.5], [0.5, 0.55], [0.55, 0.6],
    [0.6, 0.7], [0.7, 0.8], [0.8, 1.0001],
  ]
  const sonuc = kovalar.map((k) => ({ from: k[0], to: k[1], n: 0, predToplam: 0, wins: 0 }))
  for (const kayit of kayitlar || []) {
    const p = Number(kayit.pred)
    if (!Number.isFinite(p)) continue
    for (let i = 0; i < kovalar.length; i++) {
      if (p >= kovalar[i][0] && p < kovalar[i][1]) {
        sonuc[i].n++
        sonuc[i].predToplam += p
        if (kayit.win) sonuc[i].wins++
        break
      }
    }
  }
  return sonuc.map((k) => ({
    from: k.from,
    to: k.to > 1 ? 1 : k.to,
    n: k.n,
    predMean: k.n > 0 ? k.predToplam / k.n : null,
    actual: k.n > 0 ? k.wins / k.n : null,
  }))
}

/**
 * Brier skoru: tahmin edilen olasilik ile gerceklesme arasindaki kare hata
 * ortalamasi. Kucuk daha iyidir; sabit taban tahminiyle karsilastirilir.
 * @param {Array<{pred:number, win:boolean}>} kayitlar
 * @param {number} [taban] Karsilastirma icin sabit tahmin
 * @returns {{model:number|null, base:number|null}}
 */
function brier (kayitlar, taban) {
  let toplam = 0
  let tabanToplam = 0
  let n = 0
  for (const kayit of kayitlar || []) {
    const p = Number(kayit.pred)
    if (!Number.isFinite(p)) continue
    const y = kayit.win ? 1 : 0
    toplam += (p - y) * (p - y)
    if (Number.isFinite(taban)) tabanToplam += (taban - y) * (taban - y)
    n++
  }
  return {
    model: n > 0 ? toplam / n : null,
    base: n > 0 && Number.isFinite(taban) ? tabanToplam / n : null,
  }
}

module.exports = {
  mulberry32,
  wilson,
  binomTwoSided,
  blockBootstrapMean,
  permutationP,
  calibration,
  brier,
}
