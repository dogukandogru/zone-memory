'use strict'

// A12 - src/core/store/memstore.js testleri (CONTRACTS.md bolum 6 ve 21).
// Gecici klasorde calisir, sonunda temizler.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const memstore = require('../src/core/store/memstore')
const { CTX_NAMES, SHAPE_LEN, RET_LEN } = require('../src/core/learn/features')
const fixtures = require('./helpers/fixtures')

let kok = null

before(() => {
  kok = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-memstore-'))
})

after(() => {
  if (kok) fs.rmSync(kok, { recursive: true, force: true })
})

/** Test klasorunde temel yol. */
function yol (ad) {
  return path.join(kok, ad)
}

/** Deterministik ozellik vektoru (bkz. test/helpers/fixtures.js). */
function ozellik (tohum) {
  return fixtures.ozellik(tohum)
}

/**
 * Sentetik hafiza kaydi. Alanlarin tamami ortak yardimcidan gelir, boylece
 * sozlesme degistiginde (ornegin baglam vektoru uzarsa) tek yerden guncellenir.
 */
function olay (i) {
  return fixtures.olay({
    i: i,
    zoneId: i * 2,
    yon: i % 2 === 0 ? 'BUY' : 'SELL',
    basarili: i % 3 === 0,
    bar: 100 + i,
    time: 1700000000 + i * 3600,
    price: 1900 + i,
    atr: 1.5,
    qualified: i % 3 === 0,
    mfeAtr: 1.25,
    maeAtr: 0.75,
    fwdReturnPct: 0.5,
    features: ozellik(i),
  })
}

test('loadMemory / statMemory: dosya yoksa null doner', async () => {
  assert.equal(await memstore.loadMemory(yol('yok')), null)
  assert.equal(await memstore.statMemory(yol('yok')), null)
})

test('saveMemory / loadMemory: gidis donus tum alanlari korur', async () => {
  const base = yol('hafiza1')
  const events = []
  for (let i = 0; i < 6; i++) events.push(olay(i))

  const r = await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })
  assert.equal(r.count, 6)
  assert.equal(r.rowLen, SHAPE_LEN + RET_LEN + CTX_NAMES.length)

  const geri = await memstore.loadMemory(base)
  assert.notEqual(geri, null)
  assert.equal(geri.tf, '15m')
  assert.deepEqual(geri.ctxNames, CTX_NAMES)
  assert.equal(geri.events.length, 6)

  for (let i = 0; i < 6; i++) {
    const a = events[i]
    const b = geri.events[i]
    for (const alan of ['id', 'zoneId', 'isSupport', 'direction', 'bar', 'time', 'price',
      'zoneTop', 'zoneBottom', 'zoneFlow', 'zoneAgeBars', 'penetration', 'atr',
      'score', 'maxScore', 'qualified', 'strong', 'session',
      'outcome', 'success', 'mfeAtr', 'maeAtr', 'fwdReturnPct', 'barsToOutcome']) {
      assert.deepEqual(b[alan], a[alan], i + '. kaydin ' + alan + ' alani bozulmus')
    }
    assert.deepEqual(b.parts, a.parts, i + '. kaydin parts alani bozulmus')
  }
})

test('loadMemory: features geri kurulur ve dogru uzunluklarda olur', async () => {
  const base = yol('hafiza2')
  const events = []
  for (let i = 0; i < 4; i++) events.push(olay(i))
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })

  const geri = await memstore.loadMemory(base)
  for (let i = 0; i < 4; i++) {
    const f = geri.events[i].features
    assert.ok(f, i + '. kayitta features yok')
    assert.ok(f.shape instanceof Float32Array)
    assert.ok(f.ret instanceof Float32Array)
    assert.ok(f.ctx instanceof Float32Array)
    assert.equal(f.shape.length, SHAPE_LEN)
    assert.equal(f.ret.length, RET_LEN)
    assert.equal(f.ctx.length, CTX_NAMES.length)

    const b = ozellik(i)
    for (let d = 0; d < SHAPE_LEN; d++) {
      assert.ok(Math.abs(f.shape[d] - b.shape[d]) < 1e-6, 'shape[' + d + '] bozulmus')
    }
    for (let d = 0; d < RET_LEN; d++) {
      assert.ok(Math.abs(f.ret[d] - b.ret[d]) < 1e-6, 'ret[' + d + '] bozulmus')
    }
    for (let d = 0; d < CTX_NAMES.length; d++) {
      assert.ok(Math.abs(f.ctx[d] - b.ctx[d]) < 1e-6, 'ctx[' + d + '] bozulmus')
    }
  }
})

