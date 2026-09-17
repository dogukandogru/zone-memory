// Tek seferlik goc: depodaki HistData kaynakli barlarin yaz saati kaymasini
// duzeltir.
//
// Sorun: histdata.js dosya saatlerini SABIT UTC-5 sayiyordu. Olculdu ki
// gercekte yaz saati uygulaniyor (2018 ve oncesi ABD, 2019 ve sonrasi AB
// kurali), yani yilin 7-8 ayinda depodaki her bar gercek UTC'den 1 saat GEC
// etiketli. Ayristirici duzeltildi (src/core/data/histdata.js dosyaOfsetiSn);
// bu betik daha once yazilmis barlari duzeltir.
//
// Ne yapar: yaz saati doneminde olan barlarin zamanini 3600 saniye geri
// alir, bar sayisini ve siralamayi korur. Zaman damgali yedek alir ve
// bitince <ad>.dst.json isaret dosyasi yazar; isaret varken yeniden
// calismayi reddeder (cift kaydirma seriyi bozar).
//
// SIRA ONEMLI: once vekil bolum kesilmeli (scripts/repair-proxy.mjs), sonra
// bu goc, en son yeni ayristiriciyla eksik ay indirilmelidir. Aksi halde
// yeni ayristiricinin dogru yazdigi barlar ikinci kez kaydirilir.
//
// Kullanim:
//   node scripts/fix-dst.mjs              # yalnizca rapor
//   node scripts/fix-dst.mjs --apply      # yedekle ve uygula

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
const histdata = require('../src/core/data/histdata.js')
const { argumanlariAyristir, damga } = require('../src/core/util/cli.js')

const SAAT = 3600
const TURETILEN = ['5m', '15m', '1h', '4h']

