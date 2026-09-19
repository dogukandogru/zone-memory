'use strict'

// A4 EK KILIT - "GELECEGI BOZ" TESTI (ileriye bakma sizintisi yok)
// ===========================================================================
// IDDIA: src/core/indicator/proZones.js hicbir olayi, o olayin KARAR BARINDAN
// SONRAKI barlara bakarak uretmez.
//
// Bu iddiayi tek tek gostergeleri okuyarak kanitlamak kirilgan: bugun nedensel
// olan bir hesap, yarin eklenen bir dizi yuzunden ileriye bakabilir. Bu yuzden
// kanit KARA KUTU olarak kuruluyor:
//
//   1. Sentetik bir seri uretilir (tohumlu sozde rastgele; Math.random YOK,
//      testin her kosuda ayni seriyi gormesi gerekir). Seri gercekten kutu
//      dogurur, kutuya dokunulur, kutu kirilir; bu once sayilarla dogrulanir
//      ki test bos bir listeyi karsilastirip "gecti" demesin.
//   2. Indikator calistirilir, olay listesi alinir.
//   3. Serinin K. barindan SONRASI bozulur: fiyatlar 10 katina cikarilir,
//      hacim baska bir olcege tasinir. Zaman damgalari ve bar sayisi AYNI
//      kalir, degisen tek sey GELECEKTIR.
//   4. Karar bari K'dan kucuk veya esit olan her olayin TUM alanlari (ic ice
//      `parts` nesnesi dahil) birebir ayni olmak zorundadir. Alan listesi ELLE
//      YAZILMAZ, kayittan turetilir: boylece indikatore yarin eklenen bir olay
//      alani kendiliginden kilidin altina girer.
//
// ---------------------------------------------------------------------------
// K NASIL SECILIR: TEK BARLIK SIZINTI ANCAK K = KARAR BARI ISE GORUNUR
// ---------------------------------------------------------------------------
// Bu testin ilk hali uc sabit K degeri kullaniyordu ve OLCULDU: `close[i]`
// yerine `close[i + 1]` okuyan kasitli bir sizinti bu haliyle YAKALANMIYOR.
// Sebebi basit: K = 540 iken 300. bardaki olay 301. bari okusa bile 301 hala
// bozulmamis bolgededir. Bir barlik ileriye bakmanin gorunur oldugu tek yer
// K'nin TAM OLARAK o olayin karar barina esit oldugu kosudur.
//
// Bu yuzden asil kilit, K'yi her olayin (ve her kutunun) KENDI karar barina
// esitleyerek tarar. Sabit uc K degeri de ayri bir testte duruyor, cunku onlar
// "K ile karar bari arasinda uzun bir gelecek var" halini olcer.
//
// ---------------------------------------------------------------------------
// KARSILASTIRMAYA GIRMEYEN ALANLAR VE NEDENLERI
// ---------------------------------------------------------------------------
// OLAY kaydinda: hicbiri. Su anda olay kaydinin tek bir alani bile disarida
// birakilmiyor, cunku runIndicator SONUC (outcome) alani uretmiyor; sonuc
// etiketleme ayri bir katmandir (src/core/learn/). Yine de ileride olay
// kaydina sonuc alani eklenirse bu test HAKLI OLARAK kirmizi yanmasin diye
// adlar GELECEGE_BAKAN_OLAY_ALANLARI kumesinde duruyor: outcome / win /
// mfeAtr gibi alanlar tanim geregi karar barindan SONRAKI barlardan olculur.
// Kumenin bugun BOS KESISTIGI de ayrica dogrulaniyor, yoksa yanlislikla
// gercek bir alani susturmus olabiliriz.
//
// BOLGE kaydinda: bir kutu karar barindan sonra yasamaya devam eder, bu yuzden
// asagidaki alanlar gelecege BAGLIDIR ve dogum karsilastirmasina girmez:
//   endBar, endTime            kutunun takipten dustugu bar (K'dan sonra olur)
//   broken, brokenBar,
//   brokenTime                 kirilma K'dan sonra olabilir
//   top, bottom                birlesme K'dan sonra kutuyu genisletebilir
//   flow, mergeCount,
//   touchCount                 dokunus ve birlesme ile K'dan sonra artar
// Bunun yerine iki kilit kuruluyor:
//   (a) DOGUM alanlari (id, isSupport, createdBar, createdTime, pivotBar,
//       pivotTime, flowAtBirth, bbDistAtr) K'dan once dogan her kutuda aynidir.
//   (b) K'dan once KIRILMIS bir kutunun butun yasami K'dan once bittigi icin
//       o kutunun TUM alanlari (yukaridakiler dahil) aynidir.

