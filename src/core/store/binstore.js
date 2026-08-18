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

/** Tam okuma garantisi ile bir sutunu Float64Array'e doldurur. */
async function readColumn(handle, count, position) {
  const arr = new Float64Array(count)
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
 * Seriyi dosyaya yazar. Once .tmp dosyasina yazilir, sonra rename edilir;
 * boylece yarim kalmis yazim mevcut dosyayi bozmaz.
 * @param {string} filePath
 * @param {import('../series').Series} s
 * @returns {Promise<{count:number, bytes:number}>}
 */
async function writeSeries(filePath, s) {
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
  const tmpPath = filePath + '.tmp'
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
    return { count: count, bytes: pos }
  } catch (err) {
    await handle.close().catch(function () {})
    await fs.promises.unlink(tmpPath).catch(function () {})
    throw err
  }
}

/**
 * Dosyadan seri okur.
 * @param {string} filePath
 * @returns {Promise<import('../series').Series|null>} Dosya yoksa null
 */
async function readSeries(filePath) {
  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  try {
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
    const count = info.count
    const stat = await handle.stat()
    const expected = HEADER_BYTES + count * COLUMN_COUNT * BYTES_PER_VALUE
    if (stat.size < expected) {
      throw new Error(
        'binstore: dosya beklenenden kisa (' + stat.size + ' < ' + expected + '): ' + filePath
      )
    }
    let pos = HEADER_BYTES
    const time = await readColumn(handle, count, pos)
    pos += count * BYTES_PER_VALUE
    const open = await readColumn(handle, count, pos)
    pos += count * BYTES_PER_VALUE
    const high = await readColumn(handle, count, pos)
    pos += count * BYTES_PER_VALUE
    const low = await readColumn(handle, count, pos)
    pos += count * BYTES_PER_VALUE
    const close = await readColumn(handle, count, pos)
    pos += count * BYTES_PER_VALUE
    const volume = await readColumn(handle, count, pos)
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
 * Mevcut dosyaya yeni barlari ekler. Zamana gore tekillestirir,
 * ayni zaman damgasinda YENI veri kazanir.
 * @param {string} filePath
 * @param {import('../series').Series} s
 * @returns {Promise<{added:number, total:number}>} added = net eklenen bar sayisi
 */
async function appendSeries(filePath, s) {
  const incoming = series.sanitize(s || series.emptySeries())
  const existing = await readSeries(filePath)
  const before = existing ? existing.length : 0
  const merged = existing ? series.sanitize(series.concatSeries(existing, incoming)) : incoming
  await writeSeries(filePath, merged)
  return { added: merged.length - before, total: merged.length }
}

/**
 * Dosya hakkinda ozet bilgi.
 * @param {string} filePath
 * @returns {Promise<{count:number, firstTime:number, lastTime:number}|null>} Dosya yoksa null
 */
async function statSeries(filePath) {
  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  try {
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
    const count = info.count
    if (count === 0) return { count: 0, firstTime: 0, lastTime: 0 }
    const edge = Buffer.alloc(8)
    await handle.read(edge, 0, 8, HEADER_BYTES)
    const firstTime = edge.readDoubleLE(0)
    await handle.read(edge, 0, 8, HEADER_BYTES + (count - 1) * BYTES_PER_VALUE)
    const lastTime = edge.readDoubleLE(0)
    return { count: count, firstTime: firstTime, lastTime: lastTime }
  } finally {
    await handle.close().catch(function () {})
  }
}

module.exports = {
  MAGIC,
  writeSeries,
  readSeries,
  appendSeries,
  statSeries,
}
