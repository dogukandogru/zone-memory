// OANDA veri paketini hazirlar ve GitHub'a yayinlar.
//
// NEDEN
// Uygulama artik yalnizca OANDA ile calisiyor, ama kurulu makinelerin deposu
// HistData + Binance ile kurulmustu. Depo yeniden kurulmali ve OANDA'dan tek
// tek indirmek olculdu: 1 dakikalik tam gecmis ~7 milyon mum, bir saatten
// uzun suruyor. Musterinin makinesinde yapilamaz. Bu yuzden dosya BURADA
// hazirlanip surum varligi olarak yayinlaniyor; uygulama tek dosya indiriyor.
//
// Kullanim:
//   node scripts/publish-data.mjs --bin <XAUUSD_1m.bin yolu> --surum 1
//   node scripts/publish-data.mjs --bin ... --surum 1 --yayinla
//
// `--yayinla` verilmezse yalnizca hazirlar ve ozeti yazdirir; `dataBundle.js`
// icindeki PAKET_SHA256 degeri bu ciktidan alinir.
//
// SURUM ETIKETI ON SURUM OLARAK ISARETLENIR.
// GitHub'in "en son surum" adresi on surumleri atlar. Isaretlenmezse veri
// surumu en son surum olur, electron-updater orada latest.yml bulamaz ve
// OTOMATIK GUNCELLEME SESSIZCE KIRILIR. Daha once ayni tuzaga dusuldu.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const binstore = require('../src/core/store/binstore.js')
const { argumanlariAyristir } = require('../src/core/util/cli.js')

const yaz = (s) => process.stdout.write(s + '\n')

/** Dosyanin SHA-256 ozeti. */
async function ozet(dosya) {
  const h = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(dosya), h)
  return h.digest('hex')
}

const boyut = (b) => (b >= 1073741824
  ? (b / 1073741824).toFixed(2) + ' GB'
  : (b / 1048576).toFixed(0) + ' MB')

async function main() {
  const arg = argumanlariAyristir(process.argv.slice(2))
  const kaynak = typeof arg.bin === 'string' ? arg.bin : ''
  const surum = Number(arg.surum) || 1
  const yayinla = arg.yayinla === true

  if (!kaynak) {
    yaz('Kullanim: node scripts/publish-data.mjs --bin <XAUUSD_1m.bin> --surum 1 [--yayinla]')
    process.exit(1)
  }
  if (!fs.existsSync(kaynak)) {
    yaz('HATA: dosya yok: ' + kaynak)
    process.exit(1)
  }

  // DOGRULAMA: yayinlanan dosya okunabilir ve makul uzunlukta olmali.
  // Bozuk bir dosya yayinlanirsa her musteri onu indirir.
  const durum = await binstore.statSeries(kaynak)
  if (!durum || !durum.count) {
    yaz('HATA: dosya okunabilir bir mum deposu degil.')
    process.exit(1)
  }
  const ilk = new Date(durum.firstTime * 1000).toISOString().slice(0, 10)
  const son = new Date(durum.lastTime * 1000).toISOString().slice(0, 10)
  yaz('Kaynak : ' + kaynak)
  yaz('Mum    : ' + durum.count.toLocaleString('tr-TR') + ' (' + ilk + ' -> ' + son + ')')
  yaz('Boyut  : ' + boyut(fs.statSync(kaynak).size))

  const acikOzet = await ozet(kaynak)
  yaz('SHA-256 (acilmis hali): ' + acikOzet)

  const ad = 'XAUUSD_1m_oanda_v' + surum + '.bin.gz'
  const gzYol = path.join(path.dirname(kaynak), ad)
  yaz('\nSikistiriliyor: ' + ad)
  await pipeline(
    fs.createReadStream(kaynak),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(gzYol)
  )
  yaz('Sikistirilmis : ' + boyut(fs.statSync(gzYol).size))

  yaz('\nsrc/main/dataBundle.js icine yazilacak degerler:')
  yaz("  const GEREKLI_SURUM = " + surum)
  yaz("  const PAKET_SHA256 = '" + acikOzet + "'")

  if (!yayinla) {
    yaz('\n--yayinla verilmedi, yukleme yapilmadi.')
    return
  }

  const etiket = 'veri-v' + surum
  yaz('\nSurum olusturuluyor: ' + etiket + ' (ON SURUM)')
  // --prerelease SART: yoksa GitHub'in "en son surum" adresi buraya duser ve
  // electron-updater latest.yml bulamaz, otomatik guncelleme kirilir.
  const varMi = spawnSync('gh', ['release', 'view', etiket], { encoding: 'utf8' })
  if (varMi.status !== 0) {
    const olustur = spawnSync('gh', [
      'release', 'create', etiket,
      '--title', 'Veri paketi v' + surum,
      '--notes', 'OANDA XAU_USD 1 dakikalik mum deposu. Uygulama bunu kendisi indirir.',
      '--prerelease',
    ], { stdio: 'inherit' })
    if (olustur.status !== 0) {
      yaz('HATA: surum olusturulamadi.')
      process.exit(1)
    }
  }

  yaz('Yukleniyor (bu birkac dakika surebilir)')
  const yukle = spawnSync('gh', ['release', 'upload', etiket, gzYol, '--clobber'],
    { stdio: 'inherit' })
  if (yukle.status !== 0) {
    yaz('HATA: dosya yuklenemedi.')
    process.exit(1)
  }

  // GUVENLIK KONTROLU: "en son surum" hala uygulama surumu mu.
  const sonSurum = spawnSync('gh', ['api', 'repos/dogukandogru/zone-memory/releases/latest',
    '--jq', '.tag_name'], { encoding: 'utf8' })
  const sonEtiket = (sonSurum.stdout || '').trim()
  yaz('\nEn son surum: ' + sonEtiket)
  if (sonEtiket === etiket) {
    yaz('HATA: veri surumu "en son surum" oldu. electron-updater latest.yml bulamaz,')
    yaz('otomatik guncelleme kirilir. Surumu on surum olarak isaretleyin.')
    process.exit(1)
  }
  yaz('Tamam: veri surumu en son surum DEGIL, otomatik guncelleme etkilenmedi.')
  yaz('\nIndirme adresi:')
  yaz('  https://github.com/dogukandogru/zone-memory/releases/download/' + etiket + '/' + ad)
}

main().catch((err) => {
  process.stderr.write('HATA: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exit(1)
})
