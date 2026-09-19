'use strict'

// ============================================================================
// PRO ZONES - "proje son versiyon 3" Pine v6 indikatorunun JavaScript portu
// ----------------------------------------------------------------------------
// Kaynak: ~/Downloads/son pro.txt  (indicator("proje son versiyon 3"))
//
// Ozet mantik (Pine'daki hali):
//   1. Pivot high / pivot low barlarinda bir bolge adayi dogar.
//   2. Aday iki KESIN kapiyi gecmek zorundadir:
//        volume : pivot barinin hacmi kendi ortalamasinin minVolRatio kati VE
//                 flow skoru (clamp(vR * 3, 1, 10)) minFlowToShow uzerinde
//        bollinger : pivot tepesi ust bandin uzerinde / pivot dibi alt bandin
//                 altinda, yani asirilik bolgesinde
//      Bu iki kapi birlikte kutuyu bir "hacimli asirilik" kurulumu yapar.
//      Yon bu yuzden ORTALAMAYA DONUS yonudur: destek kutusu BUY, direnc
//      kutusu SELL. Pine'in kutuya yazdigi metin de zaten budur
//      (BUY LIQUIDITY / SELL LIQUIDITY).
//   3. Ayni yonde ve orta noktasi atr * mergeAtrMult mesafesinden yakin bir
//      aktif kutu varsa yeni kutu ACILMAZ, mevcut kutu genisletilir ve flow
//      skoru score * 0.25 kadar artar (tavan 10).
//   4. Kutuya her dokunusta (touchCooldown bar araligiyla) flow skoru 0.35
//      artar. Kapanis destegin altina atr * breakAtrMult kadar tasarsa (veya
//      direncin ustune) kutu KIRILIR ve takipten cikar.
//   5. Kutu, pivot barindan itibaren maxAgeBars bar yasar; cizimi
//      boxLengthBars bar ileri uzar.
//
// ----------------------------------------------------------------------------
// PINE'A EKLENEN KATMAN: SINYAL
// ----------------------------------------------------------------------------
// Pine yalnizca kutu ciziyordu, hicbir alis/satis olayi uretmiyordu. Bu port
// IKI olay uretir ve ikisi de sonraki hareketi ongorme iddiasindadir:
//
//   kind = 'form'   Kutu DOGDUGU anda. Pivot barindan pivotLen bar sonra
//                   onaylanir (pivot ancak o zaman kesinlesir), yani ileriye
//                   bakma yoktur. "Hacimli asirilik olustu, tepki bekliyorum."
//
//   kind = 'touch'  Kutuya yapilan ILK dokunusta. "Bolge test ediliyor,
//                   tutacak mi."
//
// Ilk dokunus, kutunun DOGDUGU bara denk gelebilir: kutu pivotun etrafinda
// dogdugu icin fiyat o anda zaten kutunun icinde olabilir. Bu kasitlidir,
// kullanicinin kararidir. Onceki bir surumde kutunun once tamamen terk
// edilmesini bekleyen bir kural vardi (`requireArmedTouch`), kaldirildi.
//
// Her bolge en fazla BIR form ve BIR touch olayi uretir. Sebebi hafiza
// katmanidir: ayni bolgeye art arda dokunuslar birbirinin kopyasidir, hepsi
// hafizaya girseydi benzerlik motoru "20 benzer kayit buldum" derken ayni
// olayin 20 kopyasini bulmus olurdu (bkz. README 6.2).
//
// ----------------------------------------------------------------------------
// PINE'DAN BILEREK AYRILAN NOKTALAR
// ----------------------------------------------------------------------------
//  1. box / label gibi gorsel nesneler uretilmez. Bolgeler duz veri olarak
//     doner, cizim isi renderer'indir.
//  2. Pine'da bolge listesi maxZones asilinca EN ESKI kutu takipten cikar ama
//     grafikte kalir. Burada da ayni: kutu `zones` ciktisina gecer, yalnizca
//     canli takipten duser.
//  3. Skorlama katmani Pine'da yok. Kutu olusumunun kapisi (hacim + bollinger)
//     zaten KESIN oldugu icin, o iki kriter her kutuda dogrudur ve skor
//     bileseni olarak bilgi tasimaz. Bu yuzden skor, olayin OLDUGU BARDA
//     degisen bes seyi olcer: flow gucu, ust zaman dilimi trendi, seans,
//     fitil reddi ve o barin hacim gucu.
//  4. Ust zaman dilimi trendi ve seans bilgisi Pine'da hic yoktur; buraya
//     yalnizca BAGLAM ve skor bileseni olarak eklendi. Kutu olusumunu
//     etkilemezler.
//  5. Pine tek bir zaman diliminde calisir; hangi serinin taranacagina ana
//     uygulama karar verir, indikator kendisine verileni isler.
// ============================================================================