test('saveMemory: JSON icinde features YOK, meta alanlari dolu', async () => {
  const base = yol('hafiza3')
  const events = [olay(0), olay(1)]
  await memstore.saveMemory(base, { tf: '5m', ctxNames: CTX_NAMES, events })

  const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  assert.equal(meta.version, 2)
  assert.equal(meta.tf, '5m')
  assert.equal(meta.count, 2)
  assert.equal(meta.shapeLen, SHAPE_LEN)
  assert.equal(meta.retLen, RET_LEN)
  assert.equal(meta.ctxLen, CTX_NAMES.length)
  assert.equal(meta.rowLen, SHAPE_LEN + RET_LEN + CTX_NAMES.length)
  assert.deepEqual(meta.ctxNames, CTX_NAMES)
  for (const e of meta.events) {
    assert.equal('features' in e, false, 'features JSON dosyasina yazilmamali')
  }

  // Vektor dosyasi tam boyutta olmali: 24 baytlik baslik + veri.
  const rowLen = SHAPE_LEN + RET_LEN + CTX_NAMES.length
  assert.equal(fs.statSync(base + '.vec').size, 24 + 2 * rowLen * 4)
})

test('saveMemory: features eksikse hata firlatir', async () => {
  const base = yol('hafiza-eksik')
  const bozuk = olay(0)
  delete bozuk.features
  await assert.rejects(
    () => memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events: [bozuk] }),
    /features/i
  )
})

test('statMemory: sayim, tf ve ilk/son zaman', async () => {
  const base = yol('hafiza4')
  const events = []
  for (let i = 0; i < 5; i++) events.push(olay(i))
  await memstore.saveMemory(base, { tf: '1h', ctxNames: CTX_NAMES, events })

  const st = await memstore.statMemory(base)
  assert.equal(st.count, 5)
  assert.equal(st.tf, '1h')
  assert.equal(st.firstTime, events[0].time)
  assert.equal(st.lastTime, events[4].time)
})

test('saveMemory / loadMemory: bos hafiza', async () => {
  const base = yol('hafiza-bos')
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events: [] })
  const geri = await memstore.loadMemory(base)
  assert.notEqual(geri, null)
  assert.equal(geri.events.length, 0)
  assert.deepEqual(geri.ctxNames, CTX_NAMES)
})

test('deleteMemory: json, vec ve yan ozet dosyasini siler', async () => {
  const base = yol('hafiza-sil')
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events: [olay(0)] })
  assert.equal(fs.existsSync(base + '.json'), true)
  assert.equal(fs.existsSync(base + '.vec'), true)
  assert.equal(fs.existsSync(base + '.meta.json'), true)

  const silindi = await memstore.deleteMemory(base)
  assert.equal(silindi, true)
  assert.equal(fs.existsSync(base + '.json'), false)
  assert.equal(fs.existsSync(base + '.vec'), false)
  // Yan ozet geride kalirsa statMemory silinmis bir hafizayi var gosterirdi.
  assert.equal(fs.existsSync(base + '.meta.json'), false)
  assert.equal(await memstore.loadMemory(base), null)
  assert.equal(await memstore.statMemory(base), null)
})

