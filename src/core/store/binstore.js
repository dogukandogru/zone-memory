'use strict'

// Mum serilerinin ikili dosya deposu.
// CONTRACTS.md bolum 5'teki bayt duzeni birebir uygulanir (little endian):
//
//   offset 0   : 8 bayt  ascii magic 'ZMEM0001'
//   offset 8   : uint32  surum = 1
//   offset 12  : uint32  rezerve = 0
//   offset 16  : float64 count
//   offset 24  : count * float64  time
//   ...        : count * float64  open, high, low, close, volume (bu sirayla)
//
// Buyuk dosyalarda (yuz megabaytlar) tek parca tampon ayirmamak icin
// okuma ve yazma parca parca yapilir.
//
// KUYRUK DOSYASI (`<ad>.tail.bin`) NEDEN VAR.
// 1m deposu 6 milyon bara yaklasinca dosya 293 MB oluyor ve tek bir bar
// eklemek bile TUM dosyayi yeniden yazdiriyordu: canli dongu her yeni barda
// 293 MB okuyup 293 MB yaziyordu. Artik ana dosyanin son barindan YENI olan
// barlar, satir sirali kucuk bir kuyruk dosyasina eklenir (bar basina 48
// bayt); okuma ana dosya ile kuyrugu birlestirir. Kuyruk 5000 bara ulasinca
// ya da gelen barlar ana dosyanin icine dusunce tam yazim yapilir ve kuyruk
// silinir.

const fs = require('fs')
const path = require('path')
const series = require('../series')

const MAGIC = 'ZMEM0001'
const VERSION = 1
const HEADER_BYTES = 24
const COLUMN_COUNT = 6
const BYTES_PER_VALUE = 8
/** Tek seferde islenecek azami bayt (4 MB). */
const CHUNK_BYTES = 4 * 1024 * 1024
/** Kuyruk dosyasinin uzantisi. */
const TAIL_SUFFIX = '.tail.bin'
/** Kuyrukta bar basina bayt: satir sirali 6 sutun. */
const TAIL_BYTES_PER_BAR = COLUMN_COUNT * BYTES_PER_VALUE
/** Kuyruk bu bar sayisina ulastiginda ana dosyaya sikistirilir. */
const TAIL_MAX_BARS = 5000
/** Okuma dogrulamasinin baktigi bas/son bar sayisi. */
const VERIFY_EDGE_BARS = 1000

// Hedef platformlar little endian; degilse bayt takasi yapilir.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/** Float64Array'in bir parcasi icin yazilabilir Buffer gorunumu uretir. */
function chunkView(arr, byteOffset, byteLength) {
  const view = Buffer.from(arr.buffer, arr.byteOffset + byteOffset, byteLength)
  if (LITTLE_ENDIAN) return view
  const copy = Buffer.from(view)
  copy.swap64()
  return copy
}

/** Dosyanin bulundugu klasoru olusturur. */
async function ensureDir(filePath) {
  const dir = path.dirname(filePath)
  if (dir && dir !== '.') await fs.promises.mkdir(dir, { recursive: true })
}

/** Ana dosyanin kuyruk dosyasi yolu. */
function tailPathOf(filePath) {
  return filePath + TAIL_SUFFIX
}

// DOSYA YOLU BAZLI SIRA (async mutex).
//
// Iki yazar ayni anda gelebiliyor: canli dongu bar eklerken kullanici "Veri
// Cek" diyor, ya da ust zaman dilimleri yeniden kuruluyor. Gecici dosya adi
// sabit `.tmp` oldugu icin ikisi ayni dosyaya yaziyor, ilk rename'den sonra
// ikincisi yarim tamponu ana dosyanin uzerine tasiyordu. Simdi ayni yol icin
// yazimlar sirayla kosar ve gecici ad surece ozgudur.
const kilitler = new Map()

/**
 * Verilen dosya yolu icin isi siraya alir.
 * @param {string} filePath
 * @param {function():Promise<any>} fn
 * @returns {Promise<any>}
 */
function kilitle(filePath, fn) {
  const onceki = kilitler.get(filePath) || Promise.resolve()
  const is = onceki.then(function () {
    return fn()
  })
  // Siradaki isler onceki hatadan etkilenmesin diye bekleyen surum hatayi yutar.
  const bekleyen = is.then(
    function () {},
    function () {}
  )
  kilitler.set(filePath, bekleyen)
  bekleyen.then(function () {
    if (kilitler.get(filePath) === bekleyen) kilitler.delete(filePath)
  })
  return is
}

