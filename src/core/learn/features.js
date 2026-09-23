'use strict'

/**
 * Ozellik cikarimi (A4).
 *
 * Bir dokunus anindaki piyasa yapisini sabit boyutlu uc parcaya cevirir:
 *   shape : son 32 kapanistan turetilmis, yumusatilmis ve min-max normalize
 *           edilmis 16 boyutlu sekil vektoru
 *   ret   : son 33 kapanisin 32 log getirisi, z-score normalize
 *   ctx   : CTX_NAMES sirasindaki baglam degerleri
 *
 * Referans: ../indicator2/backend/app/services/features.py
 * Fark: sekil vektoru artik ham 32 getiri yerine yumusatilmis 16 kovadir,
 * baglam ise bolge ve skor bilesenleriyle genisletilmistir.
 *
 * Baglam vektoru proZones indikatorune baglidir: skor bilesenleri (pFlow,
 * pTrend, pSession, pRejection, pVolume) onun urettigi `parts` anahtarlarinin
 * birebir karsiligidir. CTX_NAMES degisirse eski hafiza dosyalari uyumsuz
 * kalir; motor bunu yakalayip yeniden tarama ister (engine.worker.js).
 */

/**
 * Ozellik surumu. CTX_NAMES veya hesaplama kurallari degistiginde ARTIRILIR;
 * hafiza dosyasina yazilir, boylece eski bir hafizanin yeni olaylarla
 * karsilastirilamayacagi yalnizca uzunluk esitligine bakilarak degil acikca
 * anlasilir.
 */
const FEATURE_VERSION = 2

const SHAPE_LEN = 16
const RET_LEN = 32
/** Getiri penceresi. DEGISMEZ: satir uzunlugu buna bagli (bkz. ROW_LEN). */
const WINDOW_BARS = 32

/**
 * SEKIL PENCERESI (bar). Kullanici Ayarlar'dan degistirebilir.
 *
 * Sekil vektoru her zaman SHAPE_LEN (16) noktadir; pencere buyudukce her
 * nokta daha cok barin ortalamasi olur, yani daha genis ama daha kaba bir
 * bicim karsilastirilir. Getiri vektoru bundan ETKILENMEZ ve 32 kalir:
 * uzunlugu degisseydi hafiza dosyasinin satir boyu degisir, eski dosyalar
 * okunamaz hale gelirdi.
 *
 * DIKKAT: bu deger ozellik vektorunu degistirir, yani hafizanin yeniden
 * kurulmasini gerektirir. Ayar izine (cfgHash) dahildir, boylece degisince
 * yeniden tarama kendiliginden istenir.
 */
const SHAPE_WINDOW_VARSAYILAN = 32
/** Anlamli alt ve ust sinir: 16'nin altinda kova basina 1 bar bile dusmez. */
const SHAPE_WINDOW_EN_AZ = 16
const SHAPE_WINDOW_EN_COK = 512

/** Ayardan gecerli sekil penceresini cikarir. */
function sekilPenceresi (opts) {
  const ham = opts && Number.isFinite(Number(opts.shapeWindowBars))
    ? Math.round(Number(opts.shapeWindowBars))
    : SHAPE_WINDOW_VARSAYILAN
  if (ham < SHAPE_WINDOW_EN_AZ) return SHAPE_WINDOW_EN_AZ
  if (ham > SHAPE_WINDOW_EN_COK) return SHAPE_WINDOW_EN_COK
  return ham
}
/** Sekil yumusatmasinda kullanilan hareketli ortalama uzunlugu. */
const SMOOTH_LEN = 5

const CTX_NAMES = [
  'rsi', 'atrPct', 'distSma20Atr', 'distSma50Atr',
  'hourSin', 'hourCos', 'dowSin', 'dowCos',
  'zoneWidthAtr', 'zoneAge', 'zoneFlow', 'penetration',
  'scoreRatio', 'pFlow', 'pTrend', 'pSession', 'pRejection', 'pVolume',
  'isSupport', 'trendState', 'isForm', 'bbDistAtr', 'volRatio', 'entryDistAtr',
]

