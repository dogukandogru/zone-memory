'use strict'

/**
 * A7 - Yuruyen ileri test (walk-forward backtest).
 *
 * Bu modulun tek amaci sistemin katma degerini DURUST olcmektir. Bu yuzden
 * tek bir kural her seyin onunde gelir: bir olay degerlendirilirken, o olaydan
 * (ve ambargo penceresinden) SONRAKI hicbir kayit hafizada bulunamaz.
 *
 * Sozlesme notlari (CONTRACTS.md bolum 15 ve 16):
 * - `Signal.tp1 / tp2 / sl` alanlari FIYATTIR, ATR carpani degil. Test ATR
 *   biriminde kar/zarar hesapladigi icin carpanlar fiyatlardan geri turetilir:
 *   `tp1Atr = |tp1 - entry| / atr`, `slAtr = |entry - sl| / atr`.
 * - `profitFactor` hic kayip islem yoksa `Infinity` doner (kar varsa), her iki
 *   taraf da bossa 0 doner. Yapisal kopyalama bunu korur, JSON'a cevirirken
 *   arayuz tarafinin dikkat etmesi gerekir.
 * - Sozlesmede yalnizca `runBacktest` listelenmisti; `DEFAULT_BACKTEST_CFG`
 *   yalnizca EK olarak disa aciliyor, mevcut imzalarin hicbiri degismedi.
 */

const { DEFAULT_SIGNAL_CFG, evaluateTouch } = require('./signal')

/** Varsayilan test ayarlari. */
const DEFAULT_BACKTEST_CFG = {
  warmupEvents: 500, // Ilk bu kadar olay yalnizca hafiza olarak kullanilir
  embargoSec: 86400, // Olay zamanindan bu kadar once biten kayitlar aday olabilir
  signalCfg: null, // null ise DEFAULT_SIGNAL_CFG kullanilir
  // ISLEM MALIYETI (gidis-donus), FIYAT BIRIMINDE, yani XAUUSD icin dolar.
  //
  // Bunu gormezden gelmek 1 dakikalik grafikte sonucu tamamen yaniltir:
  // olculdu, 1m'de ATR'nin tum gecmisteki medyani yalnizca 0.348 dolardir,
  // yani islem basina 0.344 ATR'lik brut beklenti sadece 0.12 dolar eder.
  // Tipik XAUUSD spreadi 0.20 - 0.35 dolar oldugu icin bu, edimin tamamini
  // yiyebilir. Zaman dilimi buyudukce sorun kucululur (medyan ATR: 1m 0.35,
  // 5m 0.94, 15m 1.87 dolar; 2026'da sirasiyla 2.18, 5.97, 9.49 dolar).
  //
  // Maliyet, her islemde ATR birimine cevrilip (maliyet / islemin ATR'si)
  // brut sonuctan dusulur. 0 verilirse maliyet modellenmez.
  costUsd: 0,
  // Maliyetin FIYATA ORANLI hali. 17 yillik testte bu dogru olcudur, cunku
  // altin 900 dolardan 4400 dolara ciktigi icin sabit dolar maliyeti eski
  // yillari haksiz yere agir cezalandirir. Tipik XAUUSD spreadi bugun
  // 0.30 dolar civarindadir, bu 4400 dolarda yaklasik %0.0068'e denk gelir.
  // costPct > 0 ise costUsd YERINE bu kullanilir: maliyet = fiyat * costPct.
  costPct: 0.000068,
}

/**
 * @typedef {Object} Trade
 * @property {string} id
 * @property {number} eventId          Hafiza olayinin id'si
 * @property {number} time
 * @property {number} bar
 * @property {number} year
 * @property {'BUY'|'SELL'} direction
 * @property {string} session
 * @property {number} entry
 * @property {number} tp1
 * @property {number} tp2
 * @property {number} sl
 * @property {number} tp1Atr           TP1'in ATR cinsinden uzakligi
 * @property {number} slAtr            SL'in ATR cinsinden uzakligi
 * @property {number} rr
 * @property {number} atr
 * @property {number} matchCount
 * @property {number} avgSimilarity
 * @property {number} bestSimilarity
 * @property {number} winRate          Sinyalin ONGORDUGU basari orani
 * @property {number} confidence
 * @property {number} expectedMfeAtr
 * @property {number} mfeAtr           Olayin GERCEK lehte hareketi
 * @property {number} maeAtr
 * @property {string} outcome          'respect' | 'break' | 'timeout'
 * @property {boolean} success         Ham etiket
 * @property {boolean} win             Gerceklesen islem sonucu
 * @property {number} pnlAtr           +tp1Atr veya -slAtr
 * @property {number} equityAtr        Bu islemden sonraki birikimli kazanc
 * @property {number|null} prototypeId
 * @property {string} prototypeLabel
 */

