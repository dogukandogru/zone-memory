// Tum zaman dilimlerinde yuruyen ileri testi calistirip tek bir olcum
// tablosu uretir.
//
// Neden ayri betik: "yeni indikator gercekten katma deger uretiyor mu"
// sorusunun cevabi tek bir ekranda degil, zaman dilimleri arasinda
// karsilastirilarak okunur. Ayrica olcum tekrarlanabilir olmali: ayni komut,
// ayni ayar, ayni sayilar.
//
// Varsayilan olarak yalnizca TEST eder (hafiza zaten kuruluysa). --scan ile
// once hafizayi yeniden kurar. Cikti hem okunur tablo hem de --json ile ham
// veridir; --out ile dosyaya yazilir.
//
// Kullanim:
//   node scripts/measure-all.mjs
//   node scripts/measure-all.mjs --scan --tfs 5m,15m,1h
//   node scripts/measure-all.mjs --json --out olcum.json

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { dataDir as varsayilanDataDir, DEFAULT_SYMBOL } from './userdata-path.mjs'

const require = createRequire(import.meta.url)
const memstore = require('../src/core/store/memstore.js')
const binstore = require('../src/core/store/binstore.js')
const loader = require('../src/core/data/loader.js')
const memory = require('../src/core/learn/memory.js')
const backtest = require('../src/core/learn/backtest.js')
const cluster = require('../src/core/learn/cluster.js')
const presets = require('../src/core/learn/presets.js')
const { argumanlariAyristir, sayiBicim } = require('../src/core/util/cli.js')

const VARSAYILAN_TFS = ['1m', '5m', '15m', '1h', '4h']

/** Kullanicinin kayitli ayar yamasi (Electron olmadan okunur). */
function kullaniciYamasi (userDir) {
  try {
    const dosya = path.join(userDir || '', 'settings.json')
    const ham = JSON.parse(fs.readFileSync(dosya, 'utf8'))
    const yama = Object.assign({}, ham)
    delete yama.settingsVersion
    return yama
  } catch (err) {
    return {}
  }
}

const yuzde = (x, h = 1) => (Number.isFinite(x) ? (x * 100).toFixed(h) + '%' : '-')
const say = (x, h = 3) => (Number.isFinite(x) ? x.toFixed(h) : '-')

