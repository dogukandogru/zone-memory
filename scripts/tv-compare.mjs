// TradingView'den disa aktarilan mumlarla UYGULAMANIN KENDI deposundaki
// mumlari ayni indikatorden gecirip kutu kumelerini karsilastirir.
//
// NEDEN AYRI BETIK
// test/tv-parity.test.js "port Pine ile ayni mi" sorusunu sorar ve bunu
// TradingView'in KENDI mumlarini kullanarak yapar. Ama gunluk kullanimda
// port, uygulamanin kendi deposundaki mumlarla calisir ve o mumlar baska
// bir kaynaktan gelir. Hacim brokere gore degisir, kutu kapisi hacme
// baglidir; dolayisiyla AYNI indikator, ayni tarihte FARKLI kutular
// dogurabilir. Bu fark hicbir yerde olculmuyordu ve README "kutularin yuzde
// 99'dan fazlasi ayni" diyordu.
//
// Bu betik iki soruyu ayirir:
//   1. Port dogru mu?            -> test/tv-parity.test.js (ayni mumlar)
//   2. Veri kaynagi ne kadar ayirdi? -> bu betik (farkli mumlar)
//
// Kullanim:
//   node scripts/tv-compare.mjs --csv ~/Downloads/XAUUSD_15m.csv --tf 15m
//   node scripts/tv-compare.mjs --csv ... --tf 15m --json --out rapor.json
//
// GERCEK VERIYE YAZMAZ, yalnizca okur.

import fs from 'node:fs'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { dataDir as varsayilanDataDir, DEFAULT_SYMBOL } from './userdata-path.mjs'

const require = createRequire(import.meta.url)
const series = require('../src/core/series.js')
const binstore = require('../src/core/store/binstore.js')
const { runIndicator } = require('../src/core/indicator/proZones.js')
const { tfSeconds } = require('../src/core/tf.js')
const { argumanlariAyristir } = require('../src/core/util/cli.js')

const say = (x, h = 3) => (Number.isFinite(x) ? x.toFixed(h) : '-')
const yuzde = (x, h = 1) => (Number.isFinite(x) ? (x * 100).toFixed(h) + '%' : '-')

/** CSV hucresini sayiya cevirir. */
function sayiya (h) {
  if (h === undefined || h === null) return NaN
  const s = String(h).trim().replace(/^"|"$/g, '')
  if (s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'na') return NaN
  const d = s.indexOf(',') >= 0 && s.indexOf('.') < 0 ? s.replace(',', '.') : s
  const n = Number(d)
  return Number.isFinite(n) ? n : NaN
}

/** Zaman hucresini UNIX saniyeye cevirir (UNIX ya da ISO). */
function zamana (h) {
  const s = String(h === undefined ? '' : h).trim().replace(/^"|"$/g, '')
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s)
    return s.length > 10 ? Math.floor(n / 1000) : n
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN
}

/** TradingView CSV'sini seriye cevirir. */
function csvSeri (yol) {
  const ham = yol.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(yol)).toString('utf8')
    : fs.readFileSync(yol, 'utf8')
  const satirlar = ham.split(/\r?\n/).filter((x) => x.trim() !== '')
  if (satirlar.length < 2) throw new Error('CSV bos ya da yalnizca baslik satiri var')

  const ayrac = satirlar[0].indexOf(';') >= 0 && satirlar[0].indexOf(',') < 0 ? ';' : ','
  const bas = satirlar[0].split(ayrac).map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase())
  const dz = (...adlar) => {
    for (const ad of adlar) {
      const i = bas.indexOf(ad)
      if (i >= 0) return i
    }
    return -1
  }
  const iT = dz('time', 'unix time', 'date', 'datetime')
  const iO = dz('open'); const iH = dz('high'); const iL = dz('low')
  const iC = dz('close'); const iV = dz('volume')
  if (iT < 0 || iO < 0 || iH < 0 || iL < 0 || iC < 0) {
    throw new Error('CSV sutunlari bulunamadi, beklenen: time, open, high, low, close, volume')
  }
  if (iV < 0) {
    throw new Error('CSV hacim sutunu tasimiyor. Kutu kapisi hacme bagli oldugu icin ' +
      'hacimsiz bir disa aktarim karsilastirilamaz.')
  }

  const t = []; const o = []; const h = []; const l = []; const c = []; const v = []
  for (let i = 1; i < satirlar.length; i++) {
    const hu = satirlar[i].split(ayrac)
    const zt = zamana(hu[iT])
    const kap = sayiya(hu[iC])
    if (!Number.isFinite(zt) || !Number.isFinite(kap)) continue
    t.push(zt); o.push(sayiya(hu[iO])); h.push(sayiya(hu[iH]))
    l.push(sayiya(hu[iL])); c.push(kap)
    const hac = sayiya(hu[iV])
    v.push(Number.isFinite(hac) ? hac : 0)
  }
  if (t.length === 0) throw new Error('CSV icinde gecerli satir yok')
  return series.fromArrays({ time: t, open: o, high: h, low: l, close: c, volume: v })
}