const { sma, ema, atr, rsi, stdev, pivotHigh, pivotLow, clamp } = require('../ta')
const { SESSIONS, sessionIndexArray, localHourArray, localDowArray } = require('../session')
const { resample } = require('../series')
const { tfSeconds } = require('../tf')

/**
 * Varsayilanlar. Ilk on alan Pine'daki input() degerlerinin BIREBIR
 * karsiligidir, geri kalani bu porta ozgudur.
 */
const DEFAULT_PARAMS = {
  // --- Pine: Bolge Ayarlari ---
  pivotLen: 5,
  atrLen: 14,
  zoneAtrMult: 0.35,
  mergeAtrMult: 0.55,
  maxZones: 24,
  // KUTU DURUMU ARALIKLARINI KAYDET (Y3). Varsayilan kapali: yalnizca ust
  // zaman dilimi baglami olculurken gerekiyor ve bellekte yer tutuyor.
  recordTimeline: false,
  maxAgeBars: 100,
  touchCooldown: 12,
  boxLengthBars: 100,
  // --- Pine: Volume Ayarlari ---
  useVolumeFilter: true,
  volumeLen: 50,
  minVolRatio: 1.05,
  minFlowToShow: 6.0,
  // --- Pine: Bollinger Band ---
  useBBFilter: true,
  bbLen: 20,
  bbMult: 2.0,
  // Pine'da sabit yazilmis kirilma tamponu (close < bot - atr * 0.15).
  breakAtrMult: 0.15,

  // --- Sinyal katmani (Pine'da yok) ---
  signalOnForm: true,
  signalOnTouch: true,
  minScoreForSignal: 3,
  strongScoreLevel: 4,
  strongFlowLevel: 8.0,
  useFlowScore: true,
  useTrendScore: true,
  useSessionScore: true,
  useRejectionScore: true,
  useVolumeScore: true,
  wickMinRatio: 0.35,

  // --- Baglam (Pine'da yok, ozellik vektoru ve skor icin) ---
  useHtfTrend: true,
  // TREND ZAMAN DILIMI: 'auto' = grafigin dort kati.
  //
  // Bir donem sabit '15m' idi ve 15m grafikte bilesen kendi zaman diliminin
  // EMA'sini soruyordu, yani "ust zaman dilimi trendi" adi yanilticiydi.
  trendTf: 'auto',
  emaFastLen: 50,
  emaSlowLen: 200,
  // SEANS SAAT DILIMI: Europe/Athens.
  //
  // Kullanicinin saati Istanbul, ama seans ve saat OZELLIKLERI icin Istanbul
  // yanlis bir referans: Turkiye 2016 Eylul'unde yaz saatini birakti, bu
  // yuzden Londra'nin 08:00 acilisi 2016 oncesi yerel 10:00, sonrasinda
  // kislari yerel 11:00 oluyordu. kNN ayni piyasa anini iki farkli saat
  // olarak goruyordu. Atina AB kuralini kesintisiz surdurdugu icin ayni an
  // butun tarihte ayni yerel saate denk gelir (olculdu: Londra 08:00 ->
  // 2012, 2017 ve 2024'te her zaman yerel 10).
  //
  // Ekranda gorunen saatler DEGISMEDI, onlar hala Istanbul saatidir.
  sessionTz: 'Europe/Athens',
  hardSessionGate: false,
  useAsia: true,
  useLondon: true,
  useNewYork: true,
  useOther: true,

  mintick: 0.01,
}

/** Trend zaman dilimi cozulemezse 15 dakikaya duser. */
const TREND_TF_FALLBACK_SEC = 900

/** Flow skorunun Pine'daki tavani ve tabani. */
const FLOW_MIN = 1.0
const FLOW_MAX = 10.0

/**
 * Bos sonuc iskeleti: uzunlugu 0 olan seride bile tum baglam alanlari dolu olur.
 * @param {number} n
 */
function emptyContext (n) {
  const f = () => { const a = new Float64Array(n); a.fill(NaN); return a }
  return {
    atr: f(), rsi: f(), sma20: f(), sma50: f(),
    bbBasis: f(), bbUpper: f(), bbLower: f(),
    volRatio: new Float64Array(n), flowScore: new Float64Array(n),
    bullTrend: new Uint8Array(n), bearTrend: new Uint8Array(n),
    sessionIdx: new Uint8Array(n), localHour: new Uint8Array(n), localDow: new Uint8Array(n),
  }
}

/**
 * request.security(..., trendTF, lookahead_off) karsiligi. Trend zaman dilimi
 * grafikten BUYUKSE seri o dilime yeniden orneklenir, EMA'lar orada hesaplanir
 * ve degerler HTF bari KAPANDIKTAN sonra gecerli olur. Boylece bir grafik bari
 * asla kapanmamis bir HTF barini goremez.
 *
 * @param {object} s
 * @param {object} p
 * @param {number} tfSec
 * @param {Uint8Array} bullTrend
 * @param {Uint8Array} bearTrend
 */
