'use strict'

// C6 - src/main/live.js yaris durumlari.
//
// tick() iki kez await ediyor: saglayici cekimi ve isci cagrisi. Bu iki nokta
// arasinda kullanici durdurup baslatabilir ya da zaman dilimini
// degistirebilir. Onceden tf cekimden ONCE ve SONRA ayri ayri okunuyordu; eski
// turun barlari YENI zaman diliminin etiketiyle grafige, hatta yeni zaman
// diliminin deposuna yazilabiliyordu.
//
// Testler gercek live.js'i sahte saglayici, sahte motor ve sahte ayarlarla
// kosturur. Kullanicinin veri klasorune DOKUNULMAZ.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const series = require('../src/core/series')

/** Belirtilen zamanlardan sentetik seri uretir. */
function seriUret(bas, adet, tfSec) {
  const s = series.createSeries(adet)
  for (let i = 0; i < adet; i++) {
    const p = 2000 + i * 0.1
    s.time[i] = bas + i * tfSec
    s.open[i] = p
    s.high[i] = p + 0.5
    s.low[i] = p - 0.5
    s.close[i] = p
    s.volume[i] = 100
  }
  return s
}

/**
 * live.js'i sahte bagimliliklarla yukler.
 * @param {{onFetch?:Function, onEngine?:Function}} kancalar
 */
function liveYukle(kancalar) {
  const k = kancalar || {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-live-'))
  process.env.ZONE_MEMORY_USER_DIR = dir
  process.env.ZONE_MEMORY_DATA_DIR = path.join(dir, 'data')

  const olaylar = []
  const sahteEngine = {
    call: async (cmd, payload) => (k.onEngine ? k.onEngine(cmd, payload) : { tf: payload.tf, added: 0 }),
    status: () => ({ running: true, pending: 0 }),
  }
  const sahteSettings = {
    load: () => ({ apiKeys: {}, livePollSeconds: 3600, providers: { live: 'sahte' } }),
    loadPatch: () => ({}),
  }
  const sahteProvider = {
    getProvider: () => ({
      id: 'sahte',
      name: 'Sahte Canli',
      needsKey: false,
      caps: ['live'],
      isProxy: false,
      fetchCandles: async (o) => (k.onFetch ? k.onFetch(o) : seriUret(1700000000, 10, o.tfSec)),
    }),
  }

  const asilYukle = Module._load
  Module._load = function (istek, ust, ana) {
    if (istek === './engine') return sahteEngine
    if (istek === './settings') return sahteSettings
    if (istek === '../core/data/provider') return sahteProvider
    return asilYukle.apply(this, arguments)
  }
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'main'))) delete require.cache[anahtar]
  }
  const live = require('../src/main/live')
  // DIKKAT: yama burada geri alinmaz. live.js saglayici modulunu TEMBEL
  // yukluyor (getProviderById icinde), yani yama tik sirasinda da acik
  // olmali. Her test `geriAl()` ile kapatir.
  live.setEmitter((type, data) => { olaylar.push({ type, data }) })
  return {
    live: live,
    olaylar: olaylar,
    dir: dir,
    geriAl: () => { Module._load = asilYukle },
  }
}

