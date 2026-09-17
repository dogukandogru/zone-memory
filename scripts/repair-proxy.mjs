// Kirlenmis mum deposunu onarir: vekil kaynakla (PAXG, XAUT, GC=F) yazilmis
// son bolumu keser ve turetilmis zaman dilimlerini 1 dakikalik seriden
// yeniden uretir.
//
// Neden gerekli: canli dongu bir donem basis ve hacim olcegi uygulamadan ham
// PAXG barlarini depoya yazdi. Ham bar bir kez girince fiyat kaydirmasi
// hesabi 0 cikip duzeltme kalici olarak kapaniyor, senkron da "ortak zaman
// bulunamadi" hatasiyla kilitleniyor. Kod tarafindaki kalici duzeltme
// loader.normalizeProxy icindedir (artik duzeltme hesaplanamazsa hicbir sey
// yazilmaz); bu betik gecmiste yazilmis barlari temizler.
//
// Vekil bolumun baslangici uc kaynaktan bulunur, sirasiyla:
//   1. --cut ile elle verilen tarih
//   2. XAUUSD_<tf>.proxy.json icindeki ilk vekil aralik (loader yazar)
//   3. Hacim damgasi: HistData hacmi dakikadaki TICK SAYISIDIR, yani tam
//      sayidir. Binance PAXG hacmi kesirlidir. Sondan geriye dogru gun gun
//      bakilir, tam sayi hacim orani %50'nin altinda kalan kesintisiz gun
//      dizisinin basi vekil baslangicidir.
//
// Kullanim:
//   node scripts/repair-proxy.mjs                 # yalnizca rapor
//   node scripts/repair-proxy.mjs --apply         # yedekle ve uygula
//   node scripts/repair-proxy.mjs --cut 2026-08-02T23:00:00Z --apply
//
// Varsayilan olarak HICBIR SEY YAZMAZ. --apply verilince once
// <ad>.bak-YYYYMMDD-HHMMSS yedegi alinir.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { dataDir as varsayilanDataDir, DEFAULT_SYMBOL } from './userdata-path.mjs'

const require = createRequire(import.meta.url)
const binstore = require('../src/core/store/binstore.js')
const series = require('../src/core/series.js')
const { tfSeconds } = require('../src/core/tf.js')
const loader = require('../src/core/data/loader.js')
const { createMarketCalendar } = require('../src/core/session.js')

const GUN = 86400
const VARSAYILAN_TURETILEN = ['5m', '15m', '1h', '4h']

/** Basit arguman ayristirici (--ad deger, --bayrak). */
function argumanlariAyristir(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const ad = a.slice(2)
    const sonraki = argv[i + 1]
    if (sonraki === undefined || sonraki.startsWith('--')) out[ad] = true
    else { out[ad] = sonraki; i++ }
  }
  return out
}

