'use strict'

/**
 * TP SANSI MODELI: sinyalin sonucunu (TP mi SL mi) ongoren lojistik model.
 *
 * NEDEN. Guven yuzdesi once yayginlik siralamasiydi (TP ile iliskisiz),
 * sonra benzer kurulumlarin TP orani (zayif, r 0,08). Olculdu (5m 34 bin,
 * 15m 8,5 bin olay; egitim 2023 oncesi, test sonrasi): SL kutu kenarina
 * bagliyken mevcut baglam ozellikleri + birkac seri ozelligi + komsu orani,
 * birlikte, testte AUC 0,60 (5m) / 0,62 (15m) veriyor; en kotu %20 dilim
 * %20-24 TP, en iyi dilim %49-53. Komsu orani tek basina 0,56 / 0,55. Kapanistan
 * sabit ATR tanimiyla ise hicbir sey ayirt etmiyor (0,50).
 *
 * MODEL: gradyan artirmali kucuk agaclar (derinlik 2, 150 tur, hiz 0,1,
 * 16 kovali histogram bolmeleri). Olculdu (zaman ayrimli, 1m/5m/15m): agac
 * testte AUC 0,63 / 0,63 / 0,64, lojistik 0,56 / 0,57 / 0,57. Basa bas
 * esiginde (%50) agacla kalan sinyallerin TP orani %55-57, sinyal basina
 * +0,11 / +0,34 / +1,53 dolar; lojistikle 0 / +0,06 / +1,00. Derinlik 1-3,
 * 80-300 tur, hiz 0,05-0,2 hepsi 0,62-0,64: secim sagliksiz degil.
 * Kutuphane yok; 94 bin satirda (1m) egitim yarim dakika, 30 binde bes
 * saniye. 2000'den az etiketli satirda lojistik regresyona duser (L2 cezali,
 * standartlastirilmis). Tarama ve plan yenileme tum hafiza olaylari uzerinde
 * egitir (etiket = o anki TP/SL tanimiyla sonuc), canli sinyal kayitli modelle
 * (.guven.json) tahmin eder. Bilinmeyen ozellik (NaN) ayri bir kovaya duser
 * (agac) ya da ortalamaya esitlenir (lojistik).
 *
 * DURUST SINIR: bu bir kazanc makinesi degil. Kazanc kotu sinyalleri
 * elemekten ve modelin begendigi azinligi almaktan geliyor.
 */

const series = require('../series')
const { CTX_NAMES } = require('./features')

/** Baglam vektorune eklenen ozellikler (sira onemli: vektor konumu). */
const EK_ADLAR = [
  'risk_atr',          // girisin kutu UZAK kenari + 0,25 ATR'ye uzakligi / ATR (en guclu)
  'kutu_genislik_atr',
  'skor_orani',        // indikator skoru / azami
  'tur_olusum',        // 1 olusum, 0 dokunus
  'yon_al',            // 1 AL, 0 SAT
  'mum_govde',         // sinyal mumu govdesi, yon lehine, / ATR
  'yon_1saat',         // son 1 saatin hareketi, yon lehine, / ATR
  'yon_4saat',
  'yon_1gun',
  'gun_konum',         // son gunun araliginda konum (-0,5 dip .. +0,5 tepe), yon lehine
  'komsu_orani',       // en benzer 50 kurulumun agirlikli TP orani (0..1)
]
const OZELLIK_ADLARI = CTX_NAMES.concat(EK_ADLAR)
/** Bundan az etiketli satirla model kurulmaz (tahmin komsu oranina duser). */
const EN_AZ_SATIR = 200
/** Bundan az satirda agac yerine lojistik (agac az veride ezberler). */
const EN_AZ_SATIR_AGAC = 2000
/** Agac ayarlari. */
const AGAC = { derinlik: 2, tur: 150, hiz: 0.1, kova: 16, enAzHessian: 20 }
/** Kutu kenari payi (plan.js breakBufferAtr varsayilaniyla ayni). */
const KENAR_PAYI_ATR = 0.25

