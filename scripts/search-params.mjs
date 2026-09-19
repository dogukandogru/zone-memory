// Sinyal esiklerini GECMIS bir dilimde arar, BASKA bir dilimde dogrular.
//
// Neden ayri betik: esikleri "hangi ayar en iyi sonucu veriyor" diye tum
// donemde denemek, en iyi sonucu SECIM yaparak uretir; o rakam gelecekte
// tekrarlanmaz. Burada donem ikiye bolunur:
//
//   SECIM dilimi (in-sample)   : butun izgara burada denenir, en iyisi secilir
//   DOGRULAMA dilimi (out)     : secilen ayar SADECE burada raporlanir
//
// Secim dilimindeki rakam her zaman iyimserdir; karar dogrulama dilimine
// bakilarak verilir. Denenen ayar sayisi da basilir, cunku 1000 ayar deneyip
// en iyisini almak tek basina bir kazanc yanilsamasi uretir.
//
// Hiz: komsular learn/candcache.js ile bir kez hesaplanir, her ayar denemesi
// yalnizca karar mantigini yeniden calistirir (zaman dilimine gore 0.03 - 1 sn).
//
// Kullanim:
//   node scripts/search-params.mjs --tf 15m
//   node scripts/search-params.mjs --tf 15m --split 0.6 --grid ince
//   node scripts/search-params.mjs --tf 1h --min-trades 40 --json --out arama.json

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
 * Izgaralar. "kaba" gunluk kullanim icindir; "ince" daha fazla deneme yapar
 * ve secim yanliligini buyutur, bu yuzden varsayilan degildir.
 */
const IZGARALAR = {
  kaba: {
    minSimilarity: [0.75, 0.80, 0.85],
    minMatches: [5, 10, 20, 40],
    minWinRate: [0.50, 0.55, 0.60, 0.65],
    priorStrength: [0, 5, 10, 20],
    minExpectancy: [0, 0.10],
    minRr: [0],
    minLift: [0],
  },
  ince: {
    minSimilarity: [0.70, 0.75, 0.80, 0.85, 0.90],
    minMatches: [5, 10, 15, 20, 30, 40, 60],
    minWinRate: [0.45, 0.50, 0.55, 0.60, 0.65, 0.70],
    priorStrength: [0, 5, 10, 20, 40],
    minExpectancy: [0, 0.10, 0.25],
    minRr: [0, 0.8],
    minLift: [0, 0.03],
  },
}

const yuzde = (x, h = 1) => (Number.isFinite(x) ? (x * 100).toFixed(h) + '%' : '-')
const say = (x, h = 3) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(h) : '-')
const oran = (x, h = 3) => (Number.isFinite(x) ? x.toFixed(h) : '-')
const gun = (t) => (Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : '-')

/** Kullanicinin kayitli ayar yamasi (Electron olmadan okunur). */
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

/** Izgaranin kartezyen carpimi. */
function kombinasyonlar (izgara) {
  const adlar = Object.keys(izgara)
  let liste = [{}]
  for (const ad of adlar) {
    const yeni = []
    for (const temel of liste) {
      for (const deger of izgara[ad]) {
        const kopya = Object.assign({}, temel)
        kopya[ad] = deger
        yeni.push(kopya)
      }
    }
    liste = yeni
  }
  return liste
}

/** Ozetten karsilastirmaya giren alanlar. */
function olcut (s) {
  return {
    fired: s.fired,
    winRate: s.winRate,
    baselineWinRate: s.baselineWinRate,
    edgePts: s.edgePts,
    expectancyAtr: s.expectancyAtr,
    edgeNetAtr: s.edgeNetAtr,
    expectancyR: s.expectancyR,
    expectancyCI: s.expectancyCI,
    baselinePValue: s.baselinePValue,
    edgeProven: s.edgeProven,
    profitFactor: s.profitFactor,
    maxDrawdownR: s.maxDrawdownR,
    fillRate: s.fillRate,
    evalFrom: s.evalFrom,
    evalTo: s.evalTo,
  }
}

function ayarMetni (c) {
  return 'ben ' + c.minSimilarity.toFixed(2) + ' es ' + String(c.minMatches).padStart(2) +
    ' tut ' + yuzde(c.minWinRate, 0) + ' onsel ' + String(c.priorStrength).padStart(2) +
    ' bd ' + c.minExpectancy.toFixed(2) +
    (c.minRr > 0 ? ' rr ' + c.minRr.toFixed(1) : '') +
    (c.minLift > 0 ? ' katki ' + yuzde(c.minLift, 0) : '')
}

