'use strict'

// Hafiza kayitlarinin (dokunus + sonuc + ozellik vektoru) diske yazilmasi.
// CONTRACTS.md bolum 6 ile birebir uyumludur.
//
//   <ad>.json : {version:1, tf, rowLen, shapeLen, retLen, ctxLen, ctxNames, count, events}
//               events icinde her kayit `features` HARIC tum Touch + Outcome alanlari.
//   <ad>.vec  : count * rowLen adet float32.
//               Satir duzeni: [shape(shapeLen), ret(retLen), ctx(ctxLen)]
//
// Ozellik vektorleri JSON'a yazilmaz; sayisal olarak buyuk ve JSON'da
// hem yavas hem savurgan olurlar. Satir uzunlugu her zaman JSON icindeki
// rowLen alanindan okunur.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const VERSION = 1
const DEFAULT_SHAPE_LEN = 16
const DEFAULT_RET_LEN = 32
/** Tek seferde islenecek azami bayt (4 MB). */
const CHUNK_BYTES = 4 * 1024 * 1024

// Hedef platformlar little endian; degilse bayt takasi yapilir.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/**
 * Ayar izi: anahtarlari sirali JSON'un sha256 ozetinin ilk 12 hanesi.
 * Hafizanin hangi ayarla kuruldugunu karsilastirmak icin kullanilir; amac
 * gizlilik degil, sabit ve kisa bir kimlik uretmektir.
 * @param {object} parcalar
 * @returns {string}
 */
function cfgHash(parcalar) {
  const sirali = function (deger) {
    if (Array.isArray(deger)) return deger.map(sirali)
    if (deger && typeof deger === 'object') {
      const out = {}
      for (const k of Object.keys(deger).sort()) out[k] = sirali(deger[k])
      return out
    }
    // Kayan noktali kucuk farklar iz degistirmesin.
    if (typeof deger === 'number' && Number.isFinite(deger)) return Number(deger.toFixed(8))
    return deger
  }
  const metin = JSON.stringify(sirali(parcalar || {}))
  return crypto.createHash('sha256').update(metin).digest('hex').slice(0, 12)
}

/** Uzantili verilse bile temel yolu dondurur. */
function normalizeBase(basePath) {
  const p = String(basePath)
  if (p.endsWith('.json')) return p.slice(0, -5)
  if (p.endsWith('.vec')) return p.slice(0, -4)
  return p
}

/** Dosyanin bulundugu klasoru olusturur. */
async function ensureDir(filePath) {
  const dir = path.dirname(filePath)
  if (dir && dir !== '.') await fs.promises.mkdir(dir, { recursive: true })
}

/** Float32Array parcasi icin Buffer gorunumu (BE platformda takasli kopya). */
function chunkView32(arr, byteOffset, byteLength) {
  const view = Buffer.from(arr.buffer, arr.byteOffset + byteOffset, byteLength)
  if (LITTLE_ENDIAN) return view
  const copy = Buffer.from(view)
  copy.swap32()
  return copy
}

/** Kaynak diziden hedef Float32Array'e sabit uzunlukta kopyalar. */
function copyInto(dst, offset, src, len, alan, indeks) {
  if (!src || src.length !== len) {
    throw new Error(
      'memstore: ' + indeks + '. kaydin features.' + alan + ' uzunlugu ' + len + ' olmali'
    )
  }
  for (let i = 0; i < len; i++) {
    const v = +src[i]
    dst[offset + i] = Number.isFinite(v) ? v : 0
  }
}

/** Float32Array'i parca parca .tmp dosyasina yazar, rename etmez. */
async function writeVecTmp(tmpPath, arr) {
  const handle = await fs.promises.open(tmpPath, 'w')
  try {
    const total = arr.length * 4
    let done = 0
    while (done < total) {
      const len = total - done < CHUNK_BYTES ? total - done : CHUNK_BYTES
      const buf = chunkView32(arr, done, len)
      let written = 0
      while (written < len) {
        const res = await handle.write(buf, written, len - written, done + written)
        if (res.bytesWritten <= 0) throw new Error('memstore: vektor dosyasina yazilamadi')
        written += res.bytesWritten
      }
      done += len
    }
    await handle.sync().catch(function () {})
  } finally {
    await handle.close().catch(function () {})
  }
}

