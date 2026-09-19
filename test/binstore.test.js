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

/** Dogrudan Float64Array ile buyuk sentetik seri (300.000 bar icin hizli yol). */
function buyukSeri (n, t0, dt) {
  const s = series.createSeries(n)
  for (let i = 0; i < n; i++) {
    s.time[i] = t0 + i * dt
    s.open[i] = 100 + (i % 500)
    s.high[i] = 101 + (i % 500)
    s.low[i] = 99 + (i % 500)
    s.close[i] = 100.5 + (i % 500)
    s.volume[i] = 10 + (i % 7)
  }
  return s
}

/** Kuyruk dosyasi yolu. */
function kuyrukYolu (p) {
  return p + binstore.TAIL_SUFFIX
}

/** Satir sirali kuyruk kaydi uretir (48 bayt). */
function kuyrukSatiri (bar) {
  const buf = Buffer.alloc(48)
  buf.writeDoubleLE(bar.time, 0)
  buf.writeDoubleLE(bar.open, 8)
  buf.writeDoubleLE(bar.high, 16)
  buf.writeDoubleLE(bar.low, 24)
  buf.writeDoubleLE(bar.close, 32)
  buf.writeDoubleLE(bar.volume, 40)
  return buf
}

/** Klasorde kalmis gecici dosya var mi. */
function geciciDosyalar (klasor) {
  return fs.readdirSync(klasor).filter((ad) => ad.endsWith('.tmp'))
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

test('statSeries: govde beklenenden kisaysa hata firlatir', async () => {
  const p = yol('stat-eksik-govde.bin')
  const buf = Buffer.alloc(24 + 8)
  buf.write('ZMEM0001', 0, 8, 'ascii')
  buf.writeUInt32LE(1, 8)
  buf.writeUInt32LE(0, 12)
  buf.writeDoubleLE(10, 16)
  fs.writeFileSync(p, buf)
  await assert.rejects(() => binstore.statSeries(p), /kisa|boyut/i)
})

test('readSeries / statSeries: FAZLA bayt varsa hata firlatir', async () => {
  // Yarim kalmis bir yazimdan artan baytlar eskiden sessizce yok sayiliyordu:
  // bozuk dosya saglam gibi okunuyordu.
  const p = yol('fazla-bayt.bin')
  await binstore.writeSeries(p, seriKur([100, 200, 300]))
  fs.appendFileSync(p, Buffer.alloc(8))
  await assert.rejects(() => binstore.readSeries(p), /uzun|boyut/i)
  await assert.rejects(() => binstore.statSeries(p), /uzun|boyut/i)
})

test('readSeries: bas/son barlarda zaman artan degilse hata firlatir', async () => {
  const p = yol('artan-degil.bin')
  await binstore.writeSeries(p, seriKur([100, 200, 300]))
  // Ikinci barin zamanini birincinin altina cek: siralama bozuldu.
  const fd = fs.openSync(p, 'r+')
  const buf = Buffer.alloc(8)
  buf.writeDoubleLE(50, 0)
  fs.writeSync(fd, buf, 0, 8, 24 + 8)
  fs.closeSync(fd)
  await assert.rejects(() => binstore.readSeries(p), /artan/i)
})

test('appendSeries: bos seri eklemek dosyaya dokunmaz', async () => {
  const p = yol('bos-ekleme.bin')
  await binstore.writeSeries(p, seriKur([100, 200, 300]))
  const once = fs.statSync(p)
  const r = await binstore.appendSeries(p, series.emptySeries())
  assert.equal(r.added, 0)
  assert.equal(r.total, 3)
  assert.equal(fs.statSync(p).mtimeMs, once.mtimeMs, 'bos ekleme ana dosyayi yeniden yazmamali')
})

test('appendSeries: yeni barlar kuyruga yazilir, ana dosya BUYUMEZ ve hizlidir', async () => {
  // 6 milyon barlik gercek depoyu testte kurmak pahali; 300.000 bar (14,4 MB)
  // ile ayni davranis olculur. Ana dosyanin baytina dokunulmadigi ve tam
  // yazimdan belirgin bicimde hizli oldugu dogrulanir.
  const p = yol('buyuk.bin')
  const N = 300000
  const dt = 60
  const t0 = 1000000
  await binstore.writeSeries(p, buyukSeri(N, t0, dt))
  assert.equal(fs.existsSync(kuyrukYolu(p)), false, 'tam yazim kuyruk birakmamali')
  const anaBoyut = fs.statSync(p).size
  assert.equal(anaBoyut, 24 + N * 6 * 8)

  // Tek bar ekleme: ana dosya bayt bayt ayni kalmali, kuyruk 48 bayt olmali.
  const r = await binstore.appendSeries(p, buyukSeri(1, t0 + N * dt, dt))
  assert.equal(r.added, 1)
  assert.equal(r.total, N + 1)
  assert.equal(fs.statSync(p).size, anaBoyut, 'tek bar eklemek ana dosyayi yeniden yazmamali')
  assert.equal(fs.statSync(kuyrukYolu(p)).size, 48, 'kuyrukta bar basina 48 bayt olmali')

  const st = await binstore.statSeries(p)
  assert.equal(st.count, N + 1, 'statSeries kuyrugu da saymali')
  assert.equal(st.firstTime, t0)
  assert.equal(st.lastTime, t0 + N * dt)

  const geri = await binstore.readSeries(p)
  assert.equal(geri.length, N + 1, 'readSeries kuyrugu da dondurmeli')
  assert.equal(geri.time[N], t0 + N * dt)
  assert.equal(geri.time[0], t0)

  // OLCUM: 5 kuyruk ekleme ile 5 tam yazim karsilastirilir.
  let t = process.hrtime.bigint()
  for (let i = 1; i <= 5; i++) {
    await binstore.appendSeries(p, buyukSeri(1, t0 + (N + i) * dt, dt))
  }
  const kuyrukSure = Number(process.hrtime.bigint() - t) / 1e6

  // Ana dosyanin SON barini yeniden gondermek tam yazimi zorlar (gelen bar
  // artik ana dosyanin son zamanindan yeni degil).
  t = process.hrtime.bigint()
  for (let i = 0; i < 5; i++) {
    await binstore.appendSeries(p, buyukSeri(1, t0 + (N - 1) * dt, dt))
  }
  const tamSure = Number(process.hrtime.bigint() - t) / 1e6

  assert.ok(
    kuyrukSure * 2 < tamSure,
    'kuyruga ekleme tam yazimdan belirgin hizli olmali (kuyruk ' +
      kuyrukSure.toFixed(1) + ' ms, tam ' + tamSure.toFixed(1) + ' ms)'
  )
  // Tam yazim kuyrugu ana dosyaya sikistirir.
  assert.equal(fs.existsSync(kuyrukYolu(p)), false)
  const stSon = await binstore.statSeries(p)
  assert.equal(stSon.count, N + 6)
  assert.equal(geciciDosyalar(kok).length, 0, 'gecici dosya kalmamali')
})

test('appendSeries: iki esanli ekleme sirayla kosar, iki bar da okunur', async () => {
  const p = yol('esanli.bin')
  await binstore.writeSeries(p, seriKur([100, 200, 300]))
  await Promise.all([
    binstore.appendSeries(p, seriKur([400], 400)),
    binstore.appendSeries(p, seriKur([500], 500)),
  ])
  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time.subarray(0, geri.length)), [100, 200, 300, 400, 500])
  const st = await binstore.statSeries(p)
  assert.equal(st.count, 5)
  assert.equal(geciciDosyalar(kok).length, 0)
})

