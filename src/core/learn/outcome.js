'use strict'

/**
 * Dokunus etiketleme (A4).
 *
 * Bir bolgeye yapilan ILK dokunusun, bolgeye saygi gosterilip gosterilmedigini
 * ileri barlara bakarak etiketler. Destek dokunusu BUY, direnc dokunusu SELL
 * yonundedir. Giris fiyati dokunus barinin kapanisidir.
 *
 * ----------------------------------------------------------------------------
 * IKI ETIKETLEME MODU
 * ----------------------------------------------------------------------------
 * 'zone' (VARSAYILAN)  Sorunun dogru karsiligi: BOLGE TUTTU MU?
 *   Basarisiz  : fiyat bolgenin UZAK kenarindan breakBufferAtr * ATR kadar
 *                disari tasarsa. Bolge kirilmistir, artik destek/direnc degildir.
 *   Basarili   : bolge kirilmadan, fiyat bolgenin YAKIN kenarindan
 *                targetAtr * ATR kadar uzaga giderse. Bolge fiyati itmistir.
 *   Bu tanimin onemi: ogrenilen sey ile islem plani AYNI seydir. Stop, bolgenin
 *   gecersizlik seviyesidir; hedef, bolgeden uzaklasmadir. Ayrica olcum
 *   dogrudan bolgeye baglidir, genel fiyat hareketine degil.
 *
 * 'atr'  Eski tanim: giris +- N * ATR. Bolgeden bagimsizdir, bu yuzden
 *   "bolge calisti mi" sorusunu OLCMEZ, genel fiyat hareketini olcer.
 *   Karsilastirma ve geriye donuk uyumluluk icin korundu.
 *
 * Gercek XAUUSD verisinde olculen ham oranlar (2009-2026, ilk dokunuslar):
 *   15m  atr modu %48.0  |  zone modu (hedef 1.0, tampon 0.25) %48.1
 *   5m   atr modu %50.4  |  zone modu (hedef 1.0, tampon 0.25) %53.5
 * Iki mod da dengeli sinif dagilimi verir; bu ogrenme icin iyidir, cunku
 * %65/%35 gibi carpik bir dagilimda model tembellesip hep cogunlugu soyler.
 *
 * Ufuk uzunlugu bolge modunda neredeyse etkisizdir (24 bar ile 96 bar ayni
 * sonucu verir), cunku bolge siniri yakin oldugu icin sonuc hizla belli olur.
 * Bu yuzden varsayilan ufuk 48 bardir: serinin sonuna daha yakin olaylar da
 * etiketlenebilir, yani hafiza daha guncel kalir.
 *
 * Referans: ../indicator2/backend/app/services/outcomes.py
 * Fark: burada ATR disaridan verilir (indikator zaten hesapliyor), boylece her
 * dokunus icin ATR yeniden hesaplanmaz.
 */

