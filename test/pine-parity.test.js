'use strict'

// ===========================================================================
// PINE PARITE TESTI
// ---------------------------------------------------------------------------
// src/core/indicator/proZones.js, TradingView Pine v6 indikatoru "proje son
// versiyon 3"un portudur (kaynagin tam metni: docs/pine/son_pro.pine). Butun
// hafiza ve istatistik, portun Pine ile AYNI kutulari urettigi varsayimina
// dayanir ama test/ altinda uzun sure hicbir referans yoktu: mevcut
// indicator.test.js yalnizca elle kurulmus sentetik seriler kullaniyor ve
// birlestirme kuralindaki bir fark (dongunun ilk eslesmede DURMAMASI, mesafenin
// O BARIN atr'si ile olculmesi) bu yuzden uzun sure fark edilmeden kalmisti.
//
// Bu dosya portu, Pine metninden BAGIMSIZ olarak yazilmis bir referansla
// (test/helpers/pineRef.js) karsilastirir. Referans porta bakilmadan yazildi;
// aksi halde ayni hata iki yerde tekrarlanir ve test hicbir sey kanitlamaz.
//
// Karsilastirilan: kutu SAYISI, sirayla her kutunun isSupport / top / bot /
// dogum bari / kirilma bari / bitis bari, kirilmis kutu sayisi, kutu basina
// dokunus sayisi ve flow skoru, ve ILK DOKUNUS olaylarinin bari.
//
// Seriler tohumlu bir sozde rastgele uretecle uretilir (Math.random YASAK,
// testin tekrarlanabilir olmasi gerekir), 0,01 tike yuvarlanir ve hacim tasir.
// ===========================================================================

const test = require('node:test')
const assert = require('node:assert/strict')

const { runIndicator } = require('../src/core/indicator/proZones')
const series = require('../src/core/series')
const { pineRef } = require('./helpers/pineRef')
// Deterministik mulberry32. fixtures.js'teki ortak uretec kullanilir: ucuncu
// bir kopya, tohumlu serilerin dosyaya gore degismesi riskini dogurur.
const { prng } = require('./helpers/fixtures')

const T0 = 1704067200   // 2024-01-01 00:00:00 UTC
const ADIM = 900        // 15 dakika
const TIK = 0.01        // XAUUSD tik adimi
const BAR = 10000       // seri uzunlugu

/** En az bu kadar kutu dogmayan seri hicbir sey kanitlamaz. */
const EN_AZ_KUTU = 20

const TOHUMLAR = [1, 2, 3, 20240101, 987654321]

/**
 * Tohumlu, 0,01 tike yuvarlanmis, hacimli bar serisi.
 *
 * Oynaklik bir rejim dalgasiyla degisir: sakin bolgelerde pivotlar seyrek,
 * oynak bolgelerde sik olur, boylece kutu dogumu, dokunus ve kirilma yollarinin
 * hepsi ayni seride gezilir. Hacim tabani dusuk tutulup barlarin yaklasik
 * %5'inde patlatilir; Pine'in hacim kapisi (vR >= 1,05 VE flow >= 6, yani
 * pratikte vR >= 2) ancak boyle acilir.
 *
 * @param {number} tohum
 * @param {number} n
 * @param {{oynaklik?: number, spike?: number}} [sec]
 * @returns {{time:number[],open:number[],high:number[],low:number[],close:number[],volume:number[]}}
 */
function seriUret (tohum, n, sec) {
  const s = sec || {}
  const rnd = prng(tohum)
  const yuv = (x) => Math.round(x / TIK) * TIK
  const oynaklik = s.oynaklik === undefined ? 1 : s.oynaklik
  const spike = s.spike === undefined ? 0.05 : s.spike
  const d = {
    time: new Array(n), open: new Array(n), high: new Array(n),
    low: new Array(n), close: new Array(n), volume: new Array(n),
  }
  let p = 2000
  for (let i = 0; i < n; i++) {
    const rejim = oynaklik * (0.5 + 1.2 * (0.5 + 0.5 * Math.sin(i / 211 + tohum)))
    p += (rnd() - 0.5) * 3 * rejim
    const o = p
    const c = p + (rnd() - 0.5) * 2 * rejim
    const h = Math.max(o, c) + rnd() * 1.5 * rejim
    const l = Math.min(o, c) - rnd() * 1.5 * rejim
    d.time[i] = T0 + i * ADIM
    d.open[i] = yuv(o)
    d.close[i] = yuv(c)
    d.high[i] = yuv(h)
    d.low[i] = yuv(l)
    d.volume[i] = rnd() < spike
      ? Math.round(2500 + rnd() * 6000)
      : Math.round(300 + rnd() * 250)
    // Yuruyus yuvarlanmis kapanistan devam eder: fiyat gercekten tik izgarasinda.
    p = d.close[i]
  }
  return d
}