function sayi (v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * Ozellik vektoru. Bilinmeyen deger NaN kalir.
 *
 * @param {import('../series').Series|null} s Seri (seri ozellikleri icin; null olabilir)
 * @param {Object} e Olay ya da olay alanlarini tasiyan sinyal: features.ctx,
 *        price, atr, direction/isSupport, kind, zoneTop, zoneBottom, score,
 *        maxScore, time
 * @param {{komsuOrani?:number|null, tfSec?:number}} [ek]
 * @returns {Float64Array}
 */
function ozellikVektoru (s, e, ek) {
  const x = new Float64Array(OZELLIK_ADLARI.length)
  x.fill(NaN)
  if (!e) return x
  const ctx = e.features && e.features.ctx ? e.features.ctx : null
  if (ctx) {
    for (let i = 0; i < CTX_NAMES.length && i < ctx.length; i++) x[i] = sayi(ctx[i], NaN)
  }
  const atr = sayi(e.atr, NaN)
  const giris = sayi(e.price, NaN)
  const yukari = e.direction ? e.direction !== 'SELL' : !!e.isSupport
  let j = CTX_NAMES.length
  const uzak = sayi(yukari ? e.zoneBottom : e.zoneTop, NaN)
  x[j++] = atr > 0 && Number.isFinite(uzak) && Number.isFinite(giris)
    ? (yukari ? giris - (uzak - KENAR_PAYI_ATR * atr) : (uzak + KENAR_PAYI_ATR * atr) - giris) / atr
    : NaN
  x[j++] = atr > 0 && Number.isFinite(sayi(e.zoneTop, NaN)) && Number.isFinite(sayi(e.zoneBottom, NaN))
    ? Math.abs(sayi(e.zoneTop, 0) - sayi(e.zoneBottom, 0)) / atr
    : NaN
  x[j++] = sayi(e.maxScore, 0) > 0 ? sayi(e.score, 0) / sayi(e.maxScore, 1) : NaN
  x[j++] = e.kind === 'form' ? 1 : 0
  x[j++] = yukari ? 1 : 0
  const tfSec = sayi(ek && ek.tfSec, 0)
  if (s && s.length > 0 && atr > 0 && tfSec > 0) {
    const i = series.indexAtTime(s, sayi(e.time, -1))
    if (i >= 0) {
      const y1 = yukari ? 1 : -1
      const c0 = s.close[i]
      const barSaat = Math.max(1, Math.round(3600 / tfSec))
      const barGun = Math.max(1, Math.round(86400 / tfSec))
      x[j] = y1 * (c0 - s.open[i]) / atr
      if (i - barSaat >= 0) x[j + 1] = y1 * (c0 - s.close[i - barSaat]) / atr
      if (i - 4 * barSaat >= 0) x[j + 2] = y1 * (c0 - s.close[i - 4 * barSaat]) / atr
      if (i - barGun >= 0) {
        x[j + 3] = y1 * (c0 - s.close[i - barGun]) / atr
        let hi = -Infinity
        let lo = Infinity
        for (let k = i - barGun; k <= i; k++) {
          if (s.high[k] > hi) hi = s.high[k]
          if (s.low[k] < lo) lo = s.low[k]
        }
        x[j + 4] = hi > lo ? y1 * ((c0 - lo) / (hi - lo) - 0.5) : NaN
      }
    }
  }
  j += 5
  // null/undefined = bilinmiyor (sayi() null'u 0 yapardi, o "hic TP yok" olurdu).
  const ko = ek ? ek.komsuOrani : undefined
  x[j++] = ko === null || ko === undefined ? NaN : sayi(ko, NaN)
  return x
}

/**
 * Siralama tabanli AUC (baglar ortalama sira). 0,5 = bilgi yok.
 * @param {ArrayLike<number>} skor
 * @param {ArrayLike<number>} y 0/1
 */
function auc (skor, y) {
  const n = skor.length
  const idx = new Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  idx.sort((a, b) => skor[a] - skor[b])
  const rank = new Float64Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && skor[idx[j + 1]] === skor[idx[i]]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) rank[idx[k]] = r
    i = j + 1
  }
  let pos = 0
  let neg = 0
  let toplam = 0
  for (let k = 0; k < n; k++) {
    if (y[k] === 1) { pos++; toplam += rank[k] } else neg++
  }
  if (!pos || !neg) return 0.5
  return (toplam - pos * (pos + 1) / 2) / (pos * neg)
}