test('writeSeries: iki esanli tam yazim birbirinin verisini bozmaz', async () => {
  // Gecici dosya adi sabit `.tmp` iken iki yazar ayni dosyaya yaziyor ve
  // ikinci rename yarim tamponu ana dosyanin uzerine tasiyordu.
  const p = yol('esanli-yazim.bin')
  await Promise.all([
    binstore.writeSeries(p, buyukSeri(20000, 1000, 60)),
    binstore.writeSeries(p, buyukSeri(20000, 1000, 60)),
  ])
  const geri = await binstore.readSeries(p)
  assert.equal(geri.length, 20000)
  assert.equal(geri.time[19999], 1000 + 19999 * 60)
  assert.equal(geciciDosyalar(kok).length, 0)
})

test('appendSeries: kuyruk 5000 bari asinca ana dosyaya sikisir', async () => {
  const p = yol('kuyruk-siniri.bin')
  const dt = 60
  const t0 = 1000
  await binstore.writeSeries(p, buyukSeri(10, t0, dt))
  const anaBoyut = fs.statSync(p).size

  let sonraki = t0 + 10 * dt
  for (let k = 0; k < 5; k++) {
    await binstore.appendSeries(p, buyukSeri(1000, sonraki, dt))
    sonraki += 1000 * dt
  }
  assert.equal(fs.statSync(kuyrukYolu(p)).size, 5000 * 48, 'kuyruk tam 5000 bar olmali')
  assert.equal(fs.statSync(p).size, anaBoyut, 'ana dosya 5000 bara kadar dokunulmamali')

  // Bir bar daha: sinir asilir, kuyruk ana dosyaya sikisir.
  const r = await binstore.appendSeries(p, buyukSeri(1, sonraki, dt))
  assert.equal(r.total, 5011)
  assert.equal(fs.existsSync(kuyrukYolu(p)), false, 'sikistirmadan sonra kuyruk silinmeli')
  assert.equal(fs.statSync(p).size, 24 + 5011 * 6 * 8)
  const geri = await binstore.readSeries(p)
  assert.equal(geri.length, 5011)
  assert.equal(geri.time[5010], sonraki)
})

