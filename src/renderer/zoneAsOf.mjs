/**
 * zoneAsOf.mjs - Bir bolgenin BELIRLI BIR ANDAKI hali (U7).
 *
 * NEDEN AYRI DOSYA
 * Gecmis bir sinyali incelerken grafik, o sinyalden sonrasini da gosteriyordu.
 * En sinsi hali kutularin gorunumuydu: sinyal aninda saglam olan bir destek,
 * iki hafta sonra kirildigi icin kesikli ve solgun ciziliyordu. Kullanici
 * ekrana bakip "zaten kirilacakmis" diye okuyor, kendi degerlendirmesini
 * gecmise uyduruyordu. Olculemeyen ama kararlari dogrudan bozan bir ileriye
 * bakma bicimi.
 *
 * Kural bir cizim ayrintisi degil, bir DOGRULUK kurali oldugu icin cizimden
 * ayri, saf ve test edilebilir tutuluyor.
 */

/** @param {*} v */
export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Sayiya cevirir, cevrilemiyorsa NaN doner.
 *
 * DIKKAT, BU PROJEDE UC KEZ ISIRAN TUZAK: `Number(null)` SIFIRDIR. Duz
 * `Number(zone.brokenTime)` yazmak, kirilma ani tasimayan bir kutuyu
 * "1970'te kirilmis" saydiriyordu; dolayisiyla her an icin kirik gorunuyordu
 * ve U7'nin tum amaci bosa cikiyordu.
 * @param {*} v
 */
function sayiya(v) {
  if (v === null || v === undefined || v === '') return NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Bolgenin sag kenari icin gecerli zaman.
 *
 * `endTime` zaten dogru andir. Guncel indikatorde kirilan kutu ekrandan
 * KALKMAZ, soluklasarak omrunun sonuna kadar uzar; `endTime` bu yuzden
 * kirilma ani degil, kutunun bittigi andir. (Kirilmada kapanan ESKI kayitlarda
 * ikisi ayni seydi; asagidaki yedek yol yalnizca onlar icin kullanilir.)
 * @param {object} zone
 * @returns {number} NaN olabilir
 */
export function zoneRightTime(zone) {
  if (!zone) return NaN
  const bitis = sayiya(zone.endTime)
  if (isNum(bitis)) return bitis
  return sayiya(zone.createdTime)
}

/**
 * Bolge, verilen ana kadar KIRILMIS miydi?
 * @param {object} zone
 * @param {number|null} asOf UNIX saniye; null ise kisitlama yok
 */
export function zoneBrokenAt(zone, asOf) {
  if (!zone) return false
  // Kisit yoksa SON durum gecerlidir, TradingView'in bugun gosterdigi de odur.
  if (asOf === null || asOf === undefined) return !!zone.broken

  // KIRILMA GECMISI. Kutu birlesmeyle DIRILEBILIYOR (Pine: merge dalinda
  // `array.set(zBroken, j, false)`), dolayisiyla tek bir "kirildi" damgasi
  // gecmisi anlatmaya yetmez: kirilip sonra dirilen bir kutu kayitta "hic
  // kirilmadi" gorunuyor ve "o an" kipi kirik oldugu donemi SAGLAM ciziyordu.
  // Liste donusumludur (kirildi, dirildi, kirildi ...), bu yuzden o ana kadar
  // gerceklesen olay sayisi TEK ise kutu o anda kirikti.
  if (Array.isArray(zone.brokenTimes) && zone.brokenTimes.length > 0) {
    let olan = 0
    for (const t of zone.brokenTimes) {
      const an = sayiya(t)
      if (isNum(an) && an <= asOf) olan++
    }
    return olan % 2 === 1
  }

  // ESKI KAYITLAR: `brokenTimes` yok. O kayitlarda kutu kirilinca kapandigi
  // icin sag kenar kirilma aniyla ayni sayilir.
  if (!zone.broken) return false
  const kirilmaAni = sayiya(zone.brokenTime)
  const kirilma = isNum(kirilmaAni) ? kirilmaAni : zoneRightTime(zone)
  if (!isNum(kirilma)) return true
  return kirilma <= asOf
}

/**
 * Bolgenin verilen andaki zaman araligi.
 * @param {object} zone
 * @param {number|null} asOf UNIX saniye; null ise kisitlama yok
 * @returns {{start:number, end:number}|null} O anda gorunmuyorsa null
 */
export function zoneSpanAt(zone, asOf) {
  if (!zone) return null

  // IKI AYRI ZAMAN, KARISTIRILMAMALI:
  //
  //   createdTime : kutunun ONAYLANDIGI an. Pivot ancak kendisinden pivotLen
  //                 bar SONRA kesinlesir, kutu o ana kadar bilinmez.
  //   pivotTime   : kutunun CIZILDIGI yer. Pine kutuyu pivot barindan baslatir
  //                 (`box.new(left = bar_index - pivotLen, ...)`).
  //
  // Port bir donem ikisini de createdTime sayiyordu ve kutular TradingView'a
  // gore soldan bes bar kirpik ciziliyordu (100 yerine 95 bar genislik).
  // Ileriye bakma degildir: kutu yine ancak onaylandiktan SONRA gorunur,
  // yalnizca sol kenari pivota kadar uzanir. TradingView'in yaptigi da budur.
  const bilinir = sayiya(zone.createdTime)
  const sol = sayiya(zone.pivotTime)
  const start = isNum(sol) ? sol : bilinir
  let end = zoneRightTime(zone)
  if (!isNum(start) || !isNum(end) || !isNum(bilinir)) return null

  if (asOf !== null && asOf !== undefined) {
    // Henuz ONAYLANMAMIS kutu o anda EKRANDA YOKTUR.
    if (bilinir > asOf) return null
    if (end > asOf) end = asOf
  }
  if (end < start) end = start
  return { start, end }
}