// O6 - ayar izi: hafiza hangi indikator ayari ve etiket tanimiyla kuruldu?
// Onceden yalnizca baglam vektorunun uzunlugu karsilastiriliyordu, bu yuzden
// ayar degisip tarama yapilmadiginda uyumsuzluk hicbir yerde gorunmuyordu.
test('saveMemory / loadMemory: ayar izi ve cfgHash yazilip okunur', async () => {
  const base = yol('iz')
  const indicatorParams = { pivotLen: 5, minFlowToShow: 6 }
  const outcomeCfg = { targetAtr: 1.5, horizonBars: 48 }

  await memstore.saveMemory(base, {
    tf: '15m',
    ctxNames: CTX_NAMES.slice(),
    indicatorParams: indicatorParams,
    outcomeCfg: outcomeCfg,
    featureVersion: 2,
    builtToTime: 1700000000,
    events: [Object.assign(olay(1), { features: ozellik(1) })],
  })

  const yuklenen = await memstore.loadMemory(base)
  assert.deepStrictEqual(yuklenen.meta.indicatorParams, indicatorParams)
  assert.deepStrictEqual(yuklenen.meta.outcomeCfg, outcomeCfg)
  assert.strictEqual(yuklenen.meta.featureVersion, 2)
  assert.ok(yuklenen.meta.builtAt, 'builtAt yazilmali')
  assert.match(yuklenen.meta.cfgHash, /^[0-9a-f]{12}$/)

  const ozet = await memstore.statMemory(base)
  assert.strictEqual(ozet.cfgHash, yuklenen.meta.cfgHash)

  // Ayni ayar ayni izi, farkli ayar farkli izi verir.
  const iz1 = memstore.cfgHash({ indicatorParams: indicatorParams, outcomeCfg: outcomeCfg, ctxNames: CTX_NAMES.slice() })
  const iz2 = memstore.cfgHash({ indicatorParams: indicatorParams, outcomeCfg: { targetAtr: 1.0, horizonBars: 48 }, ctxNames: CTX_NAMES.slice() })
  assert.strictEqual(iz1, yuklenen.meta.cfgHash)
  assert.notStrictEqual(iz1, iz2)
  // Anahtar sirasi izi degistirmez.
  assert.strictEqual(
    memstore.cfgHash({ ctxNames: CTX_NAMES.slice(), outcomeCfg: { horizonBars: 48, targetAtr: 1.5 }, indicatorParams: indicatorParams }),
    iz1
  )
})

// T4 - HAFIZA DOSYA BICIMI
// ===========================================================================
// saveMemory once .vec, sonra .json dosyasini AYRI AYRI rename ediyor. Arada
// kapanma, cokme ya da iptal olursa yeni .vec eski .json ile kaliyor ve her
// olaya BASKA bir olayin vektoru baglaniyordu. loadMemory yalnizca .vec'in
// KISA olup olmadigina baktigi icin bu hicbir uyari uretmiyor, tum benzerlik
// ve basari oranlari sessizce bozuluyordu. Asagidaki testler o sessizligi
// kapatiyor.

/**
 * Kayitli hafizayi ESKI (T4 oncesi) bicime cevirir: .vec basligi silinir,
 * JSON'dan buildId ile partsNames cikarilir, `parts` nesneye geri acilir ve
 * yan ozet dosyasi kaldirilir. Geriye uyumun gercek dosyayla ayni sartlarda
 * sinanmasi icin var.
 */
function eskiBicimeCevir (base) {
  const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  const adlar = meta.partsNames || []
  for (const e of meta.events) {
    if (typeof e.parts !== 'number') continue
    const nesne = {}
    for (let i = 0; i < adlar.length; i++) nesne[adlar[i]] = (e.parts & (1 << i)) !== 0
    e.parts = nesne
  }
  delete meta.buildId
  delete meta.partsNames
  meta.version = 1
  fs.writeFileSync(base + '.json', JSON.stringify(meta))

  const vec = fs.readFileSync(base + '.vec')
  fs.writeFileSync(base + '.vec', vec.subarray(24))
  fs.rmSync(base + '.meta.json', { force: true })
}

test('loadMemory: .vec beklenenden UZUNSA reddeder', async () => {
  const base = yol('uzun-vec')
  const events = []
  for (let i = 0; i < 4; i++) events.push(olay(i))
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })

  // Kesilen bir yazmadan ya da baska bir kayittan artan kuyruk. Eskiden
  // "kisa degil" diye kabul edilip bastan okunuyordu.
  fs.appendFileSync(base + '.vec', Buffer.alloc(64))
  await assert.rejects(() => memstore.loadMemory(base), /uyusmuyor/)
})

test('loadMemory: .vec beklenenden KISAYSA reddeder', async () => {
  const base = yol('kisa-vec')
  const events = []
  for (let i = 0; i < 4; i++) events.push(olay(i))
  const r = await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })

  fs.truncateSync(base + '.vec', 24 + (r.count - 1) * r.rowLen * 4)
  await assert.rejects(() => memstore.loadMemory(base), /uyusmuyor/)
})