const CTX_LEN = CTX_NAMES.length
const ROW_LEN = SHAPE_LEN + RET_LEN + CTX_LEN
const IKI_PI = Math.PI * 2

/**
 * Dokunus anindaki ozellik vektorunu uretir.
 *
 * @param {Object} s      Sutunsal mum serisi
 * @param {Object} touch  Dokunus olayi
 * @param {Object} ctxArr IndicatorContext, indikatorden gelen ara diziler
 * @returns {{shape: Float32Array, ret: Float32Array, ctx: Float32Array}|null}
 *          Pencere yetmiyorsa null
 */
function buildFeatures (s, touch, ctxArr, opts) {
  if (!s || !touch) return null

  const bar = touch.bar | 0
  const n = s.length | 0
  if (bar < 0 || bar >= n) return null

  const sekilPencere = sekilPenceresi(opts)
  // Getiri icin 33 kapanis, sekil icin `sekilPencere` kapanis gerekir.
  const gereken = Math.max(WINDOW_BARS, sekilPencere)
  if (bar < gereken) return null

  const close = s.close

  // Getiri penceresi: son WINDOW_BARS + 1 kapanis.
  const hamGetiri = new Float64Array(WINDOW_BARS + 1)
  for (let i = 0; i <= WINDOW_BARS; i++) {
    const c = +close[bar - WINDOW_BARS + i]
    if (!Number.isFinite(c) || c <= 0) return null
    hamGetiri[i] = c
  }

  // Sekil penceresi AYRI okunur: kullanici genisletmis olabilir.
  const hamSekil = new Float64Array(sekilPencere)
  for (let i = 0; i < sekilPencere; i++) {
    const c = +close[bar - sekilPencere + 1 + i]
    if (!Number.isFinite(c) || c <= 0) return null
    hamSekil[i] = c
  }

  const shape = sekilVektoru(hamSekil)
  const ret = getiriVektoru(hamGetiri)
  const ctx = baglamVektoru(s, touch, ctxArr, bar)

  return { shape, ret, ctx }
}

/**
 * Sekil vektoru: verilen kapanis dizisinin TAMAMI,
 * once SMOOTH_LEN'lik hareketli ortalama ile yumusatilir (ilk barlarda pencere
 * kisaltilir, NaN uretilmez), sonra SHAPE_LEN kovaya bolunup kova ortalamasi
 * alinir, en son min-max ile 0..1 araligina tasinir.
 * @param {Float64Array} ham Sekil penceresi kadar kapanis
 * @returns {Float32Array}
 */
function sekilVektoru (ham) {
  // Dizinin TAMAMI sekil penceresidir; uzunlugu ayardan gelir.
  const pencere = ham.length | 0

  // Kisaltilmis pencereli hareketli ortalama.
  const duz = new Float64Array(pencere)
  let toplam = 0
  for (let i = 0; i < pencere; i++) {
    toplam += ham[i]
    if (i >= SMOOTH_LEN) toplam -= ham[i - SMOOTH_LEN]
    const p = i < SMOOTH_LEN ? i + 1 : SMOOTH_LEN
    duz[i] = toplam / p
  }

  // Kova ortalamalari. Kova SAYISI sabittir (SHAPE_LEN); pencere buyudukce
  // her kovaya daha cok bar duser, yani bicim daha genis ama daha kaba olur.
  const kova = new Float64Array(SHAPE_LEN)
  for (let k = 0; k < SHAPE_LEN; k++) {
    const basIdx = Math.floor((k * pencere) / SHAPE_LEN)
    const sonIdx = Math.max(basIdx + 1, Math.floor(((k + 1) * pencere) / SHAPE_LEN))
    let t = 0
    for (let i = basIdx; i < sonIdx; i++) t += duz[Math.min(i, pencere - 1)]
    kova[k] = t / (sonIdx - basIdx)
  }

  // Min-max normalize, duz seride hepsi 0.5.
  let enAz = kova[0]
  let enCok = kova[0]
  for (let k = 1; k < SHAPE_LEN; k++) {
    const v = kova[k]
    if (v < enAz) enAz = v
    if (v > enCok) enCok = v
  }

  const out = new Float32Array(SHAPE_LEN)
  const aralik = enCok - enAz
  if (!(aralik > 0)) {
    out.fill(0.5)
    return out
  }
  for (let k = 0; k < SHAPE_LEN; k++) out[k] = (kova[k] - enAz) / aralik
  return out
}

