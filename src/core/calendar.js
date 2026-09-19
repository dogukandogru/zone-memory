'use strict'

/**
 * EKONOMIK TAKVIM (Y2)
 *
 * Yuksek etkili ABD verisi anlarinda bolgeler daha hizli kiriliyor: olculdu,
 * yaklasik NFP penceresinde 15m dokunus isabeti %15,3 (n=59), diger zamanlarda
 * %28,1; bir bar icinde kirilma %79,7 ile %54,0. Orneklem kucuk ve guven
 * araliklari ortusuyor, yani filtrenin FAYDASI KANITLI DEGIL. Bu yuzden bu
 * modul iki isi ayirir:
 *
 *   1. OLCUM   testin alt kume kirilimi (bySubset) icin "veri penceresi"
 *              etiketini uretir; kapi kapali olsa bile olculur
 *   2. KAPI    signalCfg.newsBlackoutMin > 0 ise sinyal uretilmesini engeller
 *              (varsayilan 0, yani kapali)
 *
 * TAKVIM DOSYASI kullanicinin sorumlulugundadir ve YOKSA OZELLIK SESSIZCE
 * KAPALI kalir: hicbir sey degismez, hata da verilmez. Otomatik indirme
 * yapilmaz, cunku guvenilir ve ucretsiz bir kaynak yok; kullanici kendi
 * listesini koyar.
 *
 * Bicim: <dataDir>/calendar/high_impact.csv
 *
 *   timeUtc,code,currency
 *   2024-07-05T12:30:00Z,NFP,USD
 *   2024-07-11T12:30:00Z,CPI,USD
 *   2024-07-31T18:00:00Z,FOMC,USD
 *
 * Bas satir zorunlu degildir (varsa atlanir), sutun sirasi sabittir, `#` ile
 * baslayan satirlar yorumdur. Saat UTC olmalidir.
 */

const fs = require('fs')
const path = require('path')

/** Takvimin dataDir icindeki yeri. */
const CALENDAR_DIR = 'calendar'
const CALENDAR_FILE = 'high_impact.csv'

/**
 * Takvim dosyasinin yolu.
 * @param {string} dataDir
 * @returns {string}
 */
function calendarFilePath (dataDir) {
  return path.join(String(dataDir || ''), CALENDAR_DIR, CALENDAR_FILE)
}

/**
 * CSV'yi okur ve zamana gore SIRALI bir takvim nesnesi dondurur.
 *
 * Bozuk satirlar sessizce atlanir ama sayilir (`skipped`): kullanici dosyayi
 * elle hazirladigi icin tek bir yazim hatasi yuzunden tum takvimi reddetmek
 * fayda saglamaz, ama kac satirin atlandigi gorunmelidir.
 *
 * @param {string} filePath
 * @returns {{times:Float64Array, codes:string[], currencies:string[],
 *            count:number, skipped:number, path:string}|null} Dosya yoksa null
 */
function loadCalendar (filePath) {
  let ham
  try {
    ham = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    return null
  }

  const satirlar = String(ham).split(/\r?\n/)
  const kayitlar = []
  let atlanan = 0
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i].trim()
    if (satir === '' || satir.charCodeAt(0) === 35) continue
    const parcalar = satir.split(',')
    if (parcalar.length < 2) { atlanan++; continue }
    const zamanMetni = parcalar[0].trim()
    // Bas satiri (timeUtc,code,...) sessizce atla.
    if (/^time/i.test(zamanMetni)) continue
    const ms = Date.parse(zamanMetni)
    if (!Number.isFinite(ms)) { atlanan++; continue }
    const kod = parcalar[1].trim().toUpperCase()
    if (kod === '') { atlanan++; continue }
    kayitlar.push({
      time: Math.floor(ms / 1000),
      code: kod,
      currency: parcalar.length > 2 ? parcalar[2].trim().toUpperCase() : '',
    })
  }

  kayitlar.sort((a, b) => a.time - b.time)
  const times = new Float64Array(kayitlar.length)
  const codes = new Array(kayitlar.length)
  const currencies = new Array(kayitlar.length)
  for (let i = 0; i < kayitlar.length; i++) {
    times[i] = kayitlar[i].time
    codes[i] = kayitlar[i].code
    currencies[i] = kayitlar[i].currency
  }
  return {
    times: times,
    codes: codes,
    currencies: currencies,
    count: kayitlar.length,
    skipped: atlanan,
    path: String(filePath),
  }
}

/**
 * Verilen ana EN YAKIN takvim olayini bulur (ikili arama).
 *
 * `deltaMin` isaretlidir ve "karar anindan kac dakika SONRA" demektir:
 * pozitifse veri henuz gelmedi (uyari anlamli), negatifse veri gecti.
 *
 * @param {{times:Float64Array, codes:string[], currencies:string[]}|null} cal
 * @param {number} tSec Karar ani (UNIX saniye)
 * @returns {{code:string, currency:string, time:number, deltaMin:number}|null}
 */
function nearestEvent (cal, tSec) {
  if (!cal || !cal.times || cal.times.length === 0) return null
  const t = Number(tSec)
  if (!Number.isFinite(t)) return null

  const times = cal.times
  let lo = 0
  let hi = times.length - 1
  // t'den kucuk olmayan ilk indeks.
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] < t) lo = mid + 1
    else hi = mid
  }
  // Adaylar: lo ve lo - 1 (biri sonra, biri once).
  let enIyi = -1
  let enIyiFark = Infinity
  for (const idx of [lo - 1, lo, lo + 1]) {
    if (idx < 0 || idx >= times.length) continue
    const fark = Math.abs(times[idx] - t)
    if (fark < enIyiFark) { enIyiFark = fark; enIyi = idx }
  }
  if (enIyi < 0) return null
  return {
    code: cal.codes[enIyi],
    currency: cal.currencies[enIyi],
    time: times[enIyi],
    deltaMin: (times[enIyi] - t) / 60,
  }
}

/**
 * Karar aninin hangi alt kumeye girdigini soyler (olcum etiketi).
 *
 * Esikler sabit: 30 ve 60 dakika. Bunlar bir ayar degil, OLCUM KOVASIDIR;
 * kullaniciya secim sunmak alt kume sayisini orneklem basina dusurur.
 *
 * @param {{times:Float64Array}|null} cal
 * @param {number} tSec
 * @returns {'veri ±30 dk'|'veri ±60 dk'|'normal'}
 */
function newsSubset (cal, tSec) {
  const en = nearestEvent(cal, tSec)
  if (!en) return 'normal'
  const d = Math.abs(en.deltaMin)
  if (d <= 30) return 'veri ±30 dk'
  if (d <= 60) return 'veri ±60 dk'
  return 'normal'
}

module.exports = {
  CALENDAR_DIR,
  CALENDAR_FILE,
  calendarFilePath,
  loadCalendar,
  nearestEvent,
  newsSubset,
}