/**
 * Port kutusu ile referans kutusunu alan alan karsilastirir.
 * @param {Object} a port ciktisindaki kutu
 * @param {Object} b pineRef ciktisindaki kutu
 * @returns {string[]} farklarin listesi (bos ise ayni)
 */
function kutuFarki (a, b) {
  const f = []
  if (a.isSupport !== b.isSupport) f.push(`isSupport ${a.isSupport} != ${b.isSupport}`)
  if (Math.abs(a.top - b.top) > 1e-9) f.push(`top ${a.top} != ${b.top}`)
  if (Math.abs(a.bottom - b.bot) > 1e-9) f.push(`bot ${a.bottom} != ${b.bot}`)
  if (a.pivotBar !== b.bornBar) f.push(`dogum bari ${a.pivotBar} != ${b.bornBar}`)
  // Port kirilmamis kutuda brokenBar = -1 yazar, referans null.
  const portKirilma = a.brokenBar < 0 ? null : a.brokenBar
  if (portKirilma !== b.brokenBar) f.push(`kirilma bari ${portKirilma} != ${b.brokenBar}`)
  if (a.endBar !== b.endBar) f.push(`bitis bari ${a.endBar} != ${b.endBar}`)
  if (a.touchCount !== b.touchCount) f.push(`touchCount ${a.touchCount} != ${b.touchCount}`)
  if (Math.abs(a.flow - b.score) > 1e-9) f.push(`flow ${a.flow} != ${b.score}`)
  return f
}

/**
 * Bir seri + bir ayar kumesi icin portu referansla karsilastirir.
 * Fark bulunursa ILK farkli kutuyu ve bari hata mesajina yazar.
 * @param {string} etiket
 * @param {Object} d seriUret ciktisi
 * @param {Object} par indikator ayarlari
 * @returns {{port: Object, ref: Object}}
 */
function pariteKontrol (etiket, d, par) {
  const s = series.fromArrays(d)
  const port = runIndicator(s, par, ADIM)
  const ref = pineRef(d, par, { pivotEsitlik: 'kesin' })
  const pz = port.zones
  const rz = ref.zones

  // Ilk farkli kutuyu bul: sayi farkliysa bile ortak onek karsilastirilir,
  // cunku nerede ayrildiklarini gormek sayiyi gormekten daha degerlidir.
  const ortak = Math.min(pz.length, rz.length)
  for (let i = 0; i < ortak; i++) {
    const f = kutuFarki(pz[i], rz[i])
    if (f.length > 0) {
      assert.fail(`${etiket}: ${i}. kutu farkli (port dogum bari ${pz[i].pivotBar}, ` +
        `referans dogum bari ${rz[i].bornBar}): ${f.join(' | ')}`)
    }
  }
  if (pz.length !== rz.length) {
    // Fazla kutuyu getiren taraf hangisiyse onun ilk fazla kutusunu bildir.
    const portFazla = pz.length > rz.length
    const fazla = portFazla ? pz[ortak] : rz[ortak]
    assert.fail(`${etiket}: kutu sayisi farkli (ilk ${ortak} kutu ayni, ` +
      `port ${pz.length} referans ${rz.length}); ` +
      `ilk fazla kutu ${portFazla ? 'PORTTA' : 'REFERANSTA'}, ` +
      `dogum bari ${portFazla ? fazla.pivotBar : fazla.bornBar}, ` +
      `isSupport ${fazla.isSupport}`)
  }

  const portKirik = pz.filter((z) => z.broken).length
  const refKirik = rz.filter((z) => z.brokenBar !== null).length
  assert.equal(portKirik, refKirik, `${etiket}: kirilmis kutu sayisi farkli`)

  return { port, ref }
}

// ---------------------------------------------------------------------------
// 1) VARSAYILAN AYARLAR
// ---------------------------------------------------------------------------