async function main () {
  const arg = argumanlariAyristir(process.argv.slice(2))
  if (arg.help || arg.h) {
    process.stdout.write([
      'Tum zaman dilimlerinde yuruyen ileri testi calistirir ve olcum tablosu basar.',
      '',
      '  --tfs 5m,15m,1h   Olculecek zaman dilimleri (varsayilan ' + VARSAYILAN_TFS.join(',') + ')',
      '  --scan            Once hafizayi yeniden kur (uzun surer)',
      '  --warmup <n>      Isinma olay sayisi alt siniri (varsayilan 500)',
      '  --bucket <n>      Tur ve yon basina asgari aday (varsayilan hazir ayar)',
      '  --data-dir <yol>  Veri klasoru',
      '  --user-dir <yol>  Ayar klasoru (settings.json)',
      '  --json            Ham JSON yaz',
      '  --out <dosya>     Ciktiyi dosyaya yaz',
      '',
    ].join('\n'))
    return
  }

  const dataDir = arg['data-dir'] && arg['data-dir'] !== true ? String(arg['data-dir']) : varsayilanDataDir()
  const userDir = arg['user-dir'] && arg['user-dir'] !== true ? String(arg['user-dir']) : path.dirname(dataDir)
  const tfs = arg.tfs && arg.tfs !== true
    ? String(arg.tfs).split(',').map((x) => x.trim()).filter(Boolean)
    : VARSAYILAN_TFS
  const warmup = Number.isFinite(Number(arg.warmup)) ? Number(arg.warmup) : 500
  const yama = kullaniciYamasi(userDir)

  const sonuclar = []
  for (const tf of tfs) {
    const satir = { tf: tf }
    const taban = path.join(dataDir, DEFAULT_SYMBOL + '_' + tf + '_memory')

    if (arg.scan) {
      const seri = await loader.loadSeries({ dataDir: dataDir, tf: tf })
      if (!seri || seri.length < 200) {
        satir.hata = 'yeterli mum yok'
        sonuclar.push(satir)
        continue
      }
      const cfgTara = presets.resolveCfg(tf, yama, null)
      const kurulan = memory.buildMemory(seri, {
        tf: tf,
        params: (yama.indicatorParams || {}),
        outcomeCfg: cfgTara.outcomeCfg,
      })
      await memstore.saveMemory(taban, {
        tf: tf,
        ctxNames: kurulan.ctxNames,
        events: kurulan.events,
        builtToTime: seri.time[seri.length - 1],
        indicatorParams: Object.assign({}, yama.indicatorParams || {}),
        outcomeCfg: cfgTara.outcomeCfg,
      })
      satir.scanStats = kurulan.stats
    }

    const mem = await memstore.loadMemory(taban)
    if (!mem || !mem.events || mem.events.length === 0) {
      satir.hata = 'hafiza yok'
      sonuclar.push(satir)
      continue
    }
    const cfg = presets.resolveCfg(tf, yama, mem.meta)
    let protos = []
    try {
      protos = cluster.buildPrototypes({ events: mem.events }, {}) || []
    } catch (err) {
      protos = []
    }

    const t0 = Date.now()
    const res = backtest.runBacktest(mem, protos, {
      warmupEvents: warmup,
      warmupPerBucket: Number.isFinite(Number(arg.bucket)) ? Number(arg.bucket) : undefined,
      signalCfg: cfg.signalCfg,
      outcomeCfg: cfg.planOutcomeCfg,
    })
    const s = res.summary
    satir.events = mem.events.length
    satir.summary = s
    satir.sureSn = (Date.now() - t0) / 1000
    satir.usedCfg = {
      minSimilarity: cfg.signalCfg.minSimilarity,
      minMatches: cfg.signalCfg.minMatches,
      minWinRate: cfg.signalCfg.minWinRate,
      minRr: cfg.signalCfg.minRr,
      targetAtr: cfg.planOutcomeCfg.targetAtr,
    }
    sonuclar.push(satir)
  }

  if (arg.json) {
    const metin = JSON.stringify({ zaman: new Date().toISOString(), yama: yama, sonuclar: sonuclar }, null, 2)
    if (arg.out && arg.out !== true) fs.writeFileSync(String(arg.out), metin, 'utf8')
    else process.stdout.write(metin + '\n')
    return
  }

  const satirlar = []
  satirlar.push('OLCUM (' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')')
  satirlar.push('Ayar: benzerlik ' + (sonuclar[0] && sonuclar[0].usedCfg ? sonuclar[0].usedCfg.minSimilarity : '-') +
    ', en az eslesme ' + (sonuclar[0] && sonuclar[0].usedCfg ? sonuclar[0].usedCfg.minMatches : '-') +
    ', en az tutma ' + (sonuclar[0] && sonuclar[0].usedCfg ? yuzde(sonuclar[0].usedCfg.minWinRate, 0) : '-'))
  satirlar.push('')
  satirlar.push('tf   | olay    | islem | isabet  [%95 aralik]   | taban  | katki  |   p   | net/islem [%95 aralik]      | kanit')
  for (const r of sonuclar) {
    if (r.hata) {
      satirlar.push(r.tf.padEnd(4) + ' | ' + r.hata)
      continue
    }
    const s = r.summary
    const ci = s.winRateCI
    const eci = s.expectancyCI
    satirlar.push([
      r.tf.padEnd(4),
      sayiBicim(r.events).padStart(7),
      String(s.fired).padStart(5),
      (yuzde(s.winRate) + (ci ? '  [' + yuzde(ci.lo, 1) + ', ' + yuzde(ci.hi, 1) + ']' : '')).padEnd(21),
      (Number.isFinite(s.baselineWinRate) ? yuzde(s.baselineWinRate) : '-').padStart(6),
      (Number.isFinite(s.edgePts) ? (s.edgePts >= 0 ? '+' : '') + s.edgePts.toFixed(1) : '-').padStart(6),
      (Number.isFinite(s.baselinePValue) ? s.baselinePValue.toFixed(3) : '-').padStart(5),
      (say(s.expectancyAtr) + (eci ? '  [' + say(eci.lo) + ', ' + say(eci.hi) + ']' : '')).padEnd(27),
      s.warning ? s.warning : (s.edgeProven ? 'KANITLI' : 'kanitlanmadi'),
    ].join(' | '))
  }
  satirlar.push('')
  satirlar.push('Not: "katki" ayni turun tabanina gore isabet farkidir (puan). p degeri bu fark icin')
  satirlar.push('iki yonlu binom testidir. Net beklentinin %95 araligi sifiri iceriyorsa sonuc')
  satirlar.push('"kanitlanmadi" sayilir: sayinin isareti degil, araligin tamami onemlidir.')

  const metin = satirlar.join('\n') + '\n'
  if (arg.out && arg.out !== true) fs.writeFileSync(String(arg.out), metin, 'utf8')
  else process.stdout.write(metin)
}

main().catch((err) => {
  process.stderr.write('Hata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
