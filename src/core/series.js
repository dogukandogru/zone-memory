'use strict'

// Sutunsal mum serisi islemleri.
// CONTRACTS.md bolum 1 ve 4 ile birebir uyumludur.
// Tum sayisal diziler Float64Array'dir; seri buyuk olabilecegi icin
// (6 milyon bar hedefi) gereksiz kopyalamadan kacinilir.

/**
 * @typedef {Object} Series
 * @property {number} length
 * @property {Float64Array} time
 * @property {Float64Array} open
 * @property {Float64Array} high
 * @property {Float64Array} low
 * @property {Float64Array} close
 * @property {Float64Array} volume
 */

/**
 * n uzunlugunda bos seri olusturur.
 * @param {number} n
 * @returns {Series}
 */
function createSeries(n) {
  const len = n > 0 ? n | 0 : 0
  return {
    length: len,
    time: new Float64Array(len),
    open: new Float64Array(len),
    high: new Float64Array(len),
    low: new Float64Array(len),
    close: new Float64Array(len),
    volume: new Float64Array(len),
  }
}

/**
 * Uzunlugu 0 olan seri.
 * @returns {Series}
 */
function emptySeries() {
  return createSeries(0)
}

/**
 * [from, to) araligini kopyalamadan dondurur; subarray kullanir.
 * @param {Series} s
 * @param {number} [from]
 * @param {number} [to]
 * @returns {Series}
 */
function sliceSeries(s, from, to) {
  const n = s.length
  let a = from === undefined || from === null ? 0 : Math.trunc(from)
  let b = to === undefined || to === null ? n : Math.trunc(to)
  if (a < 0) a += n
  if (b < 0) b += n
  if (a < 0) a = 0
  if (a > n) a = n
  if (b < a) b = a
  if (b > n) b = n
  return {
    length: b - a,
    time: s.time.subarray(a, b),
    open: s.open.subarray(a, b),
    high: s.high.subarray(a, b),
    low: s.low.subarray(a, b),
    close: s.close.subarray(a, b),
    volume: s.volume.subarray(a, b),
  }
}

/** Tek satiri src[i] konumundan dst[j] konumuna tasir. */
function copyRow(dst, j, src, i) {
  dst.time[j] = src.time[i]
  dst.open[j] = src.open[i]
  dst.high[j] = src.high[i]
  dst.low[j] = src.low[i]
  dst.close[j] = src.close[i]
  dst.volume[j] = src.volume[i]
}

/** Kapasitesi fazla olan seriyi m uzunluguna kirpar. */
function trimSeries(s, m) {
  if (m === s.length) return s
  return {
    length: m,
    time: s.time.slice(0, m),
    open: s.open.slice(0, m),
    high: s.high.slice(0, m),
    low: s.low.slice(0, m),
    close: s.close.slice(0, m),
    volume: s.volume.slice(0, m),
  }
}

/**
 * Iki seriyi zaman sirali birlestirir. Iki seri de artan sirali varsayilir.
 * Ayni zaman damgasinda b kazanir.
 * @param {Series} a
 * @param {Series} b
 * @returns {Series}
 */
function concatSeries(a, b) {
  const na = a ? a.length : 0
  const nb = b ? b.length : 0
  if (na === 0 && nb === 0) return emptySeries()
  if (nb === 0) return a
  if (na === 0) return b

  const out = createSeries(na + nb)
  const at = a.time
  const bt = b.time
  let i = 0
  let j = 0
  let m = 0
  while (i < na && j < nb) {
    const ta = at[i]
    const tb = bt[j]
    if (ta < tb) {
      copyRow(out, m, a, i)
      i++
    } else if (tb < ta) {
      copyRow(out, m, b, j)
      j++
    } else {
      // Esitlikte yeni veri (b) kazanir.
      copyRow(out, m, b, j)
      i++
      j++
    }
    m++
  }
  while (i < na) {
    copyRow(out, m, a, i)
    i++
    m++
  }
  while (j < nb) {
    copyRow(out, m, b, j)
    j++
    m++
  }
  return trimSeries(out, m)
}

/** Normal diziyi Float64Array'e cevirir, eksik degerleri fill ile doldurur. */
function toF64(src, n, fill) {
  if (src instanceof Float64Array && src.length === n) return src
  const out = new Float64Array(n)
  if (!src) {
    if (fill !== 0) out.fill(fill)
    return out
  }
  const lim = src.length < n ? src.length : n
  for (let i = 0; i < lim; i++) out[i] = +src[i]
  for (let i = lim; i < n; i++) out[i] = fill
  return out
}

