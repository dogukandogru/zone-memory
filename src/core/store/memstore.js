'use strict'

// Hafiza kayitlarinin (dokunus + sonuc + ozellik vektoru) diske yazilmasi.
// CONTRACTS.md bolum 6 ile birebir uyumludur.
//
//   <ad>.json      : {version:2, buildId, tf, rowLen, shapeLen, retLen, ctxLen,
//                     ctxNames, partsNames, count, events}
//                    events icinde her kayit `features` HARIC tum Touch +
//                    Outcome alanlari.
//   <ad>.vec       : 24 baytlik baslik + count * rowLen adet float32.
//                    Satir duzeni: [shape(shapeLen), ret(retLen), ctx(ctxLen)]
//   <ad>.meta.json : yalnizca ozet (sayim, zaman araligi, ayar izi). statMemory
//                    buyuk JSON'u hic acmadan bunu okur.
//
// Ozellik vektorleri JSON'a yazilmaz; sayisal olarak buyuk ve JSON'da
// hem yavas hem savurgan olurlar. Satir uzunlugu her zaman JSON icindeki
// rowLen alanindan okunur.
//
// VEKTOR BASLIGI NEDEN VAR. Kayit iki dosyayi AYRI AYRI rename ediyor. Arada
// kapanma, cokme ya da iptal olursa yeni .vec eski .json ile kaliyordu; satir
// sayisi tutuyorsa hicbir uyari cikmadan her olaya BASKA bir olayin vektoru
// baglaniyor, tum benzerlik ve basari oranlari sessizce bozuluyordu. Baslikta
// count, rowLen ve o kayda ozel buildId tutuluyor; .json'daki buildId ile
// eslesmezse dosya reddediliyor. Basliksiz (eski) dosyalarda bu kontrol
// yapilamaz, orada yalnizca tam uzunluk esitligi aranir.
//
// JSON'DA YUVARLAMA NEDEN VAR. 1m hafizasinin JSON'u 42,8 MB'a ulasmisti ve
// hacmin buyuk kismi `8.29674041547036` gibi 17 haneli kayan noktali
// metinlerdi. Vektorler zaten float32 (~7 anlamli hane) oldugu icin olay
// alanlarinda bundan fazlasi bilgi tasimaz. Tam sayilar ve zaman damgalari
// yuvarlanmaz.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const VERSION = 2
const DEFAULT_SHAPE_LEN = 16
const DEFAULT_RET_LEN = 32
/** Tek seferde islenecek azami bayt (4 MB). */
const CHUNK_BYTES = 4 * 1024 * 1024

/** .vec basligi: 'ZMV2' + surum + rowLen + count + buildId'nin ilk 12 bayti. */
const VEC_MAGIC = [0x5a, 0x4d, 0x56, 0x32]
const VEC_VERSION = 2
const VEC_HEADER_BYTES = 24
const BUILD_ID_BYTES = 12

/** JSON'a yazilan kesirli sayilarin anlamli hane sayisi. */
const SIG_DIGITS = 7

/**
 * Yuvarlanmayacak olay alanlari. "Tam sayiya dokunma" kurali bunlarin hepsini
 * zaten koruyor; liste, ileride kesirli bir zaman damgasi (ms) ya da kesirli
 * bir sayac eklenirse sessizce bozulmasin diye acik tutuluyor.
 */
const HAM_ALANLAR = new Set([
  'id', 'zoneId', 'bar', 'time', 'resolvedBar', 'resolvedTime',
  'barsToOutcome', 'barsToFill', 'score', 'maxScore', 'zoneAgeBars', 'parts',
])

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
  // BOS ALANLAR IZE GIRMEZ.
  //
  // Yeni bir alan eklendiginde (ornek: featureCfg) degeri varsayilanken
  // `null` gelir. Null da ize katilsaydi, alanin eklendigi surumde HERKESIN
  // izi degisir ve hicbir sey degismedigi halde tam yeniden tarama
  // tetiklenirdi. Alan ancak GERCEKTEN bir deger tasidiginda ize girer.
  const temiz = {}
  for (const k of Object.keys(parcalar || {})) {
    const v = parcalar[k]
    if (v === null || v === undefined) continue
    temiz[k] = v
  }

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
  const metin = JSON.stringify(sirali(temiz))
  return crypto.createHash('sha256').update(metin).digest('hex').slice(0, 12)
}

