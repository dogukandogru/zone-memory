// Musteriye teslim edilecek kurulumu TEK KOMUTLA hazirlar.
//
// NEDEN
// Teslim oncesi elle yapilan uc is vardi ve ucu de sessizce yanlis
// yapilabiliyordu: API anahtar dosyasini olusturmak, veri klasorunu dogru
// yere kopyalamak ve yedek dosyalari disarida birakmayi unutmamak. Yanlis
// klasore kopyalanan veri, musteride "kayit yok" diye gorunuyor ve sebebi
// anlasilmiyordu. Artik hepsi burada.
//
// Yaptiklari:
//   1. Verilen API anahtarini src/main/apiKeys.local.json dosyasina yazar.
//   2. Veri klasorunu build/bundled-data altina kopyalar (yedekler ve gecici
//      dosyalar HARIC). Kurulum bunu icine alir, uygulama ilk acilista yerine
//      koyar.
//   3. electron-builder'i calistirir, istenirse ciktiyi zipler.
//
// Kullanim:
//   node scripts/prepare-dist.mjs --win                    (NSIS kurulumu, wine gerekir)
//   node scripts/prepare-dist.mjs --win --tasinabilir      (kurulumsuz klasor + zip)
//   node scripts/prepare-dist.mjs --win --polygon-key ABC123
//   node scripts/prepare-dist.mjs --win --no-data          (veri gomme)
//   node scripts/prepare-dist.mjs --win --dry-run          (paketleme, sadece hazirla)
//
// TASINABILIR KIP NEDEN VAR
// NSIS kurulum dosyasi macOS'ta wine ister. Veri ise YALNIZCA bu makinede
// (470 MB), yani paketi musterinin makinesinde uretmek veriyi disarida
// birakir. `--tasinabilir` wine olmadan calisir: cikan klasor zip'lenip
// tasinir, musteri acip exe'yi calistirir, kurulum gerekmez.
//
// GERCEK VERIYE YAZMAZ, yalnizca okur.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dataDir as varsayilanDataDir } from './userdata-path.mjs'

const require = createRequire(import.meta.url)
const { argumanlariAyristir } = require('../src/core/util/cli.js')

const KOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ANAHTAR_DOSYASI = path.join(KOK, 'src', 'main', 'apiKeys.local.json')
const GOMULU_KLASOR = path.join(KOK, 'build', 'bundled-data')
/** Gomulu ayar yamasinin paket icindeki adi. */
const AYAR_DOSYASI = 'settings.bundled.json'

/**
 * Pakete GIRMEYECEK dosyalar.
 *
 * Yedekler (`.bak-...`) verinin uc katina cikmasina yol aciyordu: gercek
 * klasor 1,2 GB, yedeksiz hali 0,47 GB. Gecici dosyalar zaten yarim.
 * Canli sinyal gunlugu (`.live.jsonl`) BIZIM kullanimimizin kaydidir,
 * musterinin makinesinde bizim islemlerimiz gorunmemeli.
 */
function disarida(ad) {
  if (ad.includes('.bak-')) return true
  if (ad.endsWith('.tmp')) return true
  if (ad.endsWith('.yukleniyor')) return true
  if (ad.endsWith('.live.jsonl')) return true
  return false
}

const boyut = (b) => (b >= 1073741824
  ? (b / 1073741824).toFixed(2) + ' GB'
  : (b / 1048576).toFixed(0) + ' MB')

function yaz(satir) {
  process.stdout.write(satir + '\n')
}

/** Anahtar dosyasini yazar ya da (anahtar verilmediyse) siler. */
function anahtariKur(polygon, twelvedata) {
  if (!polygon && !twelvedata) {
    if (fs.existsSync(ANAHTAR_DOSYASI)) {
      fs.unlinkSync(ANAHTAR_DOSYASI)
      yaz('  API anahtari: dosya silindi (anahtarsiz yapi)')
    } else {
      yaz('  API anahtari: yok (musteri kendi girecek)')
    }
    return
  }
  const icerik = {
    polygon: polygon || '',
    twelvedata: twelvedata || '',
  }
  fs.writeFileSync(ANAHTAR_DOSYASI, JSON.stringify(icerik, null, 2) + '\n')
  const gorunen = []
  if (polygon) gorunen.push('polygon ...' + polygon.slice(-4))
  if (twelvedata) gorunen.push('twelvedata ...' + twelvedata.slice(-4))
  // Anahtarin TAMAMI HICBIR ZAMAN yazdirilmaz: bu cikti ekrana, CI gunlugune
  // ve terminal gecmisine duser.
  yaz('  API anahtari: gomuldu (' + gorunen.join(', ') + ')')
}