/**
 * Modeli egitir: yeterli satir varsa agac (artirma), yoksa lojistik.
 * @param {Float64Array[]} X Ozellik vektorleri (NaN olabilir)
 * @param {number[]} y 0/1
 * @param {{iter?:number, lr?:number, l2?:number, zorlaLojistik?:boolean}} [opts]
 * @returns {Object|null} Model (tur 'agac' ya da 'lojistik'); yeterli satir yoksa null
 */
function egit (X, y, opts) {
  const n = Array.isArray(X) ? X.length : 0
  if (n < EN_AZ_SATIR) return null
  const o = opts || {}
  if (n >= EN_AZ_SATIR_AGAC && !o.zorlaLojistik) return egitAgac(X, y)
  return egitLojistik(X, y, o)
}

/**
 * Gradyan artirmali agaclar (lojistik kayip, ikinci dereceden yaklasim).
 * Ozellikler egitim yuzdeliklerine gore AGAC.kova kovaya bolunur; NaN son
 * kovaya duser. Her agac: kok + iki cocuk (derinlik 2). Yaprak degeri
 * -G / (H + 1). Model JSON'a yazilir; tahmin ayni kova kenarlariyla yapilir.
 */
function egitAgac (X, y) {
  const n = X.length
  const d = OZELLIK_ADLARI.length
  const BIN = AGAC.kova
  // Kova kenarlari: her ozellik icin BIN-1 yuzdelik.
  const kenarlar = []
  for (let j = 0; j < d; j++) {
    const v = []
    for (let i = 0; i < n; i++) { const x = X[i][j]; if (Number.isFinite(x)) v.push(x) }
    v.sort((a, b) => a - b)
    const k = []
    for (let q = 1; q < BIN; q++) k.push(v.length ? v[Math.floor(v.length * q / BIN)] : 0)
    kenarlar.push(k)
  }
  const KX = new Array(n)
  for (let i = 0; i < n; i++) {
    const a = new Uint8Array(d)
    for (let j = 0; j < d; j++) a[j] = kovaNo(kenarlar[j], X[i][j], BIN)
    KX[i] = a
  }
  let pozitif = 0
  for (let i = 0; i < n; i++) pozitif += y[i]
  const taban = Math.log((pozitif + 1) / (n - pozitif + 1))
  const F = new Float64Array(n).fill(taban)
  const g = new Float64Array(n)
  const h = new Float64Array(n)
  const sg = new Float64Array(BIN + 1)
  const sh = new Float64Array(BIN + 1)
  const enIyiBolme = (idx) => {
    let best = null
    for (let j = 0; j < d; j++) {
      sg.fill(0); sh.fill(0)
      for (let t = 0; t < idx.length; t++) { const i = idx[t]; const b = KX[i][j]; sg[b] += g[i]; sh[b] += h[i] }
      let tg = 0; let th = 0
      for (let b = 0; b <= BIN; b++) { tg += sg[b]; th += sh[b] }
      let lg = 0; let lh = 0
      for (let b = 0; b < BIN; b++) {
        lg += sg[b]; lh += sh[b]
        const rg = tg - lg; const rh = th - lh
        if (lh < AGAC.enAzHessian || rh < AGAC.enAzHessian) continue
        const kazanc = lg * lg / (lh + 1) + rg * rg / (rh + 1) - tg * tg / (th + 1)
        if (!best || kazanc > best.kazanc) best = { j: j, b: b, kazanc: kazanc }
      }
    }
    return best
  }
  const yaprak = (idx) => { let a = 0; let c = 0; for (let t = 0; t < idx.length; t++) { a += g[idx[t]]; c += h[idx[t]] } return -a / (c + 1) }
  const bol = (idx, kalan) => {
    if (kalan <= 0) return { deger: yaprak(idx) }
    const s = enIyiBolme(idx)
    if (!s) return { deger: yaprak(idx) }
    const sol = []; const sag = []
    for (let t = 0; t < idx.length; t++) { const i = idx[t]; (KX[i][s.j] <= s.b ? sol : sag).push(i) }
    return { j: s.j, b: s.b, kazanc: s.kazanc, sol: bol(sol, kalan - 1), sag: bol(sag, kalan - 1) }
  }
  const agaclar = []
  const kok = new Array(n)
  for (let i = 0; i < n; i++) kok[i] = i
  for (let t = 0; t < AGAC.tur; t++) {
    for (let i = 0; i < n; i++) { const p = 1 / (1 + Math.exp(-F[i])); g[i] = p - y[i]; h[i] = p * (1 - p) }
    const agac = bol(kok, AGAC.derinlik)
    if (agac.deger !== undefined) break
    for (let i = 0; i < n; i++) F[i] += AGAC.hiz * agacDegeri(agac, KX[i])
    agaclar.push(agac)
  }
  const model = {
    tur: 'agac',
    adlar: OZELLIK_ADLARI.slice(),
    kova: BIN,
    kenarlar: kenarlar,
    taban: taban,
    hiz: AGAC.hiz,
    agaclar: agaclar,
    n: n,
    tabanOran: pozitif / n,
    auc: 0.5,
  }
  const p = new Float64Array(n)
  for (let i = 0; i < n; i++) p[i] = tahmin(model, X[i])
  model.auc = Math.round(auc(p, y) * 1000) / 1000
  return model
}

