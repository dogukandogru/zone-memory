// Benzerlik agirliklarini (sekil / baglam / DTW) OLCEREK karsilastirir.
//
// Neden ayri betik ve neden AUC: agirliklari "hangisi daha cok islem uretti"
// ya da "hangisinin isabeti yuksek" diye secmek yanlistir, cunku her agirlik
// farkli sayida ve farkli zorlukta olay uretir. Burada esikler kasten GEVSEK
// tutulur (her olay degerlendirilir) ve tek soru sorulur:
//
//   kNN'in verdigi oran, kazananlari kaybedenlerden ayirabiliyor mu (AUC)
//
// AUC 0.50 "hicbir sey ayirt etmiyor" demektir; kalibrasyondan bagimsizdir,
// bu yuzden esik secimiyle karistirilamaz. Yaninda Brier (kalibrasyon) ve
// islem basina net sonuc da basilir.
//
// Donem ikiye bolunur: agirlik SECIM diliminde bakilir, karar DOGRULAMA
// dilimindeki AUC'ye gore verilir.
//
// Kullanim:
//   node scripts/weight-study.mjs --tf 15m
//   node scripts/weight-study.mjs --tf 1h --split 0.6 --json --out agirlik.json

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { dataDir as varsayilanDataDir, DEFAULT_SYMBOL } from './userdata-path.mjs'

const require = createRequire(import.meta.url)
const memstore = require('../src/core/store/memstore.js')
const backtest = require('../src/core/learn/backtest.js')
const candcache = require('../src/core/learn/candcache.js')
const cluster = require('../src/core/learn/cluster.js')
const presets = require('../src/core/learn/presets.js')
const stats = require('../src/core/learn/stats.js')
const { argumanlariAyristir, sayiBicim } = require('../src/core/util/cli.js')

/**
 * Denenecek agirliklar. Tek bilesenli olanlar bilerek listede: bir bilesenin
 * TEK BASINA ne kadar ayirt ettigini gormek, karisimi yorumlamanin tek yolu.
 */
const AGIRLIKLAR = [
  { ad: 'yalniz sekil', shape: 1.00, ctx: 0.00, dtw: 0.00 },
  { ad: 'yalniz baglam', shape: 0.00, ctx: 1.00, dtw: 0.00 },
  { ad: 'yalniz DTW', shape: 0.00, ctx: 0.00, dtw: 1.00 },
  { ad: 'mevcut', shape: 0.60, ctx: 0.25, dtw: 0.15 },
  { ad: 'sekil agir', shape: 0.80, ctx: 0.10, dtw: 0.10 },
  { ad: 'sekil + baglam', shape: 0.70, ctx: 0.30, dtw: 0.00 },
  { ad: 'dengeli', shape: 0.34, ctx: 0.33, dtw: 0.33 },
  { ad: 'baglam agir', shape: 0.30, ctx: 0.55, dtw: 0.15 },
  { ad: 'DTW agir', shape: 0.40, ctx: 0.15, dtw: 0.45 },
  { ad: 'sekil + DTW', shape: 0.60, ctx: 0.00, dtw: 0.40 },
  { ad: 'baglamsiz esit', shape: 0.50, ctx: 0.00, dtw: 0.50 },
]

// GEVSEK ESIKLER: her olay islem sayilsin, olculen sey karar degil bilgi
// icerigi olsun. Onsel 0'dir: kuculutulmus oran tabana dogru cekildigi icin
// AUC'yi degistirmez ama okumayi zorlastirir.
const GEVSEK = {
  minSimilarity: 0,
  minMatches: 1,
  minWinRate: 0,
  minRr: 0,
  minExpectancy: -1,
  minLift: 0,
  priorStrength: 0,
}

const say = (x, h = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(h) : '-')
const oran = (x, h = 3) => (Number.isFinite(x) ? x.toFixed(h) : '-')
const gun = (t) => (Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : '-')

function kullaniciYamasi (userDir) {
  try {
    const ham = JSON.parse(fs.readFileSync(path.join(userDir || '', 'settings.json'), 'utf8'))
    const yama = Object.assign({}, ham)
    delete yama.settingsVersion
    return yama
  } catch (err) {
    return {}
  }
}

