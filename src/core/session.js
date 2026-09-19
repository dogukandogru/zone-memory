'use strict'

/**
 * Seans hesaplari (CONTRACTS.md bolum 8).
 *
 * Seans, Europe/Athens yerel saatine gore belirlenir. 6 milyon bar icin bar
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
// Seans siniflandirmasinin varsayilan saat dilimi. Istanbul DEGIL: Turkiye
// 2016'da yaz saatini biraktigi icin ayni piyasa ani yillar arasinda farkli
// yerel saate dusuyordu (bkz. indicator/proZones.js sessionTz notu).
const DEFAULT_TZ = 'Europe/Athens'
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
 * SPOT ALTIN PIYASA TAKVIMI
 * ---------------------------------------------------------------------------
 * Vekil kaynaklar (PAXG, XAUT) kripto borsalarinda 7/24 islem gorur, spot
 * XAUUSD gormez. Kapali saatlerde uretilen barlar depoya girerse indikatorun
 * pivot, ATR ve hacim pencereleri kayar ve gecmisle tutarsiz olay uretir.
 *
 * Takvim ONCEDEN deponun son 8 haftasindan cikariliyordu; depoya bir kez kirli
 * (hafta sonu) bar girince o saatler "acik" sayiliyor ve suzgec kendi kendini
 * bozuyordu. Bu yuzden kural tabanli: New York yerel saatiyle piyasa Pazar
 * 18:00'de acilir, Cuma 17:00'de kapanir, her gun 17:00-18:00 arasi aradir.
 * Noel ve yilbasi tam gun kapalidir.
 */
const PIYASA_TZ = 'America/New_York'

/**
 * Piyasa acik mi diye soran, gun bazinda onbellekli bir fonksiyon uretir.
 * @param {string} [tz] varsayilan America/New_York
 * @returns {(tSec:number)=>boolean}
 */
function createMarketCalendar (tz) {
  const offsetAt = createOffsetLookup(tz || PIYASA_TZ)
  return function piyasaAcikMi (tSec) {
    if (!Number.isFinite(tSec)) return false
    const local = tSec + offsetAt(tSec)
    const days = Math.floor(local / DAY)
    // 1 Ocak 1970 Persembe idi, +4 kaydirma Pazar'i 0 yapar.
    const dow = (((days + 4) % 7) + 7) % 7
    let sod = local % DAY
    if (sod < 0) sod += DAY
    const hour = (sod / 3600) | 0

    if (dow === 6) return false                 // Cumartesi tam kapali
    if (dow === 5 && hour >= 17) return false   // Cuma 17:00 kapanis
    if (dow === 0 && hour < 18) return false    // Pazar 18:00 acilis
    if (hour === 17) return false               // gunluk ara

    const d = new Date(local * 1000)
    const ay = d.getUTCMonth() + 1
    const gun = d.getUTCDate()
    if (ay === 12 && gun === 25) return false   // Noel
    if (ay === 1 && gun === 1) return false      // Yilbasi
    return true
  }
}

/**
 * KOVA CAPASI: 4 saatlik ve gunluk kovalari SEANS ACILISINDAN baslatir.
 *
 * Epoch katlarina hizali kovalar spot altinin gunuyle ortusmez: olculdu,
 * 28.006 adet 4 saatlik kovanin 1.611'i (%5,8) iki saatten az veri iceriyor
 * ve 5.445 gunluk kovanin 896'si Pazar aksami acilisindan olusan yarim kova.
 * TradingView gunu New York seans acilisindan (yerel 18:00, yaz saatinde
 * 17:00 UTC karsiligi degisir) sayar.
 *
 * Donen fonksiyon bir zamani ve hedef kova suresini alip kovanin BASLANGIC
 * zamanini verir.
 *
 * @param {string} [tz] Varsayilan America/New_York
 * @returns {(tSec:number, kovaSn:number)=>number}
 */
