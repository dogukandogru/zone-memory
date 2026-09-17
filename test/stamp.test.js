// Yapi damgasi (scripts/stamp-build.mjs) dogrulamasi.
//
// Asil hata buradaydi: pencere basligi bir commit gosteriyordu ama calisan kod
// o commit degildi, kaydedilmemis degisiklikler vardi. Hangi olcumun hangi
// kodla alindigi izlenemiyordu. Damga artik kirliligi ve kaynak agacinin
// icerik ozetini de tasiyor; asagidaki testler bu iki alanin anlamli
// kaldigini dogrular.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const KOK = path.join(__dirname, '..')
const BETIK = path.join(KOK, 'scripts', 'stamp-build.mjs')
const DAMGA = path.join(KOK, 'src', 'build-info.json')

/** Damga betigini calistirir, cikis kodunu ve stderr'i dondurur. */
function betigiCalistir(argv, env) {
  return spawnSync(process.execPath, [BETIK].concat(argv || []), {
    cwd: KOK,
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {}),
  })
}

/** Damga dosyasini okur. */
function damgayiOku() {
  return JSON.parse(fs.readFileSync(DAMGA, 'utf8'))
}

/** `git status --porcelain` satir sayisi, git yoksa null. */
function porcelainSayisi() {
  try {
    const cikti = execFileSync('git', ['status', '--porcelain'], {
      cwd: KOK, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return cikti.split('\n').map((s) => s.trim()).filter(Boolean).length
  } catch {
    return null
  }
}

test('damga alanlari dolu ve srcHash 12 hane', () => {
  const sonuc = betigiCalistir([])
  assert.strictEqual(sonuc.status, 0, 'betik hata verdi: ' + sonuc.stderr)
  const damga = damgayiOku()

  assert.ok(damga.builtAt && !isNaN(new Date(damga.builtAt).getTime()), 'builtAt gecersiz')
  assert.strictEqual(typeof damga.dirty, 'boolean')
  assert.ok(Number.isInteger(damga.changedFiles) && damga.changedFiles >= 0)
  assert.match(damga.srcHash, /^[0-9a-f]{12}$/)
})

/** src/ agacinin degisip degismedigini anlamak icin yol+boyut+mtime imzasi. */
function srcImzasi(dir) {
  const parcalar = []
  for (const g of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const tam = path.join(dir, g.name)
    if (g.isDirectory()) parcalar.push(srcImzasi(tam))
    else if (g.isFile() && tam !== DAMGA) {
      const st = fs.statSync(tam)
      parcalar.push(tam + ':' + st.size + ':' + st.mtimeMs)
    }
  }
  return parcalar.join('|')
}

test('srcHash ayni kaynak agacinda deterministik', (t) => {
  const kaynak = path.join(KOK, 'src')
  const imzaOnce = srcImzasi(kaynak)
  assert.strictEqual(betigiCalistir([]).status, 0)
  const bir = damgayiOku().srcHash
  assert.strictEqual(betigiCalistir([]).status, 0)
  const iki = damgayiOku().srcHash
  // Iki calistirma arasinda kaynak degistiyse (ornegin editor kaydetti)
  // ozetin farkli olmasi dogru davranistir, test atlanir.
  if (srcImzasi(kaynak) !== imzaOnce) return t.skip('src/ test sirasinda degisti')
  // Damga dosyasinin kendisi ozete girmez, yoksa builtAt her calistirmada
  // degistigi icin ozet hicbir zaman ayni cikmazdi.
  assert.strictEqual(iki, bir, 'srcHash iki calistirmada farkli cikti')
})

test('dirty bayragi porcelain sayisiyla tutarli', (t) => {
  const once = porcelainSayisi()
  if (once === null) return t.skip('git calistirilamadi')
  assert.strictEqual(betigiCalistir([]).status, 0)
  const damga = damgayiOku()
  // Betik calisirken baska bir surec dosya degistirirse sayim kayar; boyle bir
  // yarisi hata gibi gostermemek icin test atlanir.
  if (porcelainSayisi() !== once) return t.skip('calisma agaci test sirasinda degisti')
  assert.strictEqual(damga.changedFiles, once)
  assert.strictEqual(damga.dirty, once > 0)
})

test('--dist kirli agacta durur, ALLOW_DIRTY=1 ile gecer', (t) => {
  const sayi = porcelainSayisi()
  if (sayi === null) return t.skip('git calistirilamadi')
  if (sayi === 0) return t.skip('agac temiz, kirli yol denenemez')

  const durdu = betigiCalistir(['--dist'], { ALLOW_DIRTY: '' })
  assert.strictEqual(durdu.status, 1, 'kirli agacta paketleme durmadi')
  assert.match(durdu.stderr, /kirli/)

  const gecti = betigiCalistir(['--dist'], { ALLOW_DIRTY: '1' })
  assert.strictEqual(gecti.status, 0, 'ALLOW_DIRTY=1 ile gecmeliydi: ' + gecti.stderr)
})
