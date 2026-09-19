'use strict'

// Y1 - src/renderer/risk.mjs pozisyon boyutu hesabi.
//
// Bu testlerin kilitledigi sey su olcumdur: SL mesafesi turler arasinda UC KAT
// degisiyor (kutu olusumu 2,02-2,10 ATR, bolge dokunusu 0,68-0,75 ATR) ve
// 2026'da 5 dakikalik medyan ATR 5,97 dolar. Sabit lotla acan kullanici
// olusum sinyalinde uc kat fazla risk aliyor. Hesap bu farki lota tasimazsa
// ekrandaki "%1 risk" yazisi yalan olur.
//
// Ikinci kilit: sistem hicbir zaman diliminde pozitif net beklenti
// uretmediginden hesap yalnizca riski SINIRLAR. Basari oranina gore lot
// buyuten bir carpani hicbir test talep etmez, tersine yuvarlama her zaman
// asagi olmak zorundadir.

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MODUL = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'risk.mjs')).href

/** ESM modulu CommonJS testten yukler. */
async function riskYukle () {
  return await import(MODUL)
}

/** Iki sayi verilen paya kadar esit mi. */
function yakin (gercek, beklenen, pay, mesaj) {
  assert.ok(Number.isFinite(gercek), (mesaj || '') + ' sonlu sayi degil: ' + gercek)
  assert.ok(Math.abs(gercek - beklenen) <= pay,
    (mesaj || '') + ' beklenen ' + beklenen + ' (pay ' + pay + '), gelen ' + gercek)
}

/** Kabul olcutundeki kurulum: XAUUSD, 0,30 dolar maliyet, %1 risk. */
function kurulum (ek) {
  return Object.assign({
    entry: 4400,
    sl: 4400 - 12.54,
    tp1: 4400 + 25.08,
    balance: 10000,
    riskPct: 1,
    contractSize: 100,
    lotStep: 0.01,
    minLot: 0.01,
    costUsd: 0.30,
  }, ek || {})
}

test('kabul olcutu: 10.000 dolarda 12,54 dolarlik SL yaklasik 0,07 lot ve 89,88 dolar risk verir', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  const s = pozisyonBoyutu(kurulum())

  assert.strictEqual(s.gecersiz, false)
  assert.strictEqual(s.yetersiz, false)
  assert.strictEqual(s.lot, 0.07, 'lot tam 0,07 olmali (kayan nokta kirligi yok)')
  // Ons basi risk 12,54 + 0,30 = 12,84 dolar; 0,07 lot * 100 ons = 89,88 dolar.
  yakin(s.riskUsd, 89.88, 0.01, 'SL vurursa kaybedilecek dolar')
  yakin(s.gerceklesenRiskPct, 0.8988, 0.001, 'gerceklesen risk yuzdesi')
  assert.ok(s.gerceklesenRiskPct <= 1, 'yuvarlama asagi oldugu icin %1 asilamaz')
  assert.strictEqual(s.yon, 'AL')
})

test('kabul olcutu: 500 dolarlik hesapta yetersiz ve en kucuk lot bakiyenin %2,57 sini riske atar', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  const s = pozisyonBoyutu(kurulum({ balance: 500 }))

  assert.strictEqual(s.gecersiz, false)
  assert.strictEqual(s.yetersiz, true, '0,01 lot bile %1 butcesine sigmiyor')
  assert.strictEqual(s.lot, 0, 'yetersizken lot uydurulmaz')
  assert.strictEqual(s.riskUsd, 0)
  yakin(s.enKucukLotRiskPct, 2.568, 0.01, 'en kucuk lotun risk yuzdesi')
})

test('turler arasindaki uc kat SL farki lota gecer, risk dolari sabit kalir', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  // 2026, 5 dakikalik medyan ATR 5,97 dolar. Olusum 2,05 ATR; dokunus 0,71 ATR.
  const atr = 5.97
  const olusum = pozisyonBoyutu(kurulum({ sl: 4400 - 2.05 * atr, tp1: undefined }))
  const dokunus = pozisyonBoyutu(kurulum({ sl: 4400 - 0.71 * atr, tp1: undefined }))

  assert.strictEqual(olusum.lot, 0.07, 'kutu olusumu lotu')
  assert.strictEqual(dokunus.lot, 0.22, 'bolge dokunusu lotu')
  assert.ok(dokunus.lot > olusum.lot * 2.5,
    'dar SL daha buyuk lot demeli, aksi halde sabit lotla ayni hataya duseriz')

  // Asil mesele: iki turde de riske atilan para birbirine yakin kalmali.
  assert.ok(Math.abs(olusum.gerceklesenRiskPct - dokunus.gerceklesenRiskPct) < 0.15,
    'iki turun riski %0,15 puandan fazla ayrismamali, gelen: ' +
    olusum.gerceklesenRiskPct + ' / ' + dokunus.gerceklesenRiskPct)
})

