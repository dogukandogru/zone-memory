'use strict'

/**
 * Teknik analiz temel fonksiyonlari (CONTRACTS.md bolum 7).
 *
 * Tum fonksiyonlar Float64Array alir ve Float64Array dondurur. Isinma (warmup)
 * bolgeleri NaN ile doldurulur, 0 ile DEGIL.
 *
 * Sayisal davranis referansi:
 *   ../indicator2/backend/app/services/indicator/master_touch.py
 *   (_pine_ema, _pine_rma, _pine_atr, _pivot_high, _pivot_low)
 *
 * Onemli Pine uyumluluk notlari:
 *  - ema ve rma, out[len-1] konumunda ILK len degerin duz ortalamasi (SMA) ile
 *    tohumlanir; oncesi NaN'dir. Bu tohumlama indikatorun sonucunu dogrudan
 *    etkiledigi icin degistirilemez.
 *  - trueRange ilk barda high - low degerini verir (onceki kapanis yoktur).
 *    Bu, pandas'in NaN atlayan max davranisiyla ve Pine'in ta.tr tanimiyla aynidir.
 *  - rsi, Pine'in ta.rsi tanimidir: degisim serisi 1. bardan baslar, bu yuzden
 *    ilk gecerli RSI degeri len indeksinde olusur.
 *  - Pencereli fonksiyonlarda pencere icinde tek bir NaN varsa sonuc NaN olur
 *    (pandas'in min_periods=len davranisi ile ayni).
 */

// Kayan toplam kullanan pencereli fonksiyonlarda birikimli yuvarlama hatasini
// sinirlamak icin bu bar araliginda toplam sifirdan yeniden hesaplanir.
const RESYNC_MASK = 4095

/** Girdiyi kopyalamadan Float64Array'e cevirir. */
function toF64 (src) {
  if (src instanceof Float64Array) return src
  return Float64Array.from(src)
}

/** n uzunlugunda NaN dolu dizi. */
function nanArray (n) {
  const out = new Float64Array(n)
  out.fill(NaN)
  return out
}

/**
 * Basit hareketli ortalama. Pencere [i-len+1 .. i].
 * Pencerede NaN varsa sonuc NaN olur.
 * @param {Float64Array} src
 * @param {number} len
 * @returns {Float64Array}
 */
function sma (src, len) {
  const a = toF64(src)
  const n = a.length
  const out = nanArray(n)
  const L = len | 0
  if (L < 1 || n < L) return out

  let sum = 0
  let nanCount = 0
  for (let i = 0; i < n; i++) {
    if (i >= L) {
      const old = a[i - L]
      if (old !== old) nanCount--
      else sum -= old
    }
    const v = a[i]
    if (v !== v) nanCount++
    else sum += v

    if (i >= L - 1) {
      if ((i & RESYNC_MASK) === 0) {
        // Kayan toplami tazele: uzun serilerde hata birikmesin.
        sum = 0
        nanCount = 0
        for (let j = i - L + 1; j <= i; j++) {
          const x = a[j]
          if (x !== x) nanCount++
          else sum += x
        }
      }
      out[i] = nanCount > 0 ? NaN : sum / L
    }
  }
  return out
}

/**
 * Pine ta.ema: out[len-1] = ilk len degerin ortalamasi, sonrasi
 * alpha = 2/(len+1) ile ustel yumusatma.
 * @param {Float64Array} src
 * @param {number} len
 * @returns {Float64Array}
 */
function ema (src, len) {
  const a = toF64(src)
  const n = a.length
  const out = nanArray(n)
  const L = len | 0
  if (L < 1 || n < L) return out

  let seed = 0
  for (let i = 0; i < L; i++) seed += a[i]
  const alpha = 2 / (L + 1)
  const beta = 1 - alpha
  let prev = seed / L
  out[L - 1] = prev
  for (let i = L; i < n; i++) {
    prev = alpha * a[i] + beta * prev
    out[i] = prev
  }
  return out
}

/**
 * Pine ta.rma (Wilder): out[len-1] = ilk len degerin ortalamasi, sonrasi
 * alpha = 1/len ile yumusatma.
 * @param {Float64Array} src
 * @param {number} len
 * @returns {Float64Array}
 */
function rma (src, len) {
  const a = toF64(src)
  const n = a.length
  const out = nanArray(n)
  const L = len | 0
  if (L < 1 || n < L) return out

  let seed = 0
  for (let i = 0; i < L; i++) seed += a[i]
  const alpha = 1 / L
  const beta = 1 - alpha
  let prev = seed / L
  out[L - 1] = prev
  for (let i = L; i < n; i++) {
    prev = alpha * a[i] + beta * prev
    out[i] = prev
  }
  return out
}

