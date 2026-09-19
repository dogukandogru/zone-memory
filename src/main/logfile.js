'use strict'

/**
 * KALICI GUNLUK DOSYASI (C7)
 *
 * Hatalar yalnizca alt seritte 12-20 saniye duruyordu, hicbir yere
 * yazilmiyordu ve yigin izi (stack) atiliyordu. Gece olusan basis, ekleme
 * veya cokme hatalarinin NE ZAMAN basladigi sonradan tespit edilemiyordu;
 * depodaki bozulmalarin baslangicini bulmak icin de elimizde hicbir sey
 * yoktu.
 *
 * Bicim: gunluk bir dosya, satir basina bir kayit.
 *   <userData>/logs/zone-memory-YYYY-MM-DD.log
 *   2026-09-19T11:24:08.123Z  HATA  engine  Isci cokti
 *     at ...
 *
 * Tasarim kararlari:
 * - Yazimlar SIRAYA girer (tek bir promise zinciri). Ayni dosyaya paralel
 *   appendFile cagrilari satirlari birbirine karistirabiliyor.
 * - Yazim hatasi sessizce yutulur: gunluk tutamamak uygulamayi durdurmamali.
 * - Acilista 14 gunden eski dosyalar silinir; aksi halde klasor sinirsiz
 *   buyur.
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const paths = require('./paths')

/** Kac gunluk gunluk saklanir. */
const SAKLAMA_GUN = 14

/** Yazimlarin sirasini koruyan zincir. */
let zincir = Promise.resolve()
/** Klasor bir kez olusturulur. */
let klasorHazir = false

/** Gunluk klasoru: <userData>/logs */
function logDir() {
  return path.join(paths.userDataDir(), 'logs')
}

/** Bugunun dosya yolu. */
function logPath(tarih) {
  const d = tarih || new Date()
  const gun = d.toISOString().slice(0, 10)
  return path.join(logDir(), 'zone-memory-' + gun + '.log')
}

/** Klasoru bir kez olusturur. */
async function klasoruHazirla() {
  if (klasorHazir) return
  await fsp.mkdir(logDir(), { recursive: true })
  klasorHazir = true
}

/**
 * Bir kaydi dosyaya ekler.
 *
 * @param {{level?:string, source?:string, message:string, stack?:string}} kayit
 * @returns {Promise<void>} Yazim bitince coezulur (test icin)
 */
function write(kayit) {
  const k = kayit || {}
  const seviye = String(k.level || 'bilgi').toUpperCase()
  const kaynak = String(k.source || '-')
  const mesaj = String(k.message === undefined || k.message === null ? '' : k.message)
    .replace(/\r?\n/g, ' ')
  let satir = new Date().toISOString() + '  ' + seviye + '  ' + kaynak + '  ' + mesaj + '\n'
  if (k.stack) {
    // Yigin izi girintili satirlar halinde: tek satirlik biçimi bozmadan
    // okunabilir kalir.
    satir += String(k.stack).split(/\r?\n/).map((x) => '    ' + x).join('\n') + '\n'
  }

  zincir = zincir.then(async () => {
    try {
      await klasoruHazirla()
      await fsp.appendFile(logPath(), satir, 'utf8')
    } catch (err) {
      // Gunluk tutamamak uygulamayi durdurmamali.
    }
  })
  return zincir
}

/**
 * SAKLAMA_GUN gununden eski gunluk dosyalarini siler.
 * @returns {Promise<number>} Silinen dosya sayisi
 */
async function temizle() {
  let silinen = 0
  try {
    await klasoruHazirla()
    const dosyalar = await fsp.readdir(logDir())
    const sinir = Date.now() - SAKLAMA_GUN * 86400 * 1000
    for (const ad of dosyalar) {
      const m = /^zone-memory-(\d{4}-\d{2}-\d{2})\.log$/.exec(ad)
      if (!m) continue
      const t = Date.parse(m[1] + 'T00:00:00Z')
      if (!Number.isFinite(t) || t >= sinir) continue
      try {
        await fsp.unlink(path.join(logDir(), ad))
        silinen++
      } catch (err) {
        // Dosya kullanimda olabilir, sessizce gec.
      }
    }
  } catch (err) {
    // Klasor yoksa silinecek de yoktur.
  }
  return silinen
}

/** Acilista cagrilir: klasoru kurar ve eskileri siler. */
function init() {
  return temizle()
}

/** Klasorun var oldugundan emin olup yolunu dondurur (menu icin). */
function ensureDirSync() {
  const dir = logDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    // Olusturulamazsa yol yine dondurulur; acma denemesi hata gosterir.
  }
  return dir
}

module.exports = {
  SAKLAMA_GUN,
  logDir,
  logPath,
  write,
  temizle,
  init,
  ensureDirSync,
}
