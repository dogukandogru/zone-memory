'use strict'

/**
 * GUVEN YUZDESI: "bu yapi gecmiste geldiginde kacinda TP oldu".
 *
 * Sinyalin en benzer GUVEN_KOMSU gecmis kurulumu alinir (sekil + baglam,
 * ayni tur ve yon, yalnizca sinyalden onceki olaylar). Her birinin
 * kullanicinin TP/SL mesafesiyle nereye gittigi bakilir; yalnizca SINYAL
 * ANINDA sonucu belli olanlar sayilir (gelecek bilgisi karismaz). Her komsu
 * BENZERLIGIYLE agirlik alir: w = exp((benzerlik - 1) / GUVEN_TAU). Yakin
 * olan cok, uzak olan az sayilir; 50. komsudan sonrasi olcumde hicbir sey
 * eklemedigi icin oraya kadar bakilir. Oran, turun taban oranina dogru
 * GUVEN_ONSEL sanal gozlemle cekilir (etkin orneklem uzerinden): birkac
 * ornekten %100 cikmasin.
 *
 * NEDEN BU TANIM. Onceki tanimlar olculdu (5m/15m, son 1 yil, gercek TP ile
 * korelasyon r):
 *   - benzer kurulum sayisinin tur icindeki siralamasi: -0,025 / -0,049;
 *     gecmis buyudukce sayi buyudugu icin yeni sinyaller hep %90+ cikiyordu;
 *   - havuz payinin siralamasi: ayni, sifir;
 *   - en benzer 10, esit agirlik: 0,085 / 0,044;
 *   - esigi gecen HEPSI, esit agirlik: 0,036 / 0,102 (5m'de havuzun %65'i
 *     "benzer" sayildigi icin taban orana cokuyor);
 *   - en benzer 50, exp(0,02) agirlik: 0,078 / 0,121  <- SECILEN;
 *     100 ve 200 komsu ya da hepsi ayni ya da daha dusuk (0,074/0,122,
 *     0,067/0,120, 0,066/0,115).
 * Kullanici istegi: "en cok benzeyen 10 yerine benzeme oranina gore
 * agirlikli katsayi, hepsini katalim". Uzaktakilerin agirligi sifira yakin
 * oldugu icin 50 komsu "hepsi" ile ayni sonucu verir ve TP/SL mesafesi
 * degisince saniyeler icinde yeniden hesaplanabilir (hepsi icin komsu
 * aramasi bastan gerekirdi, dakikalar).
 */

/** Esik dosyasindaki olcek adi; eski bicimler bununla ayrilir. */
const GUVEN_OLCEGI = 'tp-agac'
/** En benzer kac kurulum katilir. */
const GUVEN_KOMSU = 50
/** Agirlik sicakligi: w = exp((benzerlik - 1) / tau). */
const GUVEN_TAU = 0.02
/** Taban orana dogru kac sanal gozlem (etkin orneklem uzerinden). */
const GUVEN_ONSEL = 10
/** Turun taban orani bilinmiyorsa. */
const TABAN_VARSAYILAN = 0.5

function sayi (v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** Benzerlige gore agirlik (0..1]; benzerlik 1 ise 1. */
function komsuAgirligi (benzerlik) {
  return Math.exp((Math.min(1, sayi(benzerlik, 0)) - 1) / GUVEN_TAU)
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
 * @param {Array<{similarity?:number, plan?:{result?:string, resolvedTime?:number|null}|null}|null>} komsular
 *        En benzerden baslayarak; ilk GUVEN_KOMSU tanesi katilir. Plani
 *        olmayan komsu atlanir.
 * @param {number} sinyalZamani Sinyalin UNIX saniyesi
 * @param {number} taban Turun taban TP orani (0..1)
 * @returns {{confidence:number, confidenceRaw:number|null, confidenceN:number,
 *            confidenceNeff:number, confidenceBase:number}}
 *          confidence 0..100 (kuculutulmus); confidenceRaw agirlikli ham
 *          oran (sayilan komsu yoksa null); confidenceN sayilan komsu;
 *          confidenceNeff etkin orneklem; confidenceBase kullanilan taban
 */
function guvenHesapla (komsular, sinyalZamani, taban) {
  const t = Math.min(1, Math.max(0, sayi(taban, TABAN_VARSAYILAN)))
  const liste = Array.isArray(komsular) ? komsular.slice(0, GUVEN_KOMSU) : []
  let wToplam = 0
  let wTp = 0
  let wKare = 0
  let n = 0
  for (let i = 0; i < liste.length; i++) {
    const k = liste[i]
    if (!k) continue
    const sonuc = komsuSonucu(k.plan, sinyalZamani)
    if (sonuc === null) continue
    const w = komsuAgirligi(k.similarity)
    n++
    wToplam += w
    wKare += w * w
    if (sonuc === 'tp') wTp += w
  }
  const nEff = wKare > 0 ? (wToplam * wToplam) / wKare : 0
  const ham = wToplam > 0 ? wTp / wToplam : null
  const oran = ham === null ? t : (ham * nEff + GUVEN_ONSEL * t) / (nEff + GUVEN_ONSEL)
  return {
    confidence: Math.round(100 * oran),
    confidenceRaw: ham,
    confidenceN: n,
    confidenceNeff: Math.round(nEff * 10) / 10,
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
 * Ekran metni: "TP şansı %56". Dayanak ayrintisi ipucunda, burada degil.
 * @param {{confidence?:number}} s
 * @returns {string} confidence yoksa bos dize
 */
function guvenMetni (s) {
  const g = sayi(s && s.confidence, NaN)
  if (!Number.isFinite(g)) return ''
  return 'TP şansı %' + Math.round(g)
}

module.exports = {
  GUVEN_OLCEGI,
  GUVEN_KOMSU,
  GUVEN_TAU,
  GUVEN_ONSEL,
  TABAN_VARSAYILAN,
  komsuAgirligi,
  komsuSonucu,
  guvenHesapla,
  tabanOranlari,
  guvenMetni,
}