/**
 * @typedef {Object} Summary
 * @property {number} total            Degerlendirilen olay sayisi
 * @property {number} fired            Sinyal uretip islem acilan olay sayisi
 * @property {number} wins
 * @property {number} losses
 * @property {number} winRate
 * @property {number} expectancyAtr    Islem basina ortalama ATR kazanci
 * @property {number} profitFactor
 * @property {number} maxDrawdownAtr
 * @property {number} avgRr
 * @property {number} baselineWinRate  Tum etiketlenmis olaylarin ham basari orani
 */

/** Bos sonuc iskeleti (veri yoksa donulur). Alan duzeni dolu sonucla aynidir. */
function emptyResult(baselineWinRate, labeled, warmup, embargoSec) {
  return {
    trades: [],
    summary: {
      total: 0,
      fired: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      expectancyAtr: 0,
      profitFactor: 0,
      maxDrawdownAtr: 0,
      avgRr: 0,
      baselineWinRate: baselineWinRate,
      labeled: labeled,
      totalPnlAtr: 0,
      warmupEvents: warmup,
      embargoSec: embargoSec,
    },
    byYear: [],
    equity: [],
  }
}

/** UNIX saniyeden UTC yilini verir. */
function yearOf(timeSec) {
  return new Date(timeSec * 1000).getUTCFullYear()
}

/**
 * Yuruyen ileri test. Her olay yalnizca KENDINDEN ONCEKI hafizayla
 * degerlendirilir; ileriye bakma kesinlikle yasaktir.
 *
 * @param {{events:Array, tf?:string, ctxNames?:string[]}} memory
 * @param {Array} prototypes
 * @param {{signalCfg:object, warmupEvents:number, embargoSec:number}} cfg
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @returns {{trades:Trade[], summary:Summary, byYear:Array, equity:Array<{time:number,value:number}>}}
 */