test('readSeries: ayni zaman damgasi kuyrukta da varsa KUYRUK kazanir', async () => {
  const p = yol('kuyruk-kazanir.bin')
  await binstore.writeSeries(p, seriKur([100, 200, 300], 100))
  // Kuyruga elle iki kayit: biri ana dosyadaki 300 barini ezer, biri yeni.
  fs.writeFileSync(
    kuyrukYolu(p),
    Buffer.concat([
      kuyrukSatiri({ time: 300, open: 900, high: 901, low: 899, close: 900.5, volume: 77 }),
      kuyrukSatiri({ time: 400, open: 910, high: 911, low: 909, close: 910.5, volume: 88 }),
    ])
  )

  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time.subarray(0, geri.length)), [100, 200, 300, 400])
  assert.equal(geri.open[2], 900, '300 barinda kuyruk degeri kazanmali')
  assert.equal(geri.volume[2], 77)
  assert.equal(geri.open[3], 910)
  // Cakisan bar sayiyi buyutmez.
  const st = await binstore.statSeries(p)
  assert.equal(st.count, 4)
  assert.equal(st.lastTime, 400)
})

test('ana dosyasi olmayan kuyruk artigi YOK SAYILIR', async () => {
  // Kullanici .bin dosyasini elle silerse kuyruk artigi kalabilir. Onu geri
  // vermek silinmis bir depoyu bir kac barla canliymis gibi gosterirdi.
  const p = yol('artik-kuyruk.bin')
  fs.writeFileSync(
    kuyrukYolu(p),
    kuyrukSatiri({ time: 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })
  )
  assert.equal(await binstore.readSeries(p), null)
  assert.equal(await binstore.statSeries(p), null)

  const r = await binstore.appendSeries(p, seriKur([100, 200]))
  assert.equal(r.total, 2, 'artik kuyruk yeni depoya karismamali')
  assert.equal(fs.existsSync(kuyrukYolu(p)), false, 'artik kuyruk silinmeli')
  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time.subarray(0, geri.length)), [100, 200])
})