const test = require('node:test')
const assert = require('node:assert/strict')

const { runIndicator } = require('../src/core/indicator/proZones')
const series = require('../src/core/series')

const T0 = 1704067200   // 2024-01-01 00:00:00 UTC
const ADIM = 900        // 15 dakika
const BAR = 1200
const TOHUM = 12345
// Karar barindan UZAK K degerleri: "gelecegin cok ilerisi" halini olcer.
const SABIT_K = [230, 540, 870]

/** Deterministik PRNG (mulberry32). Math.random KULLANILMAZ. */
function prng (tohum) {
  let a = tohum >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Kutu dogurabilen sentetik seri: rastgele yuruyus + duzenli araliklarla derin
 * fitil ve hacim patlamasi. Fitil, Bollinger bandini asacak kadar derin (bant
 * kapisi) ve hacim ortalamanin bes katindan fazla (hacim kapisi), yani her
 * sivri uc bir kutu adayi uretir. Yon sirayla dip ve tepe olur ki hem destek
 * hem direnc kutusu dogsun.
 * @param {number} n
 * @param {number} tohum
 * @returns {{time:number[],open:number[],high:number[],low:number[],close:number[],volume:number[]}}
 */
function sentetikDiziler (n, tohum) {
  const r = prng(tohum)
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  let fiyat = 2000
  for (let i = 0; i < n; i++) {
    const o = fiyat
    const c = o + (r() - 0.5) * 10
    let h = Math.max(o, c) + r() * 2
    let l = Math.min(o, c) - r() * 2
    let v = 80 + r() * 40
    if (i % 23 === 11) {
      if (((i / 23) | 0) % 2 === 0) l -= 22 + r() * 12
      else h += 22 + r() * 12
      v = 500 + r() * 300
    }
    d.time[i] = T0 + i * ADIM
    d.open[i] = o
    d.high[i] = h
    d.low[i] = l
    d.close[i] = c
    d.volume[i] = v
    fiyat = c
  }
  return d
}

/**
 * K'dan SONRAKI barlari taninmayacak kadar bozar. Zaman damgalari ve bar
 * sayisi degismez: degisen tek sey gelecekteki fiyat ve hacimdir.
 * @param {object} d
 * @param {number} K
 * @returns {object} yeni (bozulmus) dizi kumesi
 */
function gelecegiBoz (d, K) {
  const n = d.time.length
  const out = {
    time: d.time.slice(), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  for (let i = 0; i < n; i++) {
    if (i <= K) {
      out.open[i] = d.open[i]
      out.high[i] = d.high[i]
      out.low[i] = d.low[i]
      out.close[i] = d.close[i]
      out.volume[i] = d.volume[i]
      continue
    }
    // Fiyat on kati ve kaydirilmis, bar sekli bozulmus, hacim bambaska bir
    // olcekte. Bir barlik ileriye bakma bile bu degerlerle hemen belli olur.
    out.open[i] = d.open[i] * 10
    out.high[i] = d.high[i] * 10 + 500
    out.low[i] = d.low[i] * 10 - 500
    out.close[i] = d.close[i] * 10 - 250
    out.volume[i] = d.volume[i] * 37 + 1
  }
  return out
}

/** Iki degerin NaN'i NaN'a esit sayan karsilastirmasi. */
function ayniDeger (a, b) {
  if (a === b) return true
  return typeof a === 'number' && typeof b === 'number' &&
    Number.isNaN(a) && Number.isNaN(b)
}

/**
 * Kaydi "alan yolu -> deger" duz haritasina cevirir. Ic ice nesneler
 * `parts.flow` gibi noktali yol alir; boylece alan listesi elle tutulmaz.
 * @param {object} obj
 * @param {string} [onEk]
 * @param {Map<string, any>} [out]
 * @returns {Map<string, any>}
 */
function duzlestir (obj, onEk, out) {
  const harita = out || new Map()
  for (const k of Object.keys(obj)) {
    const yol = onEk ? onEk + '.' + k : k
    const v = obj[k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      duzlestir(v, yol, harita)
    } else {
      harita.set(yol, v)
    }
  }
  return harita
}

// Karar barindan SONRAKI barlardan olculen (yani tanim geregi ileriye bakan)
// olay alanlari. Bugun runIndicator bunlarin hicbirini uretmiyor, liste ileri
// donuk bir emniyet valfidir.
const GELECEGE_BAKAN_OLAY_ALANLARI = new Set([
  'outcome', 'win', 'loss', 'mfeAtr', 'maeAtr', 'mfe', 'mae',
  'barsToOutcome', 'exitBar', 'exitTime', 'exitPrice', 'rMultiple', 'label',
])

// Kutunun DOGUMUNDA kesinlesen, bir daha yazilmayan alanlar.
const BOLGE_DOGUM_ALANLARI = ['id', 'isSupport', 'createdBar', 'createdTime',
  'pivotBar', 'pivotTime', 'flowAtBirth', 'bbDistAtr']

// Kutunun karar barindan SONRA degismeye devam eden alanlari (gerekceleri
// dosya basindaki yorumda).
const GELECEGE_BAGLI_BOLGE_ALANLARI = new Set([
  'endBar', 'endTime', 'broken', 'brokenBar', 'brokenTime',
  'top', 'bottom', 'flow', 'mergeCount', 'touchCount',
])

/** Olayin hata mesajinda kullanilacak kimligi. */
function olayKimligi (e) {
  return 'olay#' + e.id + ' (kind=' + e.kind + ', zoneId=' + e.zoneId +
    ', bar=' + e.bar + ', time=' + e.time + ')'
}

/** Seriyi calistirip sonucu doner. */
function kosu (d) {
  return runIndicator(series.fromArrays(d), {}, ADIM)
}

/**
 * K icin butun kilitleri uygular. Ilk fark bulundugunda olayin kimligi, alan
 * adi ve iki deger hata mesajina yazilir.
 * @param {number} K
 * @param {object} temizD ham diziler
 * @param {object} temiz temiz kosunun sonucu
 * @returns {{olay:number, dogum:number, kirik:number}} karsilastirilan adetler
 */
function kilitleriUygula (K, temizD, temiz) {
  const bozukD = gelecegiBoz(temizD, K)
  // Bozma gercekten olmus mu (test kendini kandirmasin).
  assert.equal(bozukD.close[K], temizD.close[K], 'K. bar bozulmamali')
  assert.notEqual(bozukD.close[K + 1], temizD.close[K + 1], 'K+1. bar bozulmali')
  const bozuk = kosu(bozukD)

  // --- 1. OLAYLAR: K ve oncesindeki her olayin TUM alanlari ----------------
  const a = temiz.touches.filter((e) => e.bar <= K)
  const b = bozuk.touches.filter((e) => e.bar <= K)
  assert.equal(b.length, a.length,
    'K=' + K + ': K ve oncesindeki olay SAYISI degisti (' + a.length + ' -> ' + b.length + ')')

  for (let i = 0; i < a.length; i++) {
    const ae = a[i]
    const am = duzlestir(ae)
    const bm = duzlestir(b[i])
    assert.deepEqual(Array.from(bm.keys()), Array.from(am.keys()),
      'K=' + K + ': ' + olayKimligi(ae) + ' alan kumesi degisti')
    for (const [yol, deger] of am) {
      if (GELECEGE_BAKAN_OLAY_ALANLARI.has(yol)) continue
      const bozukDeger = bm.get(yol)
      assert.ok(ayniDeger(deger, bozukDeger),
        'ILERIYE BAKMA SIZINTISI. K=' + K + ', ' + olayKimligi(ae) +
        ', alan "' + yol + '": temiz seride ' + String(deger) +
        ', gelecegi bozulmus seride ' + String(bozukDeger))
    }
  }

  const bozukBolge = new Map(bozuk.zones.map((z) => [z.id, z]))

  // --- 2. BOLGE DOGUM ALANLARI --------------------------------------------
  let dogum = 0
  for (const z of temiz.zones) {
    if (z.createdBar > K) continue
    dogum++
    const bz = bozukBolge.get(z.id)
    assert.ok(bz !== undefined, 'K=' + K + ': bolge#' + z.id + ' bozuk kosuda yok')
    for (const alan of BOLGE_DOGUM_ALANLARI) {
      assert.ok(ayniDeger(z[alan], bz[alan]),
        'ILERIYE BAKMA SIZINTISI. K=' + K + ', bolge#' + z.id +
        ' (pivotBar=' + z.pivotBar + '), alan "' + alan + '": temiz ' +
        String(z[alan]) + ', bozuk ' + String(bz[alan]))
    }
  }

  // --- 3. K'DAN ONCE KIRILMIS KUTULARIN TUM ALANLARI ----------------------
  // Kirilma kutuyu takipten dusurur: brokenBar <= K ise kutunun butun yasami
  // K'dan once bitmistir, endBar/endTime/flow dahil her sey sabit olmali.
  let kirik = 0
  for (const z of temiz.zones) {
    if (!z.broken || z.brokenBar < 0 || z.brokenBar > K) continue
    kirik++
    const bz = bozukBolge.get(z.id)
    assert.ok(bz !== undefined, 'K=' + K + ': kirilmis bolge#' + z.id + ' bozuk kosuda yok')
    const am = duzlestir(z)
    const bm = duzlestir(bz)
    for (const [yol, deger] of am) {
      assert.ok(ayniDeger(deger, bm.get(yol)),
        'ILERIYE BAKMA SIZINTISI. K=' + K + ', kirilmis bolge#' + z.id +
        ' (brokenBar=' + z.brokenBar + '), alan "' + yol + '": temiz ' +
        String(deger) + ', bozuk ' + String(bm.get(yol)))
    }
  }

  return { olay: a.length, dogum: dogum, kirik: kirik }
}

// ---------------------------------------------------------------------------
// 1. ADIM: seri gercekten olay uretiyor mu
// ---------------------------------------------------------------------------

test('sentetik seri gercekten kutu dogurur, dokundurur ve kirar', () => {
  const s = series.fromArrays(sentetikDiziler(BAR, TOHUM))
  const r = runIndicator(s, {}, ADIM)

  assert.equal(s.length, BAR)
  // Test bos liste karsilastirip "gecti" demesin: sayilar yazdirilir.
  console.log('[leak] bar=%d zonesCreated=%d zonesMerged=%d zonesBroken=%d ' +
    'formEvents=%d touchEvents=%d toplamOlay=%d',
  r.stats.bars, r.stats.zonesCreated, r.stats.zonesMerged, r.stats.zonesBroken,
  r.stats.formEvents, r.stats.touchEvents, r.touches.length)

  assert.ok(r.stats.zonesCreated >= 20, 'en az 20 kutu dogmali: ' + r.stats.zonesCreated)
  assert.ok(r.stats.zonesMerged >= 1, 'en az bir birlesme olmali: ' + r.stats.zonesMerged)
  assert.ok(r.stats.zonesBroken >= 3, 'en az uc kutu kirilmali: ' + r.stats.zonesBroken)
  assert.ok(r.stats.formEvents >= 10, 'form olayi uretilmeli: ' + r.stats.formEvents)
  assert.ok(r.stats.touchEvents >= 5, 'dokunus olayi uretilmeli: ' + r.stats.touchEvents)

  // Her sabit K degerinde karsilastirilacak olay var mi.
  for (const K of SABIT_K) {
    const adet = r.touches.filter((e) => e.bar <= K).length
    assert.ok(adet >= 5, 'K=' + K + ' icin en az bes olay beklenir, bulunan ' + adet)
  }
})

test('olay kaydinda gelecege bakan (sonuc) alani YOK, kilit tum alanlari kapsar', () => {
  const temiz = kosu(sentetikDiziler(BAR, TOHUM))
  assert.ok(temiz.touches.length > 0)

  const alanlar = duzlestir(temiz.touches[0])
  // Kilit bosa donmesin: kayit gercekten zengin olmali.
  assert.ok(alanlar.size >= 20, 'olay kaydinda en az 20 alan beklenir: ' + alanlar.size)

  const disarida = []
  for (const yol of alanlar.keys()) {
    if (GELECEGE_BAKAN_OLAY_ALANLARI.has(yol)) disarida.push(yol)
  }
  assert.deepEqual(disarida, [],
    'olay kaydinda sonuc alani gorundu, karsilastirmadan dusuruldu: ' + disarida.join(', '))

  // Bolge kaydinin her alani ya DOGUM ya da GELECEGE BAGLI olarak
  // siniflandirilmis olmali; yeni bir alan eklenirse burada yakalanir.
  for (const alan of Object.keys(temiz.zones[0])) {
    assert.ok(BOLGE_DOGUM_ALANLARI.includes(alan) || GELECEGE_BAGLI_BOLGE_ALANLARI.has(alan),
      'bolge kaydina yeni alan eklenmis, siniflandirilmali: ' + alan)
  }
})

// ---------------------------------------------------------------------------
// 2. ADIM: gelecegi boz, gecmis degismesin
// ---------------------------------------------------------------------------

test('uc farkli K icin: gelecegi bozmak K ve oncesindeki olaylari degistirmez', () => {
  const temizD = sentetikDiziler(BAR, TOHUM)
  const temiz = kosu(temizD)

  for (const K of SABIT_K) {
    const sayim = kilitleriUygula(K, temizD, temiz)
    assert.ok(sayim.olay >= 5, 'K=' + K + ': karsilastirilan olay az (' + sayim.olay + ')')
    assert.ok(sayim.dogum >= 5, 'K=' + K + ': karsilastirilan kutu az (' + sayim.dogum + ')')

    // Bozma gercekten HISSEDILIYOR mu: K'dan SONRAKI olaylar degismis olmali,
    // yoksa test hicbir sey olcmuyor olabilir.
    const bozuk = kosu(gelecegiBoz(temizD, K))
    const imza = (r) => r.touches.filter((e) => e.bar > K)
      .map((e) => e.bar + ':' + e.kind + ':' + e.price).join('|')
    assert.notEqual(imza(bozuk), imza(temiz),
      'K=' + K + ': bozma K sonrasini da degistirmedi, seri yeterince bozulmamis')
  }
})

test('K her karar barina esitlenerek taranir: TEK barlik ileriye bakma da yakalanir', () => {
  const temizD = sentetikDiziler(BAR, TOHUM)
  const temiz = kosu(temizD)

  // K adaylari: her olayin bari, her kutunun dogum bari ve her kirilma bari.
  // K = karar bari oldugunda "bir sonraki bar" zaten bozulmus bolgededir.
  const adaylar = new Set()
  for (const e of temiz.touches) adaylar.add(e.bar)
  for (const z of temiz.zones) {
    adaylar.add(z.createdBar)
    if (z.broken && z.brokenBar >= 0) adaylar.add(z.brokenBar)
  }
  // Son bar bozulacak bir gelecek birakmaz, disarida kalir.
  const kList = Array.from(adaylar).filter((k) => k >= 0 && k < BAR - 1).sort((x, y) => x - y)
  assert.ok(kList.length >= 30, 'taranacak karar bari sayisi az: ' + kList.length)

  let olayToplam = 0
  let kirikToplam = 0
  for (const K of kList) {
    const sayim = kilitleriUygula(K, temizD, temiz)
    olayToplam += sayim.olay
    kirikToplam += sayim.kirik
  }
  console.log('[leak] K taramasi: %d karar bari, %d olay-alan karsilastirmasi, ' +
    '%d kirilmis kutu tam karsilastirmasi', kList.length, olayToplam, kirikToplam)
  assert.ok(olayToplam > 0)
  assert.ok(kirikToplam >= 3, 'K oncesi kirilan kutu bulunamadi, kilit bos kaldi: ' + kirikToplam)
})
