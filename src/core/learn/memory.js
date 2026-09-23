'use strict'

/**
 * Hafiza katmani (A6, sozlesme bolum 14).
 *
 * Gorev: indikatoru tarih boyunca calistirmak, uretilen olaylari etiketlemek,
 * ozellik vektorlerini cikarmak ve hafiza kayitlarini (MemoryEvent) uretmek.
 * Etiketlenemeyen olaylar (ufku dolmayan, serinin sonuna yakin olanlar)
 * hafizaya girmez ama istatistiklerde sayilir.
 *
 * proZones iki tur olay uretir ve ikisi de ayni boru hattindan gecer:
 *   kind = 'form'   kutunun dogdugu an
 *   kind = 'touch'  fiyatin kutuya geri donup ilk kez dokundugu an
 * Bir bolge her turden EN FAZLA BIR olay uretir.
 *
 * ARTIMLI TARAMA YOKTUR. Bir donem `extendMemory` vardi ama HIC CAGRILMADI;
 * buna ragmen belgeler artimli guncelleme vaat ediyordu. Bir gun baglansa
 * sessiz veri bozulmasi uretirdi: yeniden taramada bolge ve olay kimlikleri
 * sifirdan numaralanir, bar indeksleri kayar (olculdu: 281 olayin 281'i) ve
 * 1 dakikalik trend bayragi %38,6 oraninda yanlis cikar. Tam tarama zaten
 * hizli (15m yaklasik 0,2 sn, 1m yaklasik 1,7 sn), bu yuzden fonksiyon
 * kaldirildi.
 */

const { runIndicator, DEFAULT_PARAMS } = require('../indicator/proZones')
const { labelTouch, DEFAULT_OUTCOME_CFG } = require('./outcome')
const { buildFeatures, CTX_NAMES } = require('./features')
const { tfSeconds } = require('../tf')
const { createMarketCalendar } = require('../session')
const stats = require('./stats')

/** Ozet tablolarinda her zaman gorunmesini istedigimiz seans adlari. */
const SESSION_NAMES = ['Asia', 'London', 'New York', 'Other']

/**
 * Ilerleme geri cagrisini [from, to] araligina olceklendirir ve ayni tamsayi
 * yuzdeyi tekrar tekrar yollamaz.
 * @param {Function|undefined} onProgress
 * @param {number} from
 * @param {number} to
 * @returns {Function|undefined}
 */
function scaleProgress (onProgress, from, to) {
  if (typeof onProgress !== 'function') return undefined
  let last = -1
  return function (pct, msg) {
    let p = typeof pct === 'number' && isFinite(pct) ? pct : 0
    if (p < 0) p = 0
    if (p > 100) p = 100
    const out = Math.round(from + (to - from) * (p / 100))
    if (out === last) return
    last = out
    onProgress(out, msg)
  }
}

/** Sayi degilse veya sonlu degilse varsayilani dondurur. */
function num (v, def) {
  return typeof v === 'number' && isFinite(v) ? v : def
}

/**
 * Tarih boyunca indikatoru calistirir, ilk dokunuslari etiketler,
 * ozellik vektorlerini cikarir ve hafiza kaydini uretir.
 *
 * Ilerleme dagilimi: indikator taramasi %0-60, etiketleme ve ozellik
 * cikarimi %60-100.
 *
 * @param {Object} s Series
 * @param {{tf:string, params:object, outcomeCfg:object, featureCfg?:object}} cfg
 * @param {(pct:number,msg:string)=>void} [onProgress]
 * @returns {{tf:string, ctxNames:string[], events:Object[], zones:Object[], stats:object}}
 */