/**
 * AYAR YAMASINI DA PAKETE KOYAR.
 *
 * NEDEN ZORUNLU: hafiza, bu makinedeki ayarlarla kuruldu ve kendi ayar izini
 * (cfgHash) tasiyor. Musteri fabrika ayarlariyla acinca iz TUTMUYOR; uygulama
 * da dogru davranip gonderilen olcumu "eski ayara ait" sayiyor, otomatik
 * tarama hafizayi bastan kuruyor ve test sinyallerini siliyor. Olculdu:
 * 5m'de 990 yayinlanan sinyal ilk acilista silindi ve liste bos gorundu.
 *
 * API anahtarlari BU DOSYAYA GIRMEZ; onlar ayri bir yoldan (apiKeys.local.json)
 * gomuluyor, iki yerde birden tasimanin anlami yok.
 */
function ayarlariKopyala(userDir) {
  const kaynak = path.join(userDir, 'settings.json')
  if (!fs.existsSync(kaynak)) {
    yaz('  Ayarlar: bu makinede kayitli ayar yok, gomulmedi')
    return false
  }
  let ham = null
  try {
    ham = JSON.parse(fs.readFileSync(kaynak, 'utf8'))
  } catch (err) {
    yaz('  Ayarlar: dosya okunamadi, gomulmedi (' + (err && err.message) + ')')
    return false
  }
  delete ham.apiKeys
  fs.writeFileSync(path.join(GOMULU_KLASOR, AYAR_DOSYASI), JSON.stringify(ham, null, 2) + '\n')
  const alanlar = Object.keys(ham).filter((a) => a !== 'settingsVersion')
  yaz('  Ayarlar: gomuldu (' + (alanlar.length ? alanlar.join(', ') : 'yalnizca surum') + ')')
  return true
}

/** Veri klasorunu gomulu klasore kopyalar. */
function veriyiKopyala(kaynakDir) {
  if (fs.existsSync(GOMULU_KLASOR)) fs.rmSync(GOMULU_KLASOR, { recursive: true, force: true })
  fs.mkdirSync(GOMULU_KLASOR, { recursive: true })

  if (!fs.existsSync(kaynakDir)) {
    yaz('  Veri: kaynak klasor yok (' + kaynakDir + '), bos gecildi')
    return { adet: 0, bayt: 0 }
  }

  let adet = 0
  let bayt = 0
  let atlanan = 0
  for (const ad of fs.readdirSync(kaynakDir)) {
    if (disarida(ad)) { atlanan++; continue }
    const kYol = path.join(kaynakDir, ad)
    let st = null
    try {
      st = fs.statSync(kYol)
    } catch (err) {
      atlanan++
      continue
    }
    if (!st.isFile()) { atlanan++; continue }
    fs.copyFileSync(kYol, path.join(GOMULU_KLASOR, ad))
    adet++
    bayt += st.size
  }
  yaz('  Veri: ' + adet + ' dosya, ' + boyut(bayt) +
    (atlanan > 0 ? ' (' + atlanan + ' dosya disarida birakildi)' : ''))
  return { adet, bayt }
}