test('SAT yonunde ayni mesafe ayni lotu verir, yon SAT olarak isaretlenir', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  const al = pozisyonBoyutu(kurulum())
  const sat = pozisyonBoyutu(kurulum({ sl: 4400 + 12.54, tp1: 4400 - 25.08 }))

  assert.strictEqual(sat.yon, 'SAT')
  assert.strictEqual(sat.lot, al.lot, 'mutlak mesafe ayni, lot da ayni olmali')
  yakin(sat.riskUsd, al.riskUsd, 1e-6, 'SAT riski')
  // TP1 asagida oldugu icin kazanc yine ARTI olmali: mutlak deger degil, yon
  // bilgisi kullanildigini kilitler.
  assert.ok(sat.tp1KazancUsd > 0, 'SAT planinda TP1 kazanci arti olmali')
  yakin(sat.tp1KazancUsd, al.tp1KazancUsd, 1e-6, 'iki yonde kazanc simetrik')
})

test('TP1 kazancindan maliyet dusulur, ters tarafa konmus TP1 eksi doner', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  const s = pozisyonBoyutu(kurulum())
  // 0,07 lot * 100 ons * (25,08 - 0,30) = 173,46 dolar.
  yakin(s.tp1KazancUsd, 173.46, 0.02, 'TP1 net kazanci (maliyet dusulmus)')

  const tp1siz = pozisyonBoyutu(kurulum({ tp1: undefined }))
  assert.strictEqual(tp1siz.tp1KazancUsd, null, 'TP1 yoksa kazanc uydurulmaz')

  // Hedef yanlis tarafa konmussa sonuc EKSI gorunmeli; mutlak deger bunu
  // sahte bir kazanca cevirirdi.
  const ters = pozisyonBoyutu(kurulum({ tp1: 4400 - 10 }))
  assert.ok(ters.tp1KazancUsd < 0, 'AL planinda girisin altindaki TP1 eksi olmali')
})

test('gecersiz girdilerde cokmez, gecersiz bayragi ve sebep doner', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  const durumlar = [
    ['SL girise esit (sifira bolme)', kurulum({ sl: 4400 })],
    ['bakiye sifir', kurulum({ balance: 0 })],
    ['bakiye eksi', kurulum({ balance: -100 })],
    ['risk yuzdesi sifir', kurulum({ riskPct: 0 })],
    ['risk yuzdesi eksi', kurulum({ riskPct: -1 })],
    ['giris NaN', kurulum({ entry: NaN })],
    ['SL metin', kurulum({ sl: 'abc' })],
    ['giris tanimsiz', kurulum({ entry: undefined })],
    ['kontrat sifir', kurulum({ contractSize: 0 })],
    ['lot adimi eksi', kurulum({ lotStep: -0.01 })],
    ['maliyet eksi', kurulum({ costUsd: -1 })],
    ['girdi yok', undefined],
    ['girdi null', null],
    ['girdi bos nesne', {}],
  ]
  for (const [ad, girdi] of durumlar) {
    const s = pozisyonBoyutu(girdi)
    assert.strictEqual(s.gecersiz, true, ad + ': gecersiz beklenirdi')
    assert.strictEqual(s.lot, 0, ad + ': lot 0 olmali')
    assert.strictEqual(s.riskUsd, 0, ad + ': risk 0 olmali')
    assert.strictEqual(typeof s.sebep, 'string', ad + ': sebep TURKCE metin olmali')
    assert.ok(s.sebep.length > 0, ad + ': sebep bos')
    assert.ok(Number.isFinite(s.gerceklesenRiskPct), ad + ': yuzde sonlu kalmali')
    assert.ok(Number.isFinite(s.enKucukLotRiskPct), ad + ': en kucuk lot yuzdesi sonlu kalmali')
  }
})

