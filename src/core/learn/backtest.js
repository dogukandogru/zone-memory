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
 *
 * IKI KOSU YOLU (A2)
 * ---------------------------------------------------------------------------
 *   runBacktest           REFERANS YOL: her olayda kNN'i bastan hesaplar.
 *   runBacktestFromCache  AYNI testi, komsulari learn/candcache.js'ten okur.
 * Ikisi de ayni ic cekirdegi (`yuruyenIleriTest`) kullanir; aralarindaki TEK
 * fark komsularin nereden geldigidir. Muhasebe, taban orani, istatistik ve
 * ozet uretimi bir kez yazilmistir: iki kopya tutulsa biri gunun birinde
 * degisir ve onbellekli sonuc sessizce referanstan sapardi.
 */

const { DEFAULT_SIGNAL_CFG, evaluateTouch, decideFromCandidates } = require('./signal')
const candcache = require('./candcache')
const stats = require('./stats')

/** Varsayilan test ayarlari. */
const DEFAULT_BACKTEST_CFG = {
  warmupEvents: 500, // Ilk bu kadar olay yalnizca hafiza olarak kullanilir
  // Olay zamanindan bu kadar once biten kayitlar aday olabilir. Deger
  // candcache.js'ten gelir: aday havuzu kurali iki modulde ortak.
  embargoSec: candcache.DEFAULT_EMBARGO_SEC,
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
  // Bir olayin degerlendirilmesi icin havuzda AYNI TUR ve AYNI YONDEN en az
  // kac aday bulunmasi gerektigi. Sabit olay sayisi (warmupEvents) yuksek
  // zaman dilimlerinde testi anlamsiz kiliyordu: 4h'de 518 olayin 500'u
  // isinmaya gidiyor ve geriye 18 olay kaliyordu.
  warmupPerBucket: 100,
  // DEGERLENDIRME PENCERESI (saniye, olay zamani). null ise tum donem.
  //
  // Pencere yalnizca OLCUMU daraltir: disarida kalan olaylar yine komsu
  // havuzuna girer ve isinma sayaclarini isletir. Parametre aramasi (A1)
  // esikleri gecmis bir dilimde secip baska bir dilimde dogrulamak icin
  // bunu kullanir; ayni kosuyu iki kez kesip elle bolmek taban oranini ve
  // istatistikleri yanlis hesaplardi.
  evalFromTime: null,
  evalToTime: null,
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
 * @property {number} pnlAtr           Net sonuc: hedef vurulduysa +tp1Atr,
 *   kirildiysa -slAtr, zaman asiminda ufuk sonu kapanisindan hesaplanan
 *   deger (maliyet dusulmus)
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
 * @property {number|null} baselineWinRate  AYNI TURUN tabani: tetiklenen
 *   islemlerin tur karisimiyla agirliklanmis, isinma sonrasi donemden ve
 *   AYNI planla hesaplanan oran. Islem yoksa null. Tum olaylarin ham orani
 *   ayri alanda: `rawWinRate`.
 * @property {number|null} edgePts  Isabetin tabana gore farki (puan)
 * @property {number|null} edgeNetAtr  Net beklentinin tabana gore farki
 * @property {number} timeouts  Zaman asimina ugrayan islem sayisi
 * @property {number} nofill  Limit emrin hic dolmadigi olay sayisi
 * @property {string|null} warning  Orneklem yetersizse uyari metni
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
      byKind: [
        { kind: 'form', total: 0, fired: 0, wins: 0, losses: 0, winRate: 0, expectancyAtr: 0, totalPnlAtr: 0 },
        { kind: 'touch', total: 0, fired: 0, wins: 0, losses: 0, winRate: 0, expectancyAtr: 0, totalPnlAtr: 0 },
      ],
      // Islem yoksa taban da tanimsizdir (ana yolla ayni kural).
      baselineWinRate: null,
      baselineExpectancyAtr: null,
      edgePts: null,
      edgeNetAtr: null,
      rawWinRate: baselineWinRate,
      timeouts: 0,
      timeoutPnlAtr: 0,
      nofill: 0,
      fillRate: null,
      labeled: labeled,
      totalPnlAtr: 0,
      warmupEvents: warmup,
      warmupPerBucket: 0,
      evalFrom: null,
      evalTo: null,
      // Veri yok: katkı rakami yerine uyari gosterilir.
      warning: 'yetersiz hafıza',
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
 * Yuruyen ileri testin IC CEKIRDEGI. Her olay yalnizca KENDINDEN ONCEKI
 * hafizayla degerlendirilir; ileriye bakma kesinlikle yasaktir.
 *
 * Disa acilan iki yol (`runBacktest` ve `runBacktestFromCache`) bu fonksiyonu
 * cagirir; tek fark `sinyalUret` argumaninda, yani komsularin nereden
 * geldigindedir.
 *
 * @param {{events:Array, tf?:string, ctxNames?:string[]}} memory
 * @param {Array} prototypes
 * @param {{signalCfg:object, warmupEvents:number, embargoSec:number}} cfg
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @param {null|((ev:Object, i:number, events:Array, poolMemory:Object,
 *          beforeTime:number)=>Object)} [sinyalUret] null ise referans yol
 *        (her olayda kNN) kullanilir.
 * @returns {{trades:Trade[], summary:Summary, byYear:Array, equity:Array<{time:number,value:number}>}}
 */
function yuruyenIleriTest(memory, prototypes, cfg, onProgress, sinyalUret) {
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

  let warmupPerBucket = Math.floor(Number(conf.warmupPerBucket))
  if (!Number.isFinite(warmupPerBucket) || warmupPerBucket < 0) {
    warmupPerBucket = DEFAULT_BACKTEST_CFG.warmupPerBucket
  }

  // Degerlendirme penceresi: disi yalnizca hafiza olarak kullanilir.
  // DIKKAT: Number(null) sifirdir, bu yuzden once acikca null/undefined
  // elenir; yoksa "sinir yok" demek isteyen null butun olaylari elerdi.
  const sinir = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))
    ? null : Number(x))
  const pencereBas = sinir(conf.evalFromTime)
  const pencereSon = sinir(conf.evalToTime)

  const rawEvents = memory && Array.isArray(memory.events) ? memory.events : []
  if (rawEvents.length === 0) return emptyResult(0, 0, warmup, embargoSec)

  // Zamana gore artan sirala ve ozellik vektoru olanlari ayir. Bu iki adim
  // candcache.js'te TEK BIR yerde tanimli: onbellekteki aday indeksleri de
  // ayni `events` dizisine gore verildigi icin siralama iki modulde birebir
  // ayni olmak zorundadir.
  const hazir = candcache.prepareEvents(memory)
  const sorted = hazir.sorted

  // Ham sayim (bilgi amacli): tum etiketlenmis olaylarin basari orani.
  // DIKKAT: bu sayi taban olarak KULLANILMAZ. Iki olay turunun taban orani
  // birbirinden cok farklidir (olculdu: form %39-50, dokunus %23-28) ve
  // tetiklenen islemlerin neredeyse tamami form. Karisik taban kullanildiginda
  // ekranda +9 ile +13 puan katkı gorunuyordu, gercek fark -1.5 ile +3.6 puan.
  // Asil taban asagida, TUR BAZINDA ve isinma sonrasi donemde birikir.
  let labeled = 0
  let labeledWins = 0
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i]
    if (typeof ev.outcome !== 'string') continue
    labeled++
    if (ev.success === true) labeledWins++
  }
  const rawWinRate = labeled > 0 ? labeledWins / labeled : 0

  // Yalnizca ozellik vektoru olan olaylar hem sorgu hem aday olabilir.
  const events = hazir.events
  const n = events.length
  if (n === 0) return emptyResult(rawWinRate, labeled, warmup, embargoSec)

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

  // Olay turu bazli kirilim. Iki sinyal turunun (kutu olusumu / bolgeye geri
  // donus) ayri ayri ne yaptigini gormek, hangisinin gercekten calistigina
  // karar vermenin tek yoludur; toplam rakam ikisini birbirine gizler.
  const kindMap = new Map([
    ['form', { total: 0, fired: 0, wins: 0, losses: 0, pnlAtr: 0, baseN: 0, baseWins: 0, baseNetAtr: 0, timeouts: 0, timeoutPnlAtr: 0, nofill: 0 }],
    ['touch', { total: 0, fired: 0, wins: 0, losses: 0, pnlAtr: 0, baseN: 0, baseWins: 0, baseNetAtr: 0, timeouts: 0, timeoutPnlAtr: 0, nofill: 0 }],
  ])
  const kindOf = (e) => (e && e.kind === 'form' ? 'form' : 'touch')
  let slippageAtr = Number(conf.slippageAtr)
  if (!Number.isFinite(slippageAtr) || slippageAtr < 0) slippageAtr = 0
  const costCfg = { costPct: costPct, costUsd: costUsd, slippageAtr: slippageAtr }
  // Istatistik icin ham kayitlar (Wilson, bootstrap, permutasyon, kalibrasyon).
  const istatistikKayitlari = []
  const tabanHavuzu = { form: { win: [], net: [] }, touch: { win: [], net: [] } }
  let pnlRToplam = 0
  let cumR = 0
  let peakR = 0
  let maxDrawdownR = 0
  let timeouts = 0
  let timeoutPnlAtr = 0
  let nofill = 0
  // Tur + yon bazinda kac aday gorulduk (isinma olcutu).
  const kovaSayaci = new Map()
  let evalFrom = null
  let evalTo = null

  // Yil x tur bazinda taban: [n, wins, netAtr]
  const yilTabanMap = new Map()
  // Yil basina tetiklenen islemlerin tur dagilimi: Map<yil, Map<kind, adet>>
  const yilKarisimMap = new Map()
  function yilTabanKaydi (time, kind) {
    const anahtar = yearOf(time) + '|' + kind
    let kayit = yilTabanMap.get(anahtar)
    if (kayit === undefined) {
      kayit = [0, 0, 0]
      yilTabanMap.set(anahtar, kayit)
    }
    return kayit
  }

  // Bir olayin sonucunun belli oldugu zaman. Eski hafizada alan yoksa ufuk
  // sonu (olay zamani + ufuk * bar suresi) ile tahmin edilir. Kural
  // candcache.js'te tek bir yerde tanimlidir; onbellek ayni havuzu kurmak
  // zorunda oldugu icin iki yerde yazilamaz.
  const cozumZamani = candcache.cozumZamaniFabrikasi(memory, signalCfg)

  const step = Math.max(1, Math.floor(n / 100))
  if (typeof onProgress === 'function') onProgress(0, 'Yürüyen ileri test başlıyor')

  for (let i = 0; i < n; i++) {
    const ev = events[i]

    // Havuzu ambargo sinirina kadar ilerlet. Olcut olayin BASLADIGI zaman
    // degil, SONUCUNUN BELLI OLDUGU zamandir: bir olayin etiketi ufuk dolana
    // kadar bilinemez, dolayisiyla o olay daha erken bir sorguya komsu
    // olamaz. Eski kayitlarda alan yoksa ufuk sonu tahmin edilir.
    const beforeTime = ev.time - embargoSec
    while (poolEnd < n && cozumZamani(events[poolEnd]) < beforeTime) {
      pool.push(events[poolEnd])
      poolEnd++
    }

    // ISINMA: sabit olay sayisi ALT SINIR, asil olcut havuzda ayni tur ve
    // ayni yonden yeterli aday bulunmasi. Boylece 4h gibi seyrek zaman
    // dilimlerinde testin tamami isinmaya gitmez.
    const kova = kindOf(ev) + '|' + (ev.direction === 'BUY' ? 'BUY' : 'SELL')
    if (i < warmup || (kovaSayaci.get(kova) || 0) < warmupPerBucket) {
      kovaSayaci.set(kova, (kovaSayaci.get(kova) || 0) + 1)
      if (typeof onProgress === 'function' && i % step === 0) {
        onProgress(Math.round(((i + 1) / n) * 100), 'Isınma: ' + (i + 1) + '/' + n)
      }
      continue
    }
    kovaSayaci.set(kova, (kovaSayaci.get(kova) || 0) + 1)
    // Pencere disi: olay havuza girdi, isinma sayildi, ama olculmez.
    if (pencereBas !== null && ev.time < pencereBas) continue
    if (pencereSon !== null && ev.time > pencereSon) continue
    if (evalFrom === null) evalFrom = ev.time
    evalTo = ev.time

    const kb = kindMap.get(kindOf(ev))

    // 'nofill': kenara konan limit emir ufuk boyunca dolmadi, yani ortada
    // islem yok. Ne degerlendirilen olay (total) ne taban sayacina girer;
    // yalnizca dolum orani icin sayilir. Komsu havuzuna da girmez
    // (similarity.js). byKind.total ile summary.total ayni seyi sayar.
    if (ev.outcome === 'nofill') {
      nofill++
      kb.nofill++
      continue
    }

    kb.total++
    total++
    // Komsular ya burada kNN ile hesaplanir (referans yol) ya da onbellekten
    // okunur. Karar mantigi her iki durumda ayni fonksiyondan gelir.
    const sig = typeof sinyalUret === 'function'
      ? sinyalUret(ev, i, events, poolMemory, beforeTime)
      : evaluateTouch(ev, ev.features, poolMemory, protos, signalCfg, beforeTime)

    // TABAN: ayni olay, ayni maliyet, kendi etiket seviyeleriyle "secim
    // yapmadan al" senaryosu. Isinma sonrasi donemde ve TUR BAZINDA birikir.
    const tabanSonuc = baseResult(ev, costCfg)
    if (tabanSonuc.ok) {
      kb.baseN++
      if (tabanSonuc.win) kb.baseWins++
      kb.baseNetAtr += tabanSonuc.pnlAtr
      const havuz = tabanHavuzu[kindOf(ev)]
      if (havuz) {
        havuz.win.push(tabanSonuc.win ? 1 : 0)
        havuz.net.push(tabanSonuc.pnlAtr)
      }
      const yilTaban = yilTabanKaydi(ev.time, kindOf(ev))
      yilTaban[0]++
      if (tabanSonuc.win) yilTaban[1]++
      yilTaban[2] += tabanSonuc.pnlAtr
    }

    if (sig && sig.fired === true) {
      const sonuc = tradeResult(ev, sig, costCfg)

      // ATR bozuksa plan fiyatlari anlamsiz olur, islem yazilmaz.
      if (sonuc.ok) {
        const atr = Number(ev.atr)
        const tp1Atr = sonuc.tp1Atr
        const slAtr = sonuc.slAtr
        const mfeAtr = sonuc.mfeAtr
        const win = sonuc.win
        const grossAtr = sonuc.grossAtr
        const costAtr = sonuc.costAtr
        const pnlAtr = sonuc.pnlAtr
        if (sonuc.timeout) {
          timeouts++
          timeoutPnlAtr += pnlAtr
          kb.timeouts++
          kb.timeoutPnlAtr += pnlAtr
        }

        fired++
        grossPnlAtr += grossAtr
        costTotalAtr += costAtr

        kb.fired++
        kb.pnlAtr += pnlAtr
        if (win) kb.wins++
        else kb.losses++

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

        // R birimi: sonuc, o islemin KENDI riskine bolunur. ATR birimi
        // islemler arasi riski esitlemez, R esitler.
        const pnlR = slAtr > 0 ? pnlAtr / slAtr : 0
        pnlRToplam += pnlR
        cumR += pnlR
        if (cumR > peakR) peakR = cumR
        const ddR = peakR - cumR
        if (ddR > maxDrawdownR) maxDrawdownR = ddR

        istatistikKayitlari.push({
          pred: Number(sig.winRate),
          win: win,
          pnlAtr: pnlAtr,
          pnlR: pnlR,
          kind: kindOf(ev),
          // Gunluk blok onyukleme icin: ayni gun icindeki islemler bagimli.
          day: Math.floor(cozumZamani(ev) / 86400),
        })

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

        // Yilin taban hesabi icin tur dagilimi.
        let karisim = yilKarisimMap.get(year)
        if (karisim === undefined) {
          karisim = new Map()
          yilKarisimMap.set(year, karisim)
        }
        const kindAd = kindOf(ev)
        karisim.set(kindAd, (karisim.get(kindAd) || 0) + 1)

        trades.push({
          id: sig.id,
          eventId: ev.id,
          time: ev.time,
          bar: ev.bar,
          year: year,
          // Olay turu: 'form' kutu olusumu, 'touch' bolgeye geri donus.
          kind: ev.kind === 'form' ? 'form' : 'touch',
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
          pnlR: slAtr > 0 ? pnlAtr / slAtr : 0,
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

        // Egri noktasi olayin BASLADIGI zamana degil, sonucun belli oldugu
        // zamana yazilir: kar, islem acilisinda degil kapanisinda gerceklesir.
        equity.push({ time: cozumZamani(ev), value: cum, valueR: cumR })
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

  // ---------------------------------------------------------------------
  // ISTATISTIK: belirsizlik olmadan nokta tahmin yaniltir.
  // ---------------------------------------------------------------------
  /** Tur bazinda tabakalanmis permutasyon: ayni turden ayni SAYIDA rastgele
   * olay secilseydi sonuc ne olurdu. */
  function permutasyon (alan, sistemDegeri) {
    const rnd = stats.mulberry32(12345)
    const reps = 1000
    const kovalar = []
    for (const g of kindMap.entries()) {
      const havuz = tabanHavuzu[g[0]]
      if (!havuz || g[1].fired === 0 || havuz[alan].length === 0) continue
      kovalar.push({ adet: g[1].fired, dizi: havuz[alan] })
    }
    if (kovalar.length === 0 || fired === 0) return null
    let enAzKadarIyi = 0
    for (let r = 0; r < reps; r++) {
      let toplam = 0
      let adet = 0
      for (const kova of kovalar) {
        for (let i = 0; i < kova.adet; i++) {
          toplam += kova.dizi[(rnd() * kova.dizi.length) | 0]
          adet++
        }
      }
      if (adet > 0 && toplam / adet >= sistemDegeri - 1e-12) enAzKadarIyi++
    }
    return enAzKadarIyi / reps
  }

  // Tetiklenen islemlerin tur karisimi: agirlikli taban bununla hesaplanir.
  const tabanAgirlikli = (function () {
    let oran = 0
    let net = 0
    let agirlik = 0
    for (const girdi of kindMap.entries()) {
      const k = girdi[1]
      if (k.fired === 0 || k.baseN === 0) continue
      const pay = k.fired / fired
      oran += pay * (k.baseWins / k.baseN)
      net += pay * (k.baseNetAtr / k.baseN)
      agirlik += pay
    }
    if (fired === 0 || agirlik === 0) return { winRate: null, expectancyAtr: null }
    return { winRate: oran / agirlik, expectancyAtr: net / agirlik }
  })()

  const byYear = []
  const years = Array.from(yearMap.keys())
  years.sort(function (a, b) {
    return a - b
  })
  for (let i = 0; i < years.length; i++) {
    const y = years[i]
    const yr = yearMap.get(y)
    // Yilin tabani, O YIL tetiklenen islemlerin TUR KARISIMIYLA agirliklanir:
    // form ve dokunusun taban oranlari cok farkli oldugu icin duz ortalama
    // yaniltir.
    const karisim = yilKarisimMap.get(y) || new Map()
    let tabanN = 0
    let tabanWins = 0
    let tabanNet = 0
    let agirlik = 0
    for (const kind of ['form', 'touch']) {
      const pay = karisim.get(kind) || 0
      if (pay === 0) continue
      const kayit = yilTabanMap.get(y + '|' + kind)
      if (!kayit || kayit[0] === 0) continue
      tabanWins += pay * (kayit[1] / kayit[0])
      tabanNet += pay * (kayit[2] / kayit[0])
      tabanN += kayit[0]
      agirlik += pay
    }
    const tabanOran = agirlik > 0 ? tabanWins / agirlik : null
    const tabanNetIslem = agirlik > 0 ? tabanNet / agirlik : null
    byYear.push({
      year: y,
      fired: yr[0],
      wins: yr[1],
      losses: yr[2],
      winRate: yr[0] > 0 ? yr[1] / yr[0] : 0,
      expectancyAtr: yr[0] > 0 ? yr[3] / yr[0] : 0,
      baselineWinRate: tabanOran,
      baselineExpectancyAtr: tabanNetIslem,
      baseN: tabanN,
      edgePts: tabanOran === null || yr[0] === 0 ? null : (yr[1] / yr[0] - tabanOran) * 100,
      edgeNetAtr: tabanNetIslem === null || yr[0] === 0 ? null : (yr[3] / yr[0]) - tabanNetIslem,
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
      byKind: Array.from(kindMap.entries()).map(function (girdi) {
        const k = girdi[1]
        const oran = k.fired > 0 ? k.wins / k.fired : 0
        const net = k.fired > 0 ? k.pnlAtr / k.fired : 0
        const tabanOran = k.baseN > 0 ? k.baseWins / k.baseN : null
        const tabanNet = k.baseN > 0 ? k.baseNetAtr / k.baseN : null
        return {
          kind: girdi[0],
          total: k.total,
          fired: k.fired,
          wins: k.wins,
          losses: k.losses,
          winRate: oran,
          expectancyAtr: net,
          totalPnlAtr: k.pnlAtr,
          // AYNI TURUN tabani: secim yapmadan bu turun tum olaylarini almak.
          baseN: k.baseN,
          baselineWinRate: tabanOran,
          baselineExpectancyAtr: tabanNet,
          edgePts: tabanOran === null || k.fired === 0 ? null : (oran - tabanOran) * 100,
          edgeNetAtr: tabanNet === null || k.fired === 0 ? null : net - tabanNet,
          timeouts: k.timeouts,
          timeoutPnlAtr: k.timeoutPnlAtr,
          nofill: k.nofill,
          winRateCI: k.fired > 0 ? stats.wilson(k.wins, k.fired) : null,
          // R cinsinden net beklentinin %95 araligi. Kanit rozeti (S5) bunu
          // kullanir: alt sinir sifirin ustundeyse "kanitli".
          expectancyRCI: (function () {
            const kayitlar = istatistikKayitlari
              .filter((x) => x.kind === girdi[0])
              .map((x) => ({ value: x.pnlR, day: x.day }))
            const c = stats.blockBootstrapMean(kayitlar, { reps: 1000, seed: 12345 })
            return c ? { lo: c.lo, hi: c.hi, mean: c.mean } : null
          })(),
          baselinePValue: k.fired > 0 && tabanOran !== null
            ? stats.binomTwoSided(k.wins, k.fired, tabanOran)
            : null,
          // Az orneklemde sayilar guvenilmez; arayuz bunu soluk gosterir.
          lowSample: k.fired > 0 && k.fired < 30,
        }
      }),
      // TABAN: tetiklenen islemlerin TUR KARISIMIYLA agirliklanmis, isinma
      // sonrasi donemden ve AYNI planla hesaplanmis oran. Karisik taban
      // (tum olaylar, tum turler, isinma dahil) ekranda +9 ile +13 puanlik
      // sahte katki gosteriyordu. Hic islem yoksa null doner.
      baselineWinRate: tabanAgirlikli.winRate,
      baselineExpectancyAtr: tabanAgirlikli.expectancyAtr,
      edgePts: tabanAgirlikli.winRate === null || fired === 0
        ? null
        : ((wins / fired) - tabanAgirlikli.winRate) * 100,
      edgeNetAtr: tabanAgirlikli.expectancyAtr === null || fired === 0
        ? null
        : (totalPnl / fired) - tabanAgirlikli.expectancyAtr,
      // ISTATISTIK
      // Wilson %95 araligi: kucuk orneklemde isabet oraninin belirsizligi.
      winRateCI: fired > 0 ? stats.wilson(wins, fired) : null,
      // Gozlenen isabet, AYNI TURUN tabaniyla aciklanabilir mi (iki yonlu
      // binom testi). Kucuk p, farkin sansla aciklanmasinin zor oldugunu
      // soyler; buyuk p "fark yok" demektir.
      baselinePValue: fired > 0 && tabanAgirlikli.winRate !== null
        ? stats.binomTwoSided(wins, fired, tabanAgirlikli.winRate)
        : null,
      // Net beklenti icin gunluk blok onyukleme araligi.
      expectancyCI: (function () {
        const c = stats.blockBootstrapMean(
          istatistikKayitlari.map((k) => ({ value: k.pnlAtr, day: k.day })),
          { reps: 1000, seed: 12345 }
        )
        return c ? { lo: c.lo, hi: c.hi } : null
      })(),
      expectancyRCI: (function () {
        const c = stats.blockBootstrapMean(
          istatistikKayitlari.map((k) => ({ value: k.pnlR, day: k.day })),
          { reps: 1000, seed: 12345 }
        )
        return c ? { lo: c.lo, hi: c.hi } : null
      })(),
      // Ayni turden ayni sayida rastgele olay secilseydi bu sonuca ulasma
      // olasiligi. 1'e yakin deger "secim bir sey katmiyor" demektir.
      permHitP: permutasyon('win', fired > 0 ? wins / fired : 0),
      permNetP: permutasyon('net', fired > 0 ? totalPnl / fired : 0),
      // Kalibrasyon: sistemin soyledigi oran ile gerceklesen oran.
      calibration: stats.calibration(istatistikKayitlari),
      brier: stats.brier(istatistikKayitlari, tabanAgirlikli.winRate),
      // R birimi (her islem kendi riskine bolunur).
      expectancyR: fired > 0 ? pnlRToplam / fired : 0,
      totalPnlR: pnlRToplam,
      maxDrawdownR: maxDrawdownR,
      // Maliyet dahil basa bas isabet: bunun altinda kalan bir isabet orani,
      // ne kadar yuksek gorunurse gorunsun para kaybettirir.
      breakEvenWinRate: (function () {
        const ortRr = rrCount > 0 ? rrSum / rrCount : 0
        if (!(ortRr > 0)) return null
        const maliyetR = fired > 0 ? (costTotalAtr / fired) : 0
        const ortSl = fired > 0 ? (grossPnlAtr === 0 ? 1 : 1) : 1
        return (1 + maliyetR * ortSl) / (1 + ortRr)
      })(),
      // Maliyet iki kat olsaydi net beklenti ne olurdu (duyarlilik).
      expectancyAtrDoubleCost: fired > 0 ? (totalPnl - costTotalAtr) / fired : 0,
      // Katki kanitlandi mi: net beklentinin alt siniri tabanin ustunde mi.
      edgeProven: (function () {
        if (fired === 0 || tabanAgirlikli.expectancyAtr === null) return null
        const c = stats.blockBootstrapMean(
          istatistikKayitlari.map((k) => ({ value: k.pnlAtr, day: k.day })),
          { reps: 1000, seed: 12345 }
        )
        if (!c) return null
        return c.lo > tabanAgirlikli.expectancyAtr
      })(),
      // Bilgi amacli ham oran: tum etiketli olaylar, tur ayrimi yok.
      rawWinRate: rawWinRate,
      timeouts: timeouts,
      timeoutPnlAtr: timeoutPnlAtr,
      // Limit emrin hic dolmadigi olaylar: islem sayilmaz, dolum orani
      // ayrica raporlanir (dokunus olaylarinda anlamlidir).
      nofill: nofill,
      // Dolum orani: dolan dokunus emirlerinin, dolan + dolmayanlara orani.
      // (k.total artik yalnizca DEGERLENDIRILEN, yani dolan olaylari sayar.)
      fillRate: (function () {
        let dolan = 0
        let dolmayan = 0
        for (const g of kindMap.entries()) {
          if (g[0] !== 'touch') continue
          dolan += g[1].total
          dolmayan += g[1].nofill
        }
        const toplam = dolan + dolmayan
        return toplam > 0 ? dolan / toplam : null
      })(),
      labeled: labeled,
      totalPnlAtr: totalPnl,
      warmupEvents: warmup,
      warmupPerBucket: warmupPerBucket,
      // Degerlendirilen donem: isinma bittikten sonraki ilk ve son olay.
      evalFrom: evalFrom,
      evalTo: evalTo,
      // Orneklem yetersizse katkı rakami yaniltici olur; arayuz bu uyariyi
      // sayinin yerine gosterir.
      warning: (function () {
        if (total === 0) return 'yetersiz hafıza'
        if (fired === 0) return 'işlem yok'
        if (total < n / 2) return 'yetersiz hafıza'
        for (const g of kindMap.entries()) {
          if (g[1].fired > 0 && g[1].total < 30) return 'yetersiz örneklem'
        }
        return null
      })(),
      embargoSec: embargoSec,
      // Maliyet kirilimi: brut sonuc, dusulen maliyet ve maliyetin edimi ne
      // kadar yedigini gosterir. Kucuk zaman dilimlerinde bu oran %100'u
      // asabilir, yani sistem kagit uzerinde kazanirken gercekte kaybeder.
      costUsd: costUsd,
      costPct: costPct,
      slippageAtr: slippageAtr,
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

/**
 * REFERANS YOL. Her olayda kNN'i bastan hesaplar; sonuc, sistemin dogruluk
 * olcusudur. Onbellekli yol bununla karsilastirilarak dogrulanir
 * (test/backtest.test.js esdegerlik testi).
 *
 * @param {{events:Array, tf?:string, ctxNames?:string[]}} memory
 * @param {Array} prototypes
 * @param {{signalCfg:object, warmupEvents:number, embargoSec:number}} cfg
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @returns {{trades:Trade[], summary:Summary, byYear:Array, equity:Array<{time:number,value:number}>}}
 */
function runBacktest(memory, prototypes, cfg, onProgress) {
  return yuruyenIleriTest(memory, prototypes, cfg, onProgress, null)
}

/**
 * ONBELLEKLI YOL. `runBacktest` ile BIREBIR ayni trades/summary ciktisini
 * uretir ama komsulari hesaplamak yerine `candcache.buildCandidates` ciktisindan
 * okur. Parametre taramasi (onlarca esik denemesi) icindir: esik degistiginde
 * komsular degismedigi icin onbellek bir kez kurulur.
 *
 * Benzerlik esigi (minSimilarity) BURADA UYGULANMAZ, onbellekten gelen adaylar
 * oldugu gibi `decideFromCandidates`e verilir: esik suzgeci o fonksiyonun
 * icinde TEK BIR yerde tanimlidir. Burada bir kez daha suzmek yalnizca
 * "en yuksek benzerlik" gerekcesini bozar, karari degistirmez.
 *
 * @param {{events:Array, tf?:string, ctxNames?:string[]}} memory
 * @param {{n:number, k:number, idx:Int32Array, sim:Float32Array}} cache
 * @param {Array} protos
 * @param {{signalCfg:object, warmupEvents:number, embargoSec:number}} cfg
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @returns {{trades:Trade[], summary:Summary, byYear:Array, equity:Array<{time:number,value:number}>}}
 */
function runBacktestFromCache(memory, cache, protos, cfg, onProgress) {
  if (!cache || !cache.idx || !cache.sim) {
    throw new Error('runBacktestFromCache: gecerli bir komsu onbellegi gerekli')
  }
  const k = Math.max(0, Math.floor(Number(cache.k)))
  const n = Math.max(0, Math.floor(Number(cache.n)))
  if (!(k > 0)) throw new Error('runBacktestFromCache: onbellekte k degeri yok')

  // Onbellegin hangi hafiza icin kuruldugu burada dogrulanir. Yanlis onbellek
  // sessizce bos aday listesi uretip "hicbir sinyal olusmadi" gibi gorunurdu.
  // Yalnizca sayilir, siralanmaz: bu dogrulama esik taramasinda her kosuda
  // yapiliyor ve siralama maliyeti bosa giderdi.
  const hamOlaylar = memory && Array.isArray(memory.events) ? memory.events : []
  let beklenenN = 0
  for (let i = 0; i < hamOlaylar.length; i++) {
    if (hamOlaylar[i] && hamOlaylar[i].features) beklenenN++
  }
  if (n !== beklenenN) {
    throw new Error('runBacktestFromCache: onbellek ' + n + ' olay icin kurulmus, hafizada ' +
      beklenenN + ' uygun olay var')
  }

  const conf = Object.assign({}, DEFAULT_BACKTEST_CFG, cfg || {})
  const signalCfg = Object.assign({}, DEFAULT_SIGNAL_CFG, conf.signalCfg || {})
  const protolar = Array.isArray(protos) ? protos : []
  const idx = cache.idx
  const sim = cache.sim

  function onbellektenSinyal (ev, i, events, poolMemory, beforeTime) {
    const adaylar = []
    const off = i * k
    for (let j = 0; j < k; j++) {
      const g = idx[off + j]
      // -1 yuvasi "bu satirda daha fazla aday yok" demektir.
      if (g < 0) break
      const olay = events[g]
      if (olay === undefined) continue
      adaylar.push({ event: olay, similarity: sim[off + j] })
    }
    // Havuzun taban orani onbellekten gelir: kalibrasyon (kuculutulmus oran)
    // bunu kullanir, tasinmazsa onbellekli yol referans yoldan sapar.
    const baseN = cache.baseN && cache.baseN.length > i ? cache.baseN[i] : 0
    const baseWins = cache.baseWins && cache.baseWins.length > i ? cache.baseWins[i] : 0
    return decideFromCandidates(ev, adaylar, undefined, signalCfg, {
      features: ev.features || null,
      prototypes: protolar,
      // Gerekce cumlesindeki "hafizada N kayit tarandi" sayisi referans yolla
      // ayni kalsin diye o andaki aday havuzunun boyu gecilir.
      scanned: poolMemory.events.length,
      beforeTime: beforeTime,
      baseRate: baseN > 0 ? baseWins / baseN : null,
      baseN: baseN,
    })
  }

  return yuruyenIleriTest(memory, protolar, cfg, onProgress, onbellektenSinyal)
}

/** Degeri [lo, hi] araligina kirpar. */
function kirp (x, lo, hi) {
  if (!Number.isFinite(x)) return 0
  return x < lo ? lo : (x > hi ? hi : x)
}

/**
 * BIR ISLEMIN SONUCU (tek tanim).
 *
 * Test, taban orani, canli gunluk ve onbellekli test hep bu fonksiyonu
 * kullanir; kazanc kurali bir donem birkac yerde ayri ayri yazilmisti ve
 * zaman asimi hesabi bunlarin birinde yanlisti.
 *
 * Kazanc kurali: olayin etiketi 'respect' VE olayin SONUCA KADARKI lehte
 * hareketi planin TP1 carpanina ulasmis olmali. Plan TP1'i etiketin
 * hedefinden uzaga koyduysa o emir gercekte dolmazdi.
 *
 * Zaman asiminda (ne hedef ne stop) sonuc TAM STOP ZARARI degildir: ufuk
 * sonundaki kapanistan cikilir. Olculdu: formda risk 1.2-2.8 ATR oldugu icin
 * eski kural her timeout'a ortalama -2.5 ATR sahte zarar yaziyordu.
 *
 * @param {object} ev Hafiza olayi (etiketli)
 * @param {{entry:number, tp1:number, sl:number}} sig Plan
 * @param {{costPct:number, costUsd:number}} costCfg
 * @returns {{ok:boolean, win?:boolean, timeout?:boolean, grossAtr?:number,
 *            costAtr?:number, pnlAtr?:number, tp1Atr?:number, slAtr?:number,
 *            mfeAtr?:number}}
 */
function tradeResult (ev, sig, costCfg) {
  const atr = Number(ev.atr)
  const tp1Atr = Math.abs(Number(sig.tp1) - Number(sig.entry)) / atr
  const slAtr = Math.abs(Number(sig.entry) - Number(sig.sl)) / atr
  if (!(atr > 0) || !Number.isFinite(tp1Atr) || !Number.isFinite(slAtr) || !(slAtr > 0)) {
    return { ok: false }
  }

  // mfeAtr DEGIL mfeExitAtr: mfeAtr ufkun tamamini olcer ve stop vurulduktan
  // SONRAKI hareketi de icerir. Eski hafizada alan yoksa mfeAtr'ye duser.
  const mfeAtr = Number(
    ev.mfeExitAtr !== undefined && ev.mfeExitAtr !== null ? ev.mfeExitAtr : ev.mfeAtr
  )
  const timeout = ev.outcome === 'timeout'
  const win = ev.success === true && mfeAtr >= tp1Atr

  let grossAtr
  if (timeout) {
    const r = Number(ev.realizedR)
    const evRisk = Number(ev.riskAtr)
    let ham
    if (Number.isFinite(r) && evRisk > 0) {
      ham = r * evRisk
    } else {
      // Eski hafiza: ufuk sonu getirisinden tahmin.
      const fwd = Number(ev.fwdReturnPct)
      const entry = Number(ev.entryPrice) || Number(ev.price) || 0
      ham = Number.isFinite(fwd) && entry ? ((fwd / 100) * entry) / atr : 0
    }
    grossAtr = kirp(ham, -slAtr, tp1Atr)
  } else {
    grossAtr = win ? tp1Atr : -slAtr
  }

  // Islem maliyeti (spread + komisyon) ATR birimine cevrilip dusulur.
  const costPct = Number(costCfg && costCfg.costPct) || 0
  const costUsd = Number(costCfg && costCfg.costUsd) || 0
  const fiyat = Number(sig.entry) || Number(ev.price) || 0
  const costPrice = costPct > 0 ? fiyat * costPct : costUsd
  // Kayma: limit emrin beklenenden kotu dolmasi. Girisi aleyhe kaydirmak ile
  // ayni sonucu verir (odul kadar azalir, risk kadar artar) ama tek bir
  // maliyet kalemi olarak eklemek hesabi basit tutar.
  const slipAtr = Math.max(0, Number(costCfg && costCfg.slippageAtr) || 0)
  const costAtr = (costPrice > 0 ? costPrice / atr : 0) + slipAtr

  return {
    ok: true,
    win: win,
    timeout: timeout,
    grossAtr: grossAtr,
    costAtr: costAtr,
    pnlAtr: grossAtr - costAtr,
    tp1Atr: tp1Atr,
    slAtr: slAtr,
    mfeAtr: Number.isFinite(mfeAtr) ? mfeAtr : NaN,
  }
}

/**
 * TABAN ISLEMI: "hicbir secim yapmadan bu olayi al" senaryosu. Olayin KENDI
 * etiket seviyeleri (hedef ve gecersizlik) plan olarak kullanilir, maliyet
 * aynidir. Boylece sistemin katma degeri ayni plan ve ayni donem uzerinden
 * karsilastirilir.
 * @param {object} ev
 * @param {{costPct:number, costUsd:number}} costCfg
 */
function baseResult (ev, costCfg) {
  const entry = Number(ev.entryPrice)
  const tp1 = Number(ev.targetPrice)
  const sl = Number(ev.invalidPrice)
  if (!Number.isFinite(entry) || !Number.isFinite(tp1) || !Number.isFinite(sl)) return { ok: false }
  return tradeResult(ev, { entry: entry, tp1: tp1, sl: sl }, costCfg)
}

module.exports = {
  DEFAULT_BACKTEST_CFG,
  runBacktest,
  runBacktestFromCache,
  tradeResult,
  baseResult,
}