function fillHtfTrend (s, p, tfSec, bullTrend, bearTrend) {
  const n = s.length
  let trendSec
  // 'auto': grafik zaman diliminin DORT KATI. Bir donem varsayilan sabit
  // '15m' idi ve 15m grafikte "ust zaman dilimi trendi" aslinda AYNI zaman
  // dilimi oluyordu, yani bilesen kendi grafiginin EMA'sini soruyordu.
  if (p.trendTf === 'auto') {
    trendSec = tfSec * 4
  } else {
    try {
      trendSec = tfSeconds(p.trendTf)
    } catch (err) {
      trendSec = TREND_TF_FALLBACK_SEC
    }
  }

  if (!(trendSec > tfSec)) {
    const close = s.close
    const fast = ema(close, p.emaFastLen)
    const slow = ema(close, p.emaSlowLen)
    for (let i = 0; i < n; i++) {
      const c = close[i]
      const f = fast[i]
      const sl = slow[i]
      bullTrend[i] = (c > f && f > sl) ? 1 : 0
      bearTrend[i] = (c < f && f < sl) ? 1 : 0
    }
    return
  }

  const htf = resample(s, trendSec)
  const hn = htf.length
  if (hn === 0) return
  const hClose = htf.close
  const hTime = htf.time
  const hFast = ema(hClose, p.emaFastLen)
  const hSlow = ema(hClose, p.emaSlowLen)

  const time = s.time
  let k = 0
  let j = -1
  for (let i = 0; i < n; i++) {
    const t = time[i]
    while (k < hn && hTime[k] + trendSec <= t) { j = k; k++ }
    if (j < 0) continue
    const c = hClose[j]
    const f = hFast[j]
    const sl = hSlow[j]
    bullTrend[i] = (c > f && f > sl) ? 1 : 0
    bearTrend[i] = (c < f && f < sl) ? 1 : 0
  }
}

/**
 * Indikatoru bastan sona calistirir.
 *
 * @param {object} s        Series (time/open/high/low/close/volume + length)
 * @param {object} [params] DEFAULT_PARAMS uzerine yazilir
 * @param {number} tfSec    Serinin zaman dilimi (saniye)
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @returns {{zones: Array, touches: Array, context: object, stats: object}}
 *          `touches`, geriye uyumluluk icin bu adi tasir; icinde hem 'form'
 *          hem 'touch' turunde olaylar vardir, ayrimi `kind` alani yapar.
 */
/**
 * Pine input araliklari. Pine'da her girdi `minval`/`maxval` ile sinirlidir;
 * port bu sinirlari uygulamazsa kullanici Pine'da mumkun OLMAYAN bir ayarla
 * tarama yapip "grafikle ayni degil" sonucuna varir. Kirpilan alanlar
 * stats.paramsClamped icinde raporlanir.
 */
const PINE_ARALIKLARI = {
  pivotLen: [2, 20],
  atrLen: [5, 100],
  zoneAtrMult: [0.05, 2.0],
  // 0 "birlestirme kapali" anlaminda kabul edilir (Pine'da boyle bir secenek
  // yok, port ekidir); 0 disindaki degerler Pine araligina kirpilir.
  mergeAtrMult: [0.10, 3.0],
  maxZones: [5, 100],
  maxAgeBars: [50, 5000],
  touchCooldown: [1, 100],
  boxLengthBars: [1, 5000],
  volumeLen: [10, 300],
  minVolRatio: [0.1, 5.0],
  minFlowToShow: [1.0, 10.0],
  bbLen: [1, 1000],
  bbMult: [0.1, 50],
}