/**
 * ZAMAN AGIRLIGI ABLASYONU (S9)
 *
 * Sorusu: eski eslesmeleri hafifletmek ya da kalibrasyon tabanini son yillara
 * sinirlamak GOSTERILEN ORANI daha dogru yapiyor mu. Bu bir esik sorusu
 * degildir, bu yuzden esikler kasten gevsek tutulur ve her olay olculur;
 * karsilastirma olcutu Brier (kalibrasyon) ve AUC (ayirt etme).
 *
 * Varsayilanin degismesi icin DOGRULAMA dilimindeki Brier iyilesmesi gerekir.
 */
const ABLASYON = [
  { ad: 'kapali (mevcut)', halfLifeYears: null, baseWindowYears: null },
  { ad: 'yariomur 8 yil', halfLifeYears: 8, baseWindowYears: null },
  { ad: 'yariomur 4 yil', halfLifeYears: 4, baseWindowYears: null },
  { ad: 'yariomur 2 yil', halfLifeYears: 2, baseWindowYears: null },
  { ad: 'taban 3 yil', halfLifeYears: null, baseWindowYears: 3 },
  { ad: 'yariomur 4 + taban 3', halfLifeYears: 4, baseWindowYears: 3 },
]

/** Ablasyon olcutleri: kalibrasyon ve ayirt etme. */
function ablasyonOlcut (sonuc) {
  const kayitlar = sonuc.trades.map((t) => ({ pred: t.winRate, win: t.win === true }))
  const taban = sonuc.summary.baselineWinRate
  const a = stats.auc(kayitlar)
  const b = stats.brier(kayitlar, Number.isFinite(taban) ? taban : undefined)
  const sirali = sonuc.trades.slice().sort((x, y) => (Number(y.winRate) || 0) - (Number(x.winRate) || 0))
  const dilim = sirali.slice(0, Math.max(1, Math.floor(sirali.length / 5)))
  let dilimR = 0
  let dilimKazanan = 0
  for (const t of dilim) {
    dilimR += Number(t.pnlR) || 0
    if (t.win) dilimKazanan++
  }
  return {
    n: sonuc.trades.length,
    auc: a ? a.auc : null,
    brier: b.model,
    brierBase: b.base,
    topN: dilim.length,
    topWinRate: dilim.length > 0 ? dilimKazanan / dilim.length : null,
    topR: dilim.length > 0 ? dilimR / dilim.length : null,
  }
}

/** Ablasyon modu: zaman agirligi ve taban penceresi varyantlari. */
async function ablasyonKosusu (mem, protos, cfgc, temelCfg, kesme, arg) {
  const satirlar = []
  const sonuclar = []
  for (let i = 0; i < ABLASYON.length; i++) {
    const v = ABLASYON[i]
    const signalCfg = Object.assign({}, cfgc.signalCfg, {
      // Her olay olculsun: olculen sey karar degil, gosterilen oranin dogrulugu.
      minSimilarity: 0, minMatches: 1, minWinRate: 0, minRr: 0, minExpectancy: -1, minLift: 0,
      halfLifeYears: v.halfLifeYears,
      baseWindowYears: v.baseWindowYears,
    })
    process.stderr.write('(' + (i + 1) + '/' + ABLASYON.length + ') ' + v.ad + '\n')
    // Taban penceresi onbellekteki havuz sayaclarini degistirir, bu yuzden
    // her varyantta onbellek yeniden kurulur. Yariomur komsulari
    // degistirmez ama ayni yoldan gecmek karsilastirmayi basit tutuyor.
    const cache = candcache.buildCandidates(mem, Object.assign({}, temelCfg, { signalCfg: signalCfg }))
    const secim = backtest.runBacktestFromCache(mem, cache, protos,
      Object.assign({}, temelCfg, { signalCfg: signalCfg, evalToTime: kesme }))
    const dogrulama = backtest.runBacktestFromCache(mem, cache, protos,
      Object.assign({}, temelCfg, { signalCfg: signalCfg, evalFromTime: kesme + 1 }))
    sonuclar.push({ ad: v.ad, cfg: v, is: ablasyonOlcut(secim), oos: ablasyonOlcut(dogrulama) })
  }

  if (arg.json) return { mod: 'ablasyon', splitTime: kesme, sonuclar: sonuclar }

  satirlar.push('ZAMAN AGIRLIGI ABLASYONU (S9)')
  satirlar.push('Esikler kasten gevsek: olculen sey karar degil, gosterilen oranin dogrulugu.')
  satirlar.push('')
  satirlar.push('varyant               | SECIM Brier | DOGRULAMA: n     AUC   Brier  (taban)  | en iyi 1/5: isabet  net R')
  for (const r of sonuclar) {
    satirlar.push([
      r.ad.padEnd(21),
      oran(r.is.brier).padStart(11),
      String(r.oos.n).padStart(5) + ' ' + oran(r.oos.auc).padStart(6) + ' ' + oran(r.oos.brier).padStart(6) +
        ' (' + oran(r.oos.brierBase) + ')',
      (Number.isFinite(r.oos.topWinRate) ? (r.oos.topWinRate * 100).toFixed(1) + '%' : '-').padStart(7) +
        ' ' + say(r.oos.topR).padStart(7),
    ].join(' | '))
  }
  satirlar.push('')
  satirlar.push('Brier kucuk daha iyidir; parantez icindeki sayi sabit taban tahmininin Brier\'i.')
  satirlar.push('Varsayilan ancak DOGRULAMA dilimindeki Brier belirgin olarak iyilesirse degismeli.')
  return satirlar.join('\n') + '\n'
}