/**
 * Getiri vektoru: RET_LEN adet log getiri, z-score normalize.
 * Standart sapma 1e-12'den kucukse hepsi 0 kalir.
 * @param {Float64Array} ham
 * @returns {Float32Array}
 */
function getiriVektoru (ham) {
  const bas = ham.length - (RET_LEN + 1)
  const lr = new Float64Array(RET_LEN)
  let toplam = 0
  for (let i = 0; i < RET_LEN; i++) {
    const v = Math.log(ham[bas + i + 1] / ham[bas + i])
    lr[i] = v
    toplam += v
  }

  const out = new Float32Array(RET_LEN)
  const ort = toplam / RET_LEN
  let kare = 0
  for (let i = 0; i < RET_LEN; i++) {
    const d = lr[i] - ort
    kare += d * d
  }
  const std = Math.sqrt(kare / RET_LEN)
  if (!(std > 1e-12)) return out

  for (let i = 0; i < RET_LEN; i++) out[i] = (lr[i] - ort) / std
  return out
}

/**
 * Baglam vektoru. Siralama CTX_NAMES ile birebir aynidir, NaN cikan her deger
 * 0 yazilir.
 * @returns {Float32Array}
 */
function baglamVektoru (s, touch, ctxArr, bar) {
  const c = ctxArr || {}
  const out = new Float32Array(CTX_LEN)

  const price = +s.close[bar]
  const atr = atrSec(touch, c, bar)
  const atrVar = atr > 1e-12

  const rsi = dizi(c.rsi, bar)
  const sma20 = dizi(c.sma20, bar)
  const sma50 = dizi(c.sma50, bar)
  const saat = dizi(c.localHour, bar)
  const gun = dizi(c.localDow, bar)

  const zoneTop = +touch.zoneTop
  const zoneBottom = +touch.zoneBottom
  const maxScore = +touch.maxScore
  const parts = touch.parts || {}

  const bull = dizi(c.bullTrend, bar)
  const bear = dizi(c.bearTrend, bar)

  // Olay turu: kutunun DOGDUGU an mi, geri donup DOKUNDUGU an mi. Benzerlik
  // motoru zaten turleri birbirine karsi eslestirmiyor (bkz. similarity.knn
  // `kind` filtresi), bu boyut yine de kume ve prototip katmaninda iki grubu
  // ayirt edilebilir tutuyor.
  const form = touch.kind === 'form' ? 1 : 0

  out[0] = rsi / 100
  out[1] = price > 0 && atrVar ? Math.min((atr / price) * 100, 1) : 0
  out[2] = atrVar ? kirp((price - sma20) / atr, -5, 5) / 5 : 0
  out[3] = atrVar ? kirp((price - sma50) / atr, -5, 5) / 5 : 0
  out[4] = Math.sin((IKI_PI * saat) / 24)
  out[5] = Math.cos((IKI_PI * saat) / 24)
  out[6] = Math.sin((IKI_PI * gun) / 7)
  out[7] = Math.cos((IKI_PI * gun) / 7)
  out[8] = atrVar ? kirp((zoneTop - zoneBottom) / atr, 0, 5) / 5 : 0
  out[9] = Math.min(Math.max(+touch.zoneAgeBars, 0) / 120, 1)
  // Flow skoru Pine'da 1..10 arasindadir, olcek tam bu araliktan gelir.
  out[10] = kirp(+touch.zoneFlow, 0, 10) / 10
  out[11] = kirp(+touch.penetration, 0, 1)
  out[12] = maxScore > 0 ? +touch.score / maxScore : 0
  out[13] = parts.flow ? 1 : 0
  out[14] = parts.trend ? 1 : 0
  out[15] = parts.session ? 1 : 0
  out[16] = parts.rejection ? 1 : 0
  out[17] = parts.volume ? 1 : 0
  out[18] = touch.isSupport ? 1 : 0
  out[19] = bull ? 1 : (bear ? -1 : 0)
  out[20] = form
  // Pivotun Bollinger bandindan ne kadar disari tastigi: asiriligin derinligi.
  out[21] = kirp(+touch.bbDistAtr, 0, 3) / 3
  // Olay barinin hacim gucu (hacim / hacim ortalamasi), 3 kati tavan sayilir.
  out[22] = kirp(+touch.volRatio, 0, 3) / 3
  // Kapanisin bolgenin yakin kenarindan uzakligi. Form olayinda fiyatin
  // pivottan ne kadar kactigini olcer, temas olayinda sifira yakindir.
  out[23] = kirp(+touch.entryDistAtr, 0, 5) / 5

  // Sozlesme geregi tum baglam degerleri sonlu olmali.
  for (let i = 0; i < CTX_LEN; i++) {
    if (!Number.isFinite(out[i])) out[i] = 0
  }
  return out
}

