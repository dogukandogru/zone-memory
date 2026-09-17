'use strict'

/**
 * Olay etiketleme (A4).
 *
 * Bir bolge olayinin, bolgeye saygi gosterilip gosterilmedigini ileri barlara
 * bakarak etiketler. Destek olayi BUY, direnc olayi SELL yonundedir.
 *
 * ----------------------------------------------------------------------------
 * IKI OLAY TURU
 * ----------------------------------------------------------------------------
 * proZones indikatoru iki tur olay uretir ve girisleri farklidir:
 *
 *   kind = 'touch'  Fiyat bolgeye geri donup dokundu. Giris, bolgenin YAKIN
 *                   kenarina limit emirdir (entryMode = 'zoneEdge'): dokunus
 *                   tanimi geregi fiyat o kenari gecmistir, yani emir dolar.
 *
 *   kind = 'form'   Kutu yeni dogdu, fiyat kutunun icinde DEGIL. Kenara limit
 *                   emir konamaz (fiyat oraya donmeyebilir), bu yuzden giris
 *                   onay barinin KAPANISIDIR. Gecersizlik yine bolgenin UZAK
 *                   kenaridir: kutu kirilirsa fikir olmustur. Hedef girise
 *                   targetAtr kadar uzaktir.
 *
 * Form olayinda risk, kapanis ile uzak kenar arasindaki mesafedir; bu mesafe
 * dokunus olayindakinden buyuktur ve kurulumdan kuruluma degisir. Bu kasitlidir:
 * fiyat pivottan ne kadar kactiysa risk o kadar buyuktur ve sinyal katmanindaki
 * beklenen deger filtresi (minExpectancy) bunu dogrudan cezalandirir.
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
 * ESKI INDIKATORLE (MASTER 1 TOUCH, kaldirilan masterTouch.js) olculen ham
 * oranlar. Bu sayilar YENI indikator ("proje son versiyon 3") icin
 * DOGRULANMIS DEGILDIR; yontem tekrarlanabilir, sayilar tasinamaz. Yeni
 * indikatorun gercek olcumu README 1. bolumdeki tablodadir.
 *   XAUUSD 2009-2026, ilk dokunuslar:
 *   15m  atr modu %48.0  |  zone modu (hedef 1.0, tampon 0.25) %48.1
 *   5m   atr modu %50.4  |  zone modu (hedef 1.0, tampon 0.25) %53.5
 * O olcumden cikan ve modu secerken hala gecerli olan gozlem su: iki mod da
 * dengeli sinif dagilimi verir, bu ogrenme icin iyidir, cunku %65/%35 gibi
 * carpik bir dagilimda model tembellesip hep cogunlugu soyler.
 *
 * Ufuk uzunlugu ESKI indikatorde bolge modunda neredeyse etkisizdi (24 bar
 * ile 96 bar ayni sonucu veriyordu), cunku bolge siniri yakin oldugu icin
 * sonuc hizla belli oluyordu. Yeni indikatorde bu OLCULMEDI. Varsayilan ufuk
 * yine 48 bardir ve bu tercihin gerekcesi olcumden bagimsizdir: serinin
 * sonuna daha yakin olaylar da etiketlenebilir, yani hafiza daha guncel kalir.
 *
 * Referans: ../indicator2/backend/app/services/outcomes.py
 * Fark: burada ATR disaridan verilir (indikator zaten hesapliyor), boylece her
 * dokunus icin ATR yeniden hesaplanmaz.
 */