function main() {
  const arg = argumanlariAyristir(process.argv.slice(2))

  const polygon = typeof arg['polygon-key'] === 'string' ? arg['polygon-key'].trim() : ''
  const twelvedata = typeof arg['twelvedata-key'] === 'string' ? arg['twelvedata-key'].trim() : ''
  const veriYok = arg['no-data'] === true
  const kuruMu = arg['dry-run'] === true
  const kaynakDir = typeof arg['data-dir'] === 'string' ? arg['data-dir'] : varsayilanDataDir()

  const tasinabilir = arg['tasinabilir'] === true || arg['portable'] === true
  // Windows'ta varsayilan mimari x64. Bu Mac arm oldugu icin electron-builder
  // kendi basina arm64 secip musterinin makinesinde CALISMAYAN bir paket
  // uretiyordu (olculdu: --win dir, win-arm64-unpacked).
  const mimari = typeof arg.arch === 'string' ? arg.arch : 'x64'

  const hedefler = []
  if (arg.win === true) {
    hedefler.push('--win')
    if (tasinabilir) hedefler.push('dir')
    hedefler.push('--' + mimari)
  }
  if (arg.mac === true) hedefler.push('--mac')

  yaz('\nMusteri kurulumu hazirlaniyor')
  yaz('-'.repeat(52))
  anahtariKur(polygon, twelvedata)

  if (veriYok) {
    if (fs.existsSync(GOMULU_KLASOR)) fs.rmSync(GOMULU_KLASOR, { recursive: true, force: true })
    fs.mkdirSync(GOMULU_KLASOR, { recursive: true })
    yaz('  Veri: gomulmedi (--no-data)')
  } else {
    veriyiKopyala(kaynakDir)
    // Ayar yamasi verinin YANINDA gitmek zorunda, yoksa hafiza izi tutmaz.
    ayarlariKopyala(path.dirname(kaynakDir))
  }

  if (kuruMu) {
    yaz('\n--dry-run verildi, paketleme yapilmadi.\n')
    return
  }

  // Yapi damgasi ve paketleme. `--dist`, kirli calisma agacinda durur.
  yaz('\nPaketleniyor...\n')
  const damga = spawnSync(process.execPath, [path.join(KOK, 'scripts', 'stamp-build.mjs'), '--dist'], {
    cwd: KOK, stdio: 'inherit',
  })
  if (damga.status !== 0) process.exit(damga.status || 1)

  const builder = spawnSync('npx', ['electron-builder', ...hedefler], {
    cwd: KOK, stdio: 'inherit', env: process.env,
  })
  if (builder.status !== 0) process.exit(builder.status || 1)

  if (tasinabilir && arg.win === true) {
    const klasor = path.join(KOK, 'release', mimari === 'x64' ? 'win-unpacked' : 'win-' + mimari + '-unpacked')
    // Gomulu verinin pakete GERCEKTEN girdigini dogrula. Bos bir
    // build/bundled-data klasoru sessizce hicbir sey kopyalamaz ve hata
    // musterinin makinesinde "kayit yok" diye ortaya cikardi.
    const kaynaklar = path.join(klasor, 'resources', 'bundled-data')
    if (!veriYok) {
      if (!fs.existsSync(kaynaklar) || fs.readdirSync(kaynaklar).length === 0) {
        yaz('\nUYARI: pakette gomulu veri YOK. build/bundled-data bos kalmis olabilir.')
        process.exitCode = 1
      } else {
        yaz('  Pakete giren veri: ' + fs.readdirSync(kaynaklar).length + ' dosya')
      }
    }

    const zipYolu = path.join(KOK, 'release', 'ZoneMemory-windows-' + mimari + '.zip')
    yaz('\nZip hazirlaniyor (birkac dakika surebilir)...')
    const zip = spawnSync('zip', ['-r', '-q', '-1', zipYolu, path.basename(klasor)], {
      cwd: path.join(KOK, 'release'), stdio: 'inherit',
    })
    if (zip.status !== 0) {
      yaz('Zip olusturulamadi, klasoru elle sikistirabilirsin: ' + klasor)
    } else {
      const st = fs.statSync(zipYolu)
      yaz('\nBitti: ' + zipYolu + ' (' + boyut(st.size) + ')')
      yaz('Musteri bunu acip icindeki "Zone Memory.exe" dosyasini calistirir.')
    }
    yaz('')
    return
  }

  yaz('\nBitti. Kurulum dosyasi release/ klasorunde.')
  if (os.platform() !== 'win32' && arg.win === true) {
    yaz('Not: NSIS kurulum dosyasi macOS uzerinde wine gerektirir.')
    yaz('     wine yoksa --tasinabilir ile kurulumsuz paket al.')
  }
  yaz('')
}

main()