test('parite: varsayilan ayarlarla 10.000 barlik bes tohumda kutular birebir ayni', () => {
  let toplamKutu = 0
  let toplamKirik = 0
  for (const tohum of TOHUMLAR) {
    const d = seriUret(tohum, BAR, { oynaklik: tohum % 2 === 1 ? 1 : 3 })

    // Fixture sozlesmesi: fiyatlar 0,01 tik izgarasinda ve hacim dolu olmali.
    for (let i = 0; i < BAR; i += 97) {
      for (const alan of ['open', 'high', 'low', 'close']) {
        const v = d[alan][i]
        assert.ok(Math.abs(v / TIK - Math.round(v / TIK)) < 1e-6,
          `tohum ${tohum}: ${alan}[${i}] tike yuvarlanmamis (${v})`)
      }
      assert.ok(d.volume[i] > 0, `tohum ${tohum}: hacim bos`)
    }

    const { ref } = pariteKontrol(`tohum ${tohum} (varsayilan)`, d, {})

    // Seri gercekten oynak olmali: kutu dogmayan seri hicbir sey kanitlamaz.
    assert.ok(ref.zones.length >= EN_AZ_KUTU,
      `tohum ${tohum}: yalnizca ${ref.zones.length} kutu dogdu, seri anlamsiz`)
    assert.ok(ref.zones.filter((z) => z.brokenBar !== null).length > 0,
      `tohum ${tohum}: hic kutu kirilmadi, kirilma yolu sinanmiyor`)
    assert.ok(ref.zones.filter((z) => z.touchCount > 0).length > 0,
      `tohum ${tohum}: hic dokunus yok, dokunus yolu sinanmiyor`)
    assert.ok(ref.zones.some((z) => z.isSupport) && ref.zones.some((z) => !z.isSupport),
      `tohum ${tohum}: tek yonlu kutu var, destek/direnc ayrimi sinanmiyor`)

    toplamKutu += ref.zones.length
    toplamKirik += ref.zones.filter((z) => z.brokenBar !== null).length
  }
  // Olculdu (2026-09): bes tohumda 170 kutu, 97'si kirilmis. Sayi degisirse
  // ya uretec ya da kutu mantigi degismistir; ikisi de bilincli olmali.
  assert.equal(toplamKutu, 170, 'toplam kutu sayisi degisti')
  assert.equal(toplamKirik, 97, 'toplam kirilmis kutu sayisi degisti')
})

test('parite: ILK DOKUNUS olaylari referansla ayni bar ve ayni zoneId', () => {
  for (const tohum of TOHUMLAR) {
    const d = seriUret(tohum, BAR, { oynaklik: tohum % 2 === 1 ? 1 : 3 })
    const { port, ref } = pariteKontrol(`tohum ${tohum} (dokunus)`, d, {})

    // Port her kutu icin EN FAZLA bir 'touch' olayi uretir (ilk dokunus).
    // Referansta bunun karsiligi touchBars[0]'dir.
    const portIlk = new Map()
    for (const t of port.touches) {
      if (t.kind !== 'touch') continue
      assert.ok(!portIlk.has(t.zoneId), `tohum ${tohum}: ${t.zoneId} icin ikinci touch olayi`)
      portIlk.set(t.zoneId, t.bar)
    }
    const refIlk = new Map()
    for (const z of ref.zones) {
      if (z.touchBars.length > 0) refIlk.set(z.id, z.touchBars[0])
    }

    assert.ok(refIlk.size > 0, `tohum ${tohum}: dokunus olayi yok, test anlamsiz`)
    assert.equal(portIlk.size, refIlk.size, `tohum ${tohum}: ilk dokunus olayi sayisi farkli`)
    for (const [zoneId, bar] of refIlk) {
      assert.equal(portIlk.get(zoneId), bar,
        `tohum ${tohum}: ${zoneId} numarali bolgenin ilk dokunusu farkli bar`)
    }
  }
})

// ---------------------------------------------------------------------------
// 2) KAPILAR ACIK: BIRLESTIRME VE maxZones YOLLARI
// ---------------------------------------------------------------------------
// Varsayilan ayarda hacim + bollinger kapilari cok kutuyu eler, 10.000 barda
// yalnizca ~30 kutu dogar ve birlestirme neredeyse hic calismaz; maxZones (24)
// ise hic dolmaz cunku kutular 100 barda yaslanip dusuyor. Bu yuzden ayni
// seriler kapilar kapatilarak bir daha taranir: boylece birlestirme, COKLU
// birlestirme ve maxZones kirpmasi da paritede olculur.