function buildMemory (s, cfg, onProgress) {
  const conf = cfg || {}
  const tf = conf.tf || '15m'
  const tfSec = tfSeconds(tf)
  const params = Object.assign({}, DEFAULT_PARAMS, conf.params || {})
  const outcomeCfg = Object.assign({}, DEFAULT_OUTCOME_CFG, conf.outcomeCfg || {})
  // Ozellik ayari (su an yalnizca sekil penceresi). Ayar izine dahildir,
  // degisince hafiza yeniden kurulur.
  const featureCfg = conf.featureCfg || null

  const report = typeof onProgress === 'function' ? onProgress : null
  if (report) report(0, 'Indikator taramasi basliyor')

  const scan = runIndicator(s, params, tfSec, scaleProgress(onProgress, 0, 60))
  const touches = (scan && scan.touches) || []
  const zones = (scan && scan.zones) || []
  const ctx = (scan && scan.context) || null
  const scanStats = (scan && scan.stats) || {}

  const n = touches.length
  const events = []
  const scoreHist = []

  let qualified = 0
  let formCount = 0
  let touchCount = 0
  let formStored = 0
  let touchStored = 0
  let labeled = 0
  let respected = 0
  let broken = 0
  let timeout = 0
  let noFeatures = 0
  let noLabel = 0
  let noLabelHorizon = 0
  let formRiskBlocked = 0
  let lowCoverage = 0
  let sumMfe = 0
  let sumMae = 0

  // DUSUK KAPSAMA KORUMASI
  // Depoda gecmiste kalici bosluklar var (olculdu: 2023-02 ile 2023-07 arasi
  // "bir saat var bir saat yok" deseniyle yaklasik 479 tam saat eksik ve bu
  // eksik saatler HistData kaynaginda da yok). Boyle bir bolgede pivot, ATR,
  // hacim ortalamasi ve 48 barlik sonuc ufku gercekte cok daha uzun bir
  // zamana yayilir; olay hafizaya farkli bir sey olcen bir kayit olarak
  // girer. Bu yuzden olayin penceresinde GERCEK bir veri boslugu varsa olay
  // hafizaya ALINMAZ, yalnizca sayilir.
  //
  // ONEMLI: hafta sonu ve gunluk ara (New York 17:00-18:00) zaman atlamasi
  // yaratir ama bunlar veri boslugu DEGILDIR, piyasa kapalidir. Bu ayrim
  // yapilmadiginda 15 dakikalikta 6890 olayin 6485'i atiliyordu. Bu yuzden
  // atlamalar kural tabanli piyasa takvimiyle suzulur.
  const oncekiBar = 50
  const sonrakiBar = num(outcomeCfg.horizonBars, 48)
  const piyasaAcikMi = createMarketCalendar()
  // Bar basina "oncesinde acik saatte eksik bar var mi" bayragi, sonra
  // kumulatif toplam: pencere sorgusu iki cikarma ile yapilir.
  const bosluktanSonra = new Int32Array(s.length + 1)
  for (let i = 1; i < s.length; i++) {
    let eksik = 0
    if (s.time[i] - s.time[i - 1] > 2 * tfSec) {
      for (let t = s.time[i - 1] + tfSec; t < s.time[i]; t += tfSec) {
        if (piyasaAcikMi(t)) { eksik = 1; break }
      }
    }
    bosluktanSonra[i + 1] = bosluktanSonra[i] + eksik
  }
  /** Olayin penceresinde gercek veri boslugu var mi. */
  function penceredeBosluk(bar) {
    const bas = Math.max(1, bar - oncekiBar)
    const bit = Math.min(s.length - 1, bar + sonrakiBar)
    if (bit < bas) return false
    return bosluktanSonra[bit + 1] - bosluktanSonra[bas] > 0
  }

  const labelProgress = scaleProgress(onProgress, 60, 100)
  if (labelProgress) labelProgress(0, 'Olaylar etiketleniyor')

  for (let i = 0; i < n; i++) {
    const t = touches[i]
    if (!t) continue

    if (t.qualified) qualified++
    const form = t.kind === 'form'
    if (form) formCount++
    else touchCount++

    // Skor histogrami: indeks = skor degeri.
    const sc = Math.max(0, Math.round(num(t.score, 0)))
    while (scoreHist.length <= sc) scoreHist.push(0)
    scoreHist[sc]++

    // Dokunus barindaki ATR. Indikator zaten hesapladi, olmazsa baglamdan al.
    let atrAt = num(t.atr, NaN)
    if (!(atrAt > 0) && ctx && ctx.atr && t.bar >= 0 && t.bar < ctx.atr.length) {
      atrAt = ctx.atr[t.bar]
    }

    const features = ctx ? buildFeatures(s, t, ctx, featureCfg) : null
    const outcome = labelTouch(s, t, atrAt, outcomeCfg)

    if (!outcome) {
      noLabel++
      // Neden etiketlenemedi: ufuk serinin sonuna sigmadi mi, yoksa kurulum
      // gercekte islenemez mi (form olayinda risk esigi, dokunusta kapanisin
      // gecersizlik tarafinda olmasi)? Ikisi ayni sayacta toplaniyordu ve
      // "olaylarin %40'i nereye gitti" sorusu cevapsiz kaliyordu.
      if (t.bar + num(outcomeCfg.horizonBars, 48) >= s.length) noLabelHorizon++
      else formRiskBlocked++
    }
    if (!features) noFeatures++

    if (outcome) {
      labeled++
      if (outcome.outcome === 'respect') respected++
      else if (outcome.outcome === 'break') broken++
      else timeout++
      sumMfe += num(outcome.mfeAtr, 0)
      sumMae += num(outcome.maeAtr, 0)
    }

    // Ikisi de yoksa bu olay hafizaya girmez, yalnizca sayilir.
    // Veri boslugunun icinde kalan olaylar da alinmaz (bkz. yukaridaki not).
    if (features && outcome) {
      if (penceredeBosluk(t.bar)) {
        lowCoverage++
      } else {
        // Sonucun belli oldugu zaman: ambargo ve aday havuzu bunu kullanir,
        // olay zamanini degil. Aksi halde sonucu henuz bilinmeyen bir olay
        // komsu olarak kullanilabiliyordu.
        const cozumBar = Math.min(
          Math.max(0, num(outcome.resolvedBar, t.bar)) + 1,
          s.length - 1
        )
        events.push(Object.assign({}, t, outcome, {
          features: features,
          resolvedTime: s.time[cozumBar],
        }))
        if (form) formStored++
        else touchStored++
      }
    }

    if (labelProgress && ((i & 127) === 0 || i === n - 1)) {
      labelProgress(((i + 1) / n) * 100, 'Olaylar etiketleniyor')
    }
  }

  const stats = {
    bars: s && typeof s.length === 'number' ? s.length : 0,
    zonesCreated: num(scanStats.zonesCreated, zones.length),
    zonesMerged: num(scanStats.zonesMerged, 0),
    totalEvents: n,
    formEvents: formCount,
    touchEvents: touchCount,
    formStored: formStored,
    touchStored: touchStored,
    firstTouches: touchCount,
    qualified: qualified,
    labeled: labeled,
    respected: respected,
    broken: broken,
    timeout: timeout,
    stored: events.length,
    noFeatures: noFeatures,
    noLabel: noLabel,
    // Etiketlenemeyenlerin ayrimi: ufuk serinin sonuna sigmadi (zamanla
    // kendiliginden cozulur) veya kurulum gercekte islenemez (risk esigi,
    // kapanisin gecersizlik tarafinda olmasi).
    noLabelHorizon: noLabelHorizon,
    formRiskBlocked: formRiskBlocked,
    // Veri boslugu yuzunden hafiza disinda birakilan olay sayisi.
    lowCoverage: lowCoverage,
    avgMfeAtr: labeled > 0 ? sumMfe / labeled : 0,
    avgMaeAtr: labeled > 0 ? sumMae / labeled : 0,
    rawWinRate: labeled > 0 ? respected / labeled : 0,
    scoreHist: scoreHist,
    firstTime: events.length > 0 ? events[0].time : 0,
    lastTime: events.length > 0 ? events[events.length - 1].time : 0,
    indicator: scanStats,
  }

  if (report) report(100, 'Hafiza hazir: ' + events.length + ' kayit')

  return {
    tf: tf,
    ctxNames: CTX_NAMES.slice(),
    events: events,
    zones: zones,
    stats: stats,
  }
}

