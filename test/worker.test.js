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
//   5. Canli kontrol AYNI BARDAKI tum olaylari degerlendirmeli. Onceden
//      yalnizca son olay aliniyordu ve `sinceTime` onun zamanina cekildigi
//      icin digerleri kalici olarak kayboluyordu.
//   6. Canli uretilen sinyaller diske yazilmali (JSON Lines gunlugu), aksi
//      halde canli performans Test sekmesindeki olcumle karsilastirilamaz.

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

/* ------------------------------------------------------------------ */
/* Canli tik icin sentetik mum serisi                                  */
/* ------------------------------------------------------------------ */

/** Canli seride ilk barin zamani (hafiza fixture'indan cok sonrasi). */
const CANLI_T0 = 1700000000
/** Canli seri uzunlugu. */
const CANLI_BAR = 600
/**
 * Dev barin indeksi. Bu bar hem pivot tepe hem pivot dip olacak kadar disa
 * tasar ve hacmi ortalamanin 6 katidir; boylece AYNI onay barinda (505) hem
 * direnc hem destek kutusu dogar ve ikisi de olay uretir.
 */
const CANLI_SICRAMA = 500
/** Iki olayin olustugu onay bari: pivot bari + pivotLen. */
const CANLI_OLAY_BAR = CANLI_SICRAMA + 5

/**
 * Canli tike gonderilen sutunsal seri. Dar aralikta gezen duz bir seridir,
 * tek istisnasi `CANLI_SICRAMA` barindaki dev dis bardir.
 * @returns {{length:number, time:number[], open:number[], high:number[],
 *            low:number[], close:number[], volume:number[]}}
 */
function canliSeri () {
  const s = { length: CANLI_BAR, time: [], open: [], high: [], low: [], close: [], volume: [] }
  for (let i = 0; i < CANLI_BAR; i++) {
    const taban = 2000 + Math.sin(i / 17) * 1.0
    const o = taban
    const c = taban + Math.sin(i / 5) * 0.3
    let h = taban + 1.2
    let l = taban - 1.2
    let v = 1000 + Math.sin(i / 7) * 50
    if (i === CANLI_SICRAMA) {
      // Fitiller hem BB bantlarinin disina tasar hem de komsu barlarin
      // uzerine/altina gecer; kapanis yerinde durdugu icin bantlar dar kalir.
      // Kutu kenarlari boylece fiyata yakin olur ve form riski 3 ATR sinirini
      // asmaz, yani olaylar etiketlenebilir.
      h = taban + 5
      l = taban - 5
      v = 6000
    }
    s.time.push(CANLI_T0 + i * 900)
    s.open.push(o)
    s.high.push(h)
    s.low.push(l)
    s.close.push(c)
    s.volume.push(v)
  }
  return s
}

/** Canli tik yuku. Butun barlar KAPANMIS sayilir (fetchedAt son barin otesi). */
function canliYuk (ek) {
  const seri = canliSeri()
  return Object.assign({
    tf: TF,
    series: seri,
    providerId: 'test-saglayici',
    isProxy: false,
    fetchedAt: seri.time[seri.length - 1] + 900 + 5,
    sinceTime: 0,
    // Indikator ayari hafizanin kuruldugu ayarla AYNI olmali, aksi halde iz
    // uyusmaz ve sinyal uretilmez.
    params: INDIKATOR_AYARI,
    // Sentetik hafiza kucuk ve benzerlikler dusuk oldugu icin esikler
    // indirilir; amac esik mantigini degil olay secimini ve gunlugu olcmek.
    cfgPatch: {
      signalCfg: { minMatches: 1, minWinRate: 0, minSimilarity: 0, minRr: 0, minExpectancy: -5 },
    },
  }, ek || {})
}