/** Degerin kovasi: kenarlari gecen ilk kova; NaN son (BIN) kova. */
function kovaNo (kenar, v, BIN) {
  if (!Number.isFinite(v)) return BIN
  let b = 0
  while (b < kenar.length && v > kenar[b]) b++
  return b
}

/** Bir agacin kovalanmis satir icin degeri. */
function agacDegeri (node, kx) {
  while (node.deger === undefined) node = kx[node.j] <= node.b ? node.sol : node.sag
  return node.deger
}

/**
 * Lojistik regresyon (az veride yedek).
 * @returns {{tur:string, adlar:string[], mu:number[], sd:number[], w:number[], b:number,
 *            n:number, taban:number, auc:number}}
 */
function egitLojistik (X, y, opts) {
  const n = X.length
  const d = OZELLIK_ADLARI.length
  const o = opts || {}
  const iter = Math.max(1, Math.round(sayi(o.iter, 300)))
  const lr = sayi(o.lr, 0.5)
  const l2 = sayi(o.l2, 0.01)
  // Ortalama ve sapma (NaN'lar disarida).
  const mu = new Float64Array(d)
  const sd = new Float64Array(d)
  for (let j = 0; j < d; j++) {
    let t = 0
    let k = 0
    for (let i = 0; i < n; i++) { const v = X[i][j]; if (Number.isFinite(v)) { t += v; k++ } }
    const m = k > 0 ? t / k : 0
    let v2 = 0
    for (let i = 0; i < n; i++) { const v = X[i][j]; if (Number.isFinite(v)) v2 += (v - m) * (v - m) }
    mu[j] = m
    sd[j] = k > 1 && v2 > 0 ? Math.sqrt(v2 / k) : 1
  }
  const Z = new Array(n)
  for (let i = 0; i < n; i++) {
    const z = new Float64Array(d)
    for (let j = 0; j < d; j++) { const v = X[i][j]; z[j] = Number.isFinite(v) ? (v - mu[j]) / sd[j] : 0 }
    Z[i] = z
  }
  const w = new Float64Array(d)
  const g = new Float64Array(d)
  let b = 0
  for (let it = 0; it < iter; it++) {
    g.fill(0)
    let gb = 0
    for (let i = 0; i < n; i++) {
      const z = Z[i]
      let t = b
      for (let j = 0; j < d; j++) t += w[j] * z[j]
      const p = 1 / (1 + Math.exp(-t))
      const e = p - y[i]
      for (let j = 0; j < d; j++) g[j] += e * z[j]
      gb += e
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j])
    b -= lr * gb / n
  }
  const model = {
    tur: 'lojistik',
    adlar: OZELLIK_ADLARI.slice(),
    mu: Array.from(mu),
    sd: Array.from(sd),
    w: Array.from(w),
    b: b,
    n: n,
    taban: y.reduce((t, v) => t + v, 0) / n,
    tabanOran: y.reduce((t, v) => t + v, 0) / n,
    auc: 0.5,
  }
  const p = new Float64Array(n)
  for (let i = 0; i < n; i++) p[i] = tahmin(model, X[i])
  model.auc = Math.round(auc(p, y) * 1000) / 1000
  return model
}