/** Varsayilan etiketleme ayarlari. */
const DEFAULT_OUTCOME_CFG = {
  mode: 'zone',
  horizonBars: 48,
  // 'zone' modu.
  // targetAtr varsayilani 1 DAKIKALIK grafik icin secildi (uygulamanin
  // varsayilan zaman dilimi). Ornek disi olculdu (ayar 2009-2018 / dogrulama
  // 2019-2026, kenardan giris, minSim 0.80 minEslesme 15 minBasari 0.62):
  //   1m,  hedef 1.0 -> taban %52.4, sistem %72.0, kar faktoru 2.10 (n=478)
  //   5m,  hedef 1.5 -> taban %43.2, sistem %60.2, kar faktoru 1.68 (n=93)
  //   5m,  hedef 1.0 -> taban %52.0, sistem %57.5, kar faktoru 1.06 (n=87)
  // Yani daha uzun zaman diliminde hedefi buyutmek gerekir: bolge genisligi
  // ATR'ye gore buyudugu icin 1.0 ATR hedef yeterli risk/odul vermiyor.
  // 5m veya 15m kullanacaksaniz Ayarlar ekranindan hedefi 1.5'e cikarin.
  targetAtr: 1.0,
  breakBufferAtr: 0.25,
  minTargetAtr: 0.25,
  // Giris modeli. 'zoneEdge' (varsayilan): bolgenin YAKIN kenarina limit emirle
  // girilir (destekte zoneTop, dirençte zoneBottom). Dokunus tanimi geregi fiyat
  // o kenari gecmistir, yani emir dolar.
  // 'close': dokunus barinin kapanisindan girilir (eski davranis).
  //
  // Neden degisti: kapanistan giris, risk/odulu kapanisin bolge icindeki
  // konumuna baglar ve TERS SECIM yaratir. Kapanis bolge dibine yakinsa stop
  // 0.25 ATR kadar yakin olur, risk/odul 8'e cikar ama gurultu stop'u aninda
  // vurur. Olculdu (15m): risk/odul kapisi bu yuzden isabet oranini %52'den
  // %25'e dusuruyordu. Kenardan giris ile risk ve odul yalnizca bolge
  // geometrisine baglidir, sabittir ve ters secim ortadan kalkar.
  entryMode: 'zoneEdge',
  // 'atr' modu
  tpAtr: 1.0,
  slAtr: 1.0,
}

/**
 * Bir dokunus icin bolge tabanli hedef ve gecersizlik seviyelerini hesaplar.
 * Sinyal modulu de ayni seviyeleri kullanir, boylece etiket ile islem plani
 * birbirinden ayrismaz.
 *
 * @param {Object} touch  Touch (zoneTop, zoneBottom, price, isSupport/direction)
 * @param {number} atr    Dokunus barindaki ATR
 * @param {Object} [cfg]
 * @returns {{entry:number, target:number, invalid:number, sign:number,
 *            riskAtr:number, rewardAtr:number}|null}
 */
function zoneLevels (touch, atr, cfg) {
  if (!touch) return null
  const c = Object.assign({}, DEFAULT_OUTCOME_CFG, cfg || {})
  const a = +atr
  if (!Number.isFinite(a) || a < 1e-12) return null

  const zt = +touch.zoneTop
  const zb = +touch.zoneBottom
  if (!Number.isFinite(zt) || !Number.isFinite(zb)) return null

  const yukari = touch.direction ? touch.direction === 'BUY' : !!touch.isSupport
  const sign = yukari ? 1 : -1

  const targetAtr = sayi(c.targetAtr, DEFAULT_OUTCOME_CFG.targetAtr)
  const bufferAtr = sayi(c.breakBufferAtr, DEFAULT_OUTCOME_CFG.breakBufferAtr)
  const minTargetAtr = sayi(c.minTargetAtr, DEFAULT_OUTCOME_CFG.minTargetAtr)
  const entryMode = c.entryMode === 'close' ? 'close' : 'zoneEdge'

  // Bolgenin YAKIN kenari: destekte ust, dirençte alt.
  const edge = yukari ? zt : zb

  let entry
  if (entryMode === 'close') {
    entry = +touch.price
    if (!Number.isFinite(entry)) return null
  } else {
    // Kenardan limit emir. Dokunus tanimi (low <= zoneTop && high >= zoneBottom)
    // geregi fiyat bu kenari gecmistir, yani emir dolar.
    entry = edge
  }

  // Gecersizlik: bolgenin UZAK kenarindan disari tasma.
  const invalid = yukari ? zb - bufferAtr * a : zt + bufferAtr * a

  // Hedef: bolgenin YAKIN kenarindan targetAtr kadar uzakta. Giris kenarda
  // oldugunda odul tam olarak targetAtr'dir. Giris kapanistan alindiginda ve
  // kapanis hedefin otesinde kaldiginda dejenere "aninda basarili" durumu
  // olusmasin diye taban konur.
  let target = yukari ? edge + targetAtr * a : edge - targetAtr * a
  const taban = entry + sign * minTargetAtr * a
  target = yukari ? Math.max(target, taban) : Math.min(target, taban)

  return {
    entry,
    target,
    invalid,
    sign,
    entryMode,
    riskAtr: Math.abs(entry - invalid) / a,
    rewardAtr: Math.abs(target - entry) / a,
  }
}