test('loadMemory: yeni .vec + eski .json (buildId uyusmazligi) reddedilir', async () => {
  // Iki kayit AYNI olay sayisi ve AYNI satir uzunluguyla yazilir; tek fark
  // buildId'dir. Bicim baslik tasimasaydi bu takas fark edilemezdi.
  const eski = yol('takas-eski')
  const yeni = yol('takas-yeni')
  const a = []
  const b = []
  for (let i = 0; i < 5; i++) {
    a.push(olay(i))
    b.push(olay(i + 100))
  }
  const ra = await memstore.saveMemory(eski, { tf: '15m', ctxNames: CTX_NAMES, events: a })
  const rb = await memstore.saveMemory(yeni, { tf: '15m', ctxNames: CTX_NAMES, events: b })
  assert.equal(ra.count, rb.count)
  assert.equal(ra.rowLen, rb.rowLen)
  assert.notEqual(ra.buildId, rb.buildId, 'her kayit kendi buildId uretmeli')

  // Cokme senaryosu: .vec yeni kaydin, .json eski kaydin.
  fs.copyFileSync(yeni + '.vec', eski + '.vec')
  await assert.rejects(() => memstore.loadMemory(eski), /uyusmuyor/)
})

test('loadMemory: baslik count/rowLen uyusmazligini yakalar', async () => {
  const base = yol('baslik-sayim')
  const events = []
  for (let i = 0; i < 3; i++) events.push(olay(i))
  const r = await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })

  // JSON'dan bir olay dusurulur: baslik hala 3 diyor, uzunluk da tutmuyor.
  const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  meta.events.pop()
  meta.count = 2
  fs.writeFileSync(base + '.json', JSON.stringify(meta))
  assert.equal(r.count, 3)
  await assert.rejects(() => memstore.loadMemory(base), /uyusmuyor/)
})

test('loadMemory: basliksiz ESKI dosya (buildId ve yan ozet yok) sorunsuz yuklenir', async () => {
  const base = yol('eski-bicim')
  const events = []
  for (let i = 0; i < 4; i++) events.push(olay(i))
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })
  eskiBicimeCevir(base)

  const geri = await memstore.loadMemory(base)
  assert.notEqual(geri, null, 'eski bicim hafiza okunabilmeli')
  assert.equal(geri.events.length, 4)
  assert.equal(geri.meta.buildId, null)
  for (let i = 0; i < 4; i++) {
    const f = geri.events[i].features
    const b = ozellik(i)
    assert.equal(f.shape.length, SHAPE_LEN)
    assert.equal(f.ctx.length, CTX_NAMES.length)
    for (let d = 0; d < SHAPE_LEN; d++) {
      assert.ok(Math.abs(f.shape[d] - b.shape[d]) < 1e-6, i + '. kaydin shape[' + d + '] alani bozulmus')
    }
    // Maske yazilmamis eski dosyada `parts` nesne olarak gelir.
    assert.deepEqual(geri.events[i].parts, events[i].parts)
  }

  // Yan ozet olmadan statMemory eski yola, yani buyuk JSON'a dusmeli.
  assert.equal(fs.existsSync(base + '.meta.json'), false)
  const ozet = await memstore.statMemory(base)
  assert.equal(ozet.count, 4)
  assert.equal(ozet.tf, '15m')
  assert.equal(ozet.firstTime, events[0].time)
  assert.equal(ozet.lastTime, events[3].time)
  assert.equal(ozet.buildId, null)
})

test('loadMemory: eski .vec uzunlugu tutmuyorsa yine reddedilir', async () => {
  const base = yol('eski-bozuk')
  const events = [olay(0), olay(1)]
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })
  eskiBicimeCevir(base)
  fs.appendFileSync(base + '.vec', Buffer.alloc(16))
  await assert.rejects(() => memstore.loadMemory(base), /uyusmuyor/)
})

test('saveMemory: parts bit maskesi olarak yazilir ve geri acilir', async () => {
  const base = yol('parts-maske')
  const events = [olay(0), olay(1), olay(2)]
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })

  const ham = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  assert.deepEqual(ham.partsNames, ['flow', 'trend', 'session', 'rejection', 'volume'])
  for (const e of ham.events) {
    assert.equal(typeof e.parts, 'number', 'parts JSON icinde sayi olmali')
  }
  // Bit sirasi partsNames sirasidir: flow|trend|session|volume = 1+2+4+16.
  assert.equal(ham.events[0].parts, 23)

  const geri = await memstore.loadMemory(base)
  for (let i = 0; i < events.length; i++) {
    assert.deepEqual(geri.events[i].parts, events[i].parts, i + '. kaydin parts alani geri acilmadi')
  }
})