test('compactTail: ana dosyasi olmayan kuyrugu siler, depo uretmez', async () => {
  const p = yol('artik-sikistir.bin')
  fs.writeFileSync(
    kuyrukYolu(p),
    kuyrukSatiri({ time: 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })
  )
  const r = await binstore.compactTail(p)
  assert.equal(r.compacted, 0)
  assert.equal(r.total, 0)
  assert.equal(fs.existsSync(kuyrukYolu(p)), false)
  assert.equal(fs.existsSync(p), false, 'olmayan depo icin ana dosya olusturulmamali')
})

test('compactTail: kuyrugu ana dosyaya isler, veriyi korur', async () => {
  const p = yol('sikistir.bin')
  await binstore.writeSeries(p, seriKur([100, 200, 300]))
  await binstore.appendSeries(p, seriKur([400, 500], 400))
  assert.equal(fs.existsSync(kuyrukYolu(p)), true)

  const oncesi = await binstore.readSeries(p)
  const r = await binstore.compactTail(p)
  assert.equal(r.compacted, 2)
  assert.equal(r.total, 5)
  assert.equal(fs.existsSync(kuyrukYolu(p)), false)
  assert.equal(fs.statSync(p).size, 24 + 5 * 6 * 8, 'barlar artik ana dosyada olmali')

  const sonrasi = await binstore.readSeries(p)
  for (const alan of ['time', 'open', 'high', 'low', 'close', 'volume']) {
    assert.deepEqual(
      Array.from(sonrasi[alan].subarray(0, sonrasi.length)),
      Array.from(oncesi[alan].subarray(0, oncesi.length)),
      alan + ' sutunu sikistirmada degisti'
    )
  }

  // Kuyruk yokken cagri ana dosyayi yeniden YAZMAZ.
  const durum = fs.statSync(p)
  const r2 = await binstore.compactTail(p)
  assert.equal(r2.compacted, 0)
  assert.equal(r2.total, 5)
  assert.equal(fs.statSync(p).mtimeMs, durum.mtimeMs)
})

test('writeSeries: mevcut kuyrugu siler (tam yazim her seyi kapsar)', async () => {
  const p = yol('yazim-kuyrugu-siler.bin')
  await binstore.writeSeries(p, seriKur([100, 200]))
  await binstore.appendSeries(p, seriKur([300], 300))
  assert.equal(fs.existsSync(kuyrukYolu(p)), true)

  await binstore.writeSeries(p, seriKur([1000, 2000]))
  assert.equal(fs.existsSync(kuyrukYolu(p)), false, 'tam yazimdan sonra kuyruk kalmamali')
  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time.subarray(0, geri.length)), [1000, 2000])
})

test('appendSeries: sifir barlik mevcut dosyaya ekleme kuyruktan okunur', async () => {
  const p = yol('bos-dosyaya-ekle.bin')
  await binstore.writeSeries(p, series.emptySeries())
  const r = await binstore.appendSeries(p, seriKur([300, 400], 300))
  assert.equal(r.added, 2)
  assert.equal(r.total, 2)
  const st = await binstore.statSeries(p)
  assert.equal(st.count, 2)
  assert.equal(st.firstTime, 300)
  assert.equal(st.lastTime, 400)
  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time.subarray(0, geri.length)), [300, 400])
})