/**
 * Gercek aralik (true range). Ilk bar icin high - low.
 * @param {Float64Array} high
 * @param {Float64Array} low
 * @param {Float64Array} close
 * @returns {Float64Array}
 */
function trueRange (high, low, close) {
  const h = toF64(high)
  const l = toF64(low)
  const c = toF64(close)
  const n = h.length
  const out = new Float64Array(n)
  if (n === 0) return out

  out[0] = h[0] - l[0]
  for (let i = 1; i < n; i++) {
    const pc = c[i - 1]
    let m = h[i] - l[i]
    // pc NaN ise asagidaki karsilastirmalar false doner ve m = high - low kalir.
    const b = Math.abs(h[i] - pc)
    if (b > m) m = b
    const d = Math.abs(l[i] - pc)
    if (d > m) m = d
    out[i] = m
  }
  return out
}

/**
 * Pine ta.atr: rma(trueRange, len).
 * @returns {Float64Array}
 */
function atr (high, low, close, len) {
  return rma(trueRange(high, low, close), len)
}

/**
 * Pine ta.rsi. up = max(diff, 0), down = max(-diff, 0),
 * rsi = 100 - 100/(1 + rma(up,len)/rma(down,len)).
 * rma(down) = 0 ise 100, rma(up) = 0 ise 0.
 * Degisim serisi 1. bardan basladigi icin ilk gecerli deger len indeksindedir.
 * @param {Float64Array} src
 * @param {number} len
 * @returns {Float64Array}
 */
function rsi (src, len) {
  const a = toF64(src)
  const n = a.length
  const out = nanArray(n)
  const L = len | 0
  if (L < 1 || n < L + 1) return out

  const m = n - 1
  const up = new Float64Array(m)
  const dn = new Float64Array(m)
  for (let i = 1; i < n; i++) {
    const d = a[i] - a[i - 1]
    const j = i - 1
    if (d !== d) {
      up[j] = NaN
      dn[j] = NaN
    } else if (d > 0) {
      up[j] = d
      dn[j] = 0
    } else if (d < 0) {
      up[j] = 0
      dn[j] = -d
    } else {
      up[j] = 0
      dn[j] = 0
    }
  }

  const ru = rma(up, L)
  const rd = rma(dn, L)
  for (let j = L - 1; j < m; j++) {
    const u = ru[j]
    const w = rd[j]
    let v
    if (u !== u || w !== w) v = NaN
    else if (w === 0) v = 100
    else if (u === 0) v = 0
    else v = 100 - 100 / (1 + u / w)
    out[j + 1] = v
  }
  return out
}

/**
 * Monotonik ikili kuyruk ile O(n) pencereli uc deger.
 * @param {Float64Array} src
 * @param {number} len
 * @param {boolean} wantMax true ise azami, false ise asgari
 * @returns {Float64Array}
 */
function rollingExtreme (src, len, wantMax) {
  const a = toF64(src)
  const n = a.length
  const out = nanArray(n)
  const L = len | 0
  if (L < 1 || n < L) return out

  // Kuyrukta ayni anda en fazla L indeks bulunur, halka tampon yeterlidir.
  const dq = new Int32Array(L)
  let head = 0
  let tail = 0
  let nanCount = 0

  for (let i = 0; i < n; i++) {
    const start = i - L + 1
    if (i >= L) {
      const old = a[i - L]
      if (old !== old) nanCount--
    }
    // Once pencereden cikan indeksleri at, sonra ekle: boylece kuyruk hicbir
    // zaman L ogeyi asmaz ve halka tampon tasmaz.
    while (tail > head && dq[head % L] < start) head++

    const v = a[i]
    if (v !== v) {
      nanCount++
    } else {
      // Yeni deger, arkada kalan daha zayif adaylari gecersiz kilar.
      if (wantMax) {
        while (tail > head && a[dq[(tail - 1) % L]] <= v) tail--
      } else {
        while (tail > head && a[dq[(tail - 1) % L]] >= v) tail--
      }
      dq[tail % L] = i
      tail++
    }

    if (start >= 0 && nanCount === 0 && tail > head) out[i] = a[dq[head % L]]
  }
  return out
}

/**
 * Pencere [i-len+1 .. i] icindeki azami deger. Pencerede NaN varsa NaN.
 * @returns {Float64Array}
 */
function rollingMax (src, len) {
  return rollingExtreme(src, len, true)
}

/**
 * Pencere [i-len+1 .. i] icindeki asgari deger. Pencerede NaN varsa NaN.
 * @returns {Float64Array}
 */