/**
 * Bir dokunusun bolgeye saygi gosterip gostermedigini etiketler.
 *
 * Her iki modda da MUHAFAZAKAR kural gecerlidir: ayni barda hem basarisizlik
 * hem basari kosulu saglanirsa BASARISIZ sayilir (bar ici sira bilinmez).
 *
 * mfeAtr / maeAtr ufkun TAMAMI uzerinden hesaplanir (ozellik olarak degerli).
 * mfeExitAtr / maeExitAtr ise yalnizca SONUCA KADAR olan kismi olcer; islem
 * plani hedefleri bunlardan turetilir, cunku stop vurulduktan sonraki hareket
 * gercekte yakalanamaz.
 *
 * @param {import('../series.js').Series|Object} s  Sutunsal mum serisi
 * @param {Object} touch                            Dokunus olayi
 * @param {number} atrAtTouch                       Dokunus barindaki ATR
 * @param {Object} [cfg]                            DEFAULT_OUTCOME_CFG uzerine yazilir
 * @returns {Object|null} Outcome, ileri veri yetmiyorsa null
 */
function labelTouch (s, touch, atrAtTouch, cfg) {
  if (!s || !touch) return null

  const c = Object.assign({}, DEFAULT_OUTCOME_CFG, cfg || {})
  const horizonBars = pozitifTamsayi(c.horizonBars, DEFAULT_OUTCOME_CFG.horizonBars)
  const mode = c.mode === 'atr' ? 'atr' : 'zone'

  const bar = touch.bar | 0
  const n = s.length | 0
  if (bar < 0 || bar >= n) return null

  // Ufkun tamami seride bulunmali, aksi halde etiketlenemez.
  if (bar + horizonBars >= n) return null

  const atr = +atrAtTouch
  if (!Number.isFinite(atr) || atr < 1e-12) return null

  const high = s.high
  const low = s.low
  const close = s.close

  const barKapanis = +close[bar]
  if (!Number.isFinite(barKapanis) || barKapanis === 0) return null

  // Destek dokunusu BUY (+1), direnc dokunusu SELL (-1).
  const yukari = touch.direction ? touch.direction === 'BUY' : !!touch.isSupport
  const yon = yukari ? 1 : -1

  // Basari ve basarisizlik seviyeleri moda gore belirlenir.
  let entry = barKapanis
  let hedef
  let gecersiz
  let kenardanGiris = false
  if (mode === 'zone') {
    const lv = zoneLevels(touch, atr, Object.assign({}, c, { price: undefined }))
    if (!lv) return null
    entry = lv.entry
    hedef = lv.target
    gecersiz = lv.invalid
    kenardanGiris = lv.entryMode === 'zoneEdge'
  } else {
    const tpAtr = sayi(c.tpAtr, DEFAULT_OUTCOME_CFG.tpAtr)
    const slAtr = sayi(c.slAtr, DEFAULT_OUTCOME_CFG.slAtr)
    hedef = entry + yon * tpAtr * atr
    gecersiz = entry - yon * slAtr * atr
  }
  if (!Number.isFinite(entry) || entry === 0) return null

  // Kenardan giriste emir DOKUNUS BARI icinde dolar. O bar gecersizlik
  // seviyesini de gordiyse, bar ici sirayi bilemedigimiz icin MUHAFAZAKAR
  // davranilir ve bolge kirilmis sayilir. Hedefe ayni barda ulasildigini ise
  // saymayiz: yuksek fiyat, dolum ANINDAN once olusmus olabilir.
  if (kenardanGiris) {
    const h0 = +high[bar]
    const l0 = +low[bar]
    const ilkGecersiz = yukari
      ? (Number.isFinite(l0) && l0 <= gecersiz)
      : (Number.isFinite(h0) && h0 >= gecersiz)
    if (ilkGecersiz) {
      const cikis0 = +close[bar + horizonBars]
      return {
        outcome: 'break',
        success: false,
        mfeAtr: 0,
        maeAtr: Math.abs(entry - gecersiz) / atr,
        mfeExitAtr: 0,
        maeExitAtr: Math.abs(entry - gecersiz) / atr,
        fwdReturnPct: Number.isFinite(cikis0) ? (yon * (cikis0 - entry) / entry) * 100 : 0,
        barsToOutcome: 0,
        atr,
        mode,
        entryPrice: entry,
        targetPrice: hedef,
        invalidPrice: gecersiz,
        riskAtr: Math.abs(entry - gecersiz) / atr,
        rewardAtr: Math.abs(hedef - entry) / atr,
      }
    }
  }

  const son = bar + horizonBars
  let enIyi = 0        // lehte azami hareket, fiyat biriminde, TUM ufuk
  let enKotu = 0       // aleyhte azami hareket, fiyat biriminde, TUM ufuk
  let enIyiCikis = 0   // lehte azami hareket, yalnizca SONUCA kadar
  let enKotuCikis = 0  // aleyhte azami hareket, yalnizca SONUCA kadar
  let sonucBar = -1
  let respect = false

  for (let i = bar + 1; i <= son; i++) {
    const h = +high[i]
    const l = +low[i]
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue

    // MFE/MAE ufkun tamami uzerinden birikir, erken cikista bile durmaz.
    const lehte = yukari ? h - entry : entry - l
    const aleyhte = yukari ? entry - l : h - entry
    if (lehte > enIyi) enIyi = lehte
    if (aleyhte > enKotu) enKotu = aleyhte

    if (sonucBar === -1) {
      if (lehte > enIyiCikis) enIyiCikis = lehte
      if (aleyhte > enKotuCikis) enKotuCikis = aleyhte

      const gecersizVurdu = yukari ? l <= gecersiz : h >= gecersiz
      const hedefVurdu = yukari ? h >= hedef : l <= hedef
      if (gecersizVurdu) {
        // Muhafazakar kural: ayni barda ikisi de vurulduysa basarisiz sayilir.
        sonucBar = i
        respect = false
      } else if (hedefVurdu) {
        sonucBar = i
        respect = true
      }
    }
  }

  const cikis = +close[son]
  const fwdReturnPct = Number.isFinite(cikis) ? (yon * (cikis - entry) / entry) * 100 : 0

  const outcome = sonucBar === -1 ? 'timeout' : (respect ? 'respect' : 'break')

  return {
    outcome,
    success: outcome === 'respect',
    mfeAtr: enIyi > 0 ? enIyi / atr : 0,
    maeAtr: enKotu > 0 ? enKotu / atr : 0,
    mfeExitAtr: enIyiCikis > 0 ? enIyiCikis / atr : 0,
    maeExitAtr: enKotuCikis > 0 ? enKotuCikis / atr : 0,
    fwdReturnPct,
    barsToOutcome: sonucBar === -1 ? -1 : sonucBar - bar,
    atr,
    mode,
    entryPrice: entry,
    targetPrice: hedef,
    invalidPrice: gecersiz,
    riskAtr: Math.abs(entry - gecersiz) / atr,
    rewardAtr: Math.abs(hedef - entry) / atr,
  }
}

/** Sonlu sayi degilse varsayilana duser. */
function sayi (v, varsayilan) {
  const x = +v
  return Number.isFinite(x) ? x : varsayilan
}

/** Pozitif tamsayi degilse varsayilana duser. */
function pozitifTamsayi (v, varsayilan) {
  const x = Math.trunc(+v)
  return Number.isFinite(x) && x >= 1 ? x : varsayilan
}

module.exports = {
  DEFAULT_OUTCOME_CFG,
  labelTouch,
  zoneLevels,
}
