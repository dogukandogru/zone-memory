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
  const beklenen = ['src/build-info.json']
  const fazlalik = yokSayilan.filter((d) => !beklenen.includes(d))
  assert.deepStrictEqual(fazlalik, [], `kaynak dosyalar yok sayiliyor: ${fazlalik.join(', ')}`)
})