function rollingMin (src, len) {
  return rollingExtreme(src, len, false)
}

/**
 * Pencereli ortalama, sma ile ayni hesaptir.
 * @returns {Float64Array}
 */
function rollingMean (src, len) {
  return sma(src, len)
}

/**
 * Pencereli standart sapma (Pine ta.stdev gibi anakutle sapmasi, len'e bolunur).
 * Pencerede NaN varsa sonuc NaN.
 * @param {Float64Array} src
 * @param {number} len
 * @returns {Float64Array}
 */
function stdev (src, len) {
  const a = toF64(src)
  const n = a.length
  const out = nanArray(n)
  const L = len | 0
  if (L < 1 || n < L) return out

  let sum = 0
  let sumSq = 0
  let nanCount = 0
  for (let i = 0; i < n; i++) {
    if (i >= L) {
      const old = a[i - L]
      if (old !== old) {
        nanCount--
      } else {
        sum -= old
        sumSq -= old * old
      }
    }
    const v = a[i]
    if (v !== v) {
      nanCount++
    } else {
      sum += v
      sumSq += v * v
    }

    if (i >= L - 1) {
      if ((i & RESYNC_MASK) === 0) {
        sum = 0
        sumSq = 0
        nanCount = 0
        for (let j = i - L + 1; j <= i; j++) {
          const x = a[j]
          if (x !== x) nanCount++
          else {
            sum += x
            sumSq += x * x
          }
        }
      }
      if (nanCount === 0) {
        const mean = sum / L
        let variance = sumSq / L - mean * mean
        if (!(variance > 0)) variance = 0
        out[i] = Math.sqrt(variance)
      }
    }
  }
  return out
}

/**
 * Pine ta.pivothigh. Merkez bar c olmak uzere
 * high[c] > max(high[c-left..c-1]) VE high[c] > max(high[c+1..c+right]) ise
 * deger c+right indeksine yazilir. Esitlikte pivot YOKTUR.
 * @param {Float64Array} high
 * @param {number} left
 * @param {number} right
 * @returns {Float64Array}
 */
function pivotHigh (high, left, right) {
  const h = toF64(high)
  const n = h.length
  const out = nanArray(n)
  const l = left | 0
  const r = right | 0
  if (l < 0 || r < 0) return out

  for (let c = l; c < n - r; c++) {
    const v = h[c]
    if (v !== v) continue
    let ok = true
    for (let j = c - l; j < c; j++) {
      // NaN karsilastirmasi false doner, o zaman da pivot yoktur.
      if (!(v > h[j])) { ok = false; break }
    }
    if (!ok) continue
    const end = c + r
    for (let j = c + 1; j <= end; j++) {
      if (!(v > h[j])) { ok = false; break }
    }
    if (ok) out[end] = v
  }
  return out
}

/**
 * Pine ta.pivotlow. pivotHigh'in simetrigidir, kesin kucukluk aranir.
 * @param {Float64Array} low
 * @param {number} left
 * @param {number} right
 * @returns {Float64Array}
 */
function pivotLow (low, left, right) {
  const lo = toF64(low)
  const n = lo.length
  const out = nanArray(n)
  const l = left | 0
  const r = right | 0
  if (l < 0 || r < 0) return out

  for (let c = l; c < n - r; c++) {
    const v = lo[c]
    if (v !== v) continue
    let ok = true
    for (let j = c - l; j < c; j++) {
      if (!(v < lo[j])) { ok = false; break }
    }
    if (!ok) continue
    const end = c + r
    for (let j = c + 1; j <= end; j++) {
      if (!(v < lo[j])) { ok = false; break }
    }
    if (ok) out[end] = v
  }
  return out
}

/**
 * Seriyi n bar geriye kaydirir: out[i] = src[i-n]. Bas kisim NaN olur.
 * Negatif n ileri kaydirir, o zaman son kisim NaN olur.
 * @param {Float64Array} src
 * @param {number} n
 * @returns {Float64Array}
 */
function shift (src, n) {
  const a = toF64(src)
  const len = a.length
  const out = nanArray(len)
  const k = n | 0
  const from = Math.max(0, k)
  const to = Math.min(len, len + k)
  for (let i = from; i < to; i++) out[i] = a[i - k]
  return out
}

/**
 * Degeri [lo, hi] araligina kirpar. NaN girdi NaN doner.
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp (x, lo, hi) {
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

module.exports = {
  sma,
  ema,
  rma,
  trueRange,
  atr,
  rsi,
  rollingMax,
  rollingMin,
  rollingMean,
  stdev,
  pivotHigh,
  pivotLow,
  shift,
  clamp,
}
