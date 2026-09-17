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
  assert.equal(meta.version, 1)
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

  // Vektor dosyasi tam boyutta olmali.
  const rowLen = SHAPE_LEN + RET_LEN + CTX_NAMES.length
  assert.equal(fs.statSync(base + '.vec').size, 2 * rowLen * 4)
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

test('deleteMemory: her iki dosyayi da siler', async () => {
  const base = yol('hafiza-sil')
  await memstore.saveMemory(base, { tf: '15m', ctxNames: CTX_NAMES, events: [olay(0)] })
  assert.equal(fs.existsSync(base + '.json'), true)
  assert.equal(fs.existsSync(base + '.vec'), true)

  const silindi = await memstore.deleteMemory(base)
  assert.equal(silindi, true)
  assert.equal(fs.existsSync(base + '.json'), false)
  assert.equal(fs.existsSync(base + '.vec'), false)
  assert.equal(await memstore.loadMemory(base), null)
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