test('oturum degisirse eski turun sonucu KULLANILMAZ', async () => {
  let cozUret = null
  const bekleyenCekim = new Promise((res) => { cozUret = res })
  let motorCagrisi = 0

  const { live, olaylar, geriAl } = liveYukle({
    onFetch: async (o) => {
      // Ilk cekim askida kalir; test bu sirada durdurup yeniden baslatir.
      await bekleyenCekim
      return seriUret(1700000000, 10, o.tfSec)
    },
    onEngine: async (cmd, payload) => {
      // Yalnizca canli tik sayilir; 'data:status' cagrisi yazim zaman dilimini
      // belirlemek icin yapiliyor ve bu testin konusu degil.
      if (cmd === 'engine:live-tick') motorCagrisi++
      if (cmd === 'data:status') return { byTf: {} }
      return { tf: payload.tf, added: 1, lastBar: { time: 1700000000, close: 2000 }, events: [], logs: [] }
    },
  })

  live.start({ tf: '15m', providerId: 'sahte' })
  // Cekim askidayken durdur: oturum degisir.
  live.stop()
  cozUret()
  // Askidaki turun tamamlanmasina firsat ver.
  await new Promise((r) => setTimeout(r, 30))

  assert.strictEqual(motorCagrisi, 0,
    'durdurulduktan sonra isciye istek GONDERILMEMELI')
  const durum = live.status()
  assert.strictEqual(durum.running, false)
  assert.strictEqual(durum.ticks, 0, 'iptal edilen tur sayilmamali')
  assert.ok(olaylar.some((o) => o.type === 'live:status'), 'durum olayi yayinlanmali')
  geriAl()
})

test('isci baska bir zaman dilimi dondurduyse yanit atilir', async () => {
  const { live, geriAl } = liveYukle({
    onEngine: async (cmd) => {
      if (cmd === 'data:status') return { byTf: {} }
      // Isci BASKA bir tf dondurur: yanit kullanilmamali.
      return { tf: '5m', added: 3, lastBar: { time: 1700000000, close: 2000 }, events: [], logs: [] }
    },
  })

  live.start({ tf: '15m', providerId: 'sahte' })
  await new Promise((r) => setTimeout(r, 40))
  const durum = live.status()
  assert.strictEqual(durum.addedBars, 0, 'baska tf yaniti bar saymamali')
  assert.strictEqual(durum.lastBarTime, null, 'baska tf yaniti son bari yazmamali')
  live.stop()
  geriAl()
})

test('ayni turun yaniti kullanilir ve durum her tikte yayinlanir', async () => {
  const { live, olaylar, geriAl } = liveYukle({
    onEngine: async (cmd, payload) => {
      if (cmd === 'data:status') return { byTf: {} }
      return { tf: payload.tf, added: 2, lastBar: { time: 1700000600, close: 2001 }, events: [], logs: [] }
    },
  })

  live.start({ tf: '15m', providerId: 'sahte' })
  await new Promise((r) => setTimeout(r, 40))
  const durum = live.status()
  assert.strictEqual(durum.addedBars, 2)
  assert.strictEqual(durum.lastBarTime, 1700000600)
  assert.strictEqual(durum.ticks, 1)
  // Durum her tikte yayinlanir: gosterge akisin oldugunu ancak boyle anlar.
  const durumOlaylari = olaylar.filter((o) => o.type === 'live:status')
  assert.ok(durumOlaylari.length >= 2, 'baslangic ve tik sonrasi durum yayinlanmali')
  // Piyasa durumu da tasinir (gosterge hafta sonu uyari vermesin diye).
  assert.strictEqual(typeof durum.marketOpen, 'boolean')
  live.stop()
  geriAl()
})

test('durdur ve hemen baslat: yeni oturumun ilk tiki ATLANMAZ', async () => {
  let motorCagrisi = 0
  const { live, geriAl } = liveYukle({
    onEngine: async (cmd, payload) => {
      if (cmd === 'engine:live-tick') motorCagrisi++
      if (cmd === 'data:status') return { byTf: {} }
      return { tf: payload.tf, added: 1, lastBar: null, events: [], logs: [] }
    },
  })

  live.start({ tf: '15m', providerId: 'sahte' })
  live.stop()
  live.start({ tf: '15m', providerId: 'sahte' })
  await new Promise((r) => setTimeout(r, 60))
  // Eski global `ticking` bayragi yeni oturumun ilk tikini de atliyordu:
  // durdur/baslat sonrasi ilk veri bir tur gecikiyordu.
  assert.ok(motorCagrisi >= 1, 'yeni oturumun ilk tiki calismali')
  live.stop()
  geriAl()
})