/** UNIX saniyeyi okunur UTC metnine cevirir. */
function zamanYaz(t) {
  if (!Number.isFinite(t)) return '-'
  return new Date(t * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * Bir barin yaz saati doneminde olup olmadigini, DOSYA saatine gore soyler.
 * Depodaki zaman = dosya saati + 5 saat (eski, hatali kural). Dosya gununu
 * bulmak icin once 5 saat geri alinir.
 */
function yazSaatindeMi(depoZamani) {
  const dosyaAni = depoZamani - 5 * SAAT
  const d = new Date(dosyaAni * 1000)
  return histdata._dosyaOfsetiSn(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) !== 5 * SAAT
}

async function main() {
  const arg = argumanlariAyristir(process.argv.slice(2))
  if (arg.help || arg.h) {
    process.stdout.write([
      'Depodaki HistData barlarinin yaz saati kaymasini duzeltir (tek seferlik).',
      '',
      '  --data-dir <yol>  Veri klasoru',
      '  --symbol <ad>     Sembol (varsayilan ' + DEFAULT_SYMBOL + ')',
      '  --until <tarih>   Bu andan ONCEKI barlar duzeltilir (varsayilan: vekil',
      '                    kaydindaki ilk vekil baslangici, yoksa deponun sonu)',
      '  --apply           Degisiklikleri yaz (varsayilan: yalnizca rapor)',
      '  --force           Isaret dosyasi olsa bile yeniden calistir',
      '',
    ].join('\n'))
    return
  }

  const dataDir = arg['data-dir'] && arg['data-dir'] !== true ? String(arg['data-dir']) : varsayilanDataDir()
  const symbol = arg.symbol && arg.symbol !== true ? String(arg.symbol) : DEFAULT_SYMBOL
  const uygula = !!arg.apply
  const dosya = path.join(dataDir, loader.candleFileName('1m', symbol))
  const isaretYolu = dosya.replace(/\.bin$/, '') + '.dst.json'

  process.stdout.write('Veri klasoru : ' + dataDir + '\n')
  if (!fs.existsSync(dosya)) {
    process.stderr.write('1m depo dosyasi bulunamadi.\n')
    process.exitCode = 1
    return
  }
  if (fs.existsSync(isaretYolu) && !arg.force) {
    process.stdout.write('Bu depo zaten duzeltilmis (' + path.basename(isaretYolu) +
      '). Yeniden calistirmak seriyi bozar. Gerekiyorsa --force verin.\n')
    return
  }

  const s = await binstore.readSeries(dosya)
  if (!s || s.length === 0) {
    process.stderr.write('Depo bos.\n')
    process.exitCode = 1
    return
  }

  // Ust sinir: yeni ayristirici ile yazilmis barlar duzeltilmemeli.
  let sinir = null
  if (arg.until && arg.until !== true) {
    const sayi = Number(arg.until)
    sinir = Number.isFinite(sayi) && sayi > 1000000000 ? Math.floor(sayi) : Math.floor(Date.parse(String(arg.until)) / 1000)
  }
  if (sinir === null) {
    const araliklar = await loader.vekilAraliklariOku(dataDir, '1m', symbol)
    if (araliklar.length > 0) sinir = araliklar.reduce((en, r) => Math.min(en, r.from), Infinity)
  }
  if (sinir === null) sinir = s.time[s.length - 1] + 1

  process.stdout.write('Bar sayisi   : ' + s.length + ' (' + zamanYaz(s.time[0]) +
    ' - ' + zamanYaz(s.time[s.length - 1]) + ')\n')
  process.stdout.write('Duzeltme siniri: ' + zamanYaz(sinir) + ' (bu andan oncekiler)\n')

  let kaydirilan = 0
  for (let i = 0; i < s.length; i++) {
    if (s.time[i] >= sinir) break
    if (yazSaatindeMi(s.time[i])) kaydirilan++
  }
  process.stdout.write('Kaydirilacak bar: ' + kaydirilan + ' (' +
    (s.length > 0 ? ((kaydirilan / s.length) * 100).toFixed(1) : '0') + '%)\n')

  if (kaydirilan === 0) {
    process.stdout.write('Kaydirilacak bar yok.\n')
    return
  }
  if (!uygula) {
    process.stdout.write('\nYalnizca rapor. Uygulamak icin --apply ekleyin.\n')
    return
  }

  const yedek = dosya + '.bak-' + damga()
  await fsp.copyFile(dosya, yedek)
  process.stdout.write('\nYedek alindi: ' + path.basename(yedek) + '\n')

  const yeni = series.createSeries(s.length)
  for (let i = 0; i < s.length; i++) {
    const t = s.time[i]
    yeni.time[i] = (t < sinir && yazSaatindeMi(t)) ? t - SAAT : t
    yeni.open[i] = s.open[i]
    yeni.high[i] = s.high[i]
    yeni.low[i] = s.low[i]
    yeni.close[i] = s.close[i]
    yeni.volume[i] = s.volume[i]
  }

  // Kaydirma sonrasi sira bozulmamali: yaz saati gecisleri hafta sonuna
  // denk geldigi icin veri icermez, yine de dogrularız.
  let sirasiz = 0
  for (let i = 1; i < yeni.length; i++) {
    if (yeni.time[i] <= yeni.time[i - 1]) sirasiz++
  }
  if (sirasiz > 0) {
    process.stderr.write('Kaydirma sonrasi ' + sirasiz + ' bar sirasiz kaldi, yazilmadi. ' +
      'Yedek yerinde: ' + path.basename(yedek) + '\n')
    process.exitCode = 1
    return
  }

  await binstore.writeSeries(dosya, yeni)
  process.stdout.write('1m deposu yazildi: ' + yeni.length + ' bar, son ' +
    zamanYaz(yeni.time[yeni.length - 1]) + '\n')

  for (const tf of TURETILEN) {
    const yol = path.join(dataDir, loader.candleFileName(tf, symbol))
    const orneklenmis = series.resample(yeni, tfSeconds(tf))
    if (fs.existsSync(yol)) await fsp.copyFile(yol, yol + '.bak-' + damga())
    await binstore.writeSeries(yol, orneklenmis)
    process.stdout.write('  ' + tf.padEnd(4) + ' yeniden uretildi: ' + orneklenmis.length + ' bar\n')
  }

  await fsp.writeFile(isaretYolu, JSON.stringify({
    version: 1,
    appliedAt: new Date().toISOString(),
    shiftedBars: kaydirilan,
    untilTime: sinir,
    note: 'HistData yaz saati goc'+'u uygulandi, tekrar calistirilmamali.',
  }, null, 2), 'utf8')
  process.stdout.write('\nIsaret dosyasi yazildi: ' + path.basename(isaretYolu) + '\n')
  process.stdout.write('Hafizalari yeniden tarayin.\n')
}

main().catch((err) => {
  process.stderr.write('Hata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