/** Canli gunluk dosyasinin satirlarini okur. */
function gunlukSatirlari (dataDir) {
  const dosya = pathsCore.memoryPath(TF, undefined, dataDir) + '.live.jsonl'
  if (!fs.existsSync(dosya)) return []
  return fs.readFileSync(dosya, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => JSON.parse(s))
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
      /yük biçimi değişti/
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

test('engine:live-tick: ayni bardaki iki olayin IKISI DE degerlendirilir', async () => {
  await isciyle(async (cagir) => {
    const r = await cagir('engine:live-tick', canliYuk())
    assert.ok(r.added > 0, 'kapanmis barlar depoya yazilmali')
    assert.ok(Array.isArray(r.events), 'events dizisi donmeli')
    assert.equal(r.events.length, 2, 'ayni bardaki iki olay da degerlendirilmeli')

    // Iki olay AYNI barda: biri direnc kutusunun dogumu, digeri destek.
    const a = r.events[0]
    const b = r.events[1]
    assert.equal(a.touch.time, b.touch.time, 'iki olay ayni barda olmali')
    assert.equal(a.touch.bar, CANLI_OLAY_BAR)
    assert.equal(a.touch.kind, 'form')
    assert.equal(b.touch.kind, 'form')
    assert.notEqual(a.key, b.key, 'olay anahtarlari ayri olmali')
    assert.notEqual(a.touch.direction, b.touch.direction, 'biri BUY biri SELL')
    assert.ok(a.signal, 'birinci olay icin sinyal uretilmeli')
    assert.ok(b.signal, 'ikinci olay icin de sinyal uretilmeli')

    // Geriye uyum: tekil alanlar dizinin SONUNCU elemanidir (arayuz ve
    // live.js bunlari okur).
    assert.equal(r.signal, r.events[1].signal)
    assert.equal(r.touch.time, r.events[1].touch.time)

    // Gecikme: olay bari cekim aninin cok gerisinde kaldi.
    assert.ok(a.ageBars > 1, 'gecikme bar cinsinden hesaplanmali')
    assert.equal(a.signal.stale, true, 'gecikmeli sinyal isaretlenmeli')
    assert.ok(
      a.signal.reasons.some((x) => /Gecikmeli değerlendirildi/.test(x)),
      'gecikme gerekce olarak yazilmali'
    )
  })
})

test('engine:live-tick canli gunluge satir yazar, engine:live-log ozet dondurur', async () => {
  await isciyle(async (cagir, dataDir) => {
    const once = await cagir('engine:live-log', { tf: TF })
    assert.equal(once.found, false, 'kayit yoksa bos ozet donmeli')
    assert.equal(once.count, 0)
    assert.deepEqual(once.records, [])

    const r = await cagir('engine:live-tick', canliYuk())
    assert.equal(r.events.length, 2)

    const satirlar = gunlukSatirlari(dataDir)
    const olaylar = satirlar.filter((s) => s.type === 'event')
    const sonuclar = satirlar.filter((s) => s.type === 'outcome')
    assert.equal(olaylar.length, 2, 'her olay icin bir satir yazilmali')
    assert.equal(olaylar[0].tf, TF)
    assert.equal(olaylar[0].providerId, 'test-saglayici', 'saglayici yuke eklenmeli')
    assert.equal(olaylar[0].isProxy, false)
    assert.ok(olaylar[0].key, 'olay anahtari yazilmali')
    assert.ok(olaylar[0].cfgHash, 'hafizanin ayar izi yazilmali')
    assert.ok(olaylar[0].ageBars > 1)
    assert.ok(olaylar[0].touch, 'olayin kendisi yazilmali')
    // Sinyal OZET tasir: agir alanlar (topMatches) gunluge girmez.
    assert.equal(typeof olaylar[0].signal.fired, 'boolean')
    assert.equal(olaylar[0].signal.topMatches, undefined)
    for (const alan of ['direction', 'kind', 'winRate', 'matchCount', 'confidence',
      'expectancy', 'entry', 'tp1', 'sl', 'rr', 'atr']) {
      assert.ok(alan in olaylar[0].signal, alan + ' ozette olmali')
    }

    // Ufku dolmus olaylar AYNI tikte etiketlenir: olay bari 505, ufuk 48 bar,
    // seri 600 bar.
    assert.equal(r.labeled, 2, 'ufku dolan iki kayit etiketlenmeli')
    assert.equal(sonuclar.length, 2)
    assert.equal(sonuclar[0].key, olaylar[0].key, 'sonuc satiri olayla ayni anahtari tasir')
    assert.ok(['respect', 'break', 'timeout', 'nofill'].indexOf(sonuclar[0].outcome) >= 0)
    assert.equal(typeof sonuclar[0].realizedR, 'number')
    assert.equal(typeof sonuclar[0].barsToOutcome, 'number')

    const ozet = await cagir('engine:live-log', { tf: TF, limit: 10 })
    assert.equal(ozet.found, true)
    assert.equal(ozet.tf, TF)
    assert.equal(ozet.count, 2, 'iki kayit gorunmeli')
    assert.equal(ozet.records.length, 2)
    assert.equal(ozet.stale, 2, 'iki olay da gecikmeli degerlendirildi')
    assert.equal(ozet.firstTime, ozet.lastTime, 'ikisi ayni barda')
    // Tetiklenen sinyaller: isabet ve net ATR YALNIZCA onlar uzerinden.
    const tetiklenen = olaylar.filter((s) => s.signal && s.signal.fired).length
    assert.equal(tetiklenen, 2, 'esikler indirildigi icin iki sinyal de tetiklenmeli')
    assert.equal(ozet.fired, tetiklenen)
    assert.equal(ozet.labeled, tetiklenen, 'tetiklenen kayitlarin sonucu belli')
    assert.ok(ozet.winRate >= 0 && ozet.winRate <= 1, 'isabet orani 0..1 arasinda')
    assert.equal(ozet.wins, ozet.records.filter((k) => k.win === true).length)
    assert.ok(Number.isFinite(ozet.netAtr))
    // Beklenti = net ATR / etiketlenen sinyal (test ozetiyle ayni taban).
    assert.ok(Math.abs(ozet.expectancyAtr - ozet.netAtr / ozet.labeled) < 1e-12)
    // Kayitlarin sonucu ozette de gorunur.
    assert.ok(ozet.records[0].outcome, 'kaydin sonucu ozete gecmeli')

    // TARAMA VE HAFIZA SILME GUNLUGE DOKUNMAZ: canli olcu taramadan
    // bagimsiz birikir.
    await cagir('engine:memory-delete', { tf: TF })
    assert.equal(gunlukSatirlari(dataDir).length, satirlar.length,
      'hafiza silinince canli gunluk silinmemeli')
    const silmeSonrasi = await cagir('engine:live-log', { tf: TF })
    assert.equal(silmeSonrasi.count, 2)
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

// ---------------------------------------------------------------------------
// U2 - BOLGE AYRINTISI YALNIZCA O BOLGENIN OLAYLARINI DONER
// ---------------------------------------------------------------------------
// Onceden `zoneId` yok sayiliyor, son 5000 olay donuyordu ve arayuz eslesme
// bulamayinca butun listeyi o bolgeninmis gibi basiyordu. Olculdu: yanlis
// liste gosterilen bolge payi 15m'de %42, 5m'de %74, 1m'de %92,4.

test('engine:touches zoneId verilince yalnizca o bolgenin olaylarini doner', async () => {
  await isciyle(async (cagir, dir) => {
    // Uc bolgeye dagilmis olaylar; biri zaman araliginin EN BASINDA.
    const mem = fixtures.hafizaKur({
      adet: 30,
      basarili: 20,
      tf: TF,
      alanlar: (i) => ({ zoneId: i % 3 }),
    })
    await memstore.saveMemory(path.join(dir, 'XAUUSD_' + TF + '_memory'), {
      tf: TF,
      ctxNames: CTX_NAMES.slice(),
      events: mem.events,
      builtToTime: mem.events[mem.events.length - 1].time,
      indicatorParams: INDIKATOR_AYARI,
      outcomeCfg: HAFIZA_OUTCOME,
    })

    const tek = await cagir('engine:touches', { tf: TF, zoneId: 1 })
    assert.ok(tek.touches.length > 0, 'bolgenin olaylari donmeli')
    for (const t of tek.touches) {
      assert.strictEqual(t.zoneId, 1, 'baska bolgenin olayi donmemeli')
    }
    assert.strictEqual(tek.total, tek.touches.length)
    assert.strictEqual(tek.truncated, false)
    assert.strictEqual(tek.zoneId, 1)

    // Hic olayi olmayan bolgede BOS liste doner (yedek liste yok).
    const bos = await cagir('engine:touches', { tf: TF, zoneId: 9999 })
    assert.strictEqual(bos.touches.length, 0, 'olayi olmayan bolgede bos liste')
    assert.strictEqual(bos.total, 0)

    // zoneId verilmezse eski davranis: zaman araligi ve limit calisir.
    const hepsi = await cagir('engine:touches', { tf: TF })
    assert.strictEqual(hepsi.touches.length, 30)
    assert.strictEqual(hepsi.zoneId, undefined)
  })
})

/* ------------------------------------------------------------------ */
/* Ayar izi degisince olcum dosyalari                                  */
/* ------------------------------------------------------------------ */

// KILITLENEN OLAY: indikator varsayilanlari bir GUNCELLEMEYLE degisti, ayar izi
// tutmadi ve tarama kullanicinin sinyal listesini SILDI. Kullanici hicbir sey
// degistirmemisti; uygulamayi acti ve 990 sinyali gitmisti, geri donusu yoktu.
// Artik dosyalar silinmez, `.onceki` ekiyle yedeklenir ve tarama sonucu bunu
// arayuze bildirir.

const binstore = require('../src/core/store/binstore')
const { fromArrays } = require('../src/core/series')

/** Tarama icin yeterli uzunlukta sentetik seri (kutu dogurmasi sart degil). */
function taramaSerisi () {
  const n = 800
  const s = { time: [], open: [], high: [], low: [], close: [], volume: [] }
  for (let i = 0; i < n; i++) {
    const taban = 2000 + Math.sin(i / 17)
    s.time.push(CANLI_T0 + i * 900)
    s.open.push(taban)
    s.high.push(taban + (i === 400 ? 5 : 1.2))
    s.low.push(taban - (i === 400 ? 5 : 1.2))
    s.close.push(taban + Math.sin(i / 5) * 0.3)
    s.volume.push(i === 400 ? 6000 : 1000)
  }
  // binstore tipli dizi bekler.
  return fromArrays(s)
}

/** Mum deposunu kurar, olcum dosyalarini verilen ayar iziyle yazar. */
async function olcumKur (dataDir, iz) {
  await binstore.writeSeries(pathsCore.candlePath(TF, undefined, dataDir), taramaSerisi())
  const kok = pathsCore.memoryPath(TF, undefined, dataDir)
  fs.writeFileSync(kok + '.signals.json', JSON.stringify([{ id: 1, fired: true }]))
  fs.writeFileSync(kok + '.backtest.json', JSON.stringify({ cfgHash: iz, summary: { fired: 1 } }))
  return kok
}

test('ayar izi DEGISINCE olcum dosyalari silinmez, .onceki olarak yedeklenir', async () => {
  await isciyle(async (cagir, dataDir) => {
    // Hicbir zaman uretilemeyecek bir iz: tarama kesinlikle "degisti" diyecek.
    const kok = await olcumKur(dataDir, 'baska-bir-ayarin-izi')

    const sonuc = await cagir('engine:scan', { tf: TF, params: INDIKATOR_AYARI })
    assert.strictEqual(sonuc.signalsInvalidated, true,
      'arayuz listeyi yeniden kurmak icin bunu bilmeli')

    // BU TESTIN BUTUN KONUSU: veri kaybolmadi, yerini degistirdi.
    assert.strictEqual(fs.existsSync(kok + '.signals.json'), false, 'gecersiz liste yerinde kalmamali')
    assert.strictEqual(fs.existsSync(kok + '.signals.json.onceki'), true, 'liste YEDEKLENMELI')
    assert.strictEqual(fs.existsSync(kok + '.backtest.json.onceki'), true, 'ozet YEDEKLENMELI')

    const yedek = JSON.parse(fs.readFileSync(kok + '.signals.json.onceki', 'utf8'))
    assert.deepStrictEqual(yedek, [{ id: 1, fired: true }], 'yedek icerigi BOZULMAMALI')
  })
})

test('ayar izi AYNIYSA olcum dosyalarina dokunulmaz', async () => {
  await isciyle(async (cagir, dataDir) => {
    // Once bir tarama yapip bu ayarin GERCEK izini ogren.
    await binstore.writeSeries(pathsCore.candlePath(TF, undefined, dataDir), taramaSerisi())
    await cagir('engine:scan', { tf: TF, params: INDIKATOR_AYARI })
    const meta = JSON.parse(
      fs.readFileSync(pathsCore.memoryPath(TF, undefined, dataDir) + '.meta.json', 'utf8'))
    assert.ok(meta.cfgHash, 'tarama ayar izini meta dosyasina yazmali')

    const kok = await olcumKur(dataDir, meta.cfgHash)
    const sonuc = await cagir('engine:scan', { tf: TF, params: INDIKATOR_AYARI })

    assert.strictEqual(sonuc.signalsInvalidated, false, 'ayar degismedi, liste gecerli')
    assert.strictEqual(fs.existsSync(kok + '.signals.json'), true, 'liste YERINDE KALMALI')
    assert.strictEqual(fs.existsSync(kok + '.signals.json.onceki'), false, 'gereksiz yedek olusmamali')
  })
})

/* ------------------------------------------------------------------ */
/* Olcum yenileme isareti                                              */
/* ------------------------------------------------------------------ */

// Depo baska bir kaynaktan yeniden kuruldugunda ayar izi DEGISMEZ (ayar
// aynidir, degisen veridir) ama eski sinyal listesi artik baska bir veri
// kumesinin olaylarina isaret eder. Veri paketi bu durumu bir isaret
// dosyasiyla tarama katmanina tasir.
//
// KILITLENEN OLAY: isaret bir donem TARAMA biter bitmez siliniyordu. Oysa
// olcumu yeniden kuran sey tarama degil, ardindan gelen TESTTIR ve test en
// uzun adimdir. Kullanici test sirasinda uygulamayi kapatirsa isaret gitmis,
// olcum dosyalari da yedege tasinmis oluyordu; sonraki acilista hafiza guncel
// oldugu icin tarama hic calismiyor ve liste KALICI olarak bos kaliyordu.

test('yenile isareti TARAMAYLA silinmez, olcum yeniden kurulana kadar durur', async () => {
  await isciyle(async (cagir, dataDir) => {
    const kok = await olcumKur(dataDir, 'baska-bir-ayarin-izi')
    const isaret = pathsCore.memoryPath(TF, undefined, dataDir) + '.yenile'
    fs.writeFileSync(isaret, JSON.stringify({ sebep: 'oanda-veri-paketi' }))

    const sonuc = await cagir('engine:scan', { tf: TF, params: INDIKATOR_AYARI })
    assert.strictEqual(sonuc.signalsInvalidated, true)
    // Sebep DOGRU soylenmeli: kullanici hicbir ayara dokunmadi.
    assert.strictEqual(sonuc.invalidationReason, 'veri')

    // BU TESTIN BUTUN KONUSU: test daha calismadi, isaret DURMALI.
    assert.strictEqual(fs.existsSync(isaret), true,
      'isareti tarama degil, olcumu yeniden kuran TEST tuketmeli')
    assert.strictEqual(fs.existsSync(kok + '.signals.json.onceki'), true)
  })
})

test('yenile isareti olmadan sebep "ayar" olur', async () => {
  await isciyle(async (cagir, dataDir) => {
    await olcumKur(dataDir, 'baska-bir-ayarin-izi')
    const sonuc = await cagir('engine:scan', { tf: TF, params: INDIKATOR_AYARI })
    assert.strictEqual(sonuc.signalsInvalidated, true)
    assert.strictEqual(sonuc.invalidationReason, 'ayar')
  })
})

test('yenile isaretini TEST tuketir', async () => {
  await isciyle(async (cagir, dataDir) => {
    const isaret = pathsCore.memoryPath(TF, undefined, dataDir) + '.yenile'
    fs.writeFileSync(isaret, JSON.stringify({ sebep: 'oanda-veri-paketi' }))

    await cagir('engine:backtest', { tf: TF, cfg: testCfg() })

    // Olcum yeniden kuruldu: isaret artik karsiligini buldu.
    assert.strictEqual(fs.existsSync(isaret), false,
      'test bittiginde isaret silinmeli, yoksa her acilista tekrar calisir')
  })
})

/* ------------------------------------------------------------------ */
/* Turetilmis zaman dilimleri                                          */
/* ------------------------------------------------------------------ */

// Veri paketi turetilmis dosyalari siler ve data:sync onlari geri yazar.
// KILITLENEN OLAY: geri yazma bir donem yalnizca "yeni bar indirildi"
// kosuluna bagliydi. Piyasa kapaliyken (hafta sonu) saglayici sifir bar
// doner, dosyalar silinmis kalirdi; uygulama calismaya devam ederdi ama her
// acilista milyonlarca bar bastan orneklenirdi.

/** 1 dakikalik taban seri (60 saniye araliklı). */
function tabanSerisi1m () {
  const n = 2000
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [] }
  for (let i = 0; i < n; i++) {
    const f = 2000 + Math.sin(i / 40)
    d.time.push(CANLI_T0 + i * 60)
    d.open.push(f)
    d.high.push(f + 0.4)
    d.low.push(f - 0.4)
    d.close.push(f + 0.1)
    d.volume.push(100)
  }
  return fromArrays(d)
}

test('data:sync EKSIK turetilmis dosyayi yeni bar gelmese de yazar', async () => {
  await isciyle(async (cagir, dataDir) => {
    // 1 dakikalik taban dolu, turetilmis dosya YOK (veri paketi silmisti).
    const taban = tabanSerisi1m()
    await binstore.writeSeries(pathsCore.candlePath('1m', undefined, dataDir), taban)
    const hedef = pathsCore.candlePath('5m', undefined, dataDir)
    assert.strictEqual(fs.existsSync(hedef), false, 'baslangicta yok')

    // Piyasa kapali: indirilecek yeni bar YOK. `to` deponun son barina esit
    // verilince aga hic cikilmaz ve added 0 kalir.
    const sonBar = taban.time[taban.length - 1]
    const sonuc = await cagir('data:sync', {
      tf: '5m', providerId: 'histdata', to: sonBar,
    })
    assert.strictEqual(sonuc.added, 0, 'yeni bar inmemis olmali')

    assert.strictEqual(fs.existsSync(hedef), true,
      'yeni bar gelmese de eksik dosya uretilmeli')
    const uretilmis = await binstore.readSeries(hedef)
    assert.ok(uretilmis.length > 0, 'uretilen dosya bos olmamali')
  })
})

test('engine:backtest-last: benzerlik agirligi degistiyse bunu bildirir', async () => {
  await isciyle(async (cagir, dataDir) => {
    const kok = pathsCore.memoryPath(TF, undefined, dataDir)
    // ESKI agirlikla alinmis bir olcum (surum yukseltmesinden once yazilmis).
    fs.writeFileSync(kok + '.backtest.json', JSON.stringify({
      tf: TF,
      cfgHash: 'herhangi',
      usedCfg: { signalCfg: { weights: { shape: 0.6, ctx: 0.25, dtw: 0.15 } } },
      summary: { fired: 1 },
    }))

    const sonuc = await cagir('engine:backtest-last', { tf: TF })
    assert.strictEqual(sonuc.found, true)
    // Varsayilan artik "yalnizca sekil"; kayitli olcum eski agirlikla alinmis.
    assert.strictEqual(sonuc.weightsMatch, false,
      'agirlik degistiyse olcum eski sayilmali, yoksa liste sessizce ayrisir')
    assert.strictEqual(sonuc.activeWeights.shape, 1)

    // AYNI agirlikla alinmis olcum eski sayilmamali.
    fs.writeFileSync(kok + '.backtest.json', JSON.stringify({
      tf: TF,
      cfgHash: 'herhangi',
      usedCfg: { signalCfg: { weights: { shape: 1, ctx: 0, dtw: 0 } } },
      summary: { fired: 1 },
    }))
    const ayni = await cagir('engine:backtest-last', { tf: TF })
    assert.strictEqual(ayni.weightsMatch, true)
  })
})

test('engine:backtest olcume COZULMUS agirligi yazar, ham alani degil', async () => {
  await isciyle(async (cagir, dataDir) => {
    await cagir('engine:backtest', { tf: TF, cfg: testCfg() })
    const kayit = JSON.parse(fs.readFileSync(
      pathsCore.memoryPath(TF, undefined, dataDir) + '.backtest.json', 'utf8'))
    const w = kayit.usedCfg.signalCfg.weights
    // Varsayilan on ayar "yalnizca sekil": kayit da bunu soylemeli.
    // Ham `weights` alani (0.60/0.25/0.15) yazilsaydi olcumun hangi agirlikla
    // alindigi YANLIS gorunur ve "eskidi mi" karsilastirmasi her acilista
    // uyusmazlik bulup testi sonsuz kez yeniden calistirirdi.
    assert.strictEqual(w.shape, 1)
    assert.strictEqual(w.ctx, 0)
    assert.strictEqual(w.dtw, 0)

    // Ayni kayit hemen ardindan ESKIMIS sayilmamali.
    const son = await cagir('engine:backtest-last', { tf: TF })
    assert.strictEqual(son.weightsMatch, true, 'taze olcum eski sayilmamali')
  })
})