/**
 * Bir olay listesi icin bos sayac nesnesi.
 * @returns {{total:number, success:number, fail:number, timeout:number, winRate:number}}
 */
function emptyBucket () {
  return { total: 0, success: 0, fail: 0, timeout: 0, winRate: 0 }
}

/** Bir sayaca tek olay isler. */
function pushBucket (b, ev) {
  b.total++
  if (ev.success === true || ev.outcome === 'respect') b.success++
  else if (ev.outcome === 'timeout') b.timeout++
  else b.fail++
}

/** Sayaclarin oranlarini kapatir. */
function closeBucket (b) {
  b.winRate = b.total > 0 ? b.success / b.total : 0
  return b
}

/**
 * SKOR BILESENLERININ KIRILIMI
 * ---------------------------------------------------------------------------
 * Skor "sinyal" ve "nitelikli" etiketlerini belirliyor ama bilesenlerin
 * gercekten ayirt edip etmedigi hic olculmemisti. Burada her bilesen icin
 * bilesenin DOGRU oldugu ve OLMADIGI olaylar ayri sayilir; arayuz iki kovanin
 * oranini ve guven araligini yan yana gosterir. Aralar ortusuyorsa o bilesen
 * bir sey soylemiyor demektir; ters yondeyse (olculdu: hacim bileseni kenar
 * girisli dokunuslarda %26,4'e karsi %36,1) zarar veriyor demektir.
 */
