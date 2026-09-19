'use strict'

/**
 * SINYAL METINLERININ TEK KAYNAGI.
 *
 * Ayni sinyal dort ayri yerde dort ayri bicimde yaziliyordu: alt serit
 * bildirimi, canli gunluk satiri, masaustu bildirimi ve grafik isareti.
 * Bazilari "guven %59" diyordu, oysa guven puani bir OLASILIK DEGIL, uc
 * bilesenin agirlikli toplamiydi; olculdu, guven yukseldikce gerceklesen
 * oran DUSUYORDU. Bu yuzden "guven" ifadesi hicbir metinde kalmadi ve
 * butun metinler buradan uretiliyor.
 *
 * Gosterilen sey artik su: kac kayittan kaci tuttu, %95 araligi ne, turun
 * hafiza tabani ne. Bu uc sayi birlikte okunmadan oran yaniltici.
 */

/** Sayi degilse veya sonlu degilse varsayilani dondurur. */
function num (v, def) {
  return typeof v === 'number' && isFinite(v) ? v : def
}

/** Orani tam sayi yuzdeye cevirir. */
function yuzde (x) {
  const v = num(x, NaN)
  if (!isFinite(v)) return null
  return Math.round(v * 100)
}

/**
 * Sinyalin tek satirlik ozeti.
 *
 * Ornek: "9/15 tuttu (%95 aralik %36-80), tür tabanı %40"
 *
 * @param {Object} signal
 * @param {{baseRate?:number|null}} [opts] Turun hafiza tabani (0..1)
 * @returns {string}
 */
function sinyalOzeti (signal, opts) {
  if (!signal) return ''
  const o = opts || {}
  const n = Math.round(num(signal.matchCount, 0))
  const hamOran = num(signal.winRateRaw, num(signal.winRate, NaN))
  const parcalar = []

  if (n > 0 && isFinite(hamOran)) {
    parcalar.push(Math.round(hamOran * n) + '/' + n + ' tuttu')
  } else if (isFinite(num(signal.winRate, NaN))) {
    parcalar.push('%' + yuzde(signal.winRate))
  }

  const lo = yuzde(signal.winRateLo)
  const hi = yuzde(signal.winRateHi)
  if (lo !== null && hi !== null && (lo > 0 || hi > 0)) {
    parcalar.push('%95 aralık %' + lo + '-' + hi)
  }

  const taban = o.baseRate === undefined || o.baseRate === null
    ? num(signal.baseRate, NaN)
    : num(o.baseRate, NaN)
  if (isFinite(taban)) parcalar.push('tür tabanı %' + yuzde(taban))

  return parcalar.join(', ')
}

/**
 * Bildirim ve gunluk icin baslik: "AL, kutu oluşumu (15m)".
 * @param {Object} signal
 * @param {string} [tf]
 * @returns {string}
 */
function sinyalBasligi (signal, tf) {
  if (!signal) return ''
  const yon = signal.direction === 'SELL' ? 'SAT' : 'AL'
  const tur = signal.kind === 'form' ? 'kutu oluşumu' : 'bölge dokunuşu'
  return yon + ', ' + tur + (tf ? ' (' + tf + ')' : '')
}

/**
 * Grafik isaretinin kisa metni: "O 9/15".
 *
 * Onceden "O %53" yaziyordu ve 3 kayittan 3'u ile 30 kayittan 16'si ayni
 * gorunuyordu.
 *
 * @param {Object} signal
 * @returns {string}
 */
function isaretMetni (signal) {
  if (!signal) return ''
  const onek = signal.kind === 'form' ? 'OL' : 'DK'
  const n = Math.round(num(signal.matchCount, 0))
  const hamOran = num(signal.winRateRaw, num(signal.winRate, NaN))
  if (n > 0 && isFinite(hamOran)) return onek + ' ' + Math.round(hamOran * n) + '/' + n
  if (isFinite(num(signal.winRate, NaN))) return onek + ' %' + yuzde(signal.winRate)
  return onek
}

module.exports = {
  sinyalOzeti,
  sinyalBasligi,
  isaretMetni,
}
