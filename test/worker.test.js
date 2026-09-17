'use strict'

// A12 - src/main/worker/engine.worker.js testleri (CONTRACTS.md bolum 18-20).
//
// GERCEK ISCI IPLIGIYLE calisir: worker_threads ile isci baslatilir, veri
// klasoru gecici bir dizindir. Boylece protokol (id / cmd / payload ->
// result / error), ayar birlestirme ve diske yazilan olcum ozeti birlikte
// dogrulanir. Kullanicinin gercek veri klasorune (Application Support)
// DOKUNULMAZ.
//
// Kilitlenen hatalar:
//   1. engine:backtest yuk bicimi degisti. Bir donem renderer esikleri UST
//      DUZEYDE gonderiyordu, isci ise payload.cfg okuyordu: Test sekmesi
//      kullanicinin esiklerini degil hazir ayari olcuyordu ve bu hicbir yerde
//      gorunmuyordu. Eski bicim artik ANLASILIR HATA firlatmali.
//   2. Plan hedefi ile etiket hedefi ayni olmali: usedCfg.outcomeCfg
//      HAFIZANIN kuruldugu outcomeCfg'den gelir.
//   3. Kullanici ayari hafizanin izinden farkliysa cfgMatch false olmali,
//      yoksa "gecmiste %X tuttu" rakami eski etiketlere ait olur.
//   4. Olcum ozeti diske yazilmali: uygulama kapaninca kaybolmasin.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const memstore = require('../src/core/store/memstore')
const pathsCore = require('../src/core/paths-core')
const { CTX_NAMES, FEATURE_VERSION } = require('../src/core/learn/features')
const { DEFAULT_OUTCOME_CFG } = require('../src/core/learn/outcome')
const fixtures = require('./helpers/fixtures')

const ISCI_YOLU = path.join(__dirname, '..', 'src', 'main', 'worker', 'engine.worker.js')
const TF = '15m'
/** Hafizanin kuruldugu indikator ayari (ayar izinin bir parcasi). */
const INDIKATOR_AYARI = { pivotLen: 5, minFlowToShow: 6 }
/**
 * Hafizanin kuruldugu etiket tanimi. 15 dakikalik hazir ayarin hedefi de 1.5
 * oldugu icin kullanici hicbir sey degistirmediginde iz UYUSUR.
 */
const HAFIZA_OUTCOME = Object.assign({}, DEFAULT_OUTCOME_CFG, { targetAtr: 1.5 })

/**
 * Gecici veri klasoru kurar ve icine kucuk bir hafiza yazar.
 * @returns {Promise<string>} dataDir
 */
async function veriKlasoru () {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-worker-'))
  const mem = fixtures.hafizaKur({
    adet: 60,
    basarili: 20,
    tf: TF,
    aralik: 900,
    kind: (i) => (i % 2 === 0 ? 'touch' : 'form'),
    yon: (i) => (i % 3 === 0 ? 'BUY' : 'SELL'),
    ozellik: (i) => fixtures.ozellik(i),
  })
  await memstore.saveMemory(pathsCore.memoryPath(TF, undefined, dataDir), {
    tf: TF,
    ctxNames: CTX_NAMES.slice(),
    events: mem.events,
    builtToTime: mem.events[mem.events.length - 1].time,
    // AYAR IZI: hafiza hangi indikator ayari ve hangi etiket tanimiyla kuruldu.
    indicatorParams: INDIKATOR_AYARI,
    outcomeCfg: HAFIZA_OUTCOME,
    featureVersion: FEATURE_VERSION,
  })
  return dataDir
}

/**
 * Isci ipligini baslatir ve komut cagirmak icin bir yardimci dondurur.
 * @param {string} dataDir
 */