/**
 * Normal dizilerden (veya tipli dizilerden) Series kurar.
 * volume verilmezse 0 kabul edilir.
 * @param {{time:ArrayLike<number>, open:ArrayLike<number>, high:ArrayLike<number>,
 *          low:ArrayLike<number>, close:ArrayLike<number>, volume?:ArrayLike<number>}} obj
 * @returns {Series}
 */
function fromArrays(obj) {
  if (!obj || !obj.time) return emptySeries()
  const n = obj.time.length | 0
  return {
    length: n,
    time: toF64(obj.time, n, NaN),
    open: toF64(obj.open, n, NaN),
    high: toF64(obj.high, n, NaN),
    low: toF64(obj.low, n, NaN),
    close: toF64(obj.close, n, NaN),
    volume: toF64(obj.volume, n, 0),
  }
}

/**
 * Grafik icin nesne dizisi uretir.
 * @param {Series} s
 * @param {number} [from]
 * @param {number} [to]
 * @returns {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>}
 */
function toBars(s, from, to) {
  const n = s.length
  let a = from === undefined || from === null ? 0 : Math.trunc(from)
  let b = to === undefined || to === null ? n : Math.trunc(to)
  if (a < 0) a = 0
  if (a > n) a = n
  if (b < a) b = a
  if (b > n) b = n
  const st = s.time
  const so = s.open
  const sh = s.high
  const sl = s.low
  const sc = s.close
  const sv = s.volume
  const out = new Array(b - a)
  for (let i = a; i < b; i++) {
    out[i - a] = {
      time: st[i],
      open: so[i],
      high: sh[i],
      low: sl[i],
      close: sc[i],
      volume: sv[i],
    }
  }
  return out
}

/**
 * Tam eslesen zamanin indeksi, ikili arama.
 * @param {Series} s
 * @param {number} t
 * @returns {number} Eslesme yoksa -1
 */
function indexAtTime(s, t) {
  const a = s.time
  let lo = 0
  let hi = s.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = a[mid]
    if (v < t) lo = mid + 1
    else if (v > t) hi = mid - 1
    else return mid
  }
  return -1
}

/**
 * time[i] <= t olan en buyuk indeks.
 * @param {Series} s
 * @param {number} t
 * @returns {number} Yoksa -1
 */
function lastIndexAtOrBefore(s, t) {
  const a = s.time
  let lo = 0
  let hi = s.length - 1
  let res = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] <= t) {
      res = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return res
}

/**
 * time[i] >= t olan en kucuk indeks.
 * @param {Series} s
 * @param {number} t
 * @returns {number} Yoksa -1
 */