/** Dokunustaki ATR, yoksa baglam dizisindeki ATR. */
function atrSec (touch, c, bar) {
  const a = +touch.atr
  if (Number.isFinite(a) && a > 0) return a
  const b = c.atr ? +c.atr[bar] : NaN
  return Number.isFinite(b) && b > 0 ? b : 0
}

/** Dizi degerini sonlu sayi olarak okur, yoksa 0 doner. */
function dizi (arr, i) {
  if (!arr) return 0
  const v = +arr[i]
  return Number.isFinite(v) ? v : 0
}

/** Degeri [lo, hi] araligina kirpar, NaN icin lo doner. */
function kirp (x, lo, hi) {
  if (!Number.isFinite(x)) return lo
  return x < lo ? lo : (x > hi ? hi : x)
}

/** Bir kaydin duz satir uzunlugu: shape + ret + ctx. */
function rowLength () {
  return ROW_LEN
}

/**
 * Ozellikleri duz bir Float32Array'e yazar.
 * Satir duzeni: [shape(16), ret(32), ctx(CTX_LEN)].
 * @param {{shape: Float32Array, ret: Float32Array, ctx: Float32Array}} features
 * @param {Float32Array} out
 * @param {number} offset
 * @returns {number} Bir sonraki satirin baslangic ofseti
 */
function packRow (features, out, offset) {
  const o = offset | 0
  out.set(features.shape, o)
  out.set(features.ret, o + SHAPE_LEN)
  out.set(features.ctx, o + SHAPE_LEN + RET_LEN)
  return o + ROW_LEN
}

/**
 * Duz satirdan Features nesnesini geri kurar.
 * @param {Float32Array} buf
 * @param {number} offset
 * @returns {{shape: Float32Array, ret: Float32Array, ctx: Float32Array}}
 */
function unpackRow (buf, offset) {
  const o = offset | 0
  return {
    shape: buf.slice(o, o + SHAPE_LEN),
    ret: buf.slice(o + SHAPE_LEN, o + SHAPE_LEN + RET_LEN),
    ctx: buf.slice(o + SHAPE_LEN + RET_LEN, o + ROW_LEN),
  }
}

module.exports = {
  FEATURE_VERSION,
  SHAPE_LEN,
  RET_LEN,
  WINDOW_BARS,
  CTX_NAMES,
  buildFeatures,
  SHAPE_WINDOW_VARSAYILAN,
  SHAPE_WINDOW_EN_AZ,
  SHAPE_WINDOW_EN_COK,
  sekilPenceresi,
  rowLength,
  packRow,
  unpackRow,
}