test('saveMemory: parts anahtarlari olaydan olaya degisirse maske kullanilmaz', async () => {
  // Maskede "anahtar yok" ile "anahtar false" ayni gorunur. Kume degiskense
  // gidis donus birebir kalmayacagi icin bicim nesneye duser.
  const base = yol('parts-degisken')
  const a = olay(0)
  const b = olay(1)
  a.parts = { flow: true, trend: false }
  b.parts = { flow: true, trend: false, volume: true }
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events: [a, b] })

  const ham = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  assert.equal(ham.partsNames, null)
  assert.deepEqual(ham.events[0].parts, { flow: true, trend: false })

  const geri = await memstore.loadMemory(base)
  assert.deepEqual(geri.events[0].parts, a.parts)
  assert.deepEqual(geri.events[1].parts, b.parts)
})

test('saveMemory: 7 haneye yuvarlama olaylari sayisal olarak ayni birakir', async () => {
  const base = yol('yuvarlama')
  const events = []
  for (let i = 0; i < 6; i++) {
    const e = olay(i)
    // Gercek hafizadaki gibi 17 haneli degerler.
    e.zoneFlow = 8.296740415470361
    e.entryDistAtr = 1.7810786632444904
    e.volRatio = 1.8390720211438218
    e.realizedR = -0.22660966424452163
    e.fwdReturnPct = 0.00015204995927232987
    events.push(e)
  }
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })
  const geri = await memstore.loadMemory(base)

  for (let i = 0; i < events.length; i++) {
    const a = events[i]
    const b = geri.events[i]
    for (const alan of Object.keys(a)) {
      if (alan === 'features' || alan === 'parts') continue
      const v = a[alan]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (Number.isInteger(v)) {
        assert.strictEqual(b[alan], v, i + '. kaydin ' + alan + ' tam sayisi degismis')
        continue
      }
      // 7 anlamli hane: bagil hata yarim birim, yani 5e-7'den kucuk kalmali.
      const bagil = Math.abs(b[alan] - v) / Math.abs(v)
      assert.ok(bagil < 1e-6, i + '. kaydin ' + alan + ' alani cok sapti: ' + v + ' -> ' + b[alan])
    }
  }

  // Yuvarlama gercekten uygulanmis mi (yoksa test hicbir sey kilitlemez).
  const ham = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  assert.strictEqual(ham.events[0].zoneFlow, 8.29674)
  assert.strictEqual(ham.events[0].fwdReturnPct, 0.00015205)
})

test('saveMemory: yuvarlama zaman damgalarini ve tam sayilari BOZMAZ', async () => {
  const base = yol('yuvarlama-zaman')
  // toPrecision(7) bu degerleri saniyelerce kaydirirdi; HAM_ALANLAR korur.
  const e = olay(0)
  e.time = 1737214763
  e.resolvedTime = 1737299999.5
  e.id = 1234567891
  e.zoneId = 987654321
  e.bar = 1234567
  e.resolvedBar = 1234599
  e.barsToOutcome = -1
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events: [e] })

  const ham = JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
  const g = ham.events[0]
  assert.strictEqual(g.time, 1737214763)
  assert.strictEqual(g.resolvedTime, 1737299999.5)
  assert.strictEqual(g.id, 1234567891)
  assert.strictEqual(g.zoneId, 987654321)
  assert.strictEqual(g.bar, 1234567)
  assert.strictEqual(g.resolvedBar, 1234599)
  assert.strictEqual(g.barsToOutcome, -1)

  const ozet = await memstore.statMemory(base)
  assert.strictEqual(ozet.firstTime, 1737214763)
  assert.strictEqual(ozet.lastTime, 1737214763)
})

