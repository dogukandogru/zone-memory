// Depo butunlugu: cekirdek modullerin tamami yuklenebilmeli ve kaynak kod
// yanlislikla .gitignore ile yok sayilmamalidir. (Veri katmani bir donem
// `data/` kurali yuzunden hic commit edilmemisti.)
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const KOK = path.join(__dirname, '..')
const CEKIRDEK = path.join(KOK, 'src', 'core')

/** Klasordeki tum .js dosyalarini ozyinelemeli toplar. */
function jsDosyalari(dir) {
  const cikti = []
  for (const girdi of fs.readdirSync(dir, { withFileTypes: true })) {
    const tam = path.join(dir, girdi.name)
    if (girdi.isDirectory()) cikti.push(...jsDosyalari(tam))
    else if (girdi.name.endsWith('.js')) cikti.push(tam)
  }
  return cikti
}

test('src/core altindaki her modul yuklenebiliyor', () => {
  const dosyalar = jsDosyalari(CEKIRDEK)
  assert.ok(dosyalar.length >= 15, `beklenenden az modul bulundu: ${dosyalar.length}`)
  for (const dosya of dosyalar) {
    assert.doesNotThrow(() => require(dosya), `yuklenemedi: ${path.relative(KOK, dosya)}`)
  }
})

// EM-DASH YASAGI
// Genel kural: em-dash (U+2014) karakteri hicbir yerde kullanilmaz, ne kodda
// ne yorumda ne kullaniciya gorunen metinde. Arayuz metinleri ve gerekce
// cumleleri elle yazildigi icin bu karakter kolayca sizar; tek tek kontrol
// etmek yerine depo taranir.
//
// TEK MUAFIYET: kuralin KENDISINI anlatan satirlar (CONTRACTS.md icindeki
// kural maddesi gibi). O satirlarda karakterin gecmesi kacinilmazdir.
test('src, scripts, test, README ve CONTRACTS icinde em-dash gecmez', () => {
  // Karakter kodda yazilmaz, kod noktasindan uretilir.
  const EM_DASH = String.fromCharCode(0x2014)
  const UZANTILAR = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md'])

  /** Taranacak dosyalari toplar. */
  function metinDosyalari(dir) {
    const cikti = []
    for (const girdi of fs.readdirSync(dir, { withFileTypes: true })) {
      const tam = path.join(dir, girdi.name)
      if (girdi.isDirectory()) {
        if (girdi.name === 'node_modules' || girdi.name.startsWith('.')) continue
        cikti.push(...metinDosyalari(tam))
      } else if (UZANTILAR.has(path.extname(girdi.name))) {
        cikti.push(tam)
      }
    }
    return cikti
  }

  const hedefler = []
  for (const klasor of ['src', 'scripts', 'test']) {
    hedefler.push(...metinDosyalari(path.join(KOK, klasor)))
  }
  for (const dosya of ['README.md', 'CONTRACTS.md']) {
    hedefler.push(path.join(KOK, dosya))
  }
  assert.ok(hedefler.length >= 30, `beklenenden az dosya tarandi: ${hedefler.length}`)

  const bulgular = []
  for (const dosya of hedefler) {
    const satirlar = fs.readFileSync(dosya, 'utf8').split('\n')
    for (let i = 0; i < satirlar.length; i++) {
      if (!satirlar[i].includes(EM_DASH)) continue
      // Kuralin kendisini anlatan satir muaftir.
      if (/em[-_ ]?dash/i.test(satirlar[i])) continue
      bulgular.push(`${path.relative(KOK, dosya)}:${i + 1}: ${satirlar[i].trim().slice(0, 80)}`)
    }
  }
  assert.deepStrictEqual(bulgular, [], `em-dash bulundu:\n${bulgular.join('\n')}`)
})

test('src altinda yok sayilan tek dosya uretilen yapi damgasidir', (t) => {
  if (!fs.existsSync(path.join(KOK, '.git'))) return t.skip('git deposu yok')
  let cikti
  try {
    cikti = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', 'src'], {
      cwd: KOK, encoding: 'utf8',
    })
  } catch {
    return t.skip('git calistirilamadi')
  }
  const yokSayilan = cikti.split('\n').map((s) => s.trim()).filter(Boolean)
  // src/build-info.json  : her yapida uretilir.
  // src/main/apiKeys.local.json : pakete gomulen API anahtari. Depo HERKESE
  //   ACIK (surum yayinlamak icin boyle), dolayisiyla anahtar git'e GIRMEMELI.
  //   Yayinda GitHub deposunun sirrindan uretilir, yerelde elle olusturulur.
  const beklenen = ['src/build-info.json', 'src/main/apiKeys.local.json']
  const fazlalik = yokSayilan.filter((d) => !beklenen.includes(d))
  assert.deepStrictEqual(fazlalik, [], `kaynak dosyalar yok sayiliyor: ${fazlalik.join(', ')}`)
})

// KULLANICIYA GOSTERILEN SONUC KELIMESI TEK YERDEN GELIR.
//
// Grafik isareti bir donem "ÖRNEK saygı" yaziyordu. Bu, `respect` etiketinin
// birebir cevirisiydi ve kullaniciya hicbir sey anlatmiyordu; ustelik ikili
// oldugu icin zaman asimini "kirilim" gosteriyordu. Sonuc kelimeleri artik
// tek bir yardimcidan (panels.js sonucEtiketi) geliyor.
test('arayuz metinlerinde ham etiket cevirisi kullanilmaz', () => {
  // Yalnizca ANLAMSIZ ceviri yasaklanir. "kırılım" bilerek disarida:
  // "bileşen kırılımı" / "yıl kırılımı" bambaska bir anlamda ve mesrudur.
  const YASAK = ['saygı']
  const dosyalar = ['app.js', 'panels.js', 'overlay.js', 'chart.js', 'index.html']
  const bulgular = []
  for (const ad of dosyalar) {
    const yol = path.join(KOK, 'src', 'renderer', ad)
    if (!fs.existsSync(yol)) continue
    const satirlar = fs.readFileSync(yol, 'utf8').split('\n')
    for (let i = 0; i < satirlar.length; i++) {
      const satir = satirlar[i]
      // Kuralin kendisini anlatan yorum satirlari muaf.
      if (/^\s*(\/\/|\*|\/\*)/.test(satir)) continue
      for (const k of YASAK) {
        if (satir.includes(k)) bulgular.push(ad + ':' + (i + 1) + ': ' + satir.trim().slice(0, 70))
      }
    }
  }
  assert.deepStrictEqual(bulgular, [],
    'sonuc kelimesi sonucEtiketi() uzerinden gelmeli:\n' + bulgular.join('\n'))
})