/** Surece ve cagriya ozgu gecici dosya adi. */
function tmpPathOf(filePath) {
  const rastgele = Math.random().toString(36).slice(2, 10)
  return filePath + '.' + process.pid + '.' + rastgele + '.tmp'
}

/**
 * rename sonrasi klasor girdisini diske isler; boylece cokme sonrasi dosya
 * adi da kalici olur. Windows'ta klasor acilamaz, hata yutulur.
 */
async function syncDir(filePath) {
  const dir = path.dirname(filePath)
  let handle
  try {
    handle = await fs.promises.open(dir, 'r')
  } catch (err) {
    return
  }
  try {
    await handle.sync()
  } catch (err) {
    // Windows ve bazi dosya sistemleri klasor fsync'ini desteklemez.
  } finally {
    await handle.close().catch(function () {})
  }
}

/** Tam yazim garantisi ile parca yazar, yeni konumu dondurur. */
async function writeColumn(handle, arr, position) {
  const total = arr.length * BYTES_PER_VALUE
  let done = 0
  while (done < total) {
    const len = total - done < CHUNK_BYTES ? total - done : CHUNK_BYTES
    const buf = chunkView(arr, done, len)
    let written = 0
    while (written < len) {
      const res = await handle.write(buf, written, len - written, position + done + written)
      if (res.bytesWritten <= 0) throw new Error('binstore: dosyaya yazilamadi')
      written += res.bytesWritten
    }
    done += len
  }
  return position + total
}

/**
 * Tam okuma garantisi ile bir sutunu Float64Array'e doldurur.
 * `extra` verilirse dizi o kadar FAZLA yer ile ayrilir ama yalnizca `count`
 * deger okunur: kuyruk barlari ikinci bir 293 MB'lik kopya alinmadan bu bos
 * kapasiteye eklenir.
 */
async function readColumn(handle, count, position, extra) {
  const ek = extra > 0 ? extra | 0 : 0
  const arr = new Float64Array(count + ek)
  const total = count * BYTES_PER_VALUE
  if (total === 0) return arr
  const buf = Buffer.from(arr.buffer, arr.byteOffset, total)
  let done = 0
  while (done < total) {
    const len = total - done < CHUNK_BYTES ? total - done : CHUNK_BYTES
    let got = 0
    while (got < len) {
      const res = await handle.read(buf, done + got, len - got, position + done + got)
      if (res.bytesRead <= 0) throw new Error('binstore: dosya beklenenden kisa, veri okunamadi')
      got += res.bytesRead
    }
    done += len
  }
  if (!LITTLE_ENDIAN) buf.swap64()
  return arr
}

/** Basligi cozer ve dogrular. */
function parseHeader(buf, filePath) {
  if (buf.length < HEADER_BYTES) {
    throw new Error('binstore: baslik eksik, gecersiz dosya: ' + filePath)
  }
  const magic = buf.toString('ascii', 0, 8)
  if (magic !== MAGIC) {
    throw new Error(
      'binstore: dosya imzasi uyusmuyor (beklenen ' + MAGIC + ', bulunan ' + JSON.stringify(magic) + '): ' + filePath
    )
  }
  const version = buf.readUInt32LE(8)
  if (version !== VERSION) {
    throw new Error('binstore: desteklenmeyen surum ' + version + ': ' + filePath)
  }
  const countRaw = buf.readDoubleLE(16)
  if (!Number.isFinite(countRaw) || countRaw < 0 || Math.floor(countRaw) !== countRaw) {
    throw new Error('binstore: bar sayisi gecersiz: ' + filePath)
  }
  return { version: version, count: countRaw }
}

/** Baslik tamponu uretir. */
function buildHeader(count) {
  const buf = Buffer.alloc(HEADER_BYTES)
  buf.write(MAGIC, 0, 8, 'ascii')
  buf.writeUInt32LE(VERSION, 8)
  buf.writeUInt32LE(0, 12)
  buf.writeDoubleLE(count, 16)
  return buf
}