/**
 * Tahmin: TP olasiligi (0..1). Model yoksa ya da bozuksa NaN.
 * @param {Object|null} model 'agac' ya da 'lojistik'
 * @param {ArrayLike<number>} x
 */
function tahmin (model, x) {
  if (!model) return NaN
  if (model.tur === 'agac') {
    if (!Array.isArray(model.agaclar) || !Array.isArray(model.kenarlar)) return NaN
    const d = model.kenarlar.length
    if (!x || x.length < d) return NaN
    const BIN = model.kova || AGAC.kova
    const kx = new Uint8Array(d)
    for (let j = 0; j < d; j++) kx[j] = kovaNo(model.kenarlar[j], x[j], BIN)
    let f = sayi(model.taban, 0)
    const hiz = sayi(model.hiz, AGAC.hiz)
    for (let t = 0; t < model.agaclar.length; t++) f += hiz * agacDegeri(model.agaclar[t], kx)
    return 1 / (1 + Math.exp(-f))
  }
  if (!Array.isArray(model.w) || !Array.isArray(model.mu) || !Array.isArray(model.sd)) return NaN
  const d = model.w.length
  if (!x || x.length < d) return NaN
  let t = sayi(model.b, 0)
  for (let j = 0; j < d; j++) {
    const v = x[j]
    const z = Number.isFinite(v) ? (v - model.mu[j]) / (model.sd[j] || 1) : 0
    t += model.w[j] * z
  }
  return 1 / (1 + Math.exp(-t))
}

/**
 * Ozelliklerin etkisi, buyukten kucuge (aciklama icin). Agacta bolme
 * kazanclarinin toplami, lojistikte katsayi.
 */
function etkiler (model) {
  if (!model) return []
  if (model.tur === 'agac' && Array.isArray(model.agaclar)) {
    const toplam = new Float64Array(model.adlar.length)
    const gez = (node) => { if (!node || node.deger !== undefined) return; toplam[node.j] += sayi(node.kazanc, 0); gez(node.sol); gez(node.sag) }
    for (let t = 0; t < model.agaclar.length; t++) gez(model.agaclar[t])
    const enCok = Math.max(1e-9, Math.max.apply(null, Array.from(toplam)))
    return model.adlar.map((ad, j) => ({ ad: ad, w: Math.round(100 * toplam[j] / enCok) / 100 }))
      .sort((a, b) => b.w - a.w)
  }
  if (!Array.isArray(model.w)) return []
  return model.adlar.map((ad, j) => ({ ad: ad, w: model.w[j] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
}

module.exports = {
  OZELLIK_ADLARI,
  EK_ADLAR,
  EN_AZ_SATIR,
  EN_AZ_SATIR_AGAC,
  AGAC,
  KENAR_PAYI_ATR,
  ozellikVektoru,
  auc,
  egit,
  tahmin,
  etkiler,
}