test('parite: kapilar acikken birlestirme ve maxZones kirpmasi da birebir ayni', () => {
  const setler = [
    ['kapilar acik', { useVolumeFilter: false, useBBFilter: false }],
    ['dar maxZones', {
      useVolumeFilter: false, useBBFilter: false,
      maxZones: 5, maxAgeBars: 5000, boxLengthBars: 5000,
    }],
    ['genis birlesme', { useBBFilter: false, mergeAtrMult: 3.0 }],
  ]

  let birlesmeToplam = 0
  let cokluBirlesmeToplam = 0
  let kirpilanToplam = 0

  for (const tohum of TOHUMLAR) {
    const d = seriUret(tohum, BAR, { oynaklik: tohum % 2 === 1 ? 1 : 3 })
    for (const [ad, par] of setler) {
      const { port, ref } = pariteKontrol(`tohum ${tohum} (${ad})`, d, par)

      // Birlesme sayisi da tutmali: port pivot basina bir kez (zonesMerged),
      // referans kutu basina kac kez birlestigini tutar.
      const birlesenKutu = ref.zones.filter((z) => z.mergeBars.length > 0).length
      const birlesmeAdedi = ref.zones.reduce((a, z) => a + z.mergeBars.length, 0)
      // Bir pivot birden fazla kutuya birlesebildigi icin birlesmeAdedi,
      // port'un pivot sayan zonesMerged degerinden BUYUK ESITtir.
      assert.ok(birlesmeAdedi >= port.stats.zonesMerged,
        `tohum ${tohum} ${ad}: birlesme adedi pivot sayisinin altinda`)

      birlesmeToplam += birlesenKutu
      cokluBirlesmeToplam += birlesmeAdedi - port.stats.zonesMerged
      kirpilanToplam += ref.zones.filter((z) => z.trimmedBar !== null).length
    }
  }

  // Bu test gercekten birlestirme ve kirpma yollarini geziyor mu?
  assert.ok(birlesmeToplam > 100, `birlesme yolu sinanmiyor: ${birlesmeToplam}`)
  assert.ok(cokluBirlesmeToplam > 0,
    `bir pivotun BIRDEN FAZLA kutuya birlestigi durum hic olusmadi: ${cokluBirlesmeToplam}`)
  assert.ok(kirpilanToplam > 100, `maxZones kirpmasi sinanmiyor: ${kirpilanToplam}`)
})

// ---------------------------------------------------------------------------
// 3) PIVOT ESITLIK KURALI
// ---------------------------------------------------------------------------
// Pine'in ta.pivothigh/ta.pivotlow'unda esitligin ne oldugu belgelenmemistir.
// src/core/ta.js KESIN karsilastirma yapar (merkez bar komsularindan kesinlikle
// buyuk/kucuk olmali, esitlikte pivot YOKTUR) ve port da onu kullanir. Bu test
// varsayimi YAZILI hale getirir ve alternatifin (esitlige izin veren kural)
// sonucu gercekten degistirdigini olcer: 0,01 tike yuvarlanmis seride ayni
// fiyat komsu barlarda tekrarlanabilir, yani bu bir kagit uzerinde fark degil.

test('pivot esitlik kurali: port KESIN kurali varsayar, esitDahil sonucu degistirir', () => {
  let kesinToplam = 0
  let esitToplam = 0
  let farkliTohum = 0

  for (const tohum of TOHUMLAR) {
    const d = seriUret(tohum, BAR, { oynaklik: tohum % 2 === 1 ? 1 : 3 })
    const s = series.fromArrays(d)
    const port = runIndicator(s, {}, ADIM)
    const kesin = pineRef(d, {}, { pivotEsitlik: 'kesin' })
    const esit = pineRef(d, {}, { pivotEsitlik: 'esitDahil' })

    // Port KESIN kuralla birebir ayni.
    assert.equal(port.zones.length, kesin.zones.length,
      `tohum ${tohum}: port kesin kuralla ayni kutu sayisini vermeli`)

    kesinToplam += kesin.zones.length
    esitToplam += esit.zones.length
    if (esit.zones.length !== kesin.zones.length) farkliTohum++
  }

  // Olculdu (2026-09): kesin 170, esitDahil 174 kutu. Bes tohumun dordunde fark
  // var, biri (3) ayni. Yani kural bir tercih meselesi degil, portun ciktisini
  // degistiren bir varsayimdir; Pine'in gercek davranisi degisirse buradaki
  // sayilar da degismeli.
  assert.equal(kesinToplam, 170, 'kesin kuralda toplam kutu sayisi degisti')
  assert.equal(esitToplam, 174, 'esitDahil kuralinda toplam kutu sayisi degisti')
  assert.ok(esitToplam > kesinToplam,
    'esitlige izin vermek en az bir pivot daha uretmeli, yoksa secenek anlamsiz')
  assert.ok(farkliTohum >= 3, `fark yalnizca ${farkliTohum} tohumda gorundu`)
})