/**
 * Basligi okur ve dosya boyutunun bildirilen bar sayisiyla BIREBIR uyustugunu
 * dogrular.
 *
 * Neden tam esitlik: eskiden yalnizca "beklenenden kisa" hali yakalaniyordu.
 * Yarim kalmis bir yazimdan arta kalan FAZLA baytlar sessizce gormezden
 * gelinince, bozuk dosya saglam gibi okunuyor ve hata ancak indikator
 * sonucunda ortaya cikiyordu.
 */
async function basligiOku(handle, filePath) {
  const head = Buffer.alloc(HEADER_BYTES)
  let got = 0
  while (got < HEADER_BYTES) {
    const res = await handle.read(head, got, HEADER_BYTES - got, got)
    if (res.bytesRead <= 0) break
    got += res.bytesRead
  }
  if (got < HEADER_BYTES) {
    throw new Error('binstore: baslik eksik, gecersiz dosya: ' + filePath)
  }
  const info = parseHeader(head, filePath)
  const stat = await handle.stat()
  const expected = HEADER_BYTES + info.count * COLUMN_COUNT * BYTES_PER_VALUE
  if (stat.size !== expected) {
    const yon = stat.size < expected ? 'kisa' : 'uzun'
    throw new Error(
      'binstore: dosya boyutu beklenenden ' + yon + ' (' + stat.size + ' != ' + expected + '): ' + filePath
    )
  }
  return info
}

/** Verilen aralikta zamanin sonlu ve kesin artan oldugunu dogrular. */
function araliktaZamanDogrula(time, from, to, filePath) {
  let prev = -Infinity
  for (let i = from; i < to; i++) {
    const t = time[i]
    if (!Number.isFinite(t)) {
      throw new Error('binstore: bar zamani sonlu degil (indeks ' + i + '): ' + filePath)
    }
    if (t <= prev) {
      throw new Error('binstore: bar zamanlari artan degil (indeks ' + i + '): ' + filePath)
    }
    prev = t
  }
}

/**
 * Ilk ve son 1000 barda zamanin sonlu ve artan oldugunu dogrular.
 *
 * Neden yalnizca uclar: 6 milyon barin tamamini taramak her okumaya sabit bir
 * maliyet ekler, oysa gorulen bozulmalar dosyanin BASINDA (yanlis baslik ya
 * da yanlis konumdan yazilmis ilk blok) veya SONUNDA (yarim kalmis yazim,
 * sikistirma sirasinda cokme) cikiyor.
 */
function zamanlariDogrula(time, count, filePath) {
  if (count <= 0) return
  const uc = VERIFY_EDGE_BARS < count ? VERIFY_EDGE_BARS : count
  araliktaZamanDogrula(time, 0, uc, filePath)
  // Son ucta, bastaki araligi ikinci kez taramamak icin uc barindan sonrasi.
  const bas = count - uc > uc ? count - uc : uc
  if (bas < count) araliktaZamanDogrula(time, bas, count, filePath)
}

/**
 * Seriyi dosyaya yazar. Once surece ozgu bir gecici dosyaya yazilir, sonra
 * rename edilir; boylece yarim kalmis yazim mevcut dosyayi bozmaz. Kuyruk
 * dosyasi silinir: barlarin tamami artik ana dosyadadir.
 * Kilit ALMAZ; cagiran sirada olmalidir.
 */
async function yazTemel(filePath, s) {
  if (!s) throw new Error('binstore: yazilacak seri yok')
  const count = s.length | 0
  if (
    s.time.length < count ||
    s.open.length < count ||
    s.high.length < count ||
    s.low.length < count ||
    s.close.length < count ||
    s.volume.length < count
  ) {
    throw new Error('binstore: seri sutunlari length degerinden kisa')
  }
  await ensureDir(filePath)
  const tmpPath = tmpPathOf(filePath)
  const handle = await fs.promises.open(tmpPath, 'w')
  try {
    const header = buildHeader(count)
    let written = 0
    while (written < HEADER_BYTES) {
      const res = await handle.write(header, written, HEADER_BYTES - written, written)
      if (res.bytesWritten <= 0) throw new Error('binstore: baslik yazilamadi')
      written += res.bytesWritten
    }
    let pos = HEADER_BYTES
    pos = await writeColumn(handle, s.time.subarray(0, count), pos)
    pos = await writeColumn(handle, s.open.subarray(0, count), pos)
    pos = await writeColumn(handle, s.high.subarray(0, count), pos)
    pos = await writeColumn(handle, s.low.subarray(0, count), pos)
    pos = await writeColumn(handle, s.close.subarray(0, count), pos)
    pos = await writeColumn(handle, s.volume.subarray(0, count), pos)
    await handle.sync().catch(function () {})
    await handle.close()
    await fs.promises.rename(tmpPath, filePath)
    await syncDir(filePath)
    // Kuyruk ANA DOSYADAN SONRA silinir: arada cokme olursa kuyruk barlari
    // ana dosyada zaten var, ayni zaman damgalari okumada tekillestirilir.
    await fs.promises.unlink(tailPathOf(filePath)).catch(function () {})
    return { count: count, bytes: pos }
  } catch (err) {
    await handle.close().catch(function () {})
    await fs.promises.unlink(tmpPath).catch(function () {})
    throw err
  }
}

