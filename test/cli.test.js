'use strict'

// V8 - src/core/util/cli.js testleri.
// Betiklerin (import-legacy, fetch-history) ortak yardimcilari. Arguman
// ayristirma ve damga uretimi burada kilitlenir; ikisi de uzerine yazma
// korumasinin dogru calismasi icin kritiktir.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const cli = require('../src/core/util/cli')

test('argumanlariAyristir: --ad deger bicimi', () => {
  const a = cli.argumanlariAyristir(['--tf', '1m', '--limit', '200000'])
  assert.equal(a.tf, '1m')
  assert.equal(a.limit, '200000')
  assert.deepEqual(a._, [])
})

test('argumanlariAyristir: --ad=deger bicimi', () => {
  const a = cli.argumanlariAyristir(['--out=/yol/XAUUSD_1m.bin', '--tfs=5m,15m'])
  assert.equal(a.out, '/yol/XAUUSD_1m.bin')
  assert.equal(a.tfs, '5m,15m')
})

test('argumanlariAyristir: degersiz bayrak true olur', () => {
  const a = cli.argumanlariAyristir(['--force'])
  assert.equal(a.force, true)
})

test('argumanlariAyristir: bayragin ardindan gelen bayrak deger sayilmaz', () => {
  // '--force --limit 200' icinde force bir bayraktir, degeri '--limit' degildir.
  const a = cli.argumanlariAyristir(['--force', '--limit', '200'])
  assert.equal(a.force, true)
  assert.equal(a.limit, '200')
})

test('argumanlariAyristir: adsiz argumanlar _ dizisine girer', () => {
  const a = cli.argumanlariAyristir(['dosya.bin', '--tf', '5m', 'ikinci'])
  assert.deepEqual(a._, ['dosya.bin', 'ikinci'])
  assert.equal(a.tf, '5m')
})

test('argumanlariAyristir: bos liste yalnizca _ dondurur', () => {
  assert.deepEqual(cli.argumanlariAyristir([]), { _: [] })
})

test('sayiBicim: binlik ayraci nokta', () => {
  assert.equal(cli.sayiBicim(0), '0')
  assert.equal(cli.sayiBicim(999), '999')
  assert.equal(cli.sayiBicim(1000), '1.000')
  assert.equal(cli.sayiBicim(6115663), '6.115.663')
})

test('zamanBicim: UNIX saniye -> "YYYY-MM-DD HH:MM"', () => {
  assert.equal(cli.zamanBicim(1577836800), '2020-01-01 00:00')
  assert.equal(cli.zamanBicim(NaN), '-')
  assert.equal(cli.zamanBicim(Infinity), '-')
})

test('sureBicim: virgullu saniye', () => {
  assert.equal(cli.sureBicim(7000), '7,0 sn')
  assert.equal(cli.sureBicim(123), '0,1 sn')
})

test('damga: yedek adlarinda kullanilan YYYYMMDD-HHMMSS', () => {
  // Yerel saat kullanilir; testte de yerel alanlardan beklenen kurulur.
  const t = new Date(2026, 8, 17, 4, 5, 6)
  assert.equal(cli.damga(t), '20260917-040506')
})

test('damga: argumansiz cagri da bicime uyar', () => {
  assert.match(cli.damga(), /^\d{8}-\d{6}$/)
})
