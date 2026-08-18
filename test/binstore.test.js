'use strict'

// A12 - src/core/store/binstore.js testleri (CONTRACTS.md bolum 5 ve 21).
// Gecici klasorde calisir, sonunda temizler.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const binstore = require('../src/core/store/binstore')
const series = require('../src/core/series')

let kok = null

before(() => {
  kok = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-binstore-'))
})

after(() => {
  if (kok) fs.rmSync(kok, { recursive: true, force: true })
})

/** Test klasorunde benzersiz dosya yolu. */
function yol (ad) {
  return path.join(kok, ad)
}

/** Basit sentetik seri. */
function seriKur (times, taban) {
  const n = times.length
  const t = taban === undefined ? 100 : taban
  const open = new Array(n)
  const high = new Array(n)
  const low = new Array(n)
  const close = new Array(n)
  const volume = new Array(n)
  for (let i = 0; i < n; i++) {
    open[i] = t + i
    high[i] = t + i + 0.5
    low[i] = t + i - 0.5
    close[i] = t + i + 0.25
    volume[i] = 10 + i
  }
  return series.fromArrays({ time: times, open, high, low, close, volume })
}

test('MAGIC sozlesmedeki degerdir', () => {
  assert.equal(binstore.MAGIC, 'ZMEM0001')
})

test('readSeries: dosya yoksa null doner', async () => {
  const s = await binstore.readSeries(yol('yok.bin'))
  assert.equal(s, null)
  assert.equal(await binstore.statSeries(yol('yok.bin')), null)
})

test('writeSeries / readSeries: gidis donus verinin tamamini korur', async () => {
  const p = yol('gidis-donus.bin')
  const s = seriKur([1000, 1060, 1120, 1180])
  await binstore.writeSeries(p, s)

  const geri = await binstore.readSeries(p)
  assert.notEqual(geri, null)
  assert.equal(geri.length, s.length)
  assert.ok(geri.time instanceof Float64Array)
  for (const alan of ['time', 'open', 'high', 'low', 'close', 'volume']) {
    assert.deepEqual(Array.from(geri[alan]), Array.from(s[alan]), alan + ' sutunu bozulmus')
  }
})

test('writeSeries: dosya bayt duzeni sozlesmedeki gibi (baslik + 6 sutun)', async () => {
  const p = yol('duzen.bin')
  const s = seriKur([1000, 1060, 1120])
  await binstore.writeSeries(p, s)

  const buf = fs.readFileSync(p)
  assert.equal(buf.toString('ascii', 0, 8), 'ZMEM0001')
  assert.equal(buf.readUInt32LE(8), 1)
  assert.equal(buf.readUInt32LE(12), 0)
  assert.equal(buf.readDoubleLE(16), 3)
  assert.equal(buf.length, 24 + 3 * 6 * 8)
  // Ilk sutun time olmali.
  assert.equal(buf.readDoubleLE(24), 1000)
})

test('writeSeries: gecici dosya birakmaz (atomik yazim)', async () => {
  const p = yol('atomik.bin')
  await binstore.writeSeries(p, seriKur([1, 2, 3]))
  assert.equal(fs.existsSync(p + '.tmp'), false)
})

test('statSeries: sayim ve ilk/son zaman', async () => {
  const p = yol('stat.bin')
  await binstore.writeSeries(p, seriKur([500, 560, 620, 680]))
  const st = await binstore.statSeries(p)
  assert.equal(st.count, 4)
  assert.equal(st.firstTime, 500)
  assert.equal(st.lastTime, 680)
})

test('appendSeries: bos dosyaya ekleme tum barlari yazar', async () => {
  const p = yol('ekle-yeni.bin')
  const r = await binstore.appendSeries(p, seriKur([100, 200, 300]))
  assert.equal(r.total, 3)
  assert.equal(r.added, 3)
})

test('appendSeries: cakisan zaman damgalarinda YENI veri kazanir', async () => {
  const p = yol('ekle-tekil.bin')
  await binstore.writeSeries(p, seriKur([100, 200, 300], 100))

  // 300 cakisiyor, degerleri farkli olsun diye taban degistirildi.
  const yeni = seriKur([300, 400, 500], 900)
  const r = await binstore.appendSeries(p, yeni)

  assert.equal(r.total, 5, 'tekillestirme sonrasi toplam 5 bar olmali')
  assert.equal(r.added, 2, 'net eklenen bar sayisi 2 olmali')

  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time), [100, 200, 300, 400, 500])
  // 300 barinda yeni serinin degeri gecerli olmali (900 tabanli).
  assert.equal(geri.open[2], yeni.open[0])
  assert.equal(geri.close[2], yeni.close[0])
  // Onceki barlar korunmali.
  assert.equal(geri.open[0], 100)
})

test('appendSeries: sirasiz gelen veri zaman sirali yazilir', async () => {
  const p = yol('ekle-sirasiz.bin')
  await binstore.writeSeries(p, seriKur([200, 400]))
  await binstore.appendSeries(p, seriKur([100, 300, 500]))
  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time), [100, 200, 300, 400, 500])
})

test('readSeries: bozuk magic degerinde hata firlatir', async () => {
  const p = yol('bozuk-magic.bin')
  const buf = Buffer.alloc(24 + 6 * 8)
  buf.write('BOZUK123', 0, 8, 'ascii')
  buf.writeUInt32LE(1, 8)
  buf.writeUInt32LE(0, 12)
  buf.writeDoubleLE(1, 16)
  fs.writeFileSync(p, buf)

  await assert.rejects(() => binstore.readSeries(p), /imzasi|magic|ZMEM0001/i)
  await assert.rejects(() => binstore.statSeries(p), /imzasi|magic|ZMEM0001/i)
})

test('readSeries: baslik eksikse hata firlatir', async () => {
  const p = yol('kisa.bin')
  fs.writeFileSync(p, Buffer.alloc(8))
  await assert.rejects(() => binstore.readSeries(p))
})

test('readSeries: govde beklenenden kisaysa hata firlatir', async () => {
  const p = yol('eksik-govde.bin')
  const buf = Buffer.alloc(24 + 8)
  buf.write('ZMEM0001', 0, 8, 'ascii')
  buf.writeUInt32LE(1, 8)
  buf.writeUInt32LE(0, 12)
  buf.writeDoubleLE(10, 16) // 10 bar oldugunu iddia ediyor ama govde yok
  fs.writeFileSync(p, buf)
  await assert.rejects(() => binstore.readSeries(p), /kisa/i)
})

test('writeSeries / readSeries: sifir barlik seri', async () => {
  const p = yol('bos.bin')
  await binstore.writeSeries(p, series.emptySeries())
  const geri = await binstore.readSeries(p)
  assert.equal(geri.length, 0)
  const st = await binstore.statSeries(p)
  assert.equal(st.count, 0)
})