function firstIndexAtOrAfter(s, t) {
  const a = s.time
  let lo = 0
  let hi = s.length - 1
  let res = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (a[mid] >= t) {
      res = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return res
}

/**
 * Buyuyen tamponlar icin kapasite artirimi: kapasiteyi iki katina cikarir,
 * yetmezse dogrudan `need` degerine ceker. Yeniden ornekleme kovalari ve
 * aktarim betikleri ayni yardimciyi kullanir.
 * @param {Float64Array} arr
 * @param {number} need En az bu kadar yer olmali
 * @returns {Float64Array}
 */
function growF64(arr, need) {
  let cap = arr.length * 2
  if (cap < need) cap = need
  const out = new Float64Array(cap)
  out.set(arr)
  return out
}

/**
 * Kapasiteli seriye YERINDE ekleme yapar.
 *
 * Neden var: canli dongu her yeni barda `concatSeries` cagiriyordu, bu da 6
 * milyon barlik seride bar basina 6 sutunluk tam kopya (~293 MB) demekti.
 * Yerinde ekleme kapasite yettigi surece hic kopya almaz; kapasite dolunca
 * `growF64` diziyi iki katina cikarir, yani ekleme amortize edilmis O(1)
 * olur.
 *
 * `dst` DEGISTIRILIR ve geri dondurulur. Sutunlari `length` degerinden uzun
 * olabilir; gecerli bar sayisi her zaman `length` alanidir.
 *
 * `src` zaman sirali varsayilir. Son bardan ESKI gelen satir yerinde
 * eklemeyle cozulemeyecegi icin ATLANIR; son barla AYNI zamanli satir mevcut
 * barin uzerine yazar (canli barin guncellenmesi). Sonlu olmayan zaman ya da
 * OHLC iceren satir `sanitize` ile ayni mantikla atilir, sonlu olmayan hacim
 * 0 yazilir.
 *
 * @param {Series|null} dst Kapasiteli hedef seri (yoksa yenisi kurulur)
 * @param {Series} src Eklenecek barlar
 * @returns {Series} dst
 */
function appendInPlace(dst, src) {
  const add = src ? src.length | 0 : 0
  const hedef = dst || createSeries(0)
  if (add === 0) return hedef
  let n = hedef.length | 0
  const need = n + add
  // Sutunlar ayri ayri denetlenir: kapasiteleri farkli olabilir.
  if (hedef.time.length < need) hedef.time = growF64(hedef.time, need)
  if (hedef.open.length < need) hedef.open = growF64(hedef.open, need)
  if (hedef.high.length < need) hedef.high = growF64(hedef.high, need)
  if (hedef.low.length < need) hedef.low = growF64(hedef.low, need)
  if (hedef.close.length < need) hedef.close = growF64(hedef.close, need)
  if (hedef.volume.length < need) hedef.volume = growF64(hedef.volume, need)

  const dt = hedef.time
  const dopen = hedef.open
  const dhigh = hedef.high
  const dlow = hedef.low
  const dclose = hedef.close
  const dvol = hedef.volume
  const st = src.time
  const so = src.open
  const sh = src.high
  const sl = src.low
  const sc = src.close
  const sv = src.volume

  for (let i = 0; i < add; i++) {
    const t = st[i]
    if (!Number.isFinite(t)) continue
    if (!Number.isFinite(so[i]) || !Number.isFinite(sh[i]) || !Number.isFinite(sl[i]) || !Number.isFinite(sc[i])) {
      continue
    }
    if (n > 0) {
      const son = dt[n - 1]
      if (t < son) continue
      if (t === son) n--
    }
    dt[n] = t
    dopen[n] = so[i]
    dhigh[n] = sh[i]
    dlow[n] = sl[i]
    dclose[n] = sc[i]
    const v = sv[i]
    dvol[n] = Number.isFinite(v) ? v : 0
    n++
  }
  hedef.length = n
  return hedef
}

/**
 * Ust zaman dilimine yeniden ornekler. Kova baslangici
 * Math.floor(time / toTfSec) * toTfSec olarak hizalanir.
 * Bos kovalar URETILMEZ. Tek gecisli calisir, tamponlar gerektikce buyur.
 * @param {Series} s
 * @param {number} toTfSec
 * @returns {Series}
 */
function resample(s, toTfSec) {
  if (!(toTfSec > 0)) throw new Error('resample: hedef zaman dilimi pozitif olmali')
  const n = s.length
  if (n === 0) return emptySeries()

  const st = s.time
  const so = s.open
  const sh = s.high
  const sl = s.low
  const sc = s.close
  const sv = s.volume

  // Kapasite tahmini: toplam zaman araligi / hedef zaman dilimi.
  let cap = 16
  if (n > 1) {
    const span = st[n - 1] - st[0]
    if (Number.isFinite(span) && span > 0) {
      const est = Math.ceil(span / toTfSec) + 2
      cap = est < 16 ? 16 : est > n ? n : est
    } else {
      cap = n
    }
  }

  let time = new Float64Array(cap)
  let open = new Float64Array(cap)
  let high = new Float64Array(cap)
  let low = new Float64Array(cap)
  let close = new Float64Array(cap)
  let volume = new Float64Array(cap)

  let m = 0
  let curStart = NaN

  for (let i = 0; i < n; i++) {
    const t = st[i]
    if (!Number.isFinite(t)) continue
    const bucket = Math.floor(t / toTfSec) * toTfSec
    if (bucket !== curStart) {
      if (m === time.length) {
        const need = m + 1
        time = growF64(time, need)
        open = growF64(open, need)
        high = growF64(high, need)
        low = growF64(low, need)
        close = growF64(close, need)
        volume = growF64(volume, need)
      }
      curStart = bucket
      time[m] = bucket
      open[m] = so[i]
      high[m] = sh[i]
      low[m] = sl[i]
      close[m] = sc[i]
      const v0 = sv[i]
      volume[m] = v0 === v0 ? v0 : 0
      m++
    } else {
      const j = m - 1
      const hi = sh[i]
      const lo = sl[i]
      if (hi > high[j]) high[j] = hi
      if (lo < low[j]) low[j] = lo
      close[j] = sc[i]
      const v = sv[i]
      if (v === v) volume[j] += v
    }
  }

  const out = {
    length: m,
    time: time,
    open: open,
    high: high,
    low: low,
    close: close,
    volume: volume,
  }
  return trimSeries(out, m)
}

/**
 * Zaman sirali, tekrarsiz ve NaN'siz seri dondurur.
 * Zaman/open/high/low/close sonlu degilse satir atilir; volume sonlu degilse 0 yazilir.
 * Ayni zaman damgasindan birden fazla varsa SONUNCUSU kazanir.
 * Seri zaten temizse ayni nesne geri verilir (kopyalama yok).
 * @param {Series} s
 * @returns {Series}
 */
function sanitize(s) {
  const n = s ? s.length : 0
  if (n === 0) return emptySeries()

  const st = s.time
  const so = s.open
  const sh = s.high
  const sl = s.low
  const sc = s.close
  const sv = s.volume

  // Hizli yol: zaten kesin artan ve sonlu ise dokunma.
  let clean = true
  let prev = -Infinity
  for (let i = 0; i < n; i++) {
    const t = st[i]
    if (!Number.isFinite(t) || t <= prev) {
      clean = false
      break
    }
    if (
      !Number.isFinite(so[i]) ||
      !Number.isFinite(sh[i]) ||
      !Number.isFinite(sl[i]) ||
      !Number.isFinite(sc[i]) ||
      !Number.isFinite(sv[i])
    ) {
      clean = false
      break
    }
    prev = t
  }
  if (clean) return s

  // Yavas yol: gecerli satirlarin indeksleri toplanir.
  const idx = new Int32Array(n)
  let k = 0
  for (let i = 0; i < n; i++) {
    if (
      Number.isFinite(st[i]) &&
      Number.isFinite(so[i]) &&
      Number.isFinite(sh[i]) &&
      Number.isFinite(sl[i]) &&
      Number.isFinite(sc[i])
    ) {
      idx[k++] = i
    }
  }
  if (k === 0) return emptySeries()

  const order = idx.subarray(0, k)
  // Zamana gore artan; esitlikte orijinal sira korunur (kararli davranis).
  let sorted = true
  for (let i = 1; i < k; i++) {
    if (st[order[i - 1]] > st[order[i]]) {
      sorted = false
      break
    }
  }
  if (!sorted) {
    order.sort(function (x, y) {
      const d = st[x] - st[y]
      if (d !== 0) return d < 0 ? -1 : 1
      return x - y
    })
  }

  const out = createSeries(k)
  let m = 0
  for (let i = 0; i < k; i++) {
    const src = order[i]
    const t = st[src]
    // Ayni zaman damgasi tekrar ediyorsa sonuncusunu birak.
    if (i + 1 < k && st[order[i + 1]] === t) continue
    out.time[m] = t
    out.open[m] = so[src]
    out.high[m] = sh[src]
    out.low[m] = sl[src]
    out.close[m] = sc[src]
    const v = sv[src]
    out.volume[m] = Number.isFinite(v) ? v : 0
    m++
  }
  return trimSeries(out, m)
}

/**
 * Kapanmis barlarin bitis indeksini dondurur: [0, sonuc) araligindaki barlar
 * `refTime` anina gore KAPANMISTIR.
 *
 * Neden ayri fonksiyon: canli dongu bu kontrolu isciye mesaj islendigi ana
 * gore yapiyordu. Isci uzun bir isle mesgulken (1m geriye test 53-60 sn)
 * cekim aninda acik olan bar kapanmis sayilip yarim OHLCV ile depoya
 * yaziliyordu ve sonraki cekimler ayni zaman damgasini atladigi icin bu
 * kalici oluyordu. Olcut her zaman cekim anidir.
 *
 * @param {Float64Array|number[]} times Bar acilis zamanlari (UNIX saniye)
 * @param {number} tfSec Bar suresi (saniye)
 * @param {number} refTime Cekim ani (UNIX saniye)
 * @param {number} [length] Bakilacak uzunluk (varsayilan times.length)
 * @returns {number} 0 ile length arasinda
 */
function closedEndIndex(times, tfSec, refTime, length) {
  const n = Number.isFinite(length) ? Math.min(length, times.length) : times.length
  if (!(tfSec > 0) || !Number.isFinite(refTime)) return n
  let son = n
  while (son > 0 && times[son - 1] + tfSec > refTime) son--
  return son
}

module.exports = {
  createSeries,
  emptySeries,
  closedEndIndex,
  sliceSeries,
  concatSeries,
  fromArrays,
  toBars,
  indexAtTime,
  lastIndexAtOrBefore,
  firstIndexAtOrAfter,
  growF64,
  appendInPlace,
  resample,
  sanitize,
}
