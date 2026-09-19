'use strict'

/**
 * UST ZAMAN DILIMI BAGLAMI (Y3)
 *
 * Soru: bir alt zaman dilimi olayinin karar aninda, ust zaman diliminde AYNI
 * YONLU bir bolge yakinda miydi?
 *
 * Bu sorunun yanlis cevaplanmasi kolay ve sonucu yaniltici: zones.json
 * kaydindaki `createdTime` barin ACILISIDIR ve `top` / `bottom` kutunun NIHAI
 * sinirlaridir. Ikisini kullanmak, henuz onaylanmamis bir kutuyu ve henuz
 * olusmamis birlesme sinirlarini gormek demektir.
 *
 * Olculdu: naif zamanlamayla 5m formda "aktif 1h kutusu yakini" %53,0'a karsi
 * %45,8 gorunuyor (+7 puan). Kutu 1h barinin KAPANISINDA onaylanmis ve
 * kirilmasi da kapanista bilinmis haliyle olculunce fark %48,1'e karsi %46,1'e
 * iniyor ve guven araliklari ortusuyor. Yani bugun ortada kanit yok; gorunen
 * +7 puan zamanlama sizintisiydi.
 *
 * Bu modul yalnizca `proZones.runIndicator(..., {recordTimeline: true})`
 * ciktisindaki ARALIKLARI kullanir. Her aralik "bu kutu, bu sinirlarla, bu
 * zaman araliginda BILINIYORDU" demektir.
 */

/** Sayi degilse varsayilani dondurur. */
function num (v, def) {
  return typeof v === 'number' && isFinite(v) ? v : def
}

/**
 * Zaman cizelgesinden sorgulanabilir bir dizin kurar.
 *
 * Aralıklar `knownFrom` degerine gore siralanir; sorgu bu siradan ikili
 * aramayla baslar ve geriye dogru acik araliklara bakar. Kutular uzun
 * yasadigi icin (varsayilan maxAgeBars) geriye bakma penceresi sinirsiz
 * olamaz; bu yuzden en uzun aralik suresi de saklanir ve arama onunla
 * sinirlandirilir.
 *
 * @param {Array<{zoneId:number, isSupport:boolean, top:number, bottom:number,
 *                knownFrom:number, knownTo:number|null}>} timeline
 * @returns {{rows:Array, maxSpan:number}}
 */
function buildHtfIndex (timeline) {
  const ham = Array.isArray(timeline) ? timeline : []
  const rows = []
  let maxSpan = 0
  for (let i = 0; i < ham.length; i++) {
    const t = ham[i]
    if (!t) continue
    const from = num(t.knownFrom, NaN)
    if (!isFinite(from)) continue
    const to = t.knownTo === null || t.knownTo === undefined ? Infinity : num(t.knownTo, Infinity)
    const ust = num(t.top, NaN)
    const alt = num(t.bottom, NaN)
    if (!isFinite(ust) || !isFinite(alt)) continue
    const span = to === Infinity ? Infinity : to - from
    if (span > maxSpan) maxSpan = span
    rows.push({
      zoneId: num(t.zoneId, -1),
      isSupport: t.isSupport !== false,
      top: ust,
      bottom: alt,
      from: from,
      to: to,
    })
  }
  rows.sort((a, b) => a.from - b.from)
  return { rows: rows, maxSpan: maxSpan }
}

/**
 * Karar aninda ust zaman diliminde bolge var mi.
 *
 * `yakinlik` fiyatin bolgeye ATR biriminde uzakligi icin esiktir; cagiran
 * taraf ust zaman diliminin ATR'sini verir (`atr` argumani). Bolgenin ICINDE
 * olmak her zaman "yakin" sayilir.
 *
 * @param {{rows:Array, maxSpan:number}} index
 * @param {number} tSec Karar ani (alt zaman dilimi barinin KAPANISI)
 * @param {number} price Karar anindaki fiyat
 * @param {'BUY'|'SELL'} direction
 * @param {{atr?:number, nearAtr?:number}} [opts]
 * @returns {{same:boolean, opposite:boolean, sameInside:boolean,
 *            oppositeInside:boolean, count:number}}
 */
function htfAt (index, tSec, price, direction, opts) {
  const bos = { same: false, opposite: false, sameInside: false, oppositeInside: false, count: 0 }
  if (!index || !Array.isArray(index.rows) || index.rows.length === 0) return bos
  const t = num(tSec, NaN)
  const p = num(price, NaN)
  if (!isFinite(t) || !isFinite(p)) return bos

  const o = opts || {}
  const atr = num(o.atr, 0)
  const nearAtr = num(o.nearAtr, 0.5)
  const pay = atr > 0 ? atr * nearAtr : 0
  // BUY icin ayni yon DESTEK bolgesidir (asagidan alis), SELL icin direnc.
  const ayniDestek = direction !== 'SELL'

  const rows = index.rows
  // `from <= t` olan son aralik: ikili arama.
  let lo = 0
  let hi = rows.length - 1
  let son = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].from <= t) { son = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (son < 0) return bos

  const out = { same: false, opposite: false, sameInside: false, oppositeInside: false, count: 0 }
  // Geriye dogru en uzun aralik suresi kadar bak; daha eski araliklar t'yi
  // kapsayamaz. maxSpan sonsuzsa (hala acik aralik var) tamamina bakilir.
  const enErken = index.maxSpan === Infinity ? -Infinity : t - index.maxSpan
  for (let i = son; i >= 0; i--) {
    const r = rows[i]
    if (r.from < enErken) break
    if (t < r.from || t >= r.to) continue
    out.count++
    const icinde = p >= r.bottom && p <= r.top
    const yakin = icinde || (pay > 0 && p >= r.bottom - pay && p <= r.top + pay)
    if (!yakin) continue
    const ayni = r.isSupport === ayniDestek
    if (ayni) {
      out.same = true
      if (icinde) out.sameInside = true
    } else {
      out.opposite = true
      if (icinde) out.oppositeInside = true
    }
  }
  return out
}

/**
 * Olcum etiketi: alt kume kirilimi icin tek bir dize.
 * @param {{same:boolean, opposite:boolean}} durum
 * @returns {'aynı yön yakın'|'ters yön yakın'|'ikisi de yakın'|'yok'}
 */
function htfSubset (durum) {
  if (!durum) return 'yok'
  if (durum.same && durum.opposite) return 'ikisi de yakın'
  if (durum.same) return 'aynı yön yakın'
  if (durum.opposite) return 'ters yön yakın'
  return 'yok'
}

module.exports = {
  buildHtfIndex,
  htfAt,
  htfSubset,
}