/**
 * Iki kutu kumesini yon ve PIVOT ZAMANI ile eslestirir.
 *
 * Kutu kimlikleri iki kosuda ayni olmaz (numaralandirma serinin basindan
 * baslar), bar indeksleri de farkli serilerde farkli anlara denk gelir.
 * Ortak ve anlamli olan tek anahtar pivot ZAMANIDIR. Bir bar tolerans
 * birakilir: iki kaynagin bar siniri bir tik kayabilir.
 */
function esle (a, b, tfSec) {
  const tolerans = tfSec
  const kalan = b.slice()
  const ciftler = []
  const yalnizA = []

  for (const za of a) {
    let enIyi = -1
    let enIyiFark = Infinity
    for (let j = 0; j < kalan.length; j++) {
      const zb = kalan[j]
      if (!zb) continue
      if (!!zb.isSupport !== !!za.isSupport) continue
      const fark = Math.abs(Number(zb.pivotTime) - Number(za.pivotTime))
      if (fark <= tolerans && fark < enIyiFark) { enIyiFark = fark; enIyi = j }
    }
    if (enIyi < 0) { yalnizA.push(za); continue }
    ciftler.push({ a: za, b: kalan[enIyi] })
    kalan[enIyi] = null
  }
  const yalnizB = kalan.filter(Boolean)
  return { ciftler, yalnizA, yalnizB }
}

/** Kutu kumesinin zaman araligina gore kirpilmis hali. */
function araliktakiler (zones, from, to) {
  return zones.filter((z) => {
    const t = Number(z.pivotTime)
    return Number.isFinite(t) && t >= from && t <= to
  })
}