/** ISO tarih veya UNIX saniye kabul eder. */
function zamanCozumle(deger) {
  if (deger === undefined || deger === true) return null
  const sayi = Number(deger)
  if (Number.isFinite(sayi) && sayi > 1000000000) return Math.floor(sayi)
  const ms = Date.parse(String(deger))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** UNIX saniyeyi okunur UTC metnine cevirir. */
function zamanYaz(t) {
  if (!Number.isFinite(t)) return '-'
  return new Date(t * 1000).toISOString().replace('.000Z', 'Z')
}

/** Dosya adina zaman damgali yedek soneki uretir. */
function yedekAdi(dosya) {
  const d = new Date()
  const iki = (n) => String(n).padStart(2, '0')
  const damga = d.getUTCFullYear() + iki(d.getUTCMonth() + 1) + iki(d.getUTCDate()) +
    '-' + iki(d.getUTCHours()) + iki(d.getUTCMinutes()) + iki(d.getUTCSeconds())
  return dosya + '.bak-' + damga
}

/**
 * Gun bazinda tam sayi hacim orani. HistData tick sayisi verdigi icin 1.00'e
 * yakin, vekil kaynakta 0'a yakin cikar.
 * @returns {Array<{gun:number, bar:number, tamsayiOran:number}>}
 */
function gunlukHacimDamgasi(s) {
  const gunler = []
  let aktifGun = null
  let bar = 0
  let tam = 0
  for (let i = 0; i < s.length; i++) {
    const gun = Math.floor(s.time[i] / GUN)
    if (aktifGun === null) aktifGun = gun
    if (gun !== aktifGun) {
      gunler.push({ gun: aktifGun, bar: bar, tamsayiOran: bar > 0 ? tam / bar : 1 })
      aktifGun = gun
      bar = 0
      tam = 0
    }
    bar++
    if (Number.isInteger(s.volume[i])) tam++
  }
  if (aktifGun !== null) gunler.push({ gun: aktifGun, bar: bar, tamsayiOran: bar > 0 ? tam / bar : 1 })
  return gunler
}

/** Sondan geriye dogru vekil gun dizisinin basini bulur. */
function hacimDamgasindanKesim(s) {
  const gunler = gunlukHacimDamgasi(s)
  let ilkVekilGun = null
  for (let i = gunler.length - 1; i >= 0; i--) {
    if (gunler[i].tamsayiOran < 0.5) ilkVekilGun = gunler[i].gun
    else break
  }
  if (ilkVekilGun === null) return null
  return ilkVekilGun * GUN
}

/** Turetilmis zaman dilimlerini 1m serisinden yeniden uretir. */
async function turetilmisleriUret(dataDir, symbol, taban, tfListesi, uygula) {
  const sonuc = []
  for (const tf of tfListesi) {
    const hedef = loader.candleFileName(tf, symbol)
    const yol = path.join(dataDir, hedef)
    const orneklenmis = series.resample(taban, tfSeconds(tf))
    const oncekiDurum = await binstore.statSeries(yol)
    sonuc.push({
      tf: tf,
      onceki: oncekiDurum ? oncekiDurum.count : 0,
      sonraki: orneklenmis.length,
      sonBar: orneklenmis.length ? orneklenmis.time[orneklenmis.length - 1] : 0,
    })
    if (!uygula) continue
    if (fs.existsSync(yol)) await fsp.copyFile(yol, yedekAdi(yol))
    await binstore.writeSeries(yol, orneklenmis)
  }
  return sonuc
}

async function main() {
  const arg = argumanlariAyristir(process.argv.slice(2))
  if (arg.help || arg.h) {
    process.stdout.write([
      'Kirlenmis mum deposunu onarir (vekil bolumu keser, turetilmis tf\'leri yeniden uretir).',
      '',
      '  --data-dir <yol>   Veri klasoru (varsayilan: uygulama veri klasoru)',
      '  --symbol <ad>      Sembol (varsayilan ' + DEFAULT_SYMBOL + ')',
      '  --tf <zaman>       Taban seri (varsayilan 1m)',
      '  --cut <tarih>      Vekil baslangici (ISO veya UNIX saniye)',
      '  --tfs 5m,15m,1h,4h Yeniden uretilecek zaman dilimleri',
      '  --no-derive        Turetilmis zaman dilimlerini uretme',
      '  --apply            Degisiklikleri yaz (varsayilan: yalnizca rapor)',
      '',
    ].join('\n'))
    return
  }

  const dataDir = arg['data-dir'] && arg['data-dir'] !== true ? String(arg['data-dir']) : varsayilanDataDir()
  const symbol = arg.symbol && arg.symbol !== true ? String(arg.symbol) : DEFAULT_SYMBOL
  const tf = arg.tf && arg.tf !== true ? String(arg.tf) : '1m'
  const uygula = !!arg.apply
  const turetilenler = arg.tfs && arg.tfs !== true
    ? String(arg.tfs).split(',').map((x) => x.trim()).filter(Boolean)
    : VARSAYILAN_TURETILEN

  const dosya = path.join(dataDir, loader.candleFileName(tf, symbol))
  process.stdout.write('Veri klasoru : ' + dataDir + '\n')
  process.stdout.write('Taban seri   : ' + dosya + '\n')
  if (!fs.existsSync(dosya)) {
    process.stderr.write('Depo dosyasi bulunamadi.\n')
    process.exitCode = 1
    return
  }

  const s = await binstore.readSeries(dosya)
  if (!s || s.length === 0) {
    process.stderr.write('Depo bos.\n')
    process.exitCode = 1
    return
  }
  process.stdout.write('Bar sayisi   : ' + s.length + ' (' + zamanYaz(s.time[0]) +
    ' - ' + zamanYaz(s.time[s.length - 1]) + ')\n')

  // Kesim noktasi: once --cut, sonra proxy.json, sonra hacim damgasi.
  let kesim = zamanCozumle(arg.cut)
  let kaynak = 'elle (--cut)'
  if (kesim === null) {
    const araliklar = await loader.vekilAraliklariOku(dataDir, tf, symbol)
    if (araliklar.length > 0) {
      kesim = araliklar.reduce((en, r) => Math.min(en, r.from), Infinity)
      kaynak = 'vekil kaydi (' + path.basename(loader.vekilKayitYolu(dataDir, tf, symbol)) + ')'
    }
  }
  if (kesim === null) {
    kesim = hacimDamgasindanKesim(s)
    kaynak = 'hacim damgasi (kesirli hacimli gunler)'
  }
  if (kesim === null) {
    process.stdout.write('\nVekil bolum bulunamadi, depo temiz gorunuyor. Yapilacak bir sey yok.\n')
    return
  }

  const ilkAtilan = series.firstIndexAtOrAfter(s, kesim)
  const atilacak = ilkAtilan < 0 ? 0 : s.length - ilkAtilan
  process.stdout.write('\nVekil baslangici: ' + zamanYaz(kesim) + '  [' + kaynak + ']\n')
  process.stdout.write('Atilacak bar    : ' + atilacak + '\n')
  if (atilacak === 0) {
    process.stdout.write('Kesim noktasindan sonra bar yok, yapilacak bir sey yok.\n')
    return
  }

  // Atilacak bolumun ozeti: kesirli hacim ve piyasanin kapali oldugu barlar.
  const piyasaAcikMi = createMarketCalendar()
  let kesirli = 0
  let kapaliSaat = 0
  for (let i = ilkAtilan; i < s.length; i++) {
    if (!Number.isInteger(s.volume[i])) kesirli++
    if (!piyasaAcikMi(s.time[i])) kapaliSaat++
  }
  process.stdout.write('  kesirli hacimli : ' + kesirli + '\n')
  process.stdout.write('  piyasa kapali   : ' + kapaliSaat + '\n')

  const kirpilmis = series.sliceSeries(s, 0, ilkAtilan)
  process.stdout.write('Kalan bar       : ' + kirpilmis.length + ' (son bar ' +
    zamanYaz(kirpilmis.time[kirpilmis.length - 1]) + ')\n')

  // Hafizalar artik eski bar indekslerine isaret ediyor olabilir.
  const hafizalar = fs.readdirSync(dataDir).filter((ad) => ad.endsWith('_memory.json'))
  if (hafizalar.length > 0) {
    process.stdout.write('\nBu onarimdan sonra yeniden taranmasi gereken hafizalar:\n')
    for (const ad of hafizalar) process.stdout.write('  ' + ad.replace('_memory.json', '') + '\n')
  }

  if (!uygula) {
    process.stdout.write('\nYalnizca rapor. Uygulamak icin --apply ekleyin.\n')
    if (!arg['no-derive']) {
      const rapor = await turetilmisleriUret(dataDir, symbol, kirpilmis, turetilenler, false)
      process.stdout.write('\nTuretilecek zaman dilimleri (onceki -> sonraki bar):\n')
      for (const r of rapor) {
        process.stdout.write('  ' + r.tf.padEnd(4) + ' ' + String(r.onceki).padStart(9) +
          ' -> ' + String(r.sonraki).padStart(9) + '  son ' + zamanYaz(r.sonBar) + '\n')
      }
    }
    return
  }

  const yedek = yedekAdi(dosya)
  await fsp.copyFile(dosya, yedek)
  process.stdout.write('\nYedek alindi: ' + path.basename(yedek) + '\n')
  await binstore.writeSeries(dosya, kirpilmis)
  process.stdout.write('Taban seri yazildi.\n')

  if (!arg['no-derive']) {
    const rapor = await turetilmisleriUret(dataDir, symbol, kirpilmis, turetilenler, true)
    for (const r of rapor) {
      process.stdout.write('  ' + r.tf.padEnd(4) + ' yeniden uretildi: ' + r.sonraki +
        ' bar, son ' + zamanYaz(r.sonBar) + '\n')
    }
  }

  // Vekil kaydi artik gecersiz: kesilen bolum icin tutulan araliklar silinir.
  const kayitYolu = loader.vekilKayitYolu(dataDir, tf, symbol)
  if (fs.existsSync(kayitYolu)) {
    await fsp.rename(kayitYolu, yedekAdi(kayitYolu))
    process.stdout.write('Vekil aralik kaydi yedege alindi.\n')
  }

  process.stdout.write('\nTamamlandi. Simdi eksik donemi spot kaynakla doldurun ' +
    '(fetch-history --provider histdata) ve hafizalari yeniden tarayin.\n')
}

main().catch((err) => {
  process.stderr.write('Hata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