/** Varsayilan etiketleme ayarlari. */
const DEFAULT_OUTCOME_CFG = {
  mode: 'zone',
  horizonBars: 48,
  // DOKUNUS OLAYINDA GIRIS MODELI
  // 'afterClose' (VARSAYILAN): karar dokunus barinin KAPANISINDA verilir,
  //   giris o kapanistan SONRA gelir. Kapanis kenarin lehte tarafindaysa
  //   bir sonraki bardan itibaren kenara limit emir konur (dolum kosulu
  //   fiyatin kenari fillOffsetAtr * ATR kadar gecmesi); kapanis bolgenin
  //   icindeyse kapanistan girilir; kapanis gecersizligin otesindeyse olay
  //   islem uretmez.
  // 'zoneEdge' (ESKI): giris dokunus barinin ICINDE kenardan dolmus sayilir.
  //   Bu, bar ici ILERIYE BAKMA idi: karar bar kapanisindaki bilgiyle
  //   (fitil reddi, penetration, hacim) veriliyor ama giris o bilgi
  //   olusmadan onceki bir fiyattan yaziliyordu. Olculdu: 5m fitil reddi
  //   alt kumesi bu modelde %58.4 isabet / +0.490 ATR, gerceklestirilebilir
  //   modelde %30.9 / -0.117 ATR. Karsilastirma icin korundu.
  touchEntryMode: 'afterClose',
  // Limit emrin dolmus sayilmasi icin fiyatin kenari gecmesi gereken pay.
  fillOffsetAtr: 0.05,
  // 'zone' modu.
  // targetAtr varsayilani 1 DAKIKALIK grafik icin secildi.
  //
  // DIKKAT: asagidaki sayilar ESKI INDIKATORLE (MASTER 1 TOUCH) olculdu ve
  // YENI indikator icin dogrulanmadi. Yontem (ayar donemi 2009-2018 /
  // dogrulama donemi 2019-2026, kenardan giris, minSim 0.80, minEslesme 15,
  // minBasari 0.62) aynen tekrarlanabilir; sayilar tasinamaz. Yeni
  // indikatorun gercek olcumu README 1. bolumdedir ve hicbir zaman diliminde
  // kanitlanmis katma deger gostermiyor.
  //   1m,  hedef 1.0 -> taban %52.4, sistem %72.0, kar faktoru 2.10 (n=478)
  //   5m,  hedef 1.5 -> taban %43.2, sistem %60.2, kar faktoru 1.68 (n=93)
  //   5m,  hedef 1.0 -> taban %52.0, sistem %57.5, kar faktoru 1.06 (n=87)
  // Bundan cikarilan kural (olcumden bagimsiz, geometrik gerekce): daha uzun
  // zaman diliminde hedefi buyutmek gerekir, cunku bolge genisligi ATR'ye
  // gore buyudugu icin 1.0 ATR hedef yeterli risk/odul birakmaz. Hazir
  // ayarlar (presets.js) bu yuzden 5m ve uzerinde hedefi 1.5'e cikarir;
  // o degerler de yeni indikator icin yeniden aranmalidir.
  targetAtr: 1.0,
  breakBufferAtr: 0.25,
  minTargetAtr: 0.25,
  // ESKI giris secimi. Artik dokunus olayinin girisini `touchEntryMode`
  // belirler (yukariya bakin); bu alan yalnizca `'close'` verilirse baglayici
  // olur ve dokunus olayinda da kapanistan girilir.
  //
  // Neden kapanistan giris tercih edilmiyor: kapanis girisi risk/odulu
  // kapanisin bolge icindeki konumuna baglar ve TERS SECIM yaratir. Kapanis
  // bolge dibine yakinsa stop 0.25 ATR kadar yakin olur, risk/odul 8'e cikar
  // ama gurultu stop'u aninda vurur. ESKI INDIKATORLE olculmustu (15m):
  // risk/odul kapisi bu yuzden isabet oranini %52'den %25'e dusuruyordu. Bu
  // sayi YENI indikator icin dogrulanmadi; ters secim gerekcesi ise
  // geometriktir ve olcumden bagimsiz gecerlidir. Yeni indikatorun gercek
  // olcumu icin README 1. bolume bakin.
  entryMode: 'zoneEdge',
  // KUTU OLUSUM (kind = 'form') OLAYLARINDA HEDEF
  // ---------------------------------------------------------------------
  // Dokunus olayinda risk sabittir: giris bolgenin kenari, gecersizlik uzak
  // kenar, yani risk her zaman bolge yuksekligi + tampon kadardir. Form
  // olayinda oyle degil: giris onay barinin kapanisidir ve fiyat pivottan ne
  // kadar kactiysa risk o kadar buyuktur. Hedef sabit bir ATR mesafesi olarak
  // birakilirsa risk/odul kurulumdan kuruluma 0.3 ile 2.0 arasinda savrulur ve
  // "gecmiste bu yapi %70 tuttu" cumlesi karsilastirilamaz seylerin ortalamasi
  // olur.
  //
  // Bu yuzden form olayinda hedef RISKIN KATI olarak konur: formTargetRr = 1.0,
  // hedef tam olarak bir risk birimi uzaktadir. Boylece tum form olaylari tek
  // eksende (isabet orani) karsilastirilabilir hale gelir, tipki dokunus
  // olaylarindaki sabit geometri gibi. Riski buyuk olan kurulumun hedefi de
  // uzaktir, yani vurulmasi zordur; ceza otomatik ve olculebilirdir.
  //
  // 0 yapilirsa form olayinda da sabit targetAtr mesafesi kullanilir.
  formTargetRr: 1.0,
  // Form olayinda kabul edilen azami risk, ATR biriminde. Pivot onaylanana
  // kadar fiyat cok uzaga kacmissa (sivri bir fitil dibi gibi) giris ile
  // gecersizlik arasi onlarca ATR olabilir. Boyle bir kurulum gercekte
  // islenmez; hafizaya girerse hem kendi istatistigini bozar hem de plan
  // hedeflerini sisirir. Bu esigi asan form olaylari ETIKETLENMEZ, yani
  // hafizaya hic girmez (istatistikte `noLabel` olarak sayilir).
  // 0 veya negatif verilirse sinir uygulanmaz.
  maxFormRiskAtr: 3.0,
  // 'atr' modu
  tpAtr: 1.0,
  slAtr: 1.0,
}