/**
 * Hafizayi diske yazar.
 * @param {string} basePath Uzantisiz temel yol
 * @param {{tf:string, ctxNames:string[], events:Array<Object>, builtToTime?:number}} memory
 *        `builtToTime`: hafizanin uretildigi serinin SON bar zamani. Olaylarin
 *        son zamani bunun cok gerisinde kalir (etiketleme ufku kadar ileri bar
 *        gerekir ve olaylar seyrektir), bu yuzden "hafiza guncel mi" sorusu
 *        yalnizca olay zamanina bakilarak cevaplanamaz.
 * @returns {Promise<{count:number, rowLen:number, jsonPath:string, vecPath:string}>}
 */
async function saveMemory(basePath, memory) {
  const base = normalizeBase(basePath)
  const jsonPath = base + '.json'
  const vecPath = base + '.vec'
  const mem = memory || {}
  const events = mem.events || []
  const count = events.length
  const ctxNames = mem.ctxNames ? mem.ctxNames.slice() : []

  let shapeLen = DEFAULT_SHAPE_LEN
  let retLen = DEFAULT_RET_LEN
  let ctxLen = ctxNames.length
  if (count > 0) {
    const f0 = events[0].features
    if (!f0 || !f0.shape || !f0.ret || !f0.ctx) {
      throw new Error('memstore: 0. kaydin features alani eksik (shape/ret/ctx zorunlu)')
    }
    shapeLen = f0.shape.length
    retLen = f0.ret.length
    ctxLen = f0.ctx.length
  }
  const rowLen = shapeLen + retLen + ctxLen

  // Vektor tablosu ve JSON'a girecek sade kayitlar tek geciste hazirlanir.
  const vec = new Float32Array(count * rowLen)
  const plain = new Array(count)
  for (let i = 0; i < count; i++) {
    const e = events[i]
    const f = e.features
    if (!f) throw new Error('memstore: ' + i + '. kaydin features alani yok')
    const off = i * rowLen
    copyInto(vec, off, f.shape, shapeLen, 'shape', i)
    copyInto(vec, off + shapeLen, f.ret, retLen, 'ret', i)
    copyInto(vec, off + shapeLen + retLen, f.ctx, ctxLen, 'ctx', i)
    const o = {}
    const keys = Object.keys(e)
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]
      if (key !== 'features') o[key] = e[key]
    }
    plain[i] = o
  }

  const meta = {
    version: VERSION,
    tf: mem.tf || null,
    rowLen: rowLen,
    shapeLen: shapeLen,
    retLen: retLen,
    ctxLen: ctxLen,
    ctxNames: ctxNames,
    count: count,
    builtToTime: Number.isFinite(mem.builtToTime) ? mem.builtToTime : 0,
    // Hafizayi ureten yapi damgasi. Verilmezse null kalir; eski dosyalarda
    // alan hic olmayabilir, okuma tarafi bunu bos kabul eder.
    buildCommit: mem.buildCommit ? String(mem.buildCommit) : null,
    buildSrcHash: mem.buildSrcHash ? String(mem.buildSrcHash) : null,
    // AYAR IZI. Hafiza hangi indikator ayari ve hangi etiket tanimiyla
    // kuruldu? Onceden yalnizca baglam vektorunun uzunluguna bakiliyordu, bu
    // yuzden kullanici targetAtr gibi bir ayari degistirip taramayi
    // unuttugunda canli sinyal yeni tanimla uretilen olayi eski tanimla
    // etiketlenmis gecmisle karsilastiriyor ve bu hicbir yerde gorunmuyordu.
    indicatorParams: mem.indicatorParams && typeof mem.indicatorParams === 'object'
      ? mem.indicatorParams
      : null,
    outcomeCfg: mem.outcomeCfg && typeof mem.outcomeCfg === 'object' ? mem.outcomeCfg : null,
    featureVersion: Number.isFinite(mem.featureVersion) ? mem.featureVersion : null,
    cfgHash: mem.cfgHash ? String(mem.cfgHash) : cfgHash({
      indicatorParams: mem.indicatorParams || null,
      outcomeCfg: mem.outcomeCfg || null,
      ctxNames: ctxNames,
    }),
    builtAt: mem.builtAt ? String(mem.builtAt) : new Date().toISOString(),
    events: plain,
  }

  await ensureDir(jsonPath)
  // Once iki gecici dosya yazilir, sonra sirayla yerlerine tasinir;
  // boylece yarim kalan bir kayit mevcut hafizayi bozmaz.
  const vecTmp = vecPath + '.tmp'
  const jsonTmp = jsonPath + '.tmp'
  try {
    await writeVecTmp(vecTmp, vec)
    await fs.promises.writeFile(jsonTmp, JSON.stringify(meta))
    await fs.promises.rename(vecTmp, vecPath)
    await fs.promises.rename(jsonTmp, jsonPath)
  } catch (err) {
    await fs.promises.unlink(vecTmp).catch(function () {})
    await fs.promises.unlink(jsonTmp).catch(function () {})
    throw err
  }

  return { count: count, rowLen: rowLen, jsonPath: jsonPath, vecPath: vecPath }
}