/** Islem listesinden AUC, Brier ve net beklenti. */
function olcut (sonuc, taban) {
  const kayitlar = sonuc.trades.map((t) => ({ pred: t.winRate, win: t.win === true }))
  const a = stats.auc(kayitlar)
  const b = stats.brier(kayitlar, Number.isFinite(taban) ? taban : undefined)
  // EN IYI BESLIK: siralama para kazandiriyor mu. AUC "siralama var mi" der,
  // bu sutun "siralamanin tepesi kar ediyor mu" der. Ikisi ayri sorudur:
  // olculdu, siralama guclu oldugu halde tepe dilim yine zarar edebiliyor.
  const sirali = sonuc.trades.slice().sort((x, y) => (Number(y.winRate) || 0) - (Number(x.winRate) || 0))
  const dilim = sirali.slice(0, Math.max(1, Math.floor(sirali.length / 5)))
  let dilimKazanan = 0
  let dilimNet = 0
  for (const t of dilim) {
    if (t.win) dilimKazanan++
    dilimNet += Number(t.pnlAtr) || 0
  }
  return {
    n: sonuc.trades.length,
    top: {
      n: dilim.length,
      winRate: dilim.length > 0 ? dilimKazanan / dilim.length : null,
      expectancyAtr: dilim.length > 0 ? dilimNet / dilim.length : null,
    },
    auc: a ? a.auc : null,
    nWin: a ? a.nWin : 0,
    brier: b.model,
    brierBase: b.base,
    winRate: sonuc.summary.winRate,
    expectancyAtr: sonuc.summary.expectancyAtr,
    // Tahminlerin yayilimi: hepsi ayni cikiyorsa AUC zaten 0.5'e yakin olur.
    predSpread: (function () {
      let lo = Infinity
      let hi = -Infinity
      for (const k of kayitlar) {
        if (!Number.isFinite(k.pred)) continue
        if (k.pred < lo) lo = k.pred
        if (k.pred > hi) hi = k.pred
      }
      return hi >= lo ? hi - lo : null
    })(),
  }
}