async function main () {
  const arg = argumanlariAyristir(process.argv.slice(2))
  if (arg.help || arg.h) {
    process.stdout.write([
      'Sinyal esiklerini secim diliminde arar, dogrulama diliminde raporlar.',
      '',
      '  --tf 15m           Zaman dilimi (varsayilan: ayardaki)',
      '  --split 0.6        Secim diliminin orani (varsayilan 0.6)',
      '  --grid kaba|ince   Izgara yogunlugu (varsayilan kaba)',
      '  --ablation         Esik aramasi yerine zaman agirligi ablasyonu (S9)',
      '  --min-trades 30    Bir ayarin sayilmasi icin asgari islem (her iki dilimde)',
      '  --top 8            Kac ayar listelenecek',
      '  --warmup 500       Isinma olay sayisi alt siniri',
      '  --bucket <n>       Tur ve yon basina asgari aday',
      '  --data-dir <yol>   Veri klasoru',
      '  --json             Ham JSON yaz',
      '  --out <dosya>      Ciktiyi dosyaya yaz',
      '',
    ].join('\n'))
    return
  }

  const dataDir = arg['data-dir'] && arg['data-dir'] !== true ? String(arg['data-dir']) : varsayilanDataDir()
  const userDir = arg['user-dir'] && arg['user-dir'] !== true ? String(arg['user-dir']) : path.dirname(dataDir)
  const yama = kullaniciYamasi(userDir)
  const tf = arg.tf && arg.tf !== true ? String(arg.tf) : (yama.timeframe || '15m')
  const oran = Number.isFinite(Number(arg.split)) ? Math.min(0.9, Math.max(0.1, Number(arg.split))) : 0.6
  const izgaraAd = arg.grid === 'ince' ? 'ince' : 'kaba'
  const asgariIslem = Number.isFinite(Number(arg['min-trades'])) ? Number(arg['min-trades']) : 30
  const ustSayi = Number.isFinite(Number(arg.top)) ? Number(arg.top) : 8
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

  // Bolme zamani: olaylarin zamanina gore yuzdelik. Bar sayisina gore
  // bolmek seyrek donemleri haksiz buyuk gosterirdi.
  const zamanlar = mem.events.map((e) => Number(e.time)).filter(Number.isFinite).sort((a, b) => a - b)
  const kesme = zamanlar[Math.floor(zamanlar.length * oran)]

  const temelCfg = {
    warmupEvents: warmup,
    warmupPerBucket: Number.isFinite(Number(arg.bucket)) ? Number(arg.bucket) : undefined,
    outcomeCfg: cfgc.planOutcomeCfg,
  }

  // ABLASYON MODU: esik aramasi yerine zaman agirligi varyantlari.
  if (arg.ablation) {
    const cikti = await ablasyonKosusu(mem, protos, cfgc, temelCfg, kesme, arg)
    const metin = typeof cikti === 'string' ? cikti : JSON.stringify(cikti, null, 2) + '\n'
    if (arg.out && arg.out !== true) fs.writeFileSync(String(arg.out), metin, 'utf8')
    else process.stdout.write(metin)
    return
  }

  process.stderr.write(tf + ': ' + sayiBicim(mem.events.length) + ' olay, komsu onbellegi kuruluyor...\n')
  const t0 = Date.now()
  const cache = candcache.buildCandidates(mem, Object.assign({}, temelCfg, { signalCfg: cfgc.signalCfg }))
  process.stderr.write('onbellek hazir (' + ((Date.now() - t0) / 1000).toFixed(1) + ' sn), k=' + cache.k + '\n')

  const izgara = IZGARALAR[izgaraAd]
  const kombos = kombinasyonlar(izgara)
  process.stderr.write(kombos.length + ' ayar denenecek (izgara: ' + izgaraAd + ')\n')

  const sonuclar = []
  const t1 = Date.now()
  for (let i = 0; i < kombos.length; i++) {
    const c = kombos[i]
    const signalCfg = Object.assign({}, cfgc.signalCfg, c)
    const secim = backtest.runBacktestFromCache(mem, cache, protos,
      Object.assign({}, temelCfg, { signalCfg: signalCfg, evalToTime: kesme }))
    // Secim diliminde islem sayisi yetersizse dogrulamayi hic kosmayiz.
    if (secim.summary.fired < asgariIslem) continue
    const dogrulama = backtest.runBacktestFromCache(mem, cache, protos,
      Object.assign({}, temelCfg, { signalCfg: signalCfg, evalFromTime: kesme + 1 }))
    sonuclar.push({ cfg: c, is: olcut(secim.summary), oos: olcut(dogrulama.summary) })
    if (i % 100 === 0) {
      process.stderr.write('  ' + i + '/' + kombos.length + ' (' + ((Date.now() - t1) / 1000).toFixed(0) + ' sn)\n')
    }
  }
  process.stderr.write('arama bitti (' + ((Date.now() - t1) / 1000).toFixed(0) + ' sn), ' +
    sonuclar.length + ' ayar asgari islem sayisini gecti\n')

  // SIRALAMA YALNIZCA SECIM DILIMINE BAKAR. Dogrulama rakamina gore siralamak
  // ayni yanliligi arka kapidan geri getirirdi.
  sonuclar.sort((a, b) => {
    const x = Number.isFinite(a.is.edgeNetAtr) ? a.is.edgeNetAtr : -Infinity
    const y = Number.isFinite(b.is.edgeNetAtr) ? b.is.edgeNetAtr : -Infinity
    return y - x
  })

  const ustler = sonuclar.slice(0, ustSayi)
  const ciktiJson = {
    tf: tf,
    zaman: new Date().toISOString(),
    olay: mem.events.length,
    split: oran,
    splitTime: kesme,
    grid: izgaraAd,
    denenen: kombos.length,
    gecerli: sonuclar.length,
    minTrades: asgariIslem,
    en: ustler,
  }

  if (arg.json) {
    const metin = JSON.stringify(ciktiJson, null, 2)
    if (arg.out && arg.out !== true) fs.writeFileSync(String(arg.out), metin, 'utf8')
    else process.stdout.write(metin + '\n')
    return
  }

  const satirlar = []
  satirlar.push('PARAMETRE ARAMASI ' + tf + ' (' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ')')
  satirlar.push('Olay ' + sayiBicim(mem.events.length) + ' | secim dilimi ... ' + gun(kesme) +
    ' | dogrulama dilimi ' + gun(kesme) + ' ...')
  satirlar.push('Denenen ayar ' + kombos.length + ', asgari ' + asgariIslem +
    ' islem kosulunu gecen ' + sonuclar.length)
  satirlar.push('')
  if (ustler.length === 0) {
    satirlar.push('Hicbir ayar secim diliminde ' + asgariIslem + ' isleme ulasmadi.')
    satirlar.push('Esikler cok siki demektir: --min-trades dusurun ya da izgarayi genisletin.')
  } else {
    satirlar.push('ayar                                          | SECIM: islem isabet  katki  net/islem | DOGRULAMA: islem isabet  katki  net/islem [%95]        p')
    for (const r of ustler) {
      const a = r.is
      const b = r.oos
      satirlar.push([
        ayarMetni(r.cfg).padEnd(45),
        String(a.fired).padStart(5) + ' ' + yuzde(a.winRate).padStart(6) + ' ' +
          (Number.isFinite(a.edgePts) ? say(a.edgePts, 1) : '-').padStart(6) + ' ' + say(a.expectancyAtr).padStart(7),
        String(b.fired).padStart(5) + ' ' + yuzde(b.winRate).padStart(6) + ' ' +
          (Number.isFinite(b.edgePts) ? say(b.edgePts, 1) : '-').padStart(6) + ' ' + say(b.expectancyAtr).padStart(7) +
          ' [' + (b.expectancyCI ? say(b.expectancyCI.lo) + ', ' + say(b.expectancyCI.hi) : '-') + ']',
        (Number.isFinite(b.baselinePValue) ? b.baselinePValue.toFixed(3) : '-').padStart(5),
      ].join(' | '))
    }
    satirlar.push('')
    satirlar.push('Siralama YALNIZCA secim dilimine gore yapildi. Dogrulama dilimindeki')
    satirlar.push('rakam tek gecerli olcuttur: net beklentinin %95 araligi sifiri iceriyorsa')
    satirlar.push('o ayar da kanitlanmis sayilmaz. ' + kombos.length + ' ayar denendigi icin en iyi')
    satirlar.push('secim rakaminin bir kismi sanstir; iki dilim arasinda cok sapan ayarlara guvenmeyin.')
  }

  const metin = satirlar.join('\n') + '\n'
  if (arg.out && arg.out !== true) fs.writeFileSync(String(arg.out), metin, 'utf8')
  else process.stdout.write(metin)
}

main().catch((err) => {
  process.stderr.write('Hata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