/** JSON dosyasini okur, yoksa null dondurur. */
async function readMeta(jsonPath) {
  let text
  try {
    text = await fs.promises.readFile(jsonPath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  let meta
  try {
    meta = JSON.parse(text)
  } catch (err) {
    throw new Error('memstore: hafiza dosyasi bozuk (JSON cozulemedi): ' + jsonPath)
  }
  if (!meta || typeof meta !== 'object') {
    throw new Error('memstore: hafiza dosyasi bekleneni icermiyor: ' + jsonPath)
  }
  return meta
}

/**
 * Hafizayi diskten okur, ozellik vektorlerini geri kurar.
 * @param {string} basePath
 * @returns {Promise<{tf:string, ctxNames:string[], events:Array<Object>}|null>} Yoksa null
 */
async function loadMemory(basePath) {
  const base = normalizeBase(basePath)
  const jsonPath = base + '.json'
  const vecPath = base + '.vec'
  const meta = await readMeta(jsonPath)
  if (meta === null) return null

  const events = Array.isArray(meta.events) ? meta.events : []
  const count = events.length
  const rowLen = meta.rowLen | 0
  const shapeLen = meta.shapeLen === undefined ? DEFAULT_SHAPE_LEN : meta.shapeLen | 0
  const retLen = meta.retLen === undefined ? DEFAULT_RET_LEN : meta.retLen | 0
  const ctxNames = Array.isArray(meta.ctxNames) ? meta.ctxNames : []
  const ctxLen = meta.ctxLen === undefined ? rowLen - shapeLen - retLen : meta.ctxLen | 0

  if (count > 0) {
    if (rowLen <= 0 || shapeLen + retLen + ctxLen !== rowLen) {
      throw new Error('memstore: satir uzunlugu tutarsiz: ' + jsonPath)
    }
    let raw
    try {
      raw = await fs.promises.readFile(vecPath)
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new Error('memstore: vektor dosyasi bulunamadi: ' + vecPath)
      }
      throw err
    }
    const needBytes = count * rowLen * 4
    if (raw.length < needBytes) {
      throw new Error(
        'memstore: vektor dosyasi beklenenden kisa (' + raw.length + ' < ' + needBytes + '): ' + vecPath
      )
    }
    if (!LITTLE_ENDIAN) raw.swap32()
    // Buffer havuzdan gelebilir; float32 gorunumu icin ofset 4'un kati olmali,
    // degilse hizali bir dizeye kopyalanir.
    let vec
    if ((raw.byteOffset & 3) === 0) {
      vec = new Float32Array(raw.buffer, raw.byteOffset, count * rowLen)
    } else {
      vec = new Float32Array(count * rowLen)
      Buffer.from(vec.buffer, vec.byteOffset, needBytes).set(raw.subarray(0, needBytes))
    }
    for (let i = 0; i < count; i++) {
      const off = i * rowLen
      events[i].features = {
        shape: vec.subarray(off, off + shapeLen),
        ret: vec.subarray(off + shapeLen, off + shapeLen + retLen),
        ctx: vec.subarray(off + shapeLen + retLen, off + rowLen),
      }
    }
  }

  // `meta` alani ayar izini tasir: plan geometrisi ve uyumluluk kontrolu
  // hafizanin kuruldugu outcomeCfg uzerinden yapilir (presets.resolveCfg).
  return {
    tf: meta.tf || null,
    ctxNames: ctxNames,
    events: events,
    meta: {
      builtToTime: Number.isFinite(meta.builtToTime) ? meta.builtToTime : 0,
      cfgHash: meta.cfgHash ? String(meta.cfgHash) : null,
      indicatorParams: meta.indicatorParams || null,
      outcomeCfg: meta.outcomeCfg || null,
      featureVersion: Number.isFinite(meta.featureVersion) ? meta.featureVersion : null,
      builtAt: meta.builtAt || null,
      buildCommit: meta.buildCommit || null,
      buildSrcHash: meta.buildSrcHash || null,
    },
  }
}

/**
 * Hafiza ozeti.
 * @param {string} basePath
 * @returns {Promise<{count:number, tf:string, firstTime:number, lastTime:number}|null>} Yoksa null
 */
async function statMemory(basePath) {
  const base = normalizeBase(basePath)
  const meta = await readMeta(base + '.json')
  if (meta === null) return null
  const events = Array.isArray(meta.events) ? meta.events : []
  let firstTime = Infinity
  let lastTime = -Infinity
  for (let i = 0; i < events.length; i++) {
    const t = events[i] ? events[i].time : undefined
    if (!Number.isFinite(t)) continue
    if (t < firstTime) firstTime = t
    if (t > lastTime) lastTime = t
  }
  return {
    count: events.length,
    tf: meta.tf || null,
    firstTime: Number.isFinite(firstTime) ? firstTime : 0,
    lastTime: Number.isFinite(lastTime) ? lastTime : 0,
    // Baglam vektoru uzunlugu. Cagiran taraf bunu guncel features.CTX_NAMES ile
    // karsilastirip hafizanin eski bir indikator surumunden kalip kalmadigini
    // dosyayi tumuyle okumadan anlayabilir.
    ctxLen: Number.isFinite(meta.ctxLen) ? meta.ctxLen : (Array.isArray(meta.ctxNames) ? meta.ctxNames.length : 0),
    // Bu alani tasimayan eski dosyalarda 0 doner; cagiran taraf onu "guncelligi
    // bilinmiyor" sayip bir kez yeniden tarar.
    builtToTime: Number.isFinite(meta.builtToTime) ? meta.builtToTime : 0,
    // Ayar izi ve yapi damgasi (eski dosyalarda null).
    ctxNames: Array.isArray(meta.ctxNames) ? meta.ctxNames.slice() : null,
    cfgHash: meta.cfgHash ? String(meta.cfgHash) : null,
    indicatorParams: meta.indicatorParams || null,
    outcomeCfg: meta.outcomeCfg || null,
    featureVersion: Number.isFinite(meta.featureVersion) ? meta.featureVersion : null,
    builtAt: meta.builtAt || null,
    buildCommit: meta.buildCommit || null,
    buildSrcHash: meta.buildSrcHash || null,
  }
}

/**
 * Hafiza dosyalarini siler.
 * @param {string} basePath
 * @returns {Promise<boolean>} En az bir dosya silindiyse true
 */
async function deleteMemory(basePath) {
  const base = normalizeBase(basePath)
  let removed = false
  const targets = [base + '.json', base + '.vec', base + '.json.tmp', base + '.vec.tmp']
  for (let i = 0; i < targets.length; i++) {
    try {
      await fs.promises.unlink(targets[i])
      removed = true
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
    }
  }
  return removed
}

module.exports = {
  saveMemory,
  loadMemory,
  statMemory,
  deleteMemory,
  cfgHash,
}