/**
 * Bir dokunus icin bolge tabanli hedef ve gecersizlik seviyelerini hesaplar.
 * Sinyal modulu de ayni seviyeleri kullanir, boylece etiket ile islem plani
 * birbirinden ayrismaz.
 *
 * @param {Object} touch  Olay (kind, zoneTop, zoneBottom, price, isSupport/direction)
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

  // Kutu olusum olayinda fiyat bolgenin icinde degildir, o yuzden kenara limit
  // emir konamaz: giris her zaman onay barinin kapanisidir.
  const form = touch.kind === 'form'
  // Bolgenin YAKIN kenari: destekte ust, dirençte alt.
  const edge = yukari ? zt : zb
  const kapanis = +touch.price

  // Gecersizlik: bolgenin UZAK kenarindan disari tasma.
  const invalid = yukari ? zb - bufferAtr * a : zt + bufferAtr * a

  // Dokunus olayinda giris modeli (bkz. DEFAULT_OUTCOME_CFG.touchEntryMode).
  let entryMode
  if (form) {
    entryMode = 'close'
  } else if (c.entryMode === 'close') {
    entryMode = 'close'
  } else if (c.touchEntryMode === 'zoneEdge') {
    entryMode = 'zoneEdge'
  } else {
    // 'afterClose': kararin verildigi kapanisin konumu belirler.
    if (!Number.isFinite(kapanis)) return null
    const kapanisLehte = yukari ? kapanis > edge : kapanis < edge
    const kapanisGecersiz = yukari ? kapanis <= invalid : kapanis >= invalid
    if (kapanisGecersiz) return null       // bolge o barda kirilmis, islem yok
    entryMode = kapanisLehte ? 'limitAfterClose' : 'close'
  }

  let entry
  if (entryMode === 'close') {
    entry = kapanis
    if (!Number.isFinite(entry)) return null
  } else {
    // Kenardan limit emir.
    entry = edge
  }

  // Giris zaten gecersizlik tarafindaysa ortada islem yoktur. Form olayinda
  // olabilir: pivot onaylanana kadar fiyat kutunun ta obur tarafina gecmis
  // olabilir. Boyle olaylar etiketlenmez, hafizaya girmez.
  if (!(sign * (entry - invalid) > 0)) return null

  // Hedef.
  //   dokunus : bolgenin YAKIN kenarindan targetAtr kadar uzakta (giris zaten
  //             kenarda oldugu icin odul tam targetAtr olur)
  //   form    : formTargetRr > 0 ise riskin kati kadar uzakta, degilse
  //             giristen targetAtr kadar uzakta
  // Taban, kapanis hedefin otesinde kaldiginda dejenere "aninda basarili"
  // durumunu engeller.
  const formRr = sayi(c.formTargetRr, DEFAULT_OUTCOME_CFG.formTargetRr)
  let target
  if (form) {
    target = formRr > 0
      ? entry + sign * formRr * Math.abs(entry - invalid)
      : entry + sign * targetAtr * a
  } else {
    target = yukari ? edge + targetAtr * a : edge - targetAtr * a
  }
  const taban = entry + sign * minTargetAtr * a
  target = yukari ? Math.max(target, taban) : Math.min(target, taban)

  const riskAtr = Math.abs(entry - invalid) / a

  // Fiyat pivottan cok kactiysa form kurulumu gercekte islenemez.
  if (form) {
    const maxRisk = sayi(c.maxFormRiskAtr, DEFAULT_OUTCOME_CFG.maxFormRiskAtr)
    if (maxRisk > 0 && riskAtr > maxRisk) return null
  }

  return {
    entry,
    target,
    invalid,
    sign,
    entryMode,
    riskAtr,
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
  let girisModu = 'close'
  if (mode === 'zone') {
    const lv = zoneLevels(touch, atr, Object.assign({}, c, { price: undefined }))
    if (!lv) return null
    entry = lv.entry
    hedef = lv.target
    gecersiz = lv.invalid
    girisModu = lv.entryMode
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
        resolvedBar: bar,
        atr,
        mode,
        entryPrice: entry,
        targetPrice: hedef,
        invalidPrice: gecersiz,
        exitPrice: gecersiz,
        realizedR: -1,
        riskAtr: Math.abs(entry - gecersiz) / atr,
        rewardAtr: Math.abs(hedef - entry) / atr,
      }
    }
  }

  const son = bar + horizonBars

  // LIMIT EMIR DOLUMU (dokunus, 'afterClose' modeli)
  // Karar bar kapanisinda verildigi icin emir en erken BIR SONRAKI barda
  // dolar. Dolum kosulu, fiyatin kenari fillOffsetAtr * ATR kadar gecmesidir
  // (kenara tam degen fiyat gercekte doldurmayabilir). Dolumdan once hedefe
  // gidilirse ya da ufuk boyunca dolum olmazsa sonuc 'nofill' olur: bu olay
  // hafizada kalir ama isabet oranina ve taban hesabina GIRMEZ.
  let dolumBar = bar
  if (girisModu === 'limitAfterClose') {
    const pay = sayi(c.fillOffsetAtr, DEFAULT_OUTCOME_CFG.fillOffsetAtr) * atr
    const dolumFiyati = yukari ? entry - pay : entry + pay
    let bulundu = -1
    let hedefOnce = false
    for (let i = bar + 1; i <= son; i++) {
      const h = +high[i]
      const l = +low[i]
      if (!Number.isFinite(h) || !Number.isFinite(l)) continue
      const doldu = yukari ? l <= dolumFiyati : h >= dolumFiyati
      if (doldu) { bulundu = i; break }
      // Dolmadan hedefe gidildiyse islem hic acilmadi.
      const hedefVurdu = yukari ? h >= hedef : l <= hedef
      if (hedefVurdu) { hedefOnce = true; break }
    }
    if (bulundu < 0) {
      const cikisNF = +close[son]
      return {
        outcome: 'nofill',
        success: false,
        filled: false,
        mfeAtr: 0,
        maeAtr: 0,
        mfeExitAtr: 0,
        maeExitAtr: 0,
        fwdReturnPct: Number.isFinite(cikisNF) ? (yon * (cikisNF - entry) / entry) * 100 : 0,
        barsToOutcome: -1,
        resolvedBar: son,
        atr,
        mode,
        entryMode: girisModu,
        entryPrice: entry,
        targetPrice: hedef,
        invalidPrice: gecersiz,
        exitPrice: entry,
        realizedR: 0,
        riskAtr: Math.abs(entry - gecersiz) / atr,
        rewardAtr: Math.abs(hedef - entry) / atr,
        missedTarget: hedefOnce,
      }
    }
    dolumBar = bulundu
    // Dolum barinda gecersizlik de gorulduyse bar ici sirayi bilemedigimiz
    // icin MUHAFAZAKAR davranilir: kirilma yazilir.
    const hd = +high[dolumBar]
    const ld = +low[dolumBar]
    const gecersizAyniBar = yukari
      ? (Number.isFinite(ld) && ld <= gecersiz)
      : (Number.isFinite(hd) && hd >= gecersiz)
    if (gecersizAyniBar) {
      const cikisD = +close[son]
      return {
        outcome: 'break',
        success: false,
        filled: true,
        mfeAtr: 0,
        maeAtr: Math.abs(entry - gecersiz) / atr,
        mfeExitAtr: 0,
        maeExitAtr: Math.abs(entry - gecersiz) / atr,
        fwdReturnPct: Number.isFinite(cikisD) ? (yon * (cikisD - entry) / entry) * 100 : 0,
        barsToOutcome: dolumBar - bar,
        resolvedBar: dolumBar,
        atr,
        mode,
        entryMode: girisModu,
        entryPrice: entry,
        targetPrice: hedef,
        invalidPrice: gecersiz,
        exitPrice: gecersiz,
        realizedR: -1,
        riskAtr: Math.abs(entry - gecersiz) / atr,
        rewardAtr: Math.abs(hedef - entry) / atr,
      }
    }
  }

  let enIyi = 0        // lehte azami hareket, fiyat biriminde, TUM ufuk
  let enKotu = 0       // aleyhte azami hareket, fiyat biriminde, TUM ufuk
  let enIyiCikis = 0   // lehte azami hareket, yalnizca SONUCA kadar
  let enKotuCikis = 0  // aleyhte azami hareket, yalnizca SONUCA kadar
  let sonucBar = -1
  let respect = false

  for (let i = dolumBar + 1; i <= son; i++) {
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

  // CIKIS FIYATI VE GERCEKLESEN R
  // Zaman asimina ugrayan islem bir donem TAM STOP ZARARI sayiliyordu. Formda
  // risk 1.2-2.8 ATR oldugu icin her timeout ortalama -2.5 ATR sahte zarar
  // yaziyordu; ufuk sonu kapanisindan degerlenince ortalama sifira yakin
  // (olculdu: 5m -0.018, 15m +0.043 ATR). Bu yuzden cikis fiyati ve risk
  // birimi cinsinden gerceklesen sonuc burada hesaplanir ve testte,
  // sinyalde, canli gunlukte hep AYNI tanim kullanilir.
  const riskAtrSon = Math.abs(entry - gecersiz) / atr
  const odulAtrSon = Math.abs(hedef - entry) / atr
  const cikisFiyati = outcome === 'respect' ? hedef : (outcome === 'break' ? gecersiz : cikis)
  let realizedR = 0
  if (outcome === 'respect') realizedR = riskAtrSon > 0 ? odulAtrSon / riskAtrSon : 0
  else if (outcome === 'break') realizedR = -1
  else if (Number.isFinite(cikis) && riskAtrSon > 0) {
    realizedR = (yon * (cikis - entry) / atr) / riskAtrSon
  }

  return {
    outcome,
    success: outcome === 'respect',
    mfeAtr: enIyi > 0 ? enIyi / atr : 0,
    maeAtr: enKotu > 0 ? enKotu / atr : 0,
    mfeExitAtr: enIyiCikis > 0 ? enIyiCikis / atr : 0,
    maeExitAtr: enKotuCikis > 0 ? enKotuCikis / atr : 0,
    fwdReturnPct,
    barsToOutcome: sonucBar === -1 ? -1 : sonucBar - bar,
    barsToFill: dolumBar - bar,
    // Sonucun BELLI OLDUGU bar. Ambargo bu bara gore isler: bir olay,
    // sonucu henuz cozulmemisken baska bir olaya komsu olamaz.
    resolvedBar: sonucBar === -1 ? son : sonucBar,
    atr,
    mode,
    entryMode: girisModu,
    filled: true,
    entryPrice: entry,
    targetPrice: hedef,
    invalidPrice: gecersiz,
    exitPrice: Number.isFinite(cikisFiyati) ? cikisFiyati : entry,
    realizedR: Number.isFinite(realizedR) ? realizedR : 0,
    riskAtr: riskAtrSon,
    rewardAtr: odulAtrSon,
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