test('appendSeries: kuyruk bolgesine sirasiz gelen bar da dogru okunur', async () => {
  const p = yol('kuyruk-sirasiz.bin')
  await binstore.writeSeries(p, seriKur([100, 200]))
  await binstore.appendSeries(p, seriKur([400], 400))
  // 300, ana dosyanin son zamanindan (200) yeni: kuyruga gider ama kuyrugun
  // sonundaki 400'den once gelmeli.
  await binstore.appendSeries(p, seriKur([300], 300))
  const geri = await binstore.readSeries(p)
  assert.deepEqual(Array.from(geri.time.subarray(0, geri.length)), [100, 200, 300, 400])
  const st = await binstore.statSeries(p)
  assert.equal(st.count, 4)
  assert.equal(st.lastTime, 400)
})

test('compactTail: dosya yoksa 0 doner', async () => {
  const r = await binstore.compactTail(yol('hic-yok.bin'))
  assert.equal(r.compacted, 0)
  assert.equal(r.total, 0)
})

test('geriye uyum: kuyruk dosyasi olmayan depo aynen okunur', async () => {
  // Mevcut kurulumlarda kuyruk dosyasi yok; elle yazilmis bir dosya (bizim
  // yazicimizdan gecmemis) da aynen okunmali.
  const p = yol('eski-depo.bin')
  const n = 4
  const buf = Buffer.alloc(24 + n * 6 * 8)
  buf.write('ZMEM0001', 0, 8, 'ascii')
  buf.writeUInt32LE(1, 8)
  buf.writeUInt32LE(0, 12)
  buf.writeDoubleLE(n, 16)
  const sutunlar = [
    [1000, 1060, 1120, 1180],
    [1, 2, 3, 4],
    [2, 3, 4, 5],
    [0.5, 1.5, 2.5, 3.5],
    [1.2, 2.2, 3.2, 4.2],
    [10, 11, 12, 13],
  ]
  let o = 24
  for (const sutun of sutunlar) {
    for (const v of sutun) {
      buf.writeDoubleLE(v, o)
      o += 8
    }
  }
  fs.writeFileSync(p, buf)

  const geri = await binstore.readSeries(p)
  assert.equal(geri.length, n)
  assert.deepEqual(Array.from(geri.time.subarray(0, n)), sutunlar[0])
  assert.deepEqual(Array.from(geri.volume.subarray(0, n)), sutunlar[5])
  const st = await binstore.statSeries(p)
  assert.deepEqual(st, { count: 4, firstTime: 1000, lastTime: 1180 })
})

// series.appendInPlace testi burada: kuyruk calismasinin (V4) parcasi olarak
// eklendi, canli dongudeki tam kopyayi ortadan kaldirmak icin var.
test('series.appendInPlace: kapasiteye yerinde ekler, kopya almaz', async () => {
  const hedef = series.createSeries(0)
  const ilk = series.appendInPlace(hedef, seriKur([100, 200], 100))
  assert.equal(ilk.length, 2)

  // Kapasite yetiyorsa ayni tampon kullanilir.
  ilk.time = series.growF64(ilk.time, 10)
  ilk.open = series.growF64(ilk.open, 10)
  ilk.high = series.growF64(ilk.high, 10)
  ilk.low = series.growF64(ilk.low, 10)
  ilk.close = series.growF64(ilk.close, 10)
  ilk.volume = series.growF64(ilk.volume, 10)
  const kapasiteTamponu = ilk.time.buffer
  const ikinci = series.appendInPlace(ilk, seriKur([300], 300))
  assert.equal(ikinci.length, 3)
  assert.equal(ikinci.time.buffer, kapasiteTamponu, 'kapasite yeterken kopya alinmamali')
  assert.deepEqual(Array.from(ikinci.time.subarray(0, 3)), [100, 200, 300])

  // Ayni zamanli bar son barin UZERINE yazar, eski bar atlanir.
  const ucuncu = series.appendInPlace(ikinci, seriKur([300], 999))
  assert.equal(ucuncu.length, 3)
  assert.equal(ucuncu.open[2], 999)
  const dorduncu = series.appendInPlace(ucuncu, seriKur([150], 150))
  assert.equal(dorduncu.length, 3, 'son bardan eski satir atlanmali')
})