function runBacktest(memory, prototypes, cfg, onProgress) {
  const conf = Object.assign({}, DEFAULT_BACKTEST_CFG, cfg || {})
  const signalCfg = Object.assign({}, DEFAULT_SIGNAL_CFG, conf.signalCfg || {})
  const protos = Array.isArray(prototypes) ? prototypes : []

  // Ambargo negatif olamaz, aksi halde gelecege bakilirdi.
  let embargoSec = Number(conf.embargoSec)
  if (!Number.isFinite(embargoSec) || embargoSec < 0) embargoSec = 0

  let costUsd = Number(conf.costUsd)
  if (!Number.isFinite(costUsd) || costUsd < 0) costUsd = 0

  let costPct = Number(conf.costPct)
  if (!Number.isFinite(costPct) || costPct < 0) costPct = 0

  let warmup = Math.floor(Number(conf.warmupEvents))
  if (!Number.isFinite(warmup) || warmup < 0) warmup = 0

  const rawEvents = memory && Array.isArray(memory.events) ? memory.events : []
  if (rawEvents.length === 0) return emptyResult(0, 0, warmup, embargoSec)

  // Zamana gore artan sirala. Cagiranin dizisini bozmamak icin kopya alinir.
  const sorted = rawEvents.slice()
  sorted.sort(function (a, b) {
    return a.time - b.time
  })

  // Baz cizgi: TUM etiketlenmis olaylarin ham basari orani. Sistemin ne kadar
  // katma deger urettigini gormek icin sinyal filtresinden BAGIMSIZ olculur.
  let labeled = 0
  let labeledWins = 0
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i]
    if (typeof ev.outcome !== 'string') continue
    labeled++
    if (ev.success === true) labeledWins++
  }
  const baselineWinRate = labeled > 0 ? labeledWins / labeled : 0

  // Yalnizca ozellik vektoru olan olaylar hem sorgu hem aday olabilir.
  const events = []
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].features) events.push(sorted[i])
  }
  const n = events.length
  if (n === 0) return emptyResult(baselineWinRate, labeled, warmup, embargoSec)

  // Aday havuzu: olaylar zaman sirali oldugu icin her adimda bastan filtrelemek
  // yerine tek bir dizi ileri dogru buyutulur. Ayni dizi nesnesi knn'e verilir,
  // boylece kopyalama maliyeti yoktur ve test O(n) havuz bakimiyla ilerler.
  const pool = []
  const poolMemory = {
    tf: memory.tf,
    ctxNames: memory.ctxNames,
    events: pool,
  }
  let poolEnd = 0

  /** @type {Trade[]} */
  const trades = []
  const equity = []

  let total = 0
  let fired = 0
  let wins = 0
  let losses = 0
  let grossProfit = 0
  let grossLoss = 0
  let rrSum = 0
  let rrCount = 0
  let cum = 0
  let peak = 0
  let maxDrawdownAtr = 0
  let grossPnlAtr = 0     // maliyet dusulmeden onceki toplam
  let costTotalAtr = 0    // toplam islem maliyeti, ATR biriminde

  // Yil bazli kirilim: yil -> [fired, wins, losses, pnlToplam]
  const yearMap = new Map()

  const step = Math.max(1, Math.floor(n / 100))
  if (typeof onProgress === 'function') onProgress(0, 'Yürüyen ileri test başlıyor')

  for (let i = 0; i < n; i++) {
    const ev = events[i]

    // Havuzu ambargo sinirina kadar ilerlet: yalnizca `beforeTime` degerinden
    // KESIN olarak once gerceklesmis olaylar aday olur. Bu ileriye bakma
    // yasagidir ve testin gecerliligi tamamen buna baglidir.
    const beforeTime = ev.time - embargoSec
    while (poolEnd < n && events[poolEnd].time < beforeTime) {
      pool.push(events[poolEnd])
      poolEnd++
    }

    // Isinma olaylari yalnizca hafiza besler, islem uretmez.
    if (i < warmup) {
      if (typeof onProgress === 'function' && i % step === 0) {
        onProgress(Math.round(((i + 1) / n) * 100), 'Isınma: ' + (i + 1) + '/' + n)
      }
      continue
    }

    total++
    const sig = evaluateTouch(ev, ev.features, poolMemory, protos, signalCfg, beforeTime)

    if (sig && sig.fired === true) {
      const atr = Number(ev.atr)
      const tp1Atr = Math.abs(sig.tp1 - sig.entry) / atr
      const slAtr = Math.abs(sig.entry - sig.sl) / atr

      // ATR bozuksa plan fiyatlari anlamsiz olur, islem yazilmaz.
      if (atr > 0 && Number.isFinite(tp1Atr) && Number.isFinite(slAtr) && slAtr > 0) {
        // GERCEKCI KAZANC KURALI:
        // Bir islem yalnizca (a) olayin etiketi 'respect' ise VE (b) olayin
        // SONUCA KADARKI lehte hareketi planin TP1 carpanina ULASTIYSA kazanc
        // sayilir. Plan TP1'i etiketin hedefinden daha uzaga koyduysa o emir
        // gercekte dolmazdi, kazanc yazmak testi sisirirdi.
        //
        // mfeAtr DEGIL mfeExitAtr kullanilir: mfeAtr ufkun tamamini olcer ve
        // stop vurulduktan SONRAKI hareketi de icerir, yani gercekte
        // yakalanamayacak bir kazanci kazanc gibi gosterirdi. Eski hafiza
        // dosyalarinda alan yoksa mfeAtr'ye duser.
        const mfeAtr = Number(
          ev.mfeExitAtr !== undefined && ev.mfeExitAtr !== null ? ev.mfeExitAtr : ev.mfeAtr
        )
        const win = ev.success === true && mfeAtr >= tp1Atr
        const grossAtr = win ? tp1Atr : -slAtr

        // Islem maliyeti (spread + komisyon) ATR birimine cevrilip dusulur.
        // Bu, sonucu kagit uzerinde degil gercekte elde edilebilecek hale
        // getirir; kucuk zaman dilimlerinde fark buyuktur.
        // costPct verilmisse maliyet fiyata oranlidir (17 yillik testte dogru
        // olcu budur), yoksa sabit dolar maliyeti kullanilir.
        const fiyat = Number(sig.entry) || Number(ev.price) || 0
        const costPrice = costPct > 0 ? fiyat * costPct : costUsd
        const costAtr = costPrice > 0 ? costPrice / atr : 0
        const pnlAtr = grossAtr - costAtr

        fired++
        grossPnlAtr += grossAtr
        costTotalAtr += costAtr

        // wins/losses ISABET oranidir (hedef vuruldu mu), maliyetten bagimsizdir.
        if (win) wins++
        else losses++

        // Kar faktoru ise NET sonuc uzerinden hesaplanir, cunku kullaniciyi
        // ilgilendiren maliyet dusuldukten sonraki tablodur.
        if (pnlAtr >= 0) grossProfit += pnlAtr
        else grossLoss += -pnlAtr

        cum += pnlAtr
        if (cum > peak) peak = cum
        const dd = peak - cum
        if (dd > maxDrawdownAtr) maxDrawdownAtr = dd

        const rr = Number(sig.rr)
        if (Number.isFinite(rr)) {
          rrSum += rr
          rrCount++
        }

        const year = yearOf(ev.time)
        let yr = yearMap.get(year)
        if (yr === undefined) {
          yr = [0, 0, 0, 0]
          yearMap.set(year, yr)
        }
        yr[0]++
        if (win) yr[1]++
        else yr[2]++
        yr[3] += pnlAtr

        trades.push({
          id: sig.id,
          eventId: ev.id,
          time: ev.time,
          bar: ev.bar,
          year: year,
          direction: sig.direction,
          session: ev.session,
          entry: sig.entry,
          tp1: sig.tp1,
          tp2: sig.tp2,
          sl: sig.sl,
          tp1Atr: tp1Atr,
          slAtr: slAtr,
          rr: rr,
          atr: atr,
          matchCount: sig.matchCount,
          avgSimilarity: sig.avgSimilarity,
          bestSimilarity: sig.bestSimilarity,
          winRate: sig.winRate,
          confidence: sig.confidence,
          expectedMfeAtr: sig.expectedMfeAtr,
          mfeAtr: Number.isFinite(mfeAtr) ? mfeAtr : NaN,
          maeAtr: Number(ev.maeAtr),
          outcome: ev.outcome,
          // Sonuca kac barda ulasildi. Arayuz plan cizgilerini burada bitirir.
          barsToOutcome: Number.isFinite(Number(ev.barsToOutcome)) ? Number(ev.barsToOutcome) : -1,
          success: ev.success === true,
          win: win,
          grossAtr: grossAtr,   // maliyet dusulmeden
          costAtr: costAtr,     // bu islemin maliyeti, ATR biriminde
          pnlAtr: pnlAtr,       // net: grossAtr - costAtr
          equityAtr: cum,
          prototypeId: sig.prototypeId === undefined ? null : sig.prototypeId,
          prototypeLabel: sig.prototypeLabel || '',
          // Arayuzun sinyal ayrinti ekrani icin gerekli alanlar. Bunlar
          // tasinmazsa panelde "Yapi benzerligi 0,000" ve "Benzer gecmis
          // ornekler (0)" gorunur, yani mini grafikler bos kalir.
          prototypeSim: Number.isFinite(sig.prototypeSim) ? sig.prototypeSim : 0,
          expectancy: Number.isFinite(sig.expectancy) ? sig.expectancy : 0,
          reasons: Array.isArray(sig.reasons) ? sig.reasons.slice() : [],
          // Dosya boyutu buyumesin diye ilk 6 eslesme yeter.
          topMatches: Array.isArray(sig.topMatches) ? sig.topMatches.slice(0, 6) : [],
        })

        equity.push({ time: ev.time, value: cum })
      }
    }

    if (typeof onProgress === 'function' && i % step === 0) {
      onProgress(
        Math.round(((i + 1) / n) * 100),
        'Yürüyen ileri test: ' + (i + 1) + '/' + n + ', işlem ' + fired
      )
    }
  }

  if (typeof onProgress === 'function') onProgress(100, 'Yürüyen ileri test bitti: ' + fired + ' işlem')

  const totalPnl = grossProfit - grossLoss
  let profitFactor
  if (grossLoss > 0) profitFactor = grossProfit / grossLoss
  else profitFactor = grossProfit > 0 ? Infinity : 0

  const byYear = []
  const years = Array.from(yearMap.keys())
  years.sort(function (a, b) {
    return a - b
  })
  for (let i = 0; i < years.length; i++) {
    const y = years[i]
    const yr = yearMap.get(y)
    byYear.push({
      year: y,
      fired: yr[0],
      wins: yr[1],
      losses: yr[2],
      winRate: yr[0] > 0 ? yr[1] / yr[0] : 0,
      expectancyAtr: yr[0] > 0 ? yr[3] / yr[0] : 0,
    })
  }

  return {
    trades: trades,
    summary: {
      total: total,
      fired: fired,
      wins: wins,
      losses: losses,
      winRate: fired > 0 ? wins / fired : 0,
      expectancyAtr: fired > 0 ? totalPnl / fired : 0,
      profitFactor: profitFactor,
      maxDrawdownAtr: maxDrawdownAtr,
      avgRr: rrCount > 0 ? rrSum / rrCount : 0,
      baselineWinRate: baselineWinRate,
      labeled: labeled,
      totalPnlAtr: totalPnl,
      warmupEvents: warmup,
      embargoSec: embargoSec,
      // Maliyet kirilimi: brut sonuc, dusulen maliyet ve maliyetin edimi ne
      // kadar yedigini gosterir. Kucuk zaman dilimlerinde bu oran %100'u
      // asabilir, yani sistem kagit uzerinde kazanirken gercekte kaybeder.
      costUsd: costUsd,
      costPct: costPct,
      grossExpectancyAtr: fired > 0 ? grossPnlAtr / fired : 0,
      costPerTradeAtr: fired > 0 ? costTotalAtr / fired : 0,
      grossPnlAtr: grossPnlAtr,
      costTotalAtr: costTotalAtr,
      costShare: grossPnlAtr > 0 ? costTotalAtr / grossPnlAtr : (costTotalAtr > 0 ? Infinity : 0),
    },
    byYear: byYear,
    equity: equity,
  }
}

module.exports = {
  DEFAULT_BACKTEST_CFG,
  runBacktest,
}