/** Uzantili verilse bile temel yolu dondurur. */
function normalizeBase(basePath) {
  const p = String(basePath)
  if (p.endsWith('.meta.json')) return p.slice(0, -10)
  if (p.endsWith('.json')) return p.slice(0, -5)
  if (p.endsWith('.vec')) return p.slice(0, -4)
  return p
}

/** Dosyanin bulundugu klasoru olusturur. */
async function ensureDir(filePath) {
  const dir = path.dirname(filePath)
  if (dir && dir !== '.') await fs.promises.mkdir(dir, { recursive: true })
}

/**
 * buildId metninin ilk 12 baytlik hex karsiligi. Baslikta dosyanin tamamini
 * tasimaya gerek yok: 96 bit, tek kullanicinin urettigi kayitlar icin
 * carpisma olasiligini sifira yakin tutar.
 * @param {string} buildId
 * @returns {Buffer} Her zaman 12 bayt
 */
function buildIdBaytlari(buildId) {
  const hex = String(buildId || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  const buf = Buffer.alloc(BUILD_ID_BYTES)
  if (hex.length >= BUILD_ID_BYTES * 2) buf.write(hex.slice(0, BUILD_ID_BYTES * 2), 'hex')
  return buf
}

/** 24 baytlik .vec basligini kurar. */
function vecBasligi(count, rowLen, buildId) {
  const h = Buffer.alloc(VEC_HEADER_BYTES)
  for (let i = 0; i < VEC_MAGIC.length; i++) h[i] = VEC_MAGIC[i]
  h.writeUInt16LE(VEC_VERSION, 4)
  h.writeUInt16LE(rowLen, 6)
  h.writeUInt32LE(count, 8)
  buildIdBaytlari(buildId).copy(h, 12)
  return h
}

/**
 * Basligi cozer; sihirli sayi yoksa null doner (basliksiz ESKI dosya).
 * @param {Buffer} raw
 * @returns {{version:number, rowLen:number, count:number, buildId:Buffer}|null}
 */
function vecBasliginiOku(raw) {
  if (raw.length < VEC_HEADER_BYTES) return null
  for (let i = 0; i < VEC_MAGIC.length; i++) {
    if (raw[i] !== VEC_MAGIC[i]) return null
  }
  return {
    version: raw.readUInt16LE(4),
    rowLen: raw.readUInt16LE(6),
    count: raw.readUInt32LE(8),
    buildId: raw.subarray(12, VEC_HEADER_BYTES),
  }
}

/** Vektor dosyasi hafizayla eslesmiyor: tek metin, tek yonlendirme. */
function uyusmazlik(detay, vecPath) {
  return new Error(
    'memstore: vektor dosyasi hafizayla uyusmuyor (' + detay + '), ' +
    '"Geçmişi Tara" ile yeniden olusturun: ' + vecPath
  )
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

/** Baslik + Float32Array'i parca parca .tmp dosyasina yazar, rename etmez. */
async function writeVecTmp(tmpPath, arr, header) {
  const handle = await fs.promises.open(tmpPath, 'w')
  try {
    let pos = 0
    while (pos < header.length) {
      const res = await handle.write(header, pos, header.length - pos, pos)
      if (res.bytesWritten <= 0) throw new Error('memstore: vektor basligi yazilamadi')
      pos += res.bytesWritten
    }
    const total = arr.length * 4
    let done = 0
    while (done < total) {
      const len = total - done < CHUNK_BYTES ? total - done : CHUNK_BYTES
      const buf = chunkView32(arr, done, len)
      let written = 0
      while (written < len) {
        const res = await handle.write(buf, written, len - written, header.length + done + written)
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
 * Metni .tmp dosyasina yazip diske ZORLAR. fs.writeFile yalnizca cekirdek
 * onbellegine birakiyor: .vec sync ediliyor ama .json edilmiyordu, bu yuzden
 * ani kapanmada yeni vektor dosyasi eski JSON ile kalabiliyordu.
 */
async function writeTextTmp(tmpPath, text) {
  const handle = await fs.promises.open(tmpPath, 'w')
  try {
    await handle.writeFile(text)
    await handle.sync().catch(function () {})
  } finally {
    await handle.close().catch(function () {})
  }
}

/** Kesirli sayiyi 7 anlamli haneye indirir; tam sayilara dokunmaz. */
function yuvarlaSayi(v) {
  if (!Number.isFinite(v)) return v
  if (Number.isInteger(v)) return v
  return Number(v.toPrecision(SIG_DIGITS))
}

/** Sayi / dizi / nesne ayrimi yapmadan yuvarlar (HAM_ALANLAR haric). */
function yuvarlaDeger(v) {
  if (typeof v === 'number') return yuvarlaSayi(v)
  if (Array.isArray(v)) {
    const out = new Array(v.length)
    for (let i = 0; i < v.length; i++) out[i] = yuvarlaDeger(v[i])
    return out
  }
  if (v && typeof v === 'object') {
    const out = {}
    const keys = Object.keys(v)
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      out[k] = HAM_ALANLAR.has(k) ? v[k] : yuvarlaDeger(v[k])
    }
    return out
  }
  return v
}

/**
 * Tum olaylarin `parts` nesnesi AYNI anahtar kumesini tasiyor ve yalnizca
 * boolean deger iceriyorsa anahtar listesini dondurur, aksi halde null (o
 * zaman `parts` oldugu gibi yazilir).
 *
 * Ayni kume sarti gidis donusun birebir kalmasini garanti eder: bit
 * maskesinde "anahtar yok" ile "anahtar false" ayni gorunur, bu yuzden kume
 * degisken oldugunda maske kullanilmaz.
 *
 * @param {Array<Object>} events
 * @returns {string[]|null}
 */
function partsSemasi(events) {
  let adlar = null
  for (let i = 0; i < events.length; i++) {
    const p = events[i] ? events[i].parts : null
    if (p === null || p === undefined) continue
    if (typeof p !== 'object' || Array.isArray(p)) return null
    const k = Object.keys(p)
    for (let j = 0; j < k.length; j++) {
      if (typeof p[k[j]] !== 'boolean') return null
    }
    if (adlar === null) {
      // 30 bit siniri: maske `|` ile kuruluyor, isaret bitine tasmamali.
      if (k.length === 0 || k.length > 30) return null
      adlar = k
    } else {
      if (k.length !== adlar.length) return null
      for (let j = 0; j < k.length; j++) {
        if (adlar.indexOf(k[j]) < 0) return null
      }
    }
  }
  return adlar
}

/** `parts` nesnesini bit maskesine cevirir. */
function partsMaskesi(p, adlar) {
  if (p === null || p === undefined) return null
  let m = 0
  for (let i = 0; i < adlar.length; i++) {
    if (p[adlar[i]] === true) m |= (1 << i)
  }
  return m
}

/** Bit maskesini `parts` nesnesine geri acar; sayi degilse dokunmaz. */
function partsAc(m, adlar) {
  if (typeof m !== 'number') return m
  const out = {}
  for (let i = 0; i < adlar.length; i++) out[adlar[i]] = (m & (1 << i)) !== 0
  return out
}

/** Olayin JSON'a yazilacak sade kopyasi: features cikar, sayilar yuvarlanir. */
function sadeOlay(e, partsAdlari) {
  const o = {}
  const keys = Object.keys(e)
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k]
    if (key === 'features') continue
    if (key === 'parts' && partsAdlari !== null) {
      o.parts = partsMaskesi(e.parts, partsAdlari)
      continue
    }
    o[key] = HAM_ALANLAR.has(key) ? e[key] : yuvarlaDeger(e[key])
  }
  return o
}

/**
 * Hafizayi diske yazar.
 * @param {string} basePath Uzantisiz temel yol
 * @param {{tf:string, ctxNames:string[], events:Array<Object>, builtToTime?:number}} memory
 *        `builtToTime`: hafizanin uretildigi serinin SON bar zamani. Olaylarin
 *        son zamani bunun cok gerisinde kalir (etiketleme ufku kadar ileri bar
 *        gerekir ve olaylar seyrektir), bu yuzden "hafiza guncel mi" sorusu
 *        yalnizca olay zamanina bakilarak cevaplanamaz.
 * @returns {Promise<{count:number, rowLen:number, buildId:string,
 *          jsonPath:string, vecPath:string, metaPath:string}>}
 */
async function saveMemory(basePath, memory) {
  const base = normalizeBase(basePath)
  const jsonPath = base + '.json'
  const vecPath = base + '.vec'
  const metaPath = base + '.meta.json'
  const mem = memory || {}
  const events = mem.events || []
  const count = events.length
  const ctxNames = mem.ctxNames ? mem.ctxNames.slice() : []

  // Bu KAYDIN kimligi (hafizanin icerigininki degil). .vec ile .json'un ayni
  // yazma isleminden geldigini kanitlayan tek sey bu.
  const buildId = crypto.randomUUID()

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
  // Baslik alanlari 16/32 bit; asilmasi mumkun degil ama sessizce sarmasin.
  if (rowLen > 0xffff) throw new Error('memstore: satir uzunlugu basliga sigmiyor: ' + rowLen)
  if (count > 0xffffffff) throw new Error('memstore: kayit sayisi basliga sigmiyor: ' + count)

  const partsAdlari = partsSemasi(events)

  // Vektor tablosu ve JSON'a girecek sade kayitlar tek geciste hazirlanir.
  const vec = new Float32Array(count * rowLen)
  const plain = new Array(count)
  let firstTime = Infinity
  let lastTime = -Infinity
  for (let i = 0; i < count; i++) {
    const e = events[i]
    const f = e.features
    if (!f) throw new Error('memstore: ' + i + '. kaydin features alani yok')
    const off = i * rowLen
    copyInto(vec, off, f.shape, shapeLen, 'shape', i)
    copyInto(vec, off + shapeLen, f.ret, retLen, 'ret', i)
    copyInto(vec, off + shapeLen + retLen, f.ctx, ctxLen, 'ctx', i)
    plain[i] = sadeOlay(e, partsAdlari)
    const t = e.time
    if (Number.isFinite(t)) {
      if (t < firstTime) firstTime = t
      if (t > lastTime) lastTime = t
    }
  }

  const iz = mem.cfgHash ? String(mem.cfgHash) : cfgHash({
    indicatorParams: mem.indicatorParams || null,
    // Ozellik ayari (sekil penceresi). Ize dahildir; hafizanin hangi
    // pencereyle kuruldugu dosyada yazili olmazsa karsilastirilamaz.
    featureCfg: mem.featureCfg || null,
    outcomeCfg: mem.outcomeCfg || null,
    ctxNames: ctxNames,
  })

  const ortak = {
    version: VERSION,
    // Bu kaydin kimligi; .vec basligindaki 12 baytla eslesmek zorunda.
    buildId: buildId,
    tf: mem.tf || null,
    rowLen: rowLen,
    shapeLen: shapeLen,
    retLen: retLen,
    ctxLen: ctxLen,
    ctxNames: ctxNames,
    // Bit maskesinin hangi bitinin hangi skor bilesenine karsilik geldigi.
    // Yoksa (null) `parts` nesne olarak yazilmis demektir.
    partsNames: partsAdlari,
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
    featureCfg: mem.featureCfg && typeof mem.featureCfg === 'object' ? mem.featureCfg : null,
    indicatorParams: mem.indicatorParams && typeof mem.indicatorParams === 'object'
      ? mem.indicatorParams
      : null,
    outcomeCfg: mem.outcomeCfg && typeof mem.outcomeCfg === 'object' ? mem.outcomeCfg : null,
    featureVersion: Number.isFinite(mem.featureVersion) ? mem.featureVersion : null,
    cfgHash: iz,
    builtAt: mem.builtAt ? String(mem.builtAt) : new Date().toISOString(),
  }

  const meta = Object.assign({}, ortak, { events: plain })
  // YAN DOSYA. 1m hafizasinin JSON'u 40 MB'in uzerinde; arayuz her acilista
  // yalnizca sayim ve zaman araligi icin o dosyayi bastan sona cozuyordu.
  // Ozet ayri ve kucuk bir dosyada duruyor, statMemory once onu okuyor.
  const yan = Object.assign({}, ortak, {
    firstTime: Number.isFinite(firstTime) ? firstTime : 0,
    lastTime: Number.isFinite(lastTime) ? lastTime : 0,
  })

  await ensureDir(jsonPath)
  // Once uc gecici dosya yazilir, sonra sirayla yerlerine tasinir;
  // boylece yarim kalan bir kayit mevcut hafizayi bozmaz.
  const vecTmp = vecPath + '.tmp'
  const jsonTmp = jsonPath + '.tmp'
  const metaTmp = metaPath + '.tmp'
  try {
    await writeVecTmp(vecTmp, vec, vecBasligi(count, rowLen, buildId))
    await writeTextTmp(jsonTmp, JSON.stringify(meta))
    await writeTextTmp(metaTmp, JSON.stringify(yan))
    // Yan dosya takastan ONCE silinir: is yarida kalirsa geride ESKI bir ozet
    // kalmasin, statMemory buyuk JSON'a dussun. Ozet, kaynagindan yeni
    // gorunemez.
    await fs.promises.unlink(metaPath).catch(function () {})
    await fs.promises.rename(vecTmp, vecPath)
    await fs.promises.rename(jsonTmp, jsonPath)
    await fs.promises.rename(metaTmp, metaPath)
  } catch (err) {
    await fs.promises.unlink(vecTmp).catch(function () {})
    await fs.promises.unlink(jsonTmp).catch(function () {})
    await fs.promises.unlink(metaTmp).catch(function () {})
    throw err
  }

  return {
    count: count,
    rowLen: rowLen,
    buildId: buildId,
    jsonPath: jsonPath,
    vecPath: vecPath,
    metaPath: metaPath,
  }
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
  const buildId = meta.buildId ? String(meta.buildId) : null

  // Bit maskesi geri acilir. Eski dosyalarda partsNames yoktur ve `parts`
  // zaten nesnedir; o zaman hicbir sey yapilmaz.
  const partsAdlari = Array.isArray(meta.partsNames) && meta.partsNames.length > 0
    ? meta.partsNames
    : null
  if (partsAdlari !== null) {
    for (let i = 0; i < count; i++) {
      const e = events[i]
      if (e && typeof e.parts === 'number') e.parts = partsAc(e.parts, partsAdlari)
    }
  }

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

    // Baslik varsa .vec ile .json'un AYNI kayittan geldigi buradan anlasilir.
    // Basliksiz eski dosyalarda tek elimizdeki tam uzunluk esitligi.
    const bas = vecBasliginiOku(raw)
    let veriOfs = 0
    if (bas !== null) {
      veriOfs = VEC_HEADER_BYTES
      if (bas.count !== count || bas.rowLen !== rowLen) {
        throw uyusmazlik(
          'baslik ' + bas.count + 'x' + bas.rowLen + ', hafiza ' + count + 'x' + rowLen,
          vecPath
        )
      }
      if (buildId !== null && !buildIdBaytlari(buildId).equals(bas.buildId)) {
        throw uyusmazlik('baska bir kayittan kalma, yapi kimligi farkli', vecPath)
      }
    }
    // Uzunluk ESIT olmali. Onceden yalnizca "kisa mi" bakiliyordu; uzun dosya
    // sessizce kabul edilip bastan okunuyor, yanlis vektorler hicbir uyari
    // vermeden hafizaya baglaniyordu.
    if (raw.length - veriOfs !== needBytes) {
      throw uyusmazlik(
        (raw.length - veriOfs) + ' bayt veri var, beklenen ' + needBytes,
        vecPath
      )
    }

    if (!LITTLE_ENDIAN) raw.subarray(veriOfs).swap32()
    // Buffer havuzdan gelebilir; float32 gorunumu icin ofset 4'un kati olmali,
    // degilse hizali bir dizeye kopyalanir. Baslik 24 bayt, yani 4'un kati:
    // hizalama sorusu baslikli dosyada da degismiyor.
    let vec
    if (((raw.byteOffset + veriOfs) & 3) === 0) {
      vec = new Float32Array(raw.buffer, raw.byteOffset + veriOfs, count * rowLen)
    } else {
      vec = new Float32Array(count * rowLen)
      Buffer.from(vec.buffer, vec.byteOffset, needBytes)
        .set(raw.subarray(veriOfs, veriOfs + needBytes))
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
      featureCfg: meta.featureCfg || null,
      outcomeCfg: meta.outcomeCfg || null,
      featureVersion: Number.isFinite(meta.featureVersion) ? meta.featureVersion : null,
      builtAt: meta.builtAt || null,
      buildCommit: meta.buildCommit || null,
      buildSrcHash: meta.buildSrcHash || null,
      buildId: buildId,
    },
  }
}

/** statMemory'nin dondurdugu ozeti tek yerden kurar (yan dosya ve eski yol). */
function ozetKur(m) {
  return {
    count: Number.isFinite(m.count) ? m.count : 0,
    tf: m.tf || null,
    firstTime: Number.isFinite(m.firstTime) ? m.firstTime : 0,
    lastTime: Number.isFinite(m.lastTime) ? m.lastTime : 0,
    // Baglam vektoru uzunlugu. Cagiran taraf bunu guncel features.CTX_NAMES ile
    // karsilastirip hafizanin eski bir indikator surumunden kalip kalmadigini
    // dosyayi tumuyle okumadan anlayabilir.
    ctxLen: Number.isFinite(m.ctxLen) ? m.ctxLen : (Array.isArray(m.ctxNames) ? m.ctxNames.length : 0),
    // Bu alani tasimayan eski dosyalarda 0 doner; cagiran taraf onu "guncelligi
    // bilinmiyor" sayip bir kez yeniden tarar.
    builtToTime: Number.isFinite(m.builtToTime) ? m.builtToTime : 0,
    // Ayar izi ve yapi damgasi (eski dosyalarda null).
    ctxNames: Array.isArray(m.ctxNames) ? m.ctxNames.slice() : null,
    cfgHash: m.cfgHash ? String(m.cfgHash) : null,
    indicatorParams: m.indicatorParams || null,
    featureCfg: m.featureCfg || null,
    outcomeCfg: m.outcomeCfg || null,
    featureVersion: Number.isFinite(m.featureVersion) ? m.featureVersion : null,
    builtAt: m.builtAt || null,
    buildCommit: m.buildCommit || null,
    buildSrcHash: m.buildSrcHash || null,
    buildId: m.buildId ? String(m.buildId) : null,
  }
}

/**
 * Hafiza ozeti. Once kucuk `<ad>.meta.json` denenir; yoksa ya da bozuksa eski
 * yola, yani buyuk JSON'u cozmeye duser.
 * @param {string} basePath
 * @returns {Promise<{count:number, tf:string, firstTime:number, lastTime:number}|null>} Yoksa null
 */
async function statMemory(basePath) {
  const base = normalizeBase(basePath)

  // Yan dosya yalnizca hizlandirmadir, dogrulugun kaynagi degildir: okunamazsa
  // ya da bozuksa sessizce buyuk JSON'a dusulur.
  let yan = null
  try {
    yan = await readMeta(base + '.meta.json')
  } catch (err) {
    yan = null
  }
  if (yan !== null && Number.isFinite(yan.count)) return ozetKur(yan)

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
  return ozetKur(Object.assign({}, meta, {
    count: events.length,
    firstTime: Number.isFinite(firstTime) ? firstTime : 0,
    lastTime: Number.isFinite(lastTime) ? lastTime : 0,
  }))
}

/**
 * Hafiza dosyalarini siler.
 * @param {string} basePath
 * @returns {Promise<boolean>} En az bir dosya silindiyse true
 */
async function deleteMemory(basePath) {
  const base = normalizeBase(basePath)
  let removed = false
  const targets = [
    base + '.json', base + '.vec', base + '.meta.json',
    base + '.json.tmp', base + '.vec.tmp', base + '.meta.json.tmp',
  ]
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