test('lot adimina yuvarlamada kayan nokta hatasi yok', async () => {
  const { pozisyonBoyutu } = await riskYukle()

  // 0,29 / 0,01 = 28.999999999999996 eder, duz bolme bir adim ASAGI duserdi
  // ve kullanici hak ettigi lotun altinda islem acardi.
  const s = pozisyonBoyutu({
    entry: 100, sl: 99, balance: 2.9, riskPct: 10,
    contractSize: 1, lotStep: 0.01, minLot: 0.01, costUsd: 0,
  })
  assert.strictEqual(s.lot, 0.29, 'tam 0,29 lot beklenir')

  // Sonuc kirli bir ondalik olmamali: 0,01 adiminda lot, iki basamakli
  // ondaligin en yakin karsiligi olmali. 0.07000000000000001 gibi bir deger
  // ekranda da brokere giden emirde de kabul edilemez. (Carpimla dogrulamak
  // yanlis olur: 0.07 * 100 zaten 7.000000000000001 eder, bu yuzden olcu
  // metin uzerinden alinir.)
  const t = pozisyonBoyutu(kurulum())
  assert.strictEqual(Number(t.lot.toFixed(2)), t.lot, 'lot kirli bir ondalik: ' + t.lot)

  // Gercekten asagi yuvarlandigini kilitle: 0,289 lotluk butce 0,28 verir.
  const u = pozisyonBoyutu({
    entry: 100, sl: 99, balance: 0.289, riskPct: 100,
    contractSize: 1, lotStep: 0.01, minLot: 0.01, costUsd: 0,
  })
  assert.strictEqual(u.lot, 0.28, 'adim sinirinin altindaki deger yukari cekilmemeli')
})

test('farkli lot adimlari ve bakiyelerde risk butcesi asla asilmaz', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  const adimlar = [0.01, 0.1, 1, 0.001]
  for (const adim of adimlar) {
    for (let bakiye = 300; bakiye <= 200000; bakiye += 1370) {
      for (let mesafe = 0.5; mesafe < 40; mesafe += 3.7) {
        const s = pozisyonBoyutu(kurulum({
          balance: bakiye, sl: 4400 - mesafe, lotStep: adim, minLot: adim,
        }))
        assert.strictEqual(s.gecersiz, false)
        if (s.yetersiz) {
          assert.strictEqual(s.lot, 0)
          continue
        }
        // Yuvarlama asagi oldugu icin gerceklesen risk butceyi gecemez.
        // Kucuk pay, adim sinirindaki kayan nokta duzeltmesi icindir.
        assert.ok(s.gerceklesenRiskPct <= 1 + 1e-9,
          'butce asildi: adim ' + adim + ' bakiye ' + bakiye +
          ' mesafe ' + mesafe + ' -> %' + s.gerceklesenRiskPct)
        assert.ok(s.lot >= adim, 'lot en kucuk lotun altina dusmus')
        // Lot, adimin tam kati olmali. Bolum tam sayidan sapiyorsa yuvarlama
        // tam sayi aritmetigiyle yapilmamis demektir.
        const kat = s.lot / adim
        assert.ok(Math.abs(kat - Math.round(kat)) < 1e-6,
          'lot adimin kati degil: ' + s.lot + ' / ' + adim)
      }
    }
  }
})

test('minLot adimdan kucuk verilse bile adim taban kabul edilir', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  // minLot 0 gelirse "0 lot ile islem acilabilir" gibi anlamsiz bir sonuc
  // cikmamali; broker adimi zaten alt sinirdir.
  const s = pozisyonBoyutu(kurulum({ balance: 500, minLot: 0 }))
  assert.strictEqual(s.yetersiz, true)
  yakin(s.enKucukLotRiskPct, 2.568, 0.01, 'taban lot 0,01 kabul edilmeli')
})

test('risk yuzdesi buyudukce lot kucultmez, hesap yalnizca riski sinirlar', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  let oncekiLot = -1
  for (const pct of [0.25, 0.5, 1, 2, 3, 5]) {
    const s = pozisyonBoyutu(kurulum({ riskPct: pct }))
    assert.ok(s.lot >= oncekiLot, 'risk yuzdesi artarken lot azalamaz')
    oncekiLot = s.lot
    if (!s.yetersiz) {
      assert.ok(s.gerceklesenRiskPct <= pct + 1e-9, 'istenen yuzde asildi')
    }
  }

  // Basari orani, RR ya da guven gibi alanlar sonuca DOKUNMAMALI: pozitif net
  // beklenti olculmedigi surece lot buyutmek yasak.
  const sade = pozisyonBoyutu(kurulum())
  const suslu = pozisyonBoyutu(kurulum({ winRate: 0.9, rr: 3, confidence: 1, kelly: 0.25 }))
  assert.deepStrictEqual(suslu, sade, 'basari orani alanlari lotu degistirmemeli')
})

test('cok genis SL ya da cok kucuk hesapta yetersiz doner, sonuclar sonlu kalir', async () => {
  const { pozisyonBoyutu } = await riskYukle()
  const s = pozisyonBoyutu(kurulum({ balance: 50, sl: 4400 - 300 }))
  assert.strictEqual(s.gecersiz, false)
  assert.strictEqual(s.yetersiz, true)
  assert.ok(Number.isFinite(s.enKucukLotRiskPct) && s.enKucukLotRiskPct > 100,
    'en kucuk lot bile hesabi asiyorsa bu yuzde olarak gorunmeli')
})