const SKOR_PARCALARI = ['flow', 'trend', 'session', 'rejection', 'volume']

/** Bilesen kovalari: parca -> {evet, hayir}. */
function emptyParts () {
  const out = {}
  for (const ad of SKOR_PARCALARI) out[ad] = { evet: emptyBucket(), hayir: emptyBucket() }
  // `qualified` bilesen degil sonuctur, ama ayni soruyu sorar: nitelikli
  // sayilan olaylar gercekten daha iyi mi.
  out.qualified = { evet: emptyBucket(), hayir: emptyBucket() }
  return out
}

/** Bir olayi bilesen kovalarina isler. */
function pushParts (hedef, ev) {
  const parts = ev && ev.parts ? ev.parts : null
  for (const ad of SKOR_PARCALARI) {
    if (!parts) continue
    const deger = parts[ad] === true
    pushBucket(hedef[ad][deger ? 'evet' : 'hayir'], ev)
  }
  pushBucket(hedef.qualified[ev.qualified === true ? 'evet' : 'hayir'], ev)
}

/** Bilesen kovalarinin oranlarini ve %95 araliklarini kapatir. */
function closeParts (hedef) {
  for (const ad of Object.keys(hedef)) {
    for (const kova of ['evet', 'hayir']) {
      const b = closeBucket(hedef[ad][kova])
      b.ci = stats.wilson(b.success, b.total)
    }
    const e = hedef[ad].evet
    const h = hedef[ad].hayir
    hedef[ad].diffPts = (e.total > 0 && h.total > 0) ? (e.winRate - h.winRate) * 100 : null
    // AYIRT EDICI MI: iki aralik ortusmuyorsa evet. Ortusuyorsa gozlenen fark
    // orneklem gurultusuyle aciklanabilir.
    hedef[ad].separates = !!(e.ci && h.ci && (e.ci.lo > h.ci.hi || h.ci.lo > e.ci.hi))
  }
  return hedef
}

/**
 * Hafiza ozeti: toplam, etiketlenmis, basarili, basarisiz, timeout,
 * yon dagilimi, seans dagilimi, yillara gore kirilim, ortalama mfeAtr/maeAtr
 * ve ham basari orani.
 *
 * @param {{events:Object[]}|Object[]} memory
 * @returns {object}
 */