async function main () {
  const arg = argumanlariAyristir(process.argv.slice(2))
  const csvYolu = typeof arg.csv === 'string' ? arg.csv : null
  const tf = typeof arg.tf === 'string' ? arg.tf : '15m'
  const sembol = typeof arg.symbol === 'string' ? arg.symbol : DEFAULT_SYMBOL
  const dataDir = typeof arg['data-dir'] === 'string' ? arg['data-dir'] : varsayilanDataDir()

  if (!csvYolu) {
    process.stdout.write(
      'Kullanim: node scripts/tv-compare.mjs --csv <TradingView disa aktarimi> [--tf 15m]\n' +
      '          [--symbol XAUUSD] [--data-dir <klasor>] [--json] [--out dosya]\n\n' +
      'TradingView CSV\'si docs/pine/son_pro_export.pine ile ya da dogrudan\n' +
      '"Export chart data" ile alinabilir; hacim sutunu ZORUNLUDUR.\n')
    process.exit(1)
  }

  const tfSec = tfSeconds(tf)
  if (!tfSec) throw new Error('Bilinmeyen zaman dilimi: ' + tf)

  // 1) TradingView mumlari.
  const tvSeri = csvSeri(csvYolu)
  const tvFrom = tvSeri.time[0]
  const tvTo = tvSeri.time[tvSeri.length - 1]

  // 2) Deponun ayni araliktaki mumlari (SALT OKUMA).
  const binYolu = dataDir + '/' + sembol + '_' + tf + '.bin'
  if (!fs.existsSync(binYolu)) throw new Error('Depo dosyasi yok: ' + binYolu)
  const tam = await binstore.readSeries(binYolu)
  const a0 = series.firstIndexAtOrAfter(tam, tvFrom)
  const b0 = series.lastIndexAtOrBefore(tam, tvTo)
  if (a0 < 0 || b0 < a0) throw new Error('Depoda bu aralik icin mum yok')
  const bizSeri = series.sliceSeries(tam, a0, b0 + 1)

  // 3) Ayni indikator, iki seri.
  //
  // `fullContext: true` gerekli: hacim orani (volRatio) varsayilan olarak
  // donmuyor ama raporun en onemli satiri ona dayaniyor.
  const tvR = runIndicator(tvSeri, { fullContext: true }, tfSec)
  const bizR = runIndicator(bizSeri, { fullContext: true }, tfSec)

  // Kiyas yalnizca ORTAK aralikta anlamli.
  const ortakFrom = Math.max(tvFrom, bizSeri.time[0])
  const ortakTo = Math.min(tvTo, bizSeri.time[bizSeri.length - 1])
  const tvZ = araliktakiler(tvR.zones, ortakFrom, ortakTo)
  const bizZ = araliktakiler(bizR.zones, ortakFrom, ortakTo)

  const { ciftler, yalnizA, yalnizB } = esle(tvZ, bizZ, tfSec)

  // Kesinlik ve anma: TradingView kutulari "dogru" kabul edilir.
  const precision = bizZ.length > 0 ? ciftler.length / bizZ.length : NaN
  const recall = tvZ.length > 0 ? ciftler.length / tvZ.length : NaN

  // Eslesen kutularda kenar farki, ATR biriminde.
  const atrOrt = (() => {
    let t = 0; let k = 0
    for (let i = 0; i < tvR.context.atr.length; i++) {
      const x = tvR.context.atr[i]
      if (Number.isFinite(x) && x > 0) { t += x; k++ }
    }
    return k > 0 ? t / k : NaN
  })()

  let topFarkTop = 0; let botFarkTop = 0; let enBuyukFark = 0
  for (const c of ciftler) {
    const dt = Math.abs(Number(c.a.top) - Number(c.b.top))
    const db = Math.abs(Number(c.a.bottom) - Number(c.b.bottom))
    topFarkTop += dt
    botFarkTop += db
    if (dt > enBuyukFark) enBuyukFark = dt
    if (db > enBuyukFark) enBuyukFark = db
  }
  const topFarkAtr = ciftler.length > 0 && atrOrt > 0 ? (topFarkTop / ciftler.length) / atrOrt : NaN
  const botFarkAtr = ciftler.length > 0 && atrOrt > 0 ? (botFarkTop / ciftler.length) / atrOrt : NaN

  // EKSIK KUTULAR NEDEN EKSIK.
  //
  // Raporun en onemli kismi. Eksik kutularin cogu HACIM kapisinda
  // takiliyorsa sorun PORTTA degil, veri kaynaginin hacmindedir ve portu
  // "duzeltmeye" calismak yanlis olur.
  //
  // DIKKAT: Pine'da iki ayri hacim kosulu var ve baglayici olan IKINCISIDIR:
  //   vR >= minVolRatio            (1,05)
  //   clamp(vR * 3, 1, 10) >= minFlowToShow   (6,0, yani vR >= 2,0)
  // Yalnizca 1,05'e bakmak neredeyse hicbir kutuyu aciklamaz.
  const MIN_VOL_ORAN = 1.05
  const MIN_FLOW = 6.0
  const hacimOrani = (seri, r, pivotTime) => {
    const i = series.lastIndexAtOrBefore(seri, pivotTime)
    if (i < 0) return null
    const vR = r.context.volRatio ? r.context.volRatio[i] : NaN
    return Number.isFinite(vR) ? vR : null
  }
  const flowOf = (vR) => Math.min(10, Math.max(1, vR * 3))

  let hacimYuzunden = 0
  let barYok = 0
  let baskaSebep = 0
  const eksikVr = []
  for (const z of yalnizA) {
    const vR = hacimOrani(bizSeri, bizR, Number(z.pivotTime))
    if (vR === null) { barYok++; continue }
    eksikVr.push(vR)
    if (vR < MIN_VOL_ORAN || flowOf(vR) < MIN_FLOW) hacimYuzunden++
    else baskaSebep++
  }
  eksikVr.sort((a, b) => a - b)
  const eksikVrMedyan = eksikVr.length > 0
    ? eksikVr[Math.floor(eksikVr.length / 2)]
    : NaN

  const rapor = {
    tf,
    csv: csvYolu,
    tvBar: tvSeri.length,
    depoBar: bizSeri.length,
    ortakFrom: new Date(ortakFrom * 1000).toISOString(),
    ortakTo: new Date(ortakTo * 1000).toISOString(),
    tvKutu: tvZ.length,
    depoKutu: bizZ.length,
    eslesen: ciftler.length,
    precision,
    recall,
    yalnizTv: yalnizA.length,
    yalnizDepo: yalnizB.length,
    yalnizTvHacimKapisinda: hacimYuzunden,
    yalnizTvBaskaSebep: baskaSebep,
    yalnizTvBarYok: barYok,
    yalnizTvVrMedyan: eksikVrMedyan,
    ortTopFarkAtr: topFarkAtr,
    ortBotFarkAtr: botFarkAtr,
    enBuyukKenarFarki: enBuyukFark,
    ortAtr: atrOrt,
  }

  if (arg.json) {
    const metin = JSON.stringify(rapor, null, 2)
    if (typeof arg.out === 'string') fs.writeFileSync(arg.out, metin)
    else process.stdout.write(metin + '\n')
    return
  }

  const satir = (ad, deger) => process.stdout.write(ad.padEnd(34) + String(deger) + '\n')
  process.stdout.write('\nTradingView ve depo karsilastirmasi (' + tf + ')\n')
  process.stdout.write('-'.repeat(56) + '\n')
  satir('Ortak aralik', rapor.ortakFrom + ' - ' + rapor.ortakTo)
  satir('TradingView bar / depo bar', tvSeri.length + ' / ' + bizSeri.length)
  satir('TradingView kutu / depo kutu', tvZ.length + ' / ' + bizZ.length)
  satir('Eslesen kutu', ciftler.length)
  satir('Kesinlik (depo kutulari dogru mu)', yuzde(precision))
  satir('Anma (TV kutulari bulundu mu)', yuzde(recall))
  satir('Yalnizca TradingView', yalnizA.length)
  satir('  hacim kapisinda takilan', hacimYuzunden + (yalnizA.length > 0
    ? ' (' + yuzde(hacimYuzunden / yalnizA.length) + ')' : ''))
  satir('  baska sebep (birlesme, bant)', baskaSebep)
  satir('  depoda o anda bar yok', barYok)
  satir('  eksiklerin medyan hacim orani', say(eksikVrMedyan, 3) + ' (kapi 2,000)')
  satir('Yalnizca depo', yalnizB.length)
  satir('Ort. ust kenar farki (ATR)', say(topFarkAtr, 4))
  satir('Ort. alt kenar farki (ATR)', say(botFarkAtr, 4))
  satir('En buyuk kenar farki (fiyat)', say(enBuyukFark, 4))
  process.stdout.write('\nNot: "yalnizca TradingView" kutularinin buyuk kismi hacim kapisinda\n' +
    'takiliyorsa fark PORTTAN degil, veri kaynaginin hacminden gelir.\n\n')
}

main().catch((err) => {
  process.stderr.write('Hata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exit(1)
})