async function main () {
  const arg = argumanlariAyristir(process.argv.slice(2))
  if (arg.help || arg.h) {
    process.stdout.write([
      'Benzerlik agirliklarini AUC ile karsilastirir (esiklerden bagimsiz olcum).',
      '',
      '  --tf 15m          Zaman dilimi',
      '  --split 0.6       Secim diliminin orani',
      '  --warmup 500      Isinma olay sayisi alt siniri',
      '  --json            Ham JSON yaz',
      '  --out <dosya>     Ciktiyi dosyaya yaz',
      '',
    ].join('\n'))
    return
  }

  const dataDir = arg['data-dir'] && arg['data-dir'] !== true ? String(arg['data-dir']) : varsayilanDataDir()
  const userDir = arg['user-dir'] && arg['user-dir'] !== true ? String(arg['user-dir']) : path.dirname(dataDir)
  const yama = kullaniciYamasi(userDir)
  const tf = arg.tf && arg.tf !== true ? String(arg.tf) : (yama.timeframe || '15m')
  const bolme = Number.isFinite(Number(arg.split)) ? Math.min(0.9, Math.max(0.1, Number(arg.split))) : 0.6
  const warmup = Number.isFinite(Number(arg.warmup)) ? Number(arg.warmup) : 500

  const mem = await memstore.loadMemory(path.join(dataDir, DEFAULT_SYMBOL + '_' + tf + '_memory'))
  if (!mem || !mem.events || mem.events.length === 0) throw new Error(tf + ': hafiza yok, once tarama yapin')
  const cfgc = presets.resolveCfg(tf, yama, mem.meta)
  let protos = []
  try {
    protos = cluster.buildPrototypes({ events: mem.events }, {}) || []
  } catch (err) {
    protos = []
  }

  const zamanlar = mem.events.map((e) => Number(e.time)).filter(Number.isFinite).sort((a, b) => a - b)
  const kesme = zamanlar[Math.floor(zamanlar.length * bolme)]
  const temel = {
    warmupEvents: warmup,
    warmupPerBucket: Number.isFinite(Number(arg.bucket)) ? Number(arg.bucket) : undefined,
    outcomeCfg: cfgc.planOutcomeCfg,
  }

  const sonuclar = []
  for (let i = 0; i < AGIRLIKLAR.length; i++) {
    const w = AGIRLIKLAR[i]
    const signalCfg = Object.assign({}, cfgc.signalCfg, GEVSEK, {
      weights: { shape: w.shape, ctx: w.ctx, dtw: w.dtw },
    })
    process.stderr.write('(' + (i + 1) + '/' + AGIRLIKLAR.length + ') ' + w.ad + ': komsular...\n')
    const t0 = Date.now()
    // Agirliklar komsulari degistirdigi icin onbellek her agirlikta yeniden
    // kurulur; esik taramasinin tersine burada kacinilmaz bir maliyet.
    const cache = candcache.buildCandidates(mem, Object.assign({}, temel, { signalCfg: signalCfg }))
    const secim = backtest.runBacktestFromCache(mem, cache, protos,
      Object.assign({}, temel, { signalCfg: signalCfg, evalToTime: kesme }))
    const dogrulama = backtest.runBacktestFromCache(mem, cache, protos,
      Object.assign({}, temel, { signalCfg: signalCfg, evalFromTime: kesme + 1 }))
    sonuclar.push({
      ad: w.ad,
      weights: { shape: w.shape, ctx: w.ctx, dtw: w.dtw },
      is: olcut(secim, secim.summary.baselineWinRate),
      oos: olcut(dogrulama, dogrulama.summary.baselineWinRate),
      sureSn: (Date.now() - t0) / 1000,
    })
  }

  if (arg.json) {
    const metin = JSON.stringify({
      tf: tf, zaman: new Date().toISOString(), olay: mem.events.length,
      splitTime: kesme, sonuclar: sonuclar,
    }, null, 2)
    if (arg.out && arg.out !== true) fs.writeFileSync(String(arg.out), metin, 'utf8')
    else process.stdout.write(metin + '\n')
    return
  }

  const satirlar = []
  satirlar.push('AGIRLIK CALISMASI ' + tf + ' (' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')')
  satirlar.push('Olay ' + sayiBicim(mem.events.length) + ' | secim ... ' + gun(kesme) +
    ' | dogrulama ' + gun(kesme) + ' ...')
  satirlar.push('Esikler kasten gevsek: her olay degerlendirildi, olculen sey karar degil bilgi icerigi.')
  satirlar.push('')
  satirlar.push('agirlik (sekil/baglam/dtw)      | SECIM  AUC | DOGRULAMA: n     AUC   Brier   net/islem | en iyi 1/5: n  isabet  net/islem')
  for (const r of sonuclar) {
    const w = r.weights
    satirlar.push([
      (r.ad + ' (' + w.shape.toFixed(2) + '/' + w.ctx.toFixed(2) + '/' + w.dtw.toFixed(2) + ')').padEnd(30),
      oran(r.is.auc).padStart(6),
      String(r.oos.n).padStart(5) + ' ' + oran(r.oos.auc).padStart(6) + ' ' + oran(r.oos.brier).padStart(6) +
        ' ' + say(r.oos.expectancyAtr).padStart(9),
      String(r.oos.top.n).padStart(4) + ' ' +
        (Number.isFinite(r.oos.top.winRate) ? (r.oos.top.winRate * 100).toFixed(1) + '%' : '-').padStart(6) +
        ' ' + say(r.oos.top.expectancyAtr).padStart(9),
    ].join(' | '))
  }
  satirlar.push('')
  satirlar.push('AUC 0,50 "kNN oraninin kazananla kaybedeni ayirma gucu yok" demektir.')
  satirlar.push('0,55 zayif, 0,60 ve ustu anlamli sayilir. Brier kucuk daha iyidir.')
  satirlar.push('"En iyi 1/5" sutunu asil sorudur: siralama var ama tepesi kar etmiyorsa')
  satirlar.push('sorun benzerlik agirliginda degil, islem planinin geometrisindedir.')
  satirlar.push('Karar DOGRULAMA sutununa gore verilir; secim sutunu her zaman iyimserdir.')

  const metin = satirlar.join('\n') + '\n'
  if (arg.out && arg.out !== true) fs.writeFileSync(String(arg.out), metin, 'utf8')
  else process.stdout.write(metin)
}

main().catch((err) => {
  process.stderr.write('Hata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
