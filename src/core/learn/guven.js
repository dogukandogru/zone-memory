'use strict'

/**
 * GUVEN YUZDESI: "bu yapi gecmiste geldiginde kacinda TP oldu".
 *
 * Sinyalin en benzer GUVEN_KOMSU gecmis kurulumu alinir (sekil + baglam,
 * ayni tur ve yon, yalnizca sinyalden onceki olaylar). Her birinin
 * kullanicinin TP/SL mesafesiyle nereye gittigi bakilir; yalnizca SINYAL
 * ANINDA sonucu belli olanlar sayilir (gelecek bilgisi karismaz). Oran,
 * turun taban oranina dogru GUVEN_ONSEL sanal gozlemle cekilir: 3 ornekten
 * %100 cikmasin.
 *
 * NEDEN BU TANIM. Onceki iki tanim olculdu ve TP ile korelasyonu SIFIRDI:
 *   - benzer kurulum sayisinin tur icindeki siralamasi (r = -0,025), gecmis
 *     buyudukce sayi buyudugu icin yeni sinyaller hep %90+ cikiyordu;
 *   - havuz payinin siralamasi (r = -0,025 ile -0,049).
 * En benzer 10 kurulumun TP orani ise 5m'de r = 0,085 (z 2,5): oran %65'in
 * ustundeyken sinyallerin %57'si, %35'in altindayken %40'i TP olmus. Zayif
 * ama sifirdan farkli; 15m'de dogrulanmadi (341 sinyal, r = 0,044).
 * Kullanici karari: "daha once bu sinyalin geldigi ve TP oldugu sinyalleri
 * alsak ve o sekilde bir yuzde uretsek". Yayginlik yuzdesi kaldirildi;
 * karistirmak bilgiyi yariya indiriyordu (r 0,085 -> 0,043).
 *
 * ONSEL = 10, KOMSU = 10: ustteki dilim (7/10 ve ustu) gercekte %57 TP
 * olmustu; a = 10 ile 7/10 -> %59, 10/10 -> %73 gosterilir, yani kalibre.
 * a = 5 olsaydi 10/10 -> %82, gercekten iyimser.
 */

/** Esik dosyasindaki olcek adi; eski bicimler (sayi, pay) bununla ayrilir. */
const GUVEN_OLCEGI = 'tp'
/** En benzer kac kurulum sayilir. */
const GUVEN_KOMSU = 10
/** Taban orana dogru kac sanal gozlem. */
const GUVEN_ONSEL = 10
/** Turun taban orani bilinmiyorsa. */
const TABAN_VARSAYILAN = 0.5

function sayi (v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/**
 * Bir komsu plani sinyal aninda sonuclanmis ve TP/SL ile bitmis mi.
 * @param {{result?:string, resolvedTime?:number|null}|null|undefined} plan
 * @param {number} sinyalZamani UNIX saniye
 * @returns {'tp'|'sl'|null}
 */
function komsuSonucu (plan, sinyalZamani) {
  if (!plan) return null
  if (plan.result !== 'tp' && plan.result !== 'sl') return null
  const r = sayi(plan.resolvedTime, NaN)
  if (!Number.isFinite(r) || !(r < sayi(sinyalZamani, -Infinity))) return null
  return plan.result
}

/**
 * Guven yuzdesi ve dayanagi.
 *
 * @param {Array<{result?:string, resolvedTime?:number|null}|null>} komsuPlanlari
 *        En benzerden baslayarak komsularin planlari; ilk GUVEN_KOMSU tanesi
 *        sayilir. Plani olmayan komsu null olabilir.
 * @param {number} sinyalZamani Sinyalin UNIX saniyesi
 * @param {number} taban Turun taban TP orani (0..1)
 * @returns {{confidence:number, confidenceTp:number, confidenceN:number, confidenceBase:number}}
 *          confidence 0..100; confidenceTp/confidenceN sayilan komsulardan
 *          kaci TP; confidenceBase kullanilan taban (0..1)
 */
function guvenHesapla (komsuPlanlari, sinyalZamani, taban) {
  const t = Math.min(1, Math.max(0, sayi(taban, TABAN_VARSAYILAN)))
  const liste = Array.isArray(komsuPlanlari) ? komsuPlanlari.slice(0, GUVEN_KOMSU) : []
  let tp = 0
  let n = 0
  for (let i = 0; i < liste.length; i++) {
    const sonuc = komsuSonucu(liste[i], sinyalZamani)
    if (sonuc === null) continue
    n++
    if (sonuc === 'tp') tp++
  }
  const oran = (tp + GUVEN_ONSEL * t) / (n + GUVEN_ONSEL)
  return {
    confidence: Math.round(100 * oran),
    confidenceTp: tp,
    confidenceN: n,
    confidenceBase: t,
  }
}

/**
 * Tur basina taban oran: listedeki cozulmus (tp/sl) planlarin TP orani.
 * Hic cozulmus plan yoksa TABAN_VARSAYILAN.
 *
 * @param {Array<{kind?:string, plan?:{result?:string}|null}|null>} liste
 * @returns {{form:number, touch:number}}
 */
function tabanOranlari (liste) {
  const say = { form: { tp: 0, n: 0 }, touch: { tp: 0, n: 0 } }
  const L = Array.isArray(liste) ? liste : []
  for (let i = 0; i < L.length; i++) {
    const s = L[i]
    if (!s || !s.plan) continue
    const r = s.plan.result
    if (r !== 'tp' && r !== 'sl') continue
    const k = s.kind === 'form' ? 'form' : 'touch'
    say[k].n++
    if (r === 'tp') say[k].tp++
  }
  return {
    form: say.form.n > 0 ? say.form.tp / say.form.n : TABAN_VARSAYILAN,
    touch: say.touch.n > 0 ? say.touch.tp / say.touch.n : TABAN_VARSAYILAN,
  }
}

/**
 * Ekran metni: "TP şansı %56 (6/10)". Dayanak sayilari yoksa yalnizca yuzde.
 * @param {{confidence?:number, confidenceTp?:number, confidenceN?:number}} s
 * @returns {string} confidence yoksa bos dize
 */
function guvenMetni (s) {
  const g = sayi(s && s.confidence, NaN)
  if (!Number.isFinite(g)) return ''
  const n = sayi(s && s.confidenceN, NaN)
  const tp = sayi(s && s.confidenceTp, NaN)
  let metin = 'TP şansı %' + Math.round(g)
  if (Number.isFinite(n) && n > 0 && Number.isFinite(tp)) {
    metin += ' (' + Math.round(tp) + '/' + Math.round(n) + ')'
  }
  return metin
}

module.exports = {
  GUVEN_OLCEGI,
  GUVEN_KOMSU,
  GUVEN_ONSEL,
  TABAN_VARSAYILAN,
  komsuSonucu,
  guvenHesapla,
  tabanOranlari,
  guvenMetni,
}