function createSessionAnchor (tz) {
  const offsetAt = createOffsetLookup(tz || PIYASA_TZ)
  return function kovaBasi (tSec, kovaSn) {
    if (!Number.isFinite(tSec)) return tSec
    const off = offsetAt(tSec)
    const local = tSec + off
    // Seans gunu yerel 18:00'de baslar: 18 saat geri kaydirip gun sinirini
    // bulmak, "bu an hangi seans gunune ait" sorusunu cevaplar.
    const kaydirilmis = local - 18 * 3600
    const gunBasi = Math.floor(kaydirilmis / DAY) * DAY + 18 * 3600
    const gecen = local - gunBasi
    const kovaIdx = Math.floor(gecen / kovaSn)
    // Yerel kova basini UTC'ye cevir. Ofset gun icinde degisebilir (yaz
    // saati gecisi), bu yuzden cevrimden sonra bir kez daha duzeltilir.
    const yerelKovaBasi = gunBasi + kovaIdx * kovaSn
    const kaba = yerelKovaBasi - off
    return kaba - (offsetAt(kaba) - off)
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
 * Ucu de ayni yerel saniyeden turedigi icin seans indeksi, yerel saat ve yerel
 * haftanin gunu TEK GECISTE uretilir.
 *
 * Onceden uc ayri fonksiyon vardi ve indikator ucunu de cagiriyordu: seri uc
 * kez dolasiliyor, uc ayri ofset onbellegi kuruluyor ve bar basina uc offsetAt
 * cagrisi yapiliyordu. Olculdu: 6.134.954 barlik 1 dakikalik seride uc gecis
 * 255 ms, tek gecis 107 ms suruyor ve ciktilar birebir ayni.
 *
 * Asagidaki uc sarmalayici geriye uyumluluk icindir ve ucu de tam hesabi
 * yapar; yalnizca TEK bir dizi isteyen cagirilar icin uygundur, ucunu birden
 * isteyen kod bu fonksiyonu dogrudan cagirmalidir.
 *
 * @param {Float64Array|number[]} timeArr UNIX saniye (UTC)
 * @param {string} [tz] varsayilan Europe/Athens
 * @returns {{sessionIdx: Uint8Array, localHour: Uint8Array, localDow: Uint8Array}}
 */
function localTimeArrays (timeArr, tz) {
  const n = timeArr.length
  const sessionIdx = new Uint8Array(n)
  const localHour = new Uint8Array(n)
  const localDow = new Uint8Array(n)
  if (n === 0) return { sessionIdx, localHour, localDow }
  const offsetAt = createOffsetLookup(tz)
  for (let i = 0; i < n; i++) {
    const t = timeArr[i]
    if (!Number.isFinite(t)) {
      // Gecersiz zaman damgasi 'Other' sayilir; saat ve gun 0 kalir.
      // offsetAt cagrilmaz: NaN icin Intl bicimlendirici hata firlatir.
      sessionIdx[i] = 3
      continue
    }
    const local = t + offsetAt(t)
    let sod = local % DAY
    if (sod < 0) sod += DAY
    const hour = (sod / 3600) | 0
    localHour[i] = hour
    sessionIdx[i] = sessionIndexOfHour(hour)
    // 1 Ocak 1970 Persembe idi, bu yuzden +4 kaydirma Pazar'i 0 yapar.
    const days = Math.floor(local / DAY)
    localDow[i] = ((days + 4) % 7 + 7) % 7
  }
  return { sessionIdx, localHour, localDow }
}

/**
 * Her bar icin yerel saat (0..23).
 * @param {Float64Array|number[]} timeArr UNIX saniye (UTC)
 * @param {string} [tz] varsayilan Europe/Athens
 * @returns {Uint8Array}
 */
function localHourArray (timeArr, tz) {
  return localTimeArrays(timeArr, tz).localHour
}

/**
 * Her bar icin yerel haftanin gunu. 0 = Pazar (JavaScript getDay uyumlu).
 * @param {Float64Array|number[]} timeArr UNIX saniye (UTC)
 * @param {string} [tz]
 * @returns {Uint8Array}
 */
function localDowArray (timeArr, tz) {
  return localTimeArrays(timeArr, tz).localDow
}

/**
 * Her bar icin SESSIONS dizisindeki seans indeksi.
 * Gecersiz zaman damgasi 'Other' (3) sayilir.
 * @param {Float64Array|number[]} timeArr UNIX saniye (UTC)
 * @param {string} [tz]
 * @returns {Uint8Array}
 */
function sessionIndexArray (timeArr, tz) {
  return localTimeArrays(timeArr, tz).sessionIdx
}

module.exports = {
  SESSIONS,
  PIYASA_TZ,
  localTimeArrays,
  sessionIndexArray,
  localHourArray,
  localDowArray,
  sessionName,
  createOffsetLookup,
  createMarketCalendar,
  createSessionAnchor,
}
