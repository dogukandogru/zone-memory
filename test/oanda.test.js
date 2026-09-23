'use strict'

// OANDA saglayicisi (src/core/data/oanda.js).
//
// NEDEN EKLENDI: kullanici kutulara TradingView'da OANDA:XAUUSD grafiginde
// bakiyor. Olculdu (2026-05-29 / 2026-08-31, 6004 bar, 15m): depo o
// grafikteki kutularin %56,7'sini uretiyordu, OANDA %100'unu uretiyor.
//
// Burada AG ISTEGI YAPILMAZ. Sinanan sey, ag cevabini seriye ceviren saf
// mantik: kapanmamis mumun atilmasi, zaman cevrimi ve granulerite eslemesi.

const test = require('node:test')
const assert = require('node:assert')

const oanda = require('../src/core/data/oanda')

test('saglayici kaydi: vekil DEGIL ve anahtar ister', () => {
  assert.strictEqual(oanda.id, 'oanda')
  assert.strictEqual(oanda.isProxy, false, 'OANDA spot XAU_USD verir, vekil degildir')
  assert.strictEqual(oanda.needsKey, true)
  assert.ok(oanda.caps.indexOf('history') >= 0 && oanda.caps.indexOf('live') >= 0)
})

test('granulerite eslemesi Pine zaman dilimleriyle ortusur', () => {
  const g = oanda._GRANULERITE
  assert.strictEqual(g[60], 'M1')
  assert.strictEqual(g[300], 'M5')
  assert.strictEqual(g[900], 'M15')
  assert.strictEqual(g[3600], 'H1')
  assert.strictEqual(g[14400], 'H4')
})

test('zaman cevrimi: nanosaniyeli RFC3339 ve gidis donus', () => {
  // OANDA "2026-09-23T08:30:00.000000000Z" bicimini doner.
  assert.strictEqual(oanda._zamanaCevir('2026-09-23T08:30:00.000000000Z'),
    Math.floor(Date.UTC(2026, 8, 23, 8, 30) / 1000))
  assert.strictEqual(oanda._zamanaCevir('2026-09-23T08:30:00Z'),
    Math.floor(Date.UTC(2026, 8, 23, 8, 30) / 1000))
  assert.ok(Number.isNaN(oanda._zamanaCevir('bozuk')))
  assert.ok(Number.isNaN(oanda._zamanaCevir(null)))

  const sn = Math.floor(Date.UTC(2020, 0, 2, 3, 45) / 1000)
  assert.strictEqual(oanda._zamanMetni(sn), '2020-01-02T03:45:00Z')
  assert.strictEqual(oanda._zamanaCevir(oanda._zamanMetni(sn)), sn)
})

test('en eski veri siniri olculen tarihtir', () => {
  // Olculdu: M1 dahil tum granuleritelerde en eski mum 2006-03-19.
  assert.strictEqual(oanda.EN_ESKI, Date.UTC(2006, 2, 19) / 1000)
})

test('anahtarsiz cagri anlasilir hata verir, ag istegi yapmaz', async () => {
  await assert.rejects(
    () => oanda.fetchCandles({ tfSec: 900 }),
    (err) => /anahtari gerekli/.test(err.message) && /oanda/i.test(err.message),
    'hata mesaji nereden anahtar girilecegini soylemeli')
})
