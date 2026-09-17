// Electron olmadan gecmis mum verisi indirir.
//
// `src/core/data/loader.js` icindeki syncHistory kullanilir: eksik araliklar
// saptanir, secilen saglayicidan cekilir ve ikili depoya eklenir. Ilerleme
// stderr'e yazilir, ozet stdout'a.
//
// Kullanim:
//   node scripts/fetch-history.mjs --provider histdata --tf 1m --from 2009-03 --to 2026-08
//   node scripts/fetch-history.mjs --provider polygon --tf 1m --from 2024-01 --key ANAHTAR
//   node scripts/fetch-history.mjs --list
//
// Tarih bicimleri: 2009-03, 2009-03-15, 2009-03-15T22:00:00Z veya UNIX saniye.
// --to icin ay verilirse o ayin SONU, gun verilirse o gunun sonu kabul edilir.

import path from 'node:path'
import { createRequire } from 'node:module'
import { dataDir as varsayilanVeriKlasoru, ensureDataDir, candlePath, DEFAULT_SYMBOL } from './userdata-path.mjs'

// Cekirdek moduller CommonJS oldugu icin createRequire ile yuklenir.
const require = createRequire(import.meta.url)
const binstore = require('../src/core/store/binstore.js')
const { tfSeconds, tfLabel, TF_LIST } = require('../src/core/tf.js')
const saglayicilar = require('../src/core/data/provider.js')
const { argumanlariAyristir, sayiBicim, zamanBicim, bildir } = require('../src/core/util/cli.js')

/** Saglayici basina anahtar okunabilecek ortam degiskenleri. */
const ANAHTAR_ORTAM = {
  twelvedata: ['TWELVEDATA_API_KEY', 'ZONE_MEMORY_TWELVEDATA_KEY'],
  polygon: ['POLYGON_API_KEY', 'ZONE_MEMORY_POLYGON_KEY'],
}

/* ------------------------------------------------------------------ */
/* Kucuk yardimcilar                                                    */
/* ------------------------------------------------------------------ */
/* Arguman ayristirma ve bicimleme src/core/util/cli.js icindedir.      */

/**
 * Tarih metnini UNIX saniyeye cevirir.
 * @param {string} metin '2009-03', '2009-03-15', ISO 8601 veya UNIX saniye
 * @param {boolean} sonu true ise verilen donemin SONU (dislayici ust sinir)
 * @returns {number}
 */
function zamanCoz(metin, sonu) {
  const s = String(metin).trim()
  if (/^\d{9,}$/.test(s)) return Number(s)

  let e = /^(\d{4})-(\d{2})$/.exec(s)
  if (e) {
    const yil = Number(e[1])
    const ay = Number(e[2]) - 1
    if (sonu) return Math.floor(Date.UTC(yil, ay + 1, 1) / 1000)
    return Math.floor(Date.UTC(yil, ay, 1) / 1000)
  }

  e = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (e) {
    const yil = Number(e[1])
    const ay = Number(e[2]) - 1
    const gun = Number(e[3])
    if (sonu) return Math.floor(Date.UTC(yil, ay, gun + 1) / 1000)
    return Math.floor(Date.UTC(yil, ay, gun) / 1000)
  }

  const ms = Date.parse(s)
  if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  throw new Error(
    'Tarih anlasilamadi: "' + metin + '". Ornek bicimler: 2009-03, 2009-03-15, ' +
      '2009-03-15T22:00:00Z'
  )
}

/** Saglayici listesini okunabilir sekilde yazar. */
function saglayicilariYaz() {
  const liste = saglayicilar.listProviders()
  let cikti = 'Veri saglayicilari:\n\n'
  for (let i = 0; i < liste.length; i++) {
    const p = liste[i]
    cikti += '  ' + p.id.padEnd(12) + p.name + '\n'
    cikti +=
      '  ' + ' '.repeat(12) + 'anahtar: ' + (p.needsKey ? 'gerekli' : 'gerekmez') +
      ', yetenek: ' + p.caps.join('+') +
      ', fiyat: ' + (p.isProxy ? 'vekil' : 'spot') + '\n'
    cikti += '  ' + ' '.repeat(12) + p.note + '\n\n'
  }
  process.stdout.write(cikti)
}

/**
 * loader modulunu yukler. Henuz yazilmadiysa anlamli hata verir.
 * @returns {object}
 */
function loaderYukle() {
  let loader = null
  try {
    loader = require('../src/core/data/loader.js')
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && /loader/.test(String(err.message))) {
      throw new Error(
        'src/core/data/loader.js bulunamadi. Gecmis indirme modulu olmadan bu betik calisamaz.'
      )
    }
    throw err
  }
  if (!loader || typeof loader.syncHistory !== 'function') {
    throw new Error('src/core/data/loader.js icinde syncHistory fonksiyonu yok.')
  }
  return loader
}

/* ------------------------------------------------------------------ */
/* Ana akis                                                             */
/* ------------------------------------------------------------------ */

const YARDIM =
  'Secilen saglayicidan gecmis mum verisi indirir ve ikili depoya ekler.\n' +
  '\n' +
  'Kullanim: node scripts/fetch-history.mjs [secenekler]\n' +
  '\n' +
  '  --provider <id>   Saglayici (varsayilan histdata). Liste icin --list\n' +
  '  --tf <zaman>      Zaman dilimi (varsayilan 1m): ' + TF_LIST.join(' ') + '\n' +
  '  --from <tarih>    Baslangic (varsayilan 2009-03)\n' +
  '  --to <tarih>      Bitis (varsayilan bugun)\n' +
  '  --key <anahtar>   API anahtari (twelvedata ve polygon icin gerekli)\n' +
  '  --data-dir <yol>  Veri klasoru (varsayilan uygulama veri klasoru)\n' +
  '  --symbol <ad>     Dosya adi oneki (varsayilan XAUUSD)\n' +
  '  --list            Saglayicilari listeler ve cikar\n' +
  '  --help            Bu yardimi goster\n'