function isciKur (dataDir) {
  const w = new Worker(ISCI_YOLU, { workerData: { dataDir: dataDir, userDataDir: dataDir } })
  const bekleyen = new Map()
  let sonId = 0

  w.on('message', (m) => {
    if (!m || (m.type !== 'result' && m.type !== 'error')) return
    const p = bekleyen.get(m.id)
    if (!p) return
    bekleyen.delete(m.id)
    if (m.type === 'error') p.rej(new Error(m.message))
    else p.res(m.data)
  })
  w.on('error', (err) => {
    for (const p of bekleyen.values()) p.rej(err)
    bekleyen.clear()
  })

  function cagir (cmd, payload) {
    return new Promise((res, rej) => {
      const id = ++sonId
      bekleyen.set(id, { res: res, rej: rej })
      w.postMessage({ id: id, cmd: cmd, payload: payload || {} })
    })
  }

  return { w: w, cagir: cagir }
}

/** Test govdesini gecici klasor ve isci ile kosar, sonunda ikisini de kapatir. */
async function isciyle (govde) {
  const dataDir = await veriKlasoru()
  const { w, cagir } = isciKur(dataDir)
  try {
    await govde(cagir, dataDir)
  } finally {
    await w.terminate()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

/** Testlerde kullanilan esikler: sentetik hafiza kucuk oldugu icin dusuruldu. */
function testCfg (ek) {
  return Object.assign({
    warmupEvents: 2,
    // Asil isinma olcutu tur + yon bazinda aday sayisi; sentetik hafizada 0.
    warmupPerBucket: 0,
    cfgPatch: { signalCfg: { minMatches: 3, minWinRate: 0.4, minSimilarity: 0.5 } },
  }, ek || {})
}

test('isci bilinmeyen komutta anlasilir hata doner', async () => {
  await isciyle(async (cagir) => {
    await assert.rejects(() => cagir('olmayan:komut', {}), /Bilinmeyen komut/)
    // Hata protokolu isciyi oldurmez, sonraki komut yine calisir.
    const st = await cagir('data:status', {})
    assert.ok(st && Array.isArray(st.tfs))
  })
})

test('engine:backtest YENI yuk bicimiyle calisir ve esikleri kullanir', async () => {
  await isciyle(async (cagir) => {
    const r = await cagir('engine:backtest', { tf: TF, cfg: testCfg() })
    assert.equal(r.tf, TF)
    assert.ok(r.summary, 'ozet donmeli')
    assert.equal(r.summary.warmupEvents, 2, 'isinma degeri ozete yazilmali')
    assert.equal(r.usedCfg.signalCfg.minMatches, 3, 'gonderilen esik kullanilmali')
    assert.ok(Math.abs(r.usedCfg.signalCfg.minWinRate - 0.4) < 1e-12)
    assert.ok(Math.abs(r.usedCfg.signalCfg.minSimilarity - 0.5) < 1e-12)
    assert.equal(r.usedCfg.warmupEvents, 2)
    // Hangi degerin nereden geldigi arayuzde gosterilir.
    assert.equal(r.usedCfg.sources.minMatches, 'kullanici')
  })
})

test('engine:backtest ESKI yuk bicimini SESSIZCE YOK SAYMAZ, hata firlatir', async () => {
  await isciyle(async (cagir) => {
    // Esikler ve isinma bir donem UST DUZEYDE gonderiliyordu; isci onlari
    // okumadigi icin kullanicinin esikleri hicbir yere gitmiyordu.
    await assert.rejects(
      () => cagir('engine:backtest', { tf: TF, warmupEvents: 2, signalCfg: { minMatches: 3 } }),
      /yuk bicimi degisti/
    )
    await assert.rejects(
      () => cagir('engine:backtest', { tf: TF, outcomeCfg: { targetAtr: 2 } }),
      /cfg/
    )
    // Gecersiz zaman dilimi de anlasilir hata verir.
    await assert.rejects(() => cagir('engine:backtest', { tf: '7m', cfg: testCfg() }), /zaman dilimi/)
  })
})

test('plan hedefi HAFIZANIN etiketlendigi outcomeCfg ile ayni olur', async () => {
  await isciyle(async (cagir) => {
    const r = await cagir('engine:backtest', { tf: TF, cfg: testCfg() })
    assert.equal(r.usedCfg.outcomeCfg.targetAtr, HAFIZA_OUTCOME.targetAtr,
      'plan hedefi hafizanin hedefi olmali')
    assert.equal(r.memory.cfgHash && r.memory.cfgHash.length, 12, 'hafizanin ayar izi okunmali')
    assert.equal(r.cfgMatch, true, 'kullanici bir sey degistirmediyse iz uyusmali')
    assert.equal(r.usedCfg.sources.plan, 'hafiza')
  })
})

test('kullanici hedefi degistirince cfgMatch false olur, plan yine hafizadan gelir', async () => {
  await isciyle(async (cagir) => {
    const r = await cagir('engine:backtest', {
      tf: TF,
      cfg: testCfg({
        cfgPatch: {
          outcomeCfg: { targetAtr: 2.5 },
          signalCfg: { minMatches: 3, minWinRate: 0.4, minSimilarity: 0.5 },
        },
      }),
    })
    assert.equal(r.cfgMatch, false,
      'hafiza baska ayarla kurulduysa olcum uyarilmali')
    // Plan geometrisi yine HAFIZANIN tanimindan gelir: "bolge tuttu" ile
    // "TP1 vuruldu" ayni olay olmak zorunda.
    assert.equal(r.usedCfg.outcomeCfg.targetAtr, HAFIZA_OUTCOME.targetAtr)
  })
})

test('engine:backtest-last diske yazilan ozeti geri verir', async () => {
  await isciyle(async (cagir, dataDir) => {
    const once = await cagir('engine:backtest-last', { tf: TF })
    assert.equal(once.found, false, 'olcum yapilmadan ozet olmamali')

    const r = await cagir('engine:backtest', { tf: TF, cfg: testCfg() })
    const dosya = pathsCore.memoryPath(TF, undefined, dataDir) + '.backtest.json'
    assert.equal(fs.existsSync(dosya), true, 'olcum ozeti diske yazilmali')

    const sonra = await cagir('engine:backtest-last', { tf: TF })
    assert.equal(sonra.found, true)
    assert.equal(sonra.tf, TF)
    assert.equal(sonra.stillValid, true, 'hafizanin izi degismediyse ozet gecerli')
    assert.equal(sonra.summary.warmupEvents, r.summary.warmupEvents)
    assert.equal(sonra.usedCfg.signalCfg.minMatches, 3)
    assert.equal(sonra.cfgMatch, r.cfgMatch)
  })
})

test('data:status ayar izini ve olcum dosyasinin varligini bildirir', async () => {
  await isciyle(async (cagir) => {
    const ilk = await cagir('data:status', {})
    const satir = ilk.byTf[TF]
    assert.ok(satir, '15m satiri bulunmali')
    assert.equal(satir.hasMemory, true)
    assert.equal(satir.memoryCount, 60)
    assert.equal(satir.memoryCtxLen, CTX_NAMES.length)
    assert.equal(satir.memoryCurrent, true, 'hafiza guncel surumle uretilmis olmali')
    assert.ok(satir.memoryCfgHash, 'ayar izi dolu olmali')
    assert.match(satir.memoryCfgHash, /^[0-9a-f]{12}$/)
    assert.equal(satir.memoryCfgMatch, true)
    assert.equal(satir.hasBacktest, false, 'olcum yapilmadan dosya olmamali')

    await cagir('engine:backtest', { tf: TF, cfg: testCfg() })

    const sonra = await cagir('data:status', {})
    assert.equal(sonra.byTf[TF].hasBacktest, true, 'olcumden sonra dosya gorunmeli')
    assert.ok(sonra.byTf[TF].memoryCfgHash)

    // Kullanicinin ayari hafizadan farkliysa durum satiri da uyarir.
    const farkli = await cagir('data:status', { cfgPatch: { outcomeCfg: { targetAtr: 2.5 } } })
    assert.equal(farkli.byTf[TF].memoryCfgMatch, false)
  })
})

test('engine:memory-summary hafiza ozetini tur bazinda verir', async () => {
  await isciyle(async (cagir) => {
    const r = await cagir('engine:memory-summary', { tf: TF })
    assert.equal(r.count, 60)
    assert.ok(r.summary)
    assert.equal(r.summary.byKind.form.total + r.summary.byKind.touch.total, 60)
    assert.equal(r.summary.total, 60)
  })
})
