'use strict'

// HESAP IMZASI (src/core/util/codesig.js)
//
// Imza tek bir soruyu cevaplar: "olaylari ve komsu satirlarini ureten kod
// degisti mi". Komsu onbellegi bu cevaba gore korunur ya da bastan hesaplanir
// (olculdu: 1 dakikalikta bastan hesap 333,8 sn).
//
// Kilitlenen iki hata:
//   1. IMZA COK GENIS OLMAMALI. Bir donem tum kaynagin damgasi (buildSrcHash)
//      kullanildi; arayuzde bir yazim duzeltmesi bile imzayi degistiriyor ve
//      musteri hesabi hic etkilemeyen bir guncelleme yuzunden dakikalarca
//      bekliyordu. Kullanicinin bildirdigi sorun buydu.
//   2. IMZA COK DAR DA OLMAMALI. Elle tutulan bir dosya listesi gunun birinde
//      eksik kalir ve imza SESSIZCE yanlis olur: eski satirlar yeni hesapla
//      uretilmis olaylara ait sanilir. Bu yuzden zincir `require` uzerinden
//      OTOMATIK dolasilir.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { codeSignature, COMPUTE_ENTRIES } = require('../src/core/util/codesig')

/** Bellekteki sahte dosya sisteminden okuyan bir imza hesabi. */
function sahteImza (dosyalar, girisler) {
  return codeSignature({
    root: '/kok',
    entries: girisler || ['a.js'],
    readFile: (yol) => {
      const ad = path.relative('/kok', yol)
      if (!Object.prototype.hasOwnProperty.call(dosyalar, ad)) {
        throw new Error('yok: ' + ad)
      }
      return dosyalar[ad]
    },
  })
}

test('imza gercek zincirde uretilir ve KARARLIDIR', () => {
  const a = codeSignature()
  const b = codeSignature()
  assert.match(a.hash, /^[0-9a-f]{16}$/, 'imza 16 haneli onaltilik olmali')
  assert.equal(a.hash, b.hash, 'ayni kod ayni imzayi vermeli')
  // Zincir giris modullerinin hepsini icermeli.
  for (const giris of COMPUTE_ENTRIES) {
    assert.ok(a.files.includes(giris), 'zincirde eksik giris: ' + giris)
  }
})

test('zincir require uzerinden OTOMATIK genisler, elle listeye bagli degil', () => {
  // proZones.js dogrudan listede; ta.js listede DEGIL ama ondan cagrildigi
  // icin zincirde olmali. Elle liste tutulsaydi bu dosya atlanabilirdi.
  const { files } = codeSignature()
  assert.ok(files.includes('ta.js'), 'dolayli bagimlilik zincire girmedi')
  assert.ok(files.includes('series.js'), 'dolayli bagimlilik zincire girmedi')
})

test('imza HESABIN DISINDAKI dosyalari kapsamaz', () => {
  // Arayuz, veri saglayicilari ve depo katmani hesabi belirlemez; bunlar
  // degistiginde eski satirlar hala gecerlidir.
  const { files } = codeSignature()
  for (const dis of ['data/oanda.js', 'data/loader.js', 'store/binstore.js',
    'store/memstore.js', 'learn/backtest.js']) {
    assert.ok(!files.includes(dis), 'imza gereksiz genis, kapsamamali: ' + dis)
  }
})

test('zincirdeki bir dosya degisirse imza DEGISIR', () => {
  const taban = { 'a.js': "require('./b')", 'b.js': 'x = 1' }
  const ilk = sahteImza(taban)
  assert.notEqual(ilk.hash, '')
  // Giris modulu degisti.
  assert.notEqual(sahteImza({ 'a.js': "require('./b') // not", 'b.js': 'x = 1' }).hash, ilk.hash)
  // DOLAYLI bagimlilik degisti: asil kilitlenen durum bu.
  assert.notEqual(sahteImza({ 'a.js': "require('./b')", 'b.js': 'x = 2' }).hash, ilk.hash)
})

test('zincir dolayli bagimliliklari izler ve dongude kilitlenmez', () => {
  // a -> b -> c, ayrica c -> a (dongu). Dolasma bitmeli.
  const dosyalar = {
    'a.js': "require('./b')",
    'b.js': "require('./alt/c')",
    'alt/c.js': "require('../a')",
  }
  const r = sahteImza(dosyalar)
  assert.deepEqual(r.files.slice().sort(), ['a.js', 'alt/c.js', 'b.js'])
})

test('kok DISINA cikan require izlenmez', () => {
  // Zincir yalnizca core icinde dolasilir; disari cikilsa okuma hata verir ve
  // imza bos donerdi.
  const r = sahteImza({ 'a.js': "require('../../main/ipc')\nrequire('./b')", 'b.js': 'y' })
  assert.deepEqual(r.files.slice().sort(), ['a.js', 'b.js'])
  assert.notEqual(r.hash, '')
})

test('dosya okunamazsa imza BOS doner (koruma yapilmaz)', () => {
  // Eksik zincirden imza uretmek, olmayan bir dosyayi "degismedi" saymak
  // demektir. Bos imza cagirani korumadan vazgecirir.
  const r = sahteImza({ 'a.js': "require('./yok')" })
  assert.equal(r.hash, '')
  assert.deepEqual(r.files, [])
})