/**
 * Seriyi dosyaya yazar (atomik). Ayni yola yazan diger islerle sirayla kosar.
 * @param {string} filePath
 * @param {import('../series').Series} s
 * @returns {Promise<{count:number, bytes:number}>}
 */
function writeSeries(filePath, s) {
  return kilitle(filePath, function () {
    return yazTemel(filePath, s)
  })
}

/**
 * Ana dosyayi (kuyruk HARIC) okur.
 * @param {string} filePath
 * @param {number} [extra] Sutunlarda ayrilacak fazla kapasite (bar sayisi)
 * @returns {Promise<import('../series').Series|null>} Dosya yoksa null
 */
async function anaOku(filePath, extra) {
  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  try {
    const info = await basligiOku(handle, filePath)
    const count = info.count
    let pos = HEADER_BYTES
    const time = await readColumn(handle, count, pos, extra)
    zamanlariDogrula(time, count, filePath)
    pos += count * BYTES_PER_VALUE
    const open = await readColumn(handle, count, pos, extra)
    pos += count * BYTES_PER_VALUE
    const high = await readColumn(handle, count, pos, extra)
    pos += count * BYTES_PER_VALUE
    const low = await readColumn(handle, count, pos, extra)
    pos += count * BYTES_PER_VALUE
    const close = await readColumn(handle, count, pos, extra)
    pos += count * BYTES_PER_VALUE
    const volume = await readColumn(handle, count, pos, extra)
    return {
      length: count,
      time: time,
      open: open,
      high: high,
      low: low,
      close: close,
      volume: volume,
    }
  } finally {
    await handle.close().catch(function () {})
  }
}

/**
 * Ana dosyanin ozeti (kuyruk HARIC).
 * @returns {Promise<{count:number, firstTime:number, lastTime:number}|null>}
 */
async function anaDurum(filePath) {
  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  try {
    const info = await basligiOku(handle, filePath)
    const count = info.count
    if (count === 0) return { count: 0, firstTime: 0, lastTime: 0 }
    // IKI AYRI TAMPON. Tek tampon iki okumada kullanilinca kisa okuma
    // (bytesRead < 8) sessizce ONCEKI degeri geri veriyordu: bozuk dosyada
    // lastTime = firstTime cikiyor, yukleyici de bosluk gormedigi icin
    // eksik veriyi tamam sayiyordu.
    const ilkBuf = Buffer.alloc(BYTES_PER_VALUE)
    const sonBuf = Buffer.alloc(BYTES_PER_VALUE)
    const r1 = await handle.read(ilkBuf, 0, BYTES_PER_VALUE, HEADER_BYTES)
    const r2 = await handle.read(sonBuf, 0, BYTES_PER_VALUE, HEADER_BYTES + (count - 1) * BYTES_PER_VALUE)
    if (r1.bytesRead !== BYTES_PER_VALUE || r2.bytesRead !== BYTES_PER_VALUE) {
      throw new Error('binstore: ilk/son bar zamani okunamadi: ' + filePath)
    }
    const firstTime = ilkBuf.readDoubleLE(0)
    const lastTime = sonBuf.readDoubleLE(0)
    if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime < firstTime) {
      throw new Error('binstore: ilk/son bar zamani gecersiz: ' + filePath)
    }
    return { count: count, firstTime: firstTime, lastTime: lastTime }
  } finally {
    await handle.close().catch(function () {})
  }
}

