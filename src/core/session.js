'use strict'

/**
 * Seans hesaplari (CONTRACTS.md bolum 8).
 *
 * Seans, Europe/Istanbul yerel saatine gore belirlenir. 6 milyon bar icin bar
 * basina Intl.DateTimeFormat cagirmak kabul edilemez, bu yuzden ofset GUN
 * bazinda onbelleklenir: bir UTC gunu icin ofset bir kez hesaplanir ve o gunun
 * tum barlarina uygulanir.
 *
 * Turkiye 2016 Eylul'unden beri sabit UTC+3 kullaniyor, oncesinde yaz saati
 * uygulaniyordu ve veri 2009'a kadar gidiyor. Bu yuzden sabit ofset varsayimi
 * YAPILMAZ. Ayrica bir UTC gunu yaz saati gecisini ortasinda barindirabilir;
 * boyle gunlerde gecis ani ikili arama ile bulunur ve gun ikiye bolunur.
 */

const SESSIONS = ['Asia', 'London', 'New York', 'Other']
const DEFAULT_TZ = 'Europe/Istanbul'
const DAY = 86400

// Saat dilimi basina bicimlendirici onbellegi: Intl nesnesi kurmak pahalidir.
const formatterCache = new Map()

function getFormatter (tz) {
  let fmt = formatterCache.get(tz)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(tz, fmt)
  }
  return fmt
}

/**
 * Verilen anda saat diliminin UTC ofsetini saniye cinsinden hesaplar.
 * Yerel takvim alanlari UTC gibi yorumlanip gercek UTC ani ile farki alinir.
 * @param {Intl.DateTimeFormat} fmt
 * @param {number} ms UNIX milisaniye
 * @returns {number} ofset (saniye), ornegin UTC+3 icin 10800
 */
function offsetAtMs (fmt, ms) {
  const parts = fmt.formatToParts(new Date(ms))
  let year = 1970
  let month = 1
  let day = 1
  let hour = 0
  let minute = 0
  let second = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    switch (p.type) {
      case 'year': year = +p.value; break
      case 'month': month = +p.value; break
      case 'day': day = +p.value; break
      case 'hour': hour = +p.value; break
      case 'minute': minute = +p.value; break
      case 'second': second = +p.value; break
      default: break
    }
  }
  // Bazi ICU surumleri gece yarisini 24 olarak verebilir.
  if (hour === 24) hour = 0
  // setUTCFullYear kullanmak 100'den kucuk yillarin 1900'e kaymasini onler.
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  d.setUTCHours(hour, minute, second, 0)
  return Math.round((d.getTime() - ms) / 1000)
}

/**
 * Gun bazinda onbellekli ofset arayicisi uretir.
 * @param {string} tz
 * @returns {(tSec:number)=>number} saniye cinsinden ofset
 */
function createOffsetLookup (tz) {
  const fmt = getFormatter(tz || DEFAULT_TZ)
  // gun -> [ofsetOnce, ofsetSonra, gecisSaniyesi]
  const cache = new Map()
  let lastDay = NaN
  let offBefore = 0
  let offAfter = 0
  let switchSec = Infinity

  function loadDay (dayIdx) {
    let rec = cache.get(dayIdx)
    if (rec === undefined) {
      const startSec = dayIdx * DAY
      const endSec = startSec + DAY - 1
      const a = offsetAtMs(fmt, startSec * 1000)
      const b = offsetAtMs(fmt, endSec * 1000)
      let sw = Infinity
      if (a !== b) {
        // Gun icinde saat degisimi var: gecis anini ikili arama ile bul.
        let lo = startSec
        let hi = endSec
        while (hi - lo > 1) {
          const mid = lo + Math.floor((hi - lo) / 2)
          if (offsetAtMs(fmt, mid * 1000) === a) lo = mid
          else hi = mid
        }
        sw = hi
      }
      rec = [a, b, sw]
      cache.set(dayIdx, rec)
    }
    lastDay = dayIdx
    offBefore = rec[0]
    offAfter = rec[1]
    switchSec = rec[2]
  }

  return function offsetAt (tSec) {
    const dayIdx = Math.floor(tSec / DAY)
    if (dayIdx !== lastDay) loadDay(dayIdx)
    return tSec < switchSec ? offBefore : offAfter
  }
}

/**
 * Saatten seans adi. Python portundaki _session_name ile birebir aynidir.
 * @param {number} hour 0..23
 * @returns {string} 'Asia' | 'London' | 'New York' | 'Other'
 */
function sessionName (hour) {
  const h = Math.floor(hour)
  if (h >= 0 && h < 8) return 'Asia'
  if (h >= 8 && h < 13) return 'London'
  if (h >= 13 && h < 21) return 'New York'
  return 'Other'
}

/**
 * Saatten SESSIONS icindeki indeks.
 * @param {number} h 0..23
 * @returns {number} 0..3
 */
function sessionIndexOfHour (h) {
  if (h < 8) return 0
  if (h < 13) return 1
  if (h < 21) return 2
  return 3
}

/**
 * Her bar icin yerel saat (0..23).
 * @param {Float64Array|number[]} timeArr UNIX saniye (UTC)
 * @param {string} [tz] varsayilan Europe/Istanbul
 * @returns {Uint8Array}
 */
function localHourArray (timeArr, tz) {
  const n = timeArr.length
  const out = new Uint8Array(n)
  if (n === 0) return out
  const offsetAt = createOffsetLookup(tz)
  for (let i = 0; i < n; i++) {
    const t = timeArr[i]
    if (!Number.isFinite(t)) continue
    const local = t + offsetAt(t)
    let sod = local % DAY
    if (sod < 0) sod += DAY
    out[i] = (sod / 3600) | 0
  }
  return out
}

/**
 * Her bar icin yerel haftanin gunu. 0 = Pazar (JavaScript getDay uyumlu).
 * @param {Float64Array|number[]} timeArr UNIX saniye (UTC)
 * @param {string} [tz]
 * @returns {Uint8Array}
 */
function localDowArray (timeArr, tz) {
  const n = timeArr.length
  const out = new Uint8Array(n)
  if (n === 0) return out
  const offsetAt = createOffsetLookup(tz)
  for (let i = 0; i < n; i++) {
    const t = timeArr[i]
    if (!Number.isFinite(t)) continue
    const local = t + offsetAt(t)
    // 1 Ocak 1970 Persembe idi, bu yuzden +4 kaydirma Pazar'i 0 yapar.
    const days = Math.floor(local / DAY)
    out[i] = ((days + 4) % 7 + 7) % 7
  }
  return out
}

/**
 * Her bar icin SESSIONS dizisindeki seans indeksi.
 * Gecersiz zaman damgasi 'Other' (3) sayilir.
 * @param {Float64Array|number[]} timeArr UNIX saniye (UTC)
 * @param {string} [tz]
 * @returns {Uint8Array}
 */
function sessionIndexArray (timeArr, tz) {
  const n = timeArr.length
  const out = new Uint8Array(n)
  if (n === 0) return out
  const offsetAt = createOffsetLookup(tz)
  for (let i = 0; i < n; i++) {
    const t = timeArr[i]
    if (!Number.isFinite(t)) {
      out[i] = 3
      continue
    }
    const local = t + offsetAt(t)
    let sod = local % DAY
    if (sod < 0) sod += DAY
    out[i] = sessionIndexOfHour((sod / 3600) | 0)
  }
  return out
}

module.exports = {
  SESSIONS,
  sessionIndexArray,
  localHourArray,
  localDowArray,
  sessionName,
}