function summarize (memory) {
  const events = Array.isArray(memory)
    ? memory
    : ((memory && Array.isArray(memory.events)) ? memory.events : [])

  // Yil hesabi icin aralik onbellegi: 6 milyon barlik veri icin Date nesnesi
  // basina bir kez kurulur, ayni yildaki olaylar onbellekten okunur.
  let cacheYear = 0
  let cacheStart = 0
  let cacheEnd = -1
  function yearOf (t) {
    if (t >= cacheStart && t < cacheEnd) return cacheYear
    const y = new Date(t * 1000).getUTCFullYear()
    cacheYear = y
    cacheStart = Date.UTC(y, 0, 1) / 1000
    cacheEnd = Date.UTC(y + 1, 0, 1) / 1000
    return y
  }

  const byDirection = { BUY: emptyBucket(), SELL: emptyBucket() }
  // Olay turu kirilimi: kutu olusumu ile bolgeye geri donus ayri kurulumlardir,
  // ham basari oranlarinin da ayri okunmasi gerekir.
  const byKind = { form: emptyBucket(), touch: emptyBucket() }
  // Bilesen kirilimi TUR BAZINDA: iki turun taban orani cok farkli oldugu icin
  // karisik sayilar bir bilesenin etkisini gizliyor.
  const byPart = { form: emptyParts(), touch: emptyParts() }
  const bySession = {}
  for (let i = 0; i < SESSION_NAMES.length; i++) bySession[SESSION_NAMES[i]] = emptyBucket()
  const yearMap = new Map()

  let labeled = 0
  let success = 0
  let fail = 0
  let timeout = 0
  let sumMfe = 0
  let sumMae = 0
  let firstTime = 0
  let lastTime = 0

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (!ev) continue
    const t = num(ev.time, 0)
    if (firstTime === 0 || t < firstTime) firstTime = t
    if (t > lastTime) lastTime = t

    const isLabeled = typeof ev.outcome === 'string' || typeof ev.success === 'boolean'
    if (!isLabeled) continue
    labeled++

    if (ev.success === true || ev.outcome === 'respect') success++
    else if (ev.outcome === 'timeout') timeout++
    else fail++

    sumMfe += num(ev.mfeAtr, 0)
    sumMae += num(ev.maeAtr, 0)

    const dir = ev.direction === 'SELL' ? 'SELL' : 'BUY'
    pushBucket(byDirection[dir], ev)

    const turAd = ev.kind === 'form' ? 'form' : 'touch'
    pushBucket(byKind[turAd], ev)
    pushParts(byPart[turAd], ev)

    const ses = typeof ev.session === 'string' && ev.session ? ev.session : 'Other'
    if (!bySession[ses]) bySession[ses] = emptyBucket()
    pushBucket(bySession[ses], ev)

    const y = yearOf(t)
    let yb = yearMap.get(y)
    if (!yb) {
      yb = { year: y, total: 0, success: 0, fail: 0, timeout: 0, winRate: 0, sumMfe: 0, sumMae: 0, avgMfeAtr: 0, avgMaeAtr: 0 }
      yearMap.set(y, yb)
    }
    yb.total++
    if (ev.success === true || ev.outcome === 'respect') yb.success++
    else if (ev.outcome === 'timeout') yb.timeout++
    else yb.fail++
    yb.sumMfe += num(ev.mfeAtr, 0)
    yb.sumMae += num(ev.maeAtr, 0)
  }

  closeBucket(byDirection.BUY)
  closeBucket(byDirection.SELL)
  closeBucket(byKind.form)
  closeBucket(byKind.touch)
  closeParts(byPart.form)
  closeParts(byPart.touch)
  const sessionKeys = Object.keys(bySession)
  for (let i = 0; i < sessionKeys.length; i++) closeBucket(bySession[sessionKeys[i]])

  const byYear = []
  const years = Array.from(yearMap.keys()).sort(function (a, b) { return a - b })
  for (let i = 0; i < years.length; i++) {
    const yb = yearMap.get(years[i])
    yb.winRate = yb.total > 0 ? yb.success / yb.total : 0
    yb.avgMfeAtr = yb.total > 0 ? yb.sumMfe / yb.total : 0
    yb.avgMaeAtr = yb.total > 0 ? yb.sumMae / yb.total : 0
    delete yb.sumMfe
    delete yb.sumMae
    byYear.push(yb)
  }

  return {
    tf: (memory && memory.tf) || null,
    total: events.length,
    labeled: labeled,
    success: success,
    fail: fail,
    timeout: timeout,
    winRate: labeled > 0 ? success / labeled : 0,
    rawWinRate: labeled > 0 ? success / labeled : 0,
    avgMfeAtr: labeled > 0 ? sumMfe / labeled : 0,
    avgMaeAtr: labeled > 0 ? sumMae / labeled : 0,
    firstTime: firstTime,
    lastTime: lastTime,
    byDirection: byDirection,
    byKind: byKind,
    // Skor bilesenlerinin tur bazinda ayirt etme gucu (bkz. closeParts).
    byPart: byPart,
    bySession: bySession,
    byYear: byYear,
  }
}

module.exports = {
  buildMemory,
  summarize,
}