test('statMemory: yan ozet dosyasindan okur, buyuk JSON gerekmez', async () => {
  const base = yol('yan-ozet')
  const events = []
  for (let i = 0; i < 5; i++) events.push(olay(i))
  const r = await memstore.saveMemory(base, {
    tf: '1h',
    ctxNames: CTX_NAMES,
    events,
    builtToTime: 1700009999,
    featureVersion: 3,
  })

  const yan = JSON.parse(fs.readFileSync(base + '.meta.json', 'utf8'))
  assert.equal('events' in yan, false, 'yan ozet olay listesi tasimamali')
  assert.equal(yan.buildId, r.buildId)
  assert.equal(yan.count, 5)
  assert.equal(yan.firstTime, events[0].time)
  assert.equal(yan.lastTime, events[4].time)
  assert.equal(yan.builtToTime, 1700009999)
  assert.equal(yan.ctxLen, CTX_NAMES.length)
  assert.ok(fs.statSync(base + '.meta.json').size < fs.statSync(base + '.json').size)

  // Buyuk JSON tumuyle silinse bile ozet yan dosyadan gelmeli: statMemory'nin
  // gercekten oraya baktigini kanitlayan tek olcum bu.
  fs.rmSync(base + '.json')
  const ozet = await memstore.statMemory(base)
  assert.equal(ozet.count, 5)
  assert.equal(ozet.tf, '1h')
  assert.equal(ozet.firstTime, events[0].time)
  assert.equal(ozet.lastTime, events[4].time)
  assert.equal(ozet.featureVersion, 3)
  assert.equal(ozet.buildId, r.buildId)
})

test('statMemory: yan ozet bozuksa buyuk JSON ile ayni sonucu verir', async () => {
  const base = yol('yan-bozuk')
  const events = []
  for (let i = 0; i < 4; i++) events.push(olay(i))
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events })

  const saglam = await memstore.statMemory(base)
  // Yan dosya yalnizca hizlandirma; bozulursa dogruluk kaybi olmamali.
  fs.writeFileSync(base + '.meta.json', '{ bozuk')
  const bozuk = await memstore.statMemory(base)
  assert.deepEqual(bozuk, saglam)
})

test('saveMemory: yeniden kayit yan ozeti ve buildId yi tazeler', async () => {
  const base = yol('yeniden-kayit')
  const r1 = await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events: [olay(0)] })
  const r2 = await memstore.saveMemory(base, {
    tf: '15m',
    ctxNames: CTX_NAMES,
    events: [olay(0), olay(1), olay(2)],
  })
  assert.notEqual(r1.buildId, r2.buildId)

  const ozet = await memstore.statMemory(base)
  assert.equal(ozet.count, 3)
  assert.equal(ozet.buildId, r2.buildId)
  // Ustune yazilan kayitta .vec ile .json hala ayni kayittan gelmeli.
  const geri = await memstore.loadMemory(base)
  assert.equal(geri.events.length, 3)
  assert.equal(geri.meta.buildId, r2.buildId)
  assert.equal(fs.existsSync(base + '.json.tmp'), false)
  assert.equal(fs.existsSync(base + '.vec.tmp'), false)
  assert.equal(fs.existsSync(base + '.meta.json.tmp'), false)
})

// BOS ALANLAR IZE GIRMEZ.
//
// Ize yeni bir alan eklendiginde (ornek: featureCfg) degeri varsayilanken
// null gelir. Null da katilsaydi, alanin eklendigi surumde HERKESIN izi
// degisir ve hicbir sey degismedigi halde tam yeniden tarama tetiklenirdi;
// 1 dakikalikta bu dakikalarca suren bir istir.
test('cfgHash: null ve undefined alanlar izi DEGISTIRMEZ', () => {
  const taban = { indicatorParams: { pivotLen: 5 }, ctxNames: ['a', 'b'] }
  const iz = memstore.cfgHash(taban)

  assert.strictEqual(memstore.cfgHash(Object.assign({}, taban, { featureCfg: null })), iz,
    'null alan izi degistirmemeli')
  assert.strictEqual(memstore.cfgHash(Object.assign({}, taban, { featureCfg: undefined })), iz,
    'undefined alan izi degistirmemeli')

  // Ama GERCEK bir deger izi degistirmeli, yoksa ayar degisimi yakalanmaz.
  assert.notStrictEqual(
    memstore.cfgHash(Object.assign({}, taban, { featureCfg: { shapeWindowBars: 64 } })), iz,
    'dolu alan izi DEGISTIRMELI')
})