/**
 * Kuyruk dosyasini okur. Satir sirali duzen: bar basina
 * [time, open, high, low, close, volume], 6 x float64 = 48 bayt.
 * Sonuc zaman sirali ve tekildir (ayni zaman damgasinda SON yazilan kazanir:
 * canli barin guncellenmesi boyle calisir).
 * @param {string} filePath Ana dosya yolu
 * @returns {Promise<import('../series').Series|null>} Kuyruk yoksa null
 */
async function kuyrukOku(filePath) {
  let buf
  try {
    buf = await fs.promises.readFile(tailPathOf(filePath))
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  // Kuyruk tasarim geregi kucuk (en cok 5000 bar = 240 KB), tek parca okunur.
  // Yarim kalmis SON kayit (yazim sirasinda cokme) atilir: o barlar
  // saglayicidan yeniden cekilebilir, okumayi tumden reddetmek depoyu
  // kullanilamaz hale getirirdi.
  const n = Math.floor(buf.length / TAIL_BYTES_PER_BAR)
  if (n <= 0) return null
  const out = series.createSeries(n)
  for (let i = 0; i < n; i++) {
    const o = i * TAIL_BYTES_PER_BAR
    out.time[i] = buf.readDoubleLE(o)
    out.open[i] = buf.readDoubleLE(o + 8)
    out.high[i] = buf.readDoubleLE(o + 16)
    out.low[i] = buf.readDoubleLE(o + 24)
    out.close[i] = buf.readDoubleLE(o + 32)
    out.volume[i] = buf.readDoubleLE(o + 40)
  }
  const temiz = series.sanitize(out)
  return temiz.length > 0 ? temiz : null
}

/**
 * Kuyruk dosyasindaki HAM kayit sayisi (tekillestirmeden once).
 *
 * Sinir tekil bar sayisina degil dosyaya bakar: ayni bar tekrar tekrar
 * eklenirse tekil sayi sabit kalir ama dosya buyur, ve her okuma o dosyayi
 * bastan cozmek zorunda kalir.
 */
async function kuyrukSatirSayisi(filePath) {
  try {
    const st = await fs.promises.stat(tailPathOf(filePath))
    return Math.floor(st.size / TAIL_BYTES_PER_BAR)
  } catch (err) {
    if (err && err.code === 'ENOENT') return 0
    throw err
  }
}

/** Kuyruk barlarini dosyanin sonuna ekler. */
async function kuyrugaYaz(filePath, s) {
  const n = s.length | 0
  if (n <= 0) return 0
  const buf = Buffer.alloc(n * TAIL_BYTES_PER_BAR)
  for (let i = 0; i < n; i++) {
    const o = i * TAIL_BYTES_PER_BAR
    buf.writeDoubleLE(s.time[i], o)
    buf.writeDoubleLE(s.open[i], o + 8)
    buf.writeDoubleLE(s.high[i], o + 16)
    buf.writeDoubleLE(s.low[i], o + 24)
    buf.writeDoubleLE(s.close[i], o + 32)
    buf.writeDoubleLE(s.volume[i], o + 40)
  }
  const tailPath = tailPathOf(filePath)
  await ensureDir(tailPath)
  const handle = await fs.promises.open(tailPath, 'a')
  try {
    let written = 0
    while (written < buf.length) {
      const res = await handle.write(buf, written, buf.length - written)
      if (res.bytesWritten <= 0) throw new Error('binstore: kuyruk dosyasina yazilamadi')
      written += res.bytesWritten
    }
    // Kuyruk kucuk oldugu icin her ekte diske islenir: canli bar cokmede
    // kaybolursa saglayici onu bir daha vermeyebilir.
    await handle.sync().catch(function () {})
  } finally {
    await handle.close().catch(function () {})
  }
  return n
}

/**
 * Kuyrugun ana dosyaya EKLEDIGI bar sayisi.
 *
 * appendSeries kurali geregi kuyruktaki zamanlar ana dosyanin son barindan
 * yenidir, dolayisiyla hepsi yeni bardir. Elle onarilmis bir dosyada ana
 * dosyayla cakisan zaman varsa o mevcut barin uzerine yazar, sayiyi
 * buyutmez.
 */
function kuyrukYeniSayisi(tail, anaSayi, anaSon) {
  if (!tail || tail.length === 0) return 0
  if (anaSayi === 0) return tail.length
  let yeni = 0
  for (let i = 0; i < tail.length; i++) {
    if (tail.time[i] > anaSon) yeni++
  }
  return yeni
}

/** Kuyruk barlarini ana serinin BOS KAPASITESINE kopyalar. */
function kapasiteyeEkle(main, tail) {
  const n = main.length
  const m = tail.length
  main.time.set(tail.time.subarray(0, m), n)
  main.open.set(tail.open.subarray(0, m), n)
  main.high.set(tail.high.subarray(0, m), n)
  main.low.set(tail.low.subarray(0, m), n)
  main.close.set(tail.close.subarray(0, m), n)
  main.volume.set(tail.volume.subarray(0, m), n)
  main.length = n + m
  return main
}

/**
 * Dosyadan seri okur: ana dosya ile kuyruk birlestirilir, ayni zaman
 * damgasinda KUYRUK kazanir.
 * @param {string} filePath
 * @returns {Promise<import('../series').Series|null>} Dosya yoksa null
 */
async function readSeries(filePath) {
  // Kuyruk ANA DOSYADAN ONCE okunur. Ters sirada, arada sikistirma calisirsa
  // (ana dosya henuz eski, kuyruk artik silinmis) o barlar tumden kaybolurdu.
  // Bu sirada en kotu durum ayni barin iki kez gorulmesidir, o da
  // birlestirmede tekillestirilir.
  const tail = await kuyrukOku(filePath)
  const tailLen = tail ? tail.length : 0
  const main = await anaOku(filePath, tailLen)
  // ANA DOSYA YOKSA KUYRUK DA YOK SAYILIR. Kuyruk yalnizca ana dosya varken
  // yazilir, yazim da rename ile yapilir; yani cokme ana dosyayi ortadan
  // kaldiramaz. Ana dosyasi olmayan bir kuyruk kullanicinin .bin dosyasini
  // elle silmesinden kalmis artiktir. Onu geri vermek, silinmis bir depoyu
  // bir kac barla canliymis gibi gosterir ve 1m'den turetilen tam seriyi
  // golgeler. Ilk tam yazimda bu artik silinir.
  if (!main) return null
  if (tailLen === 0) return main
  if (main.length === 0 || tail.time[0] > main.time[main.length - 1]) {
    // Normal durum: kuyruk ana dosyanin sonundan yeni. Ayrilan fazla
    // kapasiteye kopyalanir, 293 MB'lik ikinci bir birlestirme kopyasi
    // alinmaz.
    return kapasiteyeEkle(main, tail)
  }
  // Cakisma (elle onarilmis dosya): tam birlestirme, esitlikte kuyruk kazanir.
  return series.concatSeries(series.sliceSeries(main, 0, main.length), tail)
}

/**
 * Mevcut dosyaya yeni barlari ekler. Zamana gore tekillestirir,
 * ayni zaman damgasinda YENI veri kazanir.
 *
 * Gelen barlarin hepsi ana dosyanin son barindan yeniyse ve kuyruk sinirini
 * asmiyorsa yalnizca kuyruga yazilir: 293 MB'lik ana dosya hic okunmaz ve
 * hic yazilmaz. Aksi halde ana dosya + kuyruk + gelen barlar birlestirilip
 * tam yazilir, kuyruk silinir.
 * @param {string} filePath
 * @param {import('../series').Series} s
 * @returns {Promise<{added:number, total:number}>} added = net eklenen bar sayisi
 */
function appendSeries(filePath, s) {
  const incoming = series.sanitize(s || series.emptySeries())
  return kilitle(filePath, async function () {
    const tail = await kuyrukOku(filePath)
    const tailLen = tail ? tail.length : 0
    const durum = await anaDurum(filePath)
    const anaSayi = durum ? durum.count : 0
    const anaSon = anaSayi > 0 ? durum.lastTime : -Infinity
    const gorunen = anaSayi + kuyrukYeniSayisi(tail, anaSayi, anaSon)

    // Eklenecek bar yoksa dosyaya DOKUNULMAZ. Eskiden bos ekleme de tam
    // yazim yapiyordu: canli dongude her bos tik 293 MB yaziyordu.
    if (incoming.length === 0) return { added: 0, total: gorunen }

    const hamSatir = await kuyrukSatirSayisi(filePath)
    const hizli =
      durum !== null && incoming.time[0] > anaSon && hamSatir + incoming.length <= TAIL_MAX_BARS
    if (hizli) {
      await kuyrugaYaz(filePath, incoming)
      const birlesik = tailLen > 0 ? series.sanitize(series.concatSeries(tail, incoming)) : incoming
      const toplam = anaSayi + kuyrukYeniSayisi(birlesik, anaSayi, anaSon)
      return { added: toplam - gorunen, total: toplam }
    }

    const main = await anaOku(filePath, tailLen)
    let taban = main
    // Ana dosya yoksa kuyruk artigi kullanilmaz (bkz. readSeries); yazim
    // sirasinda silinir.
    if (tailLen > 0 && main) {
      if (main.length === 0 || tail.time[0] > main.time[main.length - 1]) {
        taban = kapasiteyeEkle(main, tail)
      } else {
        taban = series.sanitize(series.concatSeries(series.sliceSeries(main, 0, main.length), tail))
      }
    }
    const merged = taban ? series.sanitize(series.concatSeries(taban, incoming)) : incoming
    const before = taban ? taban.length : 0
    await yazTemel(filePath, merged)
    return { added: merged.length - before, total: merged.length }
  })
}

/**
 * Kuyruktaki barlari ana dosyaya isler ve kuyrugu siler.
 *
 * Neden ayri fonksiyon: kuyruk buyudukce her okuma onu ana dosyanin ustune
 * birlestirmek zorunda kalir. Cagiran (canli dongu, tarama oncesi ya da
 * kapanis) uygun bir anda bunu isteyerek ana dosyayi tek parca tutar.
 * @param {string} filePath
 * @returns {Promise<{compacted:number, total:number}>} compacted = islenen kuyruk bari
 */
function compactTail(filePath) {
  return kilitle(filePath, async function () {
    const tail = await kuyrukOku(filePath)
    const tailLen = tail ? tail.length : 0
    if (tailLen === 0) {
      // Kuyruk yoksa yapilacak is yok; ana dosya yeniden YAZILMAZ.
      await fs.promises.unlink(tailPathOf(filePath)).catch(function () {})
      const durum = await anaDurum(filePath)
      return { compacted: 0, total: durum ? durum.count : 0 }
    }
    const main = await anaOku(filePath, tailLen)
    if (!main) {
      // Ana dosyasi olmayan kuyruk artiktir (bkz. readSeries): yeni bir depo
      // uretmek yerine silinir.
      await fs.promises.unlink(tailPathOf(filePath)).catch(function () {})
      return { compacted: 0, total: 0 }
    }
    let merged
    if (main.length === 0 || tail.time[0] > main.time[main.length - 1]) {
      merged = kapasiteyeEkle(main, tail)
    } else {
      merged = series.sanitize(series.concatSeries(series.sliceSeries(main, 0, main.length), tail))
    }
    await yazTemel(filePath, merged)
    return { compacted: tailLen, total: merged.length }
  })
}

/**
 * Dosya hakkinda ozet bilgi: ana dosya ile kuyruk birlikte sayilir.
 * @param {string} filePath
 * @returns {Promise<{count:number, firstTime:number, lastTime:number}|null>} Dosya yoksa null
 */
async function statSeries(filePath) {
  // Okuma sirasi readSeries ile ayni nedenle kuyruktan baslar.
  const tail = await kuyrukOku(filePath)
  const tailLen = tail ? tail.length : 0
  const durum = await anaDurum(filePath)
  // Ana dosya yoksa depo yok sayilir; kuyruk artigi kullanilmaz (bkz. readSeries).
  if (!durum) return null
  if (tailLen === 0) return durum
  const yeni = kuyrukYeniSayisi(tail, durum.count, durum.lastTime)
  const kuyrukSon = tail.time[tailLen - 1]
  return {
    count: durum.count + yeni,
    firstTime: durum.count > 0 ? durum.firstTime : tail.time[0],
    lastTime: durum.count === 0 || kuyrukSon > durum.lastTime ? kuyrukSon : durum.lastTime,
  }
}

module.exports = {
  MAGIC,
  TAIL_SUFFIX,
  TAIL_MAX_BARS,
  writeSeries,
  readSeries,
  appendSeries,
  compactTail,
  statSeries,
}