function runIndicator (s, params, tfSec, onProgress) {
  const p = Object.assign({}, DEFAULT_PARAMS, params || {})
  // Pine araliklarina kirp.
  const paramsClamped = {}
  for (const alan of Object.keys(PINE_ARALIKLARI)) {
    const deger = +p[alan]
    if (!Number.isFinite(deger)) continue
    if (alan === 'mergeAtrMult' && deger === 0) continue
    const [alt, ust] = PINE_ARALIKLARI[alan]
    const kirpilmis = deger < alt ? alt : (deger > ust ? ust : deger)
    if (kirpilmis !== deger) {
      paramsClamped[alan] = { istenen: deger, kullanilan: kirpilmis }
      p[alan] = kirpilmis
    }
  }
  const n = s ? (s.length | 0) : 0
  const step = tfSec > 0 ? tfSec : 60

  let lastPct = -1
  let emitted = 0
  const report = (pct, msg) => {
    if (typeof onProgress !== 'function') return
    const v = pct < 0 ? 0 : (pct > 100 ? 100 : (pct | 0))
    if (v <= lastPct || emitted >= 100) return
    lastPct = v
    emitted++
    onProgress(v, msg)
  }

  const stats = {
    bars: n,
    zonesCreated: 0, zonesMerged: 0, zonesBroken: 0,
    blockedByVolume: 0, blockedByBB: 0,
    formEvents: 0, touchEvents: 0, firstTouches: 0,
    qualified: 0, gateBlockedSession: 0, scoreHist: {},
    // Pine araligina kirpilan ayarlar (bos ise hicbir kirpma olmadi).
    paramsClamped: paramsClamped,
  }

  if (n === 0) {
    return { zones: [], touches: [], context: emptyContext(0), stats }
  }

  const open = s.open
  const high = s.high
  const low = s.low
  const close = s.close
  const volume = s.volume
  const time = s.time

  const pivotLen = Math.max(1, p.pivotLen | 0)
  const mintick = p.mintick > 0 ? p.mintick : 1e-9

  report(2, 'ATR ve hacim ortalamasi hesaplaniyor')

  // --- Pine: atr = ta.atr(atrLen), volMA = ta.sma(volume, volumeLen) --------
  const atrNow = atr(high, low, close, Math.max(1, p.atrLen | 0))
  const volMA = sma(volume, Math.max(1, p.volumeLen | 0))

  // Pine: vDen = volMA > 0 ? volMA : volume ; vR = volume / vDen
  //       score = math.min(10, math.max(1, vR * 3.0))
  const volRatio = new Float64Array(n)
  const flowScore = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const ma = volMA[i]
    const den = (ma === ma && ma > 0) ? ma : volume[i]
    const r = den > 0 ? volume[i] / den : 1.0
    volRatio[i] = r
    const sc = r * 3.0
    flowScore[i] = sc < FLOW_MIN ? FLOW_MIN : (sc > FLOW_MAX ? FLOW_MAX : sc)
  }

  report(8, 'Bollinger bantlari hesaplaniyor')

  // --- Pine: bbBasis / bbUpper / bbLower -----------------------------------
  const bbLen = Math.max(1, p.bbLen | 0)
  const bbBasis = sma(close, bbLen)
  const bbSd = stdev(close, bbLen)
  const bbUpper = new Float64Array(n)
  const bbLower = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const d = p.bbMult * bbSd[i]
    bbUpper[i] = bbBasis[i] + d
    bbLower[i] = bbBasis[i] - d
  }

  report(12, 'Trend ve seans baglami hazirlaniyor')

  // --- Baglam: HTF trend ---------------------------------------------------
  const bullTrend = new Uint8Array(n)
  const bearTrend = new Uint8Array(n)
  if (p.useHtfTrend) fillHtfTrend(s, p, step, bullTrend, bearTrend)

  // --- Baglam: seanslar ----------------------------------------------------
  const sessionIdx = sessionIndexArray(time, p.sessionTz)
  const localHour = localHourArray(time, p.sessionTz)
  const localDow = localDowArray(time, p.sessionTz)
  const allowedMap = {
    Asia: !!p.useAsia,
    London: !!p.useLondon,
    'New York': !!p.useNewYork,
    Other: !!p.useOther,
  }
  const allowedBySession = new Uint8Array(SESSIONS.length)
  for (let i = 0; i < SESSIONS.length; i++) {
    allowedBySession[i] = allowedMap[SESSIONS[i]] ? 1 : 0
  }

  // --- Skor bileseni: fitil reddi ------------------------------------------
  const bullReject = new Uint8Array(n)
  const bearReject = new Uint8Array(n)
  {
    const wickMin = p.wickMinRatio
    for (let i = 0; i < n; i++) {
      const o = open[i]
      const c = close[i]
      const h = high[i]
      const l = low[i]
      let rng = h - l
      if (!(rng > mintick)) rng = mintick
      const bodyLow = o < c ? o : c
      const bodyHigh = o > c ? o : c
      bullReject[i] = ((bodyLow - l) / rng >= wickMin && c > o) ? 1 : 0
      bearReject[i] = ((h - bodyHigh) / rng >= wickMin && c < o) ? 1 : 0
    }
  }

  report(18, 'Pivotlar araniyor')

  // --- Pine: ta.pivothigh / ta.pivotlow ------------------------------------
  const pivHigh = pivotHigh(high, pivotLen, pivotLen)
  const pivLow = pivotLow(low, pivotLen, pivotLen)

  // Ozellik cikariminin yeniden hesaplamamasi icin baglam dizileri.
  const rsi14 = rsi(close, 14)
  const sma20 = sma(close, 20)
  const sma50 = sma(close, 50)

  // ------------------------------------------------------------------------
  // Aktif bolge listesi
  // ------------------------------------------------------------------------
  const maxZones = Math.max(1, p.maxZones | 0)
  const maxAgeBars = Math.max(1, p.maxAgeBars | 0)
  const boxLengthBars = Math.max(1, p.boxLengthBars | 0)
  const touchCooldown = Math.max(1, p.touchCooldown | 0)
  const mergeAtrMult = p.mergeAtrMult
  const zoneAtrMult = p.zoneAtrMult
  const breakAtrMult = p.breakAtrMult
  const minVolRatio = p.minVolRatio
  const minFlowToShow = p.minFlowToShow
  const hardSessionGate = !!p.hardSessionGate
  // Seans bileseni ancak AYIRT EDICIYSE skora girer: dort seans da acikken
  // her olayda 1 cikar ve yalnizca maxScore'u sisirir (bkz. emitEvent).
  const seansSkoruSayilir = !!p.useSessionScore &&
    !(p.useAsia && p.useLondon && p.useNewYork && p.useOther)

  /** @type {Array<Object>} canli kutular, olusum sirasinda */
  let live = []
  const zones = []
  const touches = []
  let nextZoneId = 0
  let nextEventId = 0
  const scoreCounts = new Int32Array(16)

  const lastTime = time[n - 1]
  /** Bar seri disina tasarsa zamani zaman dilimi adimiyla tahmin edilir. */
  const barTime = (bar) => (bar < n ? time[bar] : lastTime + (bar - (n - 1)) * step)

  // ------------------------------------------------------------------------
  // ZAMAN CIZELGESI (Y3, `p.recordTimeline` ile acilir)
  // ------------------------------------------------------------------------
  // Ust zaman dilimi bolgesini bir alt zaman dilimi olayina eklemek isteyen
  // her hesap, "o an bu kutu BILINIYOR MUYDU" sorusunu dogru cevaplamak
  // zorundadir. zones.json'daki `createdTime` barin ACILISIDIR ve `top` /
  // `bottom` kutunun NIHAI sinirlaridir; ikisini kullanmak ileriye bakmaktir.
  // Olculdu: naif zamanlamayla 5m formda "aktif 1h kutusu yakini" %53,0'a
  // karsi %45,8 gorunuyor (+7 puan), dogru zamanlamayla %48,1'e karsi %46,1
  // ve araliklar ortusuyor.
  //
  // Bu yuzden cizelge ARALIK tutar: bir kutu durumu ancak `knownFrom`
  // (dogum ya da birlesme barinin KAPANISI) ile `knownTo` (kirilma, yaslanma
  // ya da maxZones cikarma barinin kapanisi) arasinda o sinirlarla bilinir.
  // Birlesmede eski aralik kapanir, yeni sinirlarla yenisi acilir.
  const timeline = p.recordTimeline ? [] : null
  /** Bir barin KAPANIS zamani. */
  const barKapanis = (bar) => (bar < n ? time[bar] : lastTime) + step
  /** zoneId -> acik cizelge kaydinin indeksi. */
  const cizelgeAcik = timeline ? new Map() : null

  /** Kutunun o anki sinirlariyla yeni bir cizelge araligi acar. */
  const cizelgeAc = (z, bar) => {
    if (!timeline) return
    cizelgeAcik.set(z.id, timeline.length)
    timeline.push({
      zoneId: z.id,
      isSupport: z.isSupport,
      top: z.top,
      bottom: z.bottom,
      knownFrom: barKapanis(bar),
      knownTo: null,
    })
  }

  /** Acik araligi kapatir (kutu takipten dustu ya da sinirlari degisti). */
  const cizelgeKapat = (zoneId, bar) => {
    if (!timeline) return
    const idx = cizelgeAcik.get(zoneId)
    if (idx === undefined) return
    const kayit = timeline[idx]
    if (kayit && kayit.knownTo === null) kayit.knownTo = barKapanis(bar)
    cizelgeAcik.delete(zoneId)
  }

  /** Takipten dusen kutuyu cikti listesine yazar. */
  const emitZone = (z, lastBar) => {
    cizelgeKapat(z.id, lastBar)
    const right = Math.min(lastBar, z.pivotBar + boxLengthBars)
    zones.push({
      id: z.id,
      isSupport: z.isSupport,
      top: z.top,
      bottom: z.bottom,
      createdBar: z.createdBar,
      createdTime: time[z.createdBar],
      pivotBar: z.pivotBar,
      pivotTime: time[z.pivotBar],
      endBar: right,
      endTime: barTime(right),
      flow: z.flow,
      flowAtBirth: z.flowAtBirth,
      mergeCount: z.mergeCount,
      bbDistAtr: z.bbDistAtr,
      broken: z.broken,
      brokenBar: z.broken ? z.brokenBar : -1,
      touchCount: z.touchCount,
    })
  }

  /**
   * Bir bolge olayini (form veya touch) uretip `touches` listesine ekler.
   * Kapali tur icin hic olay uretilmez.
   * @param {'form'|'touch'} kind
   * @param {Object} z
   * @param {number} i
   */
  const emitEvent = (kind, z, i) => {
    if (kind === 'form' && !p.signalOnForm) return
    if (kind === 'touch' && !p.signalOnTouch) return

    const isSupport = z.isSupport
    const top = z.top
    const bottom = z.bottom
    const sIdx = sessionIdx[i]
    const sessionAllowed = allowedBySession[sIdx] === 1
    const trendOk = (isSupport ? bullTrend[i] : bearTrend[i]) === 1
    const rejectOk = (isSupport ? bullReject[i] : bearReject[i]) === 1
    const volOk = volRatio[i] >= minVolRatio
    const flowOk = z.flow >= p.strongFlowLevel

    // Skor: kutu olusumunun kapisi (hacim + bollinger) her kutuda zaten dogru
    // oldugu icin skora girmez. Buradaki bes bilesen olayin OLDUGU BARDA
    // degisen seylerdir.
    let score = 0
    let maxScore = 0
    if (p.useFlowScore) { maxScore++; if (flowOk) score++ }
    if (p.useTrendScore) { maxScore++; if (trendOk) score++ }
    // SEANS BILESENI: dort seansin hepsi acikken bu bilesen HER OLAYDA 1'dir,
    // yani skora hicbir sey katmaz ama maxScore'u bir artirir. Etkisi sessizdi:
    // "5 bilesenden 3'u" diye okunan minScoreForSignal=3 esigi, gercekte
    // "4 bilesenden 2'si" oluyordu. Artik bilesen ancak en az bir seans
    // KAPALIYSA sayiliyor.
    if (seansSkoruSayilir) { maxScore++; if (sessionAllowed) score++ }
    if (p.useRejectionScore) { maxScore++; if (rejectOk) score++ }
    if (p.useVolumeScore) { maxScore++; if (volOk) score++ }
    if (maxScore === 0) maxScore = 1

    const needed = p.minScoreForSignal < maxScore ? p.minScoreForSignal : maxScore
    const strongNeeded = p.strongScoreLevel < maxScore ? p.strongScoreLevel : maxScore
    const sessionGateOk = !hardSessionGate || sessionAllowed
    const qualified = score >= needed && sessionGateOk

    if (score >= 0 && score < scoreCounts.length) scoreCounts[score]++
    if (score >= needed && !sessionGateOk) stats.gateBlockedSession++
    if (qualified) stats.qualified++

    const highI = high[i]
    const lowI = low[i]
    const closeI = close[i]
    const height = top - bottom
    const atrI = atrNow[i]
    const atrOk = atrI === atrI && atrI > 0

    // Bolgeye ne kadar girildi (0..1). Form olayinda fiyat henuz donmedigi
    // icin 0 kalir.
    let penetration = 0
    if (kind === 'touch' && height > 0) {
      penetration = isSupport
        ? (top - (lowI < top ? lowI : top)) / height
        : ((highI > bottom ? highI : bottom) - bottom) / height
      penetration = clamp(penetration, 0, 1)
    }

    // Kapanis, bolgenin YAKIN kenarindan ne kadar uzakta (ATR biriminde).
    // Form olayinda fiyatin pivottan ne kadar uzaklastigini olcer; temas
    // olayinda fiyat kenarin icinde oldugu icin sifira yakindir.
    const nearEdge = isSupport ? top : bottom
    let entryDistAtr = 0
    if (atrOk) {
      const d = isSupport ? closeI - nearEdge : nearEdge - closeI
      entryDistAtr = d > 0 ? d / atrI : 0
    }

    if (kind === 'form') stats.formEvents++
    else { stats.touchEvents++; stats.firstTouches++ }

    touches.push({
      id: nextEventId++,
      zoneId: z.id,
      kind: kind,
      isSupport: isSupport,
      direction: isSupport ? 'BUY' : 'SELL',
      bar: i,
      time: time[i],
      price: closeI,
      zoneTop: top,
      zoneBottom: bottom,
      zoneFlow: z.flow,
      zoneAgeBars: i - z.pivotBar,
      penetration: penetration,
      entryDistAtr: entryDistAtr,
      bbDistAtr: z.bbDistAtr,
      volRatio: volRatio[i],
      atr: atrI,
      score: score,
      maxScore: maxScore,
      qualified: qualified,
      strong: score >= strongNeeded,
      session: SESSIONS[sIdx],
      parts: {
        flow: flowOk,
        trend: p.useTrendScore ? trendOk : false,
        // Bilesen skora girmiyorsa parca da false yazilir; features.js
        // pSession degerini buradan okur.
        session: seansSkoruSayilir ? sessionAllowed : false,
        rejection: p.useRejectionScore ? rejectOk : false,
        volume: p.useVolumeScore ? volOk : false,
      },
    })
  }

  /**
   * Pine'daki iki kutu olusum blogunun ortak govdesi.
   * @param {number} i         Onay bari (bar_index)
   * @param {boolean} isSupport
   * @returns {void}
   */
  const tryCreateZone = (i, isSupport) => {
    const pi = i - pivotLen
    const pv = isSupport ? pivLow[i] : pivHigh[i]
    if (pv !== pv) return

    const atrPivot = atrNow[pi]
    if (!(atrPivot === atrPivot)) return

    // Pine: zH = atr[pivotLen] * zoneAtrMult
    //       direnc  -> top = ph + zH, bot = ph - zH * 0.25
    //       destek  -> top = pl + zH * 0.25, bot = pl - zH
    const zH = atrPivot * zoneAtrMult
    const top = isSupport ? pv + zH * 0.25 : pv + zH
    const bottom = isSupport ? pv - zH : pv - zH * 0.25

    const vR = volRatio[pi]
    const score = flowScore[pi]

    const volOK = !p.useVolumeFilter || (vR >= minVolRatio && score >= minFlowToShow)
    if (!volOK) { stats.blockedByVolume++; return }

    const band = isSupport ? bbLower[pi] : bbUpper[pi]
    const bbOK = !p.useBBFilter || (band === band && (isSupport ? pv <= band : pv >= band))
    if (!bbOK) { stats.blockedByBB++; return }

    // Pivotun banttan ne kadar disari tastigi, ATR biriminde. Asirilik
    // derinliginin olcusudur; ozellik vektorune girer.
    let bbDistAtr = 0
    if (band === band && atrPivot > 0) {
      const d = isSupport ? band - pv : pv - band
      bbDistAtr = d > 0 ? d / atrPivot : 0
    }

    // BIRLESTIRME (Pine ile birebir)
    // Pine: `math.abs(ph - midOld) <= atr * mergeAtrMult` yani mesafe PIVOT
    // FIYATI ile eski kutunun orta noktasi arasinda olculur (yeni kutunun
    // orta noktasiyla DEGIL) ve dongu ilk eslesmede DURMAZ: yakin olan TUM
    // ayni yonlu kutular genisler. ATR yoksa (na) birlesme olmaz.
    // Olculdu: bu farklar 15m'de kutularin yaklasik %1'ini degistiriyordu.
    const atrI = atrNow[i]
    let merged = false
    if (mergeAtrMult > 0 && atrI === atrI) {
      const limit = atrI * mergeAtrMult
      for (let j = 0; j < live.length; j++) {
        const z = live[j]
        if (z.isSupport !== isSupport) continue
        const midOld = (z.top + z.bottom) / 2.0
        const d = pv - midOld
        if ((d < 0 ? -d : d) > limit) continue

        const boosted = z.flow + score * 0.25
        z.flow = boosted > FLOW_MAX ? FLOW_MAX : boosted
        const sinirDegisti = top > z.top || bottom < z.bottom
        if (top > z.top) z.top = top
        if (bottom < z.bottom) z.bottom = bottom
        z.mergeCount++
        merged = true
        // Sinirlar degistiyse cizelgede eski aralik kapanir ve yeni
        // sinirlarla yenisi acilir; eski karar anlari eski sinirlari gormeye
        // devam eder.
        if (sinirDegisti) {
          cizelgeKapat(z.id, i)
          cizelgeAc(z, i)
        }
      }
    }
    if (merged) {
      // Pine'da sayac pivot basina bir kez artar, kac kutu genisledigine
      // bakilmaz.
      stats.zonesMerged++
      return
    }

    stats.zonesCreated++
    const zone = {
      id: nextZoneId++,
      isSupport: isSupport,
      top: top,
      bottom: bottom,
      pivotBar: pi,
      createdBar: i,
      flow: score,
      flowAtBirth: score,
      bbDistAtr: bbDistAtr,
      mergeCount: 0,
      touchCount: 0,
      lastTouchBar: -1,
      touchFired: false,
      broken: false,
      brokenBar: -1,
    }
    live.push(zone)
    cizelgeAc(zone, i)
    emitEvent('form', zone, i)
  }

  // Ilerleme en fazla 75 kez daha bildirilir.
  const progressStep = Math.max(1, Math.floor(n / 75))
  let nextReportBar = 0

  // ------------------------------------------------------------------------
  // ANA DONGU - sira Pine ile aynidir:
  //   1) direnc olusumu, 2) destek olusumu, 3) fazla kutu kirpma,
  //   4) dokunus + kirilma guncellemesi
  // ------------------------------------------------------------------------
  for (let i = 0; i < n; i++) {
    if (i >= nextReportBar) {
      nextReportBar = i + progressStep
      report(22 + (i / n) * 78, 'Bolgeler ve sinyaller taraniyor')
    }

    if (i >= pivotLen) {
      tryCreateZone(i, false)
      tryCreateZone(i, true)
    }

    // Pine: while array.size(zones) > maxZones -> en eskiyi takipten cikar.
    while (live.length > maxZones) {
      emitZone(live.shift(), i)
    }

    const closeI = close[i]
    const highI = high[i]
    const lowI = low[i]
    const atrI = atrNow[i]
    const breakBuf = (atrI === atrI ? atrI : 0) * breakAtrMult

    let died = false
    for (let j = 0; j < live.length; j++) {
      const z = live[j]

      // Pine: tooOld = bar_index - born > maxAgeBars
      if (i - z.pivotBar > maxAgeBars) {
        emitZone(z, i)
        live[j] = null
        died = true
        continue
      }

      const touched = lowI <= z.top && highI >= z.bottom

      // Pine: skor artisi, cooldown ile ve yalnizca kirilmamis kutuda.
      if (touched && !z.broken &&
          (z.lastTouchBar < 0 || i - z.lastTouchBar >= touchCooldown)) {
        const boosted = z.flow + 0.35
        z.flow = boosted > FLOW_MAX ? FLOW_MAX : boosted
        z.lastTouchBar = i
        z.touchCount++

        // Sinyal katmani: kutuya yapilan ILK dokunus bir olay uretir.
        // Bu, kutunun dogdugu bar da olabilir.
        if (!z.touchFired) {
          z.touchFired = true
          emitEvent('touch', z, i)
        }
      }

      // Pine: breakSupport = sup and close < bot - atr * 0.15
      const breakNow = z.isSupport
        ? closeI < z.bottom - breakBuf
        : closeI > z.top + breakBuf

      if (breakNow && !z.broken) {
        z.broken = true
        z.brokenBar = i
        stats.zonesBroken++
        emitZone(z, i)
        live[j] = null
        died = true
        continue
      }
    }

    if (died) {
      const kalan = []
      for (let j = 0; j < live.length; j++) {
        if (live[j] !== null) kalan.push(live[j])
      }
      live = kalan
    }
  }

  // Seri bitiminde hayatta kalan kutular son durumlariyla ciktiya alinir.
  for (let j = 0; j < live.length; j++) emitZone(live[j], n - 1)
  zones.sort(function (a, b) { return a.id - b.id })

  for (let k = 0; k < scoreCounts.length; k++) {
    if (scoreCounts[k] > 0) stats.scoreHist[k] = scoreCounts[k]
  }

  report(100, 'Tarama tamamlandi')

  return {
    zones,
    touches,
    context: {
      atr: atrNow,
      rsi: rsi14,
      sma20,
      sma50,
      bbBasis,
      bbUpper,
      bbLower,
      volRatio,
      flowScore,
      bullTrend,
      bearTrend,
      sessionIdx,
      localHour,
      localDow,
    },
    // Ust zaman dilimi baglami icin kutu durumu araliklari (Y3). Yalnizca
    // `p.recordTimeline` verildiyse dolu, aksi halde null.
    timeline: timeline,
    stats,
  }
}

