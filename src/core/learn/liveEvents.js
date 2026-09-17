'use strict'

/**
 * CANLI OLAY SECIMI
 * ===========================================================================
 * Canli dongu her yeni kapanmis barda indikatoru SON PENCEREDE kosturur ve
 * ciktisindan "bu tikte yeni olan" olaylari ayiklar. Bu modul o ayiklamayi
 * yapar ve yalnizca saf hesap icerir; dosya, ag ve durum burada yoktur.
 *
 * KILITLENEN HATA: onceden yalnizca SON olay aliniyor ve `sinceTime` onun
 * zamanina cekiliyordu. Ayni barda iki bolge olayi olustugunda (ornegin bir
 * kutu dogarken baska bir kutuya dokunuluyorsa) digerleri KALICI olarak
 * kayboluyordu. Olculdu: 15m'de 5378 olayin 60'i ayni barda baska bir olayla
 * birlikte olusuyor.
 *
 * OLAY ANAHTARI NEDEN zoneId DEGIL
 * ---------------------------------------------------------------------------
 * `proZones` her calismada kutulari SIFIRDAN numaralandirir ve canli kuyruk
 * her barda kaydigi icin ayni bolge her tikte baska bir `zoneId` alir. Kimlik
 * bu yuzden kayan pencereden etkilenmeyen alanlardan kurulur: olay turu, olay
 * zamani ve kutunun iki kenari (sabit ondalikla).
 */

/** Olay kenarlarinin anahtarda kullanilan ondalik basamagi. */
const ONDALIK = 5

/** Sonlu sayi degilse varsayilana duser. */
function sayi (v, varsayilan) {
  const x = Number(v)
  return Number.isFinite(x) ? x : varsayilan
}

/**
 * Fiyat alanini sabit ondaliga indirger. Kuyruk penceresi kaydikca ATR'nin
 * son basamaklari zerre oynayabilir; anahtarin bundan etkilenmemesi gerekir.
 * @param {*} v
 * @returns {string}
 */
function kenar (v) {
  const x = Number(v)
  return Number.isFinite(x) ? x.toFixed(ONDALIK) : 'yok'
}

/**
 * Bir bolge olayinin kayan pencereden ETKILENMEYEN kimligi.
 * @param {Object} ev Indikatorun urettigi olay (kind, time, zoneTop, zoneBottom)
 * @returns {string}
 */
function eventKey (ev) {
  if (!ev || typeof ev !== 'object') return ''
  const kind = ev.kind === 'form' ? 'form' : 'touch'
  const time = Math.trunc(sayi(ev.time, 0))
  return kind + '|' + time + '|' + kenar(ev.zoneTop) + '|' + kenar(ev.zoneBottom)
}

/**
 * `since` degerinden SONRAKI, daha once degerlendirilmemis TUM olaylari zaman
 * sirasiyla dondurur. Ayni barda birden fazla olay varsa hepsi doner.
 *
 * @param {Array<Object>} touches Indikatorun olay listesi ('form' + 'touch')
 * @param {number} since Bu zamandan (dahil degil) sonraki olaylar alinir
 * @param {Set<string>|Array<string>} [seen] Daha once degerlendirilmis anahtarlar
 * @returns {Array<Object>} Zaman sirali, tekrarsiz olaylar
 */
function selectNewEvents (touches, since, seen) {
  if (!Array.isArray(touches) || touches.length === 0) return []
  const esik = sayi(since, 0)
  // Cagiranin kumesi DEGISTIRILMEZ: kopya uzerinde calisilir, boylece ayni
  // listede tekrarlanan anahtar da bir kez doner.
  const gorulen = new Set()
  if (seen instanceof Set) {
    for (const k of seen) gorulen.add(String(k))
  } else if (Array.isArray(seen)) {
    for (let i = 0; i < seen.length; i++) gorulen.add(String(seen[i]))
  }

  const secilen = []
  for (let i = 0; i < touches.length; i++) {
    const ev = touches[i]
    if (!ev || typeof ev !== 'object') continue
    const t = Number(ev.time)
    if (!Number.isFinite(t) || t <= esik) continue
    const anahtar = eventKey(ev)
    if (gorulen.has(anahtar)) continue
    gorulen.add(anahtar)
    secilen.push({ ev: ev, t: t, sira: i })
  }

  // Zamana gore sirali; ayni bardaki olaylarin ic sirasi indikatorun urettigi
  // sira olarak korunur.
  secilen.sort(function (a, b) {
    if (a.t !== b.t) return a.t - b.t
    return a.sira - b.sira
  })

  const cikti = new Array(secilen.length)
  for (let i = 0; i < secilen.length; i++) cikti[i] = secilen[i].ev
  return cikti
}

module.exports = {
  eventKey,
  selectNewEvents,
}