async function main() {
  const args = argumanlariAyristir(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(YARDIM)
    return
  }
  if (args.list) {
    saglayicilariYaz()
    return
  }

  const saglayiciId = typeof args.provider === 'string' ? args.provider : 'histdata'
  const tf = typeof args.tf === 'string' ? args.tf : '1m'
  const sembol = typeof args.symbol === 'string' ? args.symbol : DEFAULT_SYMBOL
  const klasor =
    typeof args['data-dir'] === 'string'
      ? path.resolve(args['data-dir'])
      : varsayilanVeriKlasoru()

  // Zaman dilimi taninmiyorsa burada anlasilir bir hata alinir.
  tfSeconds(tf)

  // Saglayici taninmiyorsa provider.js secenekleri listeleyen hata firlatir.
  const saglayici = saglayicilar.getProvider(saglayiciId)
  if (saglayici.caps.indexOf('history') < 0) {
    throw new Error(
      saglayici.name + ' gecmis veri vermez, yalnizca canli akis icindir. ' +
        'Gecmis icin --provider histdata kullanin.'
    )
  }

  let anahtar = typeof args.key === 'string' ? args.key : ''
  if (!anahtar) {
    const adaylar = ANAHTAR_ORTAM[saglayiciId] || []
    for (let i = 0; i < adaylar.length; i++) {
      if (process.env[adaylar[i]]) {
        anahtar = process.env[adaylar[i]]
        break
      }
    }
  }
  if (saglayici.needsKey && !anahtar) {
    const adaylar = ANAHTAR_ORTAM[saglayiciId] || []
    throw new Error(
      saglayici.name + ' bir API anahtari ister. --key ile verin' +
        (adaylar.length ? ' veya ' + adaylar[0] + ' ortam degiskenini kullanin.' : '.')
    )
  }

  const from = zamanCoz(typeof args.from === 'string' ? args.from : '2009-03', false)
  const to = zamanCoz(
    typeof args.to === 'string' ? args.to : new Date().toISOString().slice(0, 10),
    true
  )
  if (!(to > from)) {
    throw new Error('--to degeri --from degerinden sonra olmali.')
  }

  const loader = loaderYukle()
  ensureDataDir(klasor)

  bildir('Saglayici : ' + saglayici.name + (saglayici.isProxy ? ' (vekil fiyat)' : ''))
  bildir('Zaman     : ' + tfLabel(tf))
  bildir('Aralik    : ' + zamanBicim(from) + ' - ' + zamanBicim(to))
  bildir('Klasor    : ' + klasor)
  bildir('')

  // Ilerleme cok sik gelebilir; ekrani bogmamak icin kisilir.
  let sonYuzde = -1
  let sonAn = 0
  function ilerleme(pct, msg) {
    const yuzde = Number.isFinite(pct) ? Math.round(pct) : 0
    const simdi = Date.now()
    if (yuzde === sonYuzde && simdi - sonAn < 1000) return
    sonYuzde = yuzde
    sonAn = simdi
    bildir('  %' + String(yuzde).padStart(3) + '  ' + (msg || ''))
  }

  const baslangic = Date.now()
  const sonuc = await loader.syncHistory({
    dataDir: klasor,
    tf: tf,
    providerId: saglayiciId,
    apiKey: anahtar,
    from: from,
    to: to,
    symbol: sembol,
    onProgress: ilerleme,
  })
  const gecen = (Date.now() - baslangic) / 1000

  const o = sonuc && typeof sonuc === 'object' ? sonuc : {}
  let cikti = '\nIndirme tamamlandi (' + gecen.toFixed(1).replace('.', ',') + ' sn)\n'
  if (Array.isArray(o.ranges)) {
    if (o.ranges.length === 0) {
      cikti += 'Eksik aralik yoktu, depo zaten guncel.\n'
    } else {
      for (let i = 0; i < o.ranges.length; i++) {
        const r = o.ranges[i]
        cikti +=
          'Aralik      : ' + (r.label || zamanBicim(r.from) + ' - ' + zamanBicim(r.to)) +
          ' (' + sayiBicim(r.bars || 0) + ' mum)\n'
      }
    }
  }
  if (Number.isFinite(o.fetched)) cikti += 'Cekilen mum : ' + sayiBicim(o.fetched) + '\n'
  if (Number.isFinite(o.added)) cikti += 'Eklenen mum : ' + sayiBicim(o.added) + '\n'

  const yol = typeof o.path === 'string' && o.path ? o.path : candlePath(tf, sembol, klasor)
  const durum = await binstore.statSeries(yol)
  if (durum) {
    cikti += 'Depo        : ' + yol + '\n'
    cikti +=
      'Icerik      : ' + sayiBicim(durum.count) + ' mum, ' +
      zamanBicim(durum.firstTime) + ' - ' + zamanBicim(durum.lastTime) + '\n'
  } else {
    cikti += 'Depo dosyasi olusmadi: ' + yol + '\n'
  }
  process.stdout.write(cikti)
}

main().catch(function (err) {
  process.stderr.write('\nHata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