/**
 * CANLI KUYRUK PENCERESI: indikatorun son barlari TAM SERIYLE AYNI hesaplamasi
 * icin gereken en az bar sayisi.
 *
 * Canli kontrol indikatoru serinin son N barinda calistirir. N kucukse bazi
 * gostergeler oturmaz ve canli uretilen olay, ayni olayin hafizadaki halinden
 * FARKLI cikar. En kritigi ust zaman dilimi EMA'sidir: 1 dakikalik grafikte
 * 15 dakikalik trend icin 4000 bar yalnizca 266 ust bar eder ve EMA200
 * oturmaz (son barda tohum agirligi yaklasik %52). Olculdu: 1 dakikalik canli
 * olaylarin %5,8'inde baglam vektoru, %2,4'unde trend ve skor, %1,3'unde
 * qualified bayragi hafizadakinden farkli cikiyordu; 5m, 15m ve 1h'de fark 0.
 *
 * Formul, en uzun pencereye gore hesaplar:
 *   ust TF EMA'si    emaSlowLen * 5 * (ustTF / grafikTF)
 *   gosterge isinma  max(volumeLen, bbLen, atrLen)
 *   kutu omru        maxAgeBars + pivotLen
 *   ozellik penceresi 32 bar pay
 *
 * @param {Object} [params] Indikator ayarlari (eksikler varsayilandan)
 * @param {number} [tfSec] Grafik zaman dilimi (saniye)
 * @returns {number}
 */
function requiredTailBars (params, tfSec) {
  const p = Object.assign({}, DEFAULT_PARAMS, params || {})
  const grafikSn = tfSec > 0 ? tfSec : 60
  let trendSn
  if (p.trendTf === 'auto') {
    trendSn = grafikSn * 4
  } else {
    try {
      trendSn = tfSeconds(p.trendTf)
    } catch (err) {
      trendSn = TREND_TF_FALLBACK_SEC
    }
  }
  const kat = Math.max(1, trendSn / grafikSn)
  const emaBar = Math.ceil((+p.emaSlowLen || 200) * 5 * kat)
  const gosterge = Math.max(+p.volumeLen || 50, +p.bbLen || 20, +p.atrLen || 14)
  const kutu = (+p.maxAgeBars || 100) + (+p.pivotLen || 5)
  return Math.max(4000, emaBar + gosterge + kutu + 32)
}

module.exports = { DEFAULT_PARAMS, runIndicator, requiredTailBars }
