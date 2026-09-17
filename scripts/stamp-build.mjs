// Paketleme oncesi yapi damgasi yazar.
//
// Neden gerekli: surum numarasi her pakette ayni (0.1.0) oldugu icin
// "hangi yapiyi calistiriyorum" sorusunun cevabi yoktu. Bir hata bildirildiginde
// eski bir paketten mi geldigi anlasilamiyor ve bos yere aranmis oluyor.
// Bu damga arayuzde ve pencere basliginda gorunur.
//
// Neden yalnizca commit yetmiyor: pencere basligi bir commit gosterirken
// calisan kod o commit degildi (kaydedilmemis degisiklikler vardi). Hangi
// olcumun hangi kodla alindigi izlenemiyordu. Bu yuzden damga artik
// `git describe --always --dirty` cikisini, kirlilik bayragini, degisen dosya
// sayisini ve src/ agacinin icerik ozetini (srcHash) de tasir. srcHash git'e
// hic girmemis dosyalari da kapsar, yani diskteki gercek kodu tanimlar.
//
// --dist bayragi: kirli agactan paket uretmeyi engeller. Bilerek yapiliyorsa
// ALLOW_DIRTY=1 ortam degiskeni ile gecilir.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAMGA_DOSYASI = path.join('src', 'build-info.json')

/**
 * Git komutunu kokte calistirir, basarisizsa null doner.
 * @param {string[]} argv
 * @returns {string|null}
 */
function git(argv) {
  try {
    return execFileSync('git', argv, { cwd: kok, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
  } catch (err) {
    return null
  }
}

/** Etiket varsa etiket, yoksa kisa commit; agac kirliyse sonuna "-dirty". */
function gitKimligi() {
  const cikti = git(['describe', '--always', '--dirty'])
  return cikti === null ? '' : cikti.trim()
}

/**
 * `git status --porcelain` satirlari. Depo yoksa null doner (kirli/temiz
 * ayrimi yapilamaz, bu ikisi ayni sey degildir).
 * @returns {string[]|null}
 */
function degisenSatirlar() {
  const cikti = git(['status', '--porcelain'])
  if (cikti === null) return null
  return cikti.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * Klasordeki tum dosyalari ozyinelemeli toplar, koke gore goreli yol dondurur.
 * @param {string} dir
 * @param {string} onek
 * @returns {string[]}
 */
function dosyalar(dir, onek) {
  const cikti = []
  let girdiler
  try {
    girdiler = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return cikti
  }
  for (const g of girdiler) {
    const goreli = onek ? onek + '/' + g.name : g.name
    if (g.isDirectory()) cikti.push(...dosyalar(path.join(dir, g.name), goreli))
    else if (g.isFile()) cikti.push(goreli)
  }
  return cikti
}

/**
 * src/ agacindaki tum dosyalarin (git'e girmemis olanlar dahil) yollarindan ve
 * iceriklerinden sha256 ozeti uretir, ilk 12 hanesini dondurur.
 *
 * Damga dosyasinin kendisi haric tutulur: icinde her calistirmada degisen
 * builtAt alani var, dahil edilse ozet hicbir zaman ayni cikmazdi.
 * @returns {string}
 */
function srcOzeti() {
  const kaynak = path.join(kok, 'src')
  const liste = dosyalar(kaynak, 'src').filter((p) => p !== 'src/build-info.json')
  liste.sort()
  const ozet = crypto.createHash('sha256')
  for (const goreli of liste) {
    ozet.update(goreli, 'utf8')
    ozet.update('\0')
    ozet.update(fs.readFileSync(path.join(kok, goreli)))
    ozet.update('\0')
  }
  return ozet.digest('hex').slice(0, 12)
}

const distModu = process.argv.slice(2).includes('--dist')

// Depo yoksa kirlilik olculemez; "temiz" varsayilir, cunku karsilastirilacak
// bir commit de yoktur. Damga dosyasinin kendisi .gitignore icinde oldugu icin
// porcelain cikisinda gorunmez, ayrica dislemek gerekmez.
const satirlar = degisenSatirlar()
const degisenSayisi = satirlar === null ? 0 : satirlar.length
const kirli = degisenSayisi > 0

if (distModu && kirli && process.env.ALLOW_DIRTY !== '1') {
  process.stderr.write(
    'Paketleme durduruldu: calisma agaci kirli (' + degisenSayisi +
    ' commit edilmemis degisiklik).\n' +
    'Paketten alinan olcumun hangi kodla uretildigi izlenemez.\n' +
    'Degisiklikleri commit edin ya da bilerek yapiyorsaniz ALLOW_DIRTY=1 ile calistirin.\n'
  )
  process.exit(1)
}

const damga = {
  builtAt: new Date().toISOString(),
  commit: gitKimligi(),
  dirty: kirli,
  changedFiles: degisenSayisi,
  srcHash: srcOzeti(),
}

const hedef = path.join(kok, DAMGA_DOSYASI)
fs.writeFileSync(hedef, JSON.stringify(damga, null, 2) + '\n', 'utf8')
process.stderr.write(
  'Yapi damgasi: ' + damga.builtAt + ' ' + damga.commit +
  ' src:' + damga.srcHash +
  (damga.dirty ? ' (kirli, ' + damga.changedFiles + ' degisiklik)' : ' (temiz)') + '\n'
)
