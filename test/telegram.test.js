'use strict'

// TELEGRAM BILDIRIMI (src/main/telegram.js)
//
// Kullanici: "sinyal geldiginde Telegram kanalina gondersin, sadece musterinin
// bilgisayarinda olusan sinyalleri". Kilitlenen kurallar: yalnizca
// paketlenmis uygulama (gelistirme asla), yalnizca tetiklenmis ve gecikmemis
// sinyal, token ve kanal kimligi yoksa sessiz; token gunluge girmez.

const test = require('node:test')
const assert = require('node:assert/strict')
const telegram = require('../src/main/telegram')

const SINYAL = {
  tf: '5m',
  signal: {
    direction: 'BUY', kind: 'form', fired: true, time: 1758904200, price: 4265.22,
    zoneTop: 4262.4, zoneBottom: 4260.1, confidence: 99, similarCount: 4098,
    score: 2, maxScore: 4, plan: { tp: 4270, sl: 4260 },
  },
}

test('mesaj metni: yon, tur, dilim, zaman, fiyat, kutu, guven, TP/SL, skor; em-dash yok', () => {
  const m = telegram.metinKur(SINYAL)
  assert.match(m, /AL sinyali, kutu oluşumu \(5m\)/)
  assert.match(m, /\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} UTC/)
  assert.match(m, /Fiyat 4265\.22/)
  assert.match(m, /Kutu 4260\.10 - 4262\.40/)
  assert.match(m, /Güven %99, 4098 benzer kurulum/)
  assert.match(m, /TP 4270\.00 · SL 4260\.00/)
  assert.match(m, /skoru 2\/4/)
  assert.ok(!m.includes(String.fromCharCode(0x2014)))
  const sat = telegram.metinKur({ tf: '1m', signal: { direction: 'SELL', kind: 'touch', time: 0, price: 1 } })
  assert.match(sat, /SAT sinyali, bölge dokunuşu \(1m\)/)
})

test('gonderim karari: paketli + tetiklenmis + token + kanal; aksi halde sebebiyle hayir', () => {
  const tam = { paketli: true, enabled: true, token: 't', chatId: '@kanal' }
  assert.deepEqual(telegram.gonderilmeliMi(SINYAL, tam), { gonder: true, sebep: '' })
  assert.equal(telegram.gonderilmeliMi(SINYAL, Object.assign({}, tam, { paketli: false })).sebep, 'gelistirme calistirmasi')
  assert.equal(telegram.gonderilmeliMi(SINYAL, Object.assign({}, tam, { enabled: false })).sebep, 'ayardan kapali')
  assert.equal(telegram.gonderilmeliMi(SINYAL, Object.assign({}, tam, { token: '' })).sebep, 'token yok')
  assert.equal(telegram.gonderilmeliMi(SINYAL, Object.assign({}, tam, { chatId: '' })).sebep, 'kanal kimligi yok')
  const uretilmedi = { signal: Object.assign({}, SINYAL.signal, { fired: false }) }
  assert.equal(telegram.gonderilmeliMi(uretilmedi, tam).sebep, 'tetiklenmedi')
  const gecikmeli = { signal: Object.assign({}, SINYAL.signal, { stale: true }) }
  assert.equal(telegram.gonderilmeliMi(gecikmeli, tam).sebep, 'gecikmeli')
  assert.equal(telegram.gonderilmeliMi(null, tam).sebep, 'sinyal yok')
})

test('sinyalGonder: sahte gondericiyle kanal ve metin dogru, gelistirmede HIC gonderilmez', async () => {
  const gidenler = []
  const loglar = []
  const sahteAyar = { get: (k) => (k === 'apiKeys' ? { telegram: 'GIZLI' } : (k === 'telegram' ? { enabled: true, chatId: '@hocam' } : null)) }
  telegram.init({ settings: sahteAyar, log: (m) => loglar.push(m), sender: async (token, chat, text) => { gidenler.push({ token, chat, text }); return { ok: true } } })

  // electron yok, ZONE_MEMORY_TELEGRAM_DEV yok: paketli sayilmaz, gonderilmez.
  delete process.env.ZONE_MEMORY_TELEGRAM_DEV
  assert.equal(await telegram.sinyalGonder(SINYAL), false)
  assert.equal(gidenler.length, 0)

  // Gelistirmede acikca acilirsa gonderir.
  process.env.ZONE_MEMORY_TELEGRAM_DEV = '1'
  try {
    assert.equal(await telegram.sinyalGonder(SINYAL), true)
    assert.equal(gidenler.length, 1)
    assert.equal(gidenler[0].chat, '@hocam')
    assert.equal(gidenler[0].token, 'GIZLI')
    assert.match(gidenler[0].text, /AL sinyali/)
    // Gunlukte token gecmez.
    assert.ok(loglar.every((m) => !m.includes('GIZLI')), 'token gunluge sizdi')

    // Gonderici hata verirse akis durmaz, false doner, gunluge yazilir.
    telegram.init({ settings: sahteAyar, log: (m) => loglar.push(m), sender: async () => { throw new Error('Telegram 403: bot kanala ekli degil') } })
    assert.equal(await telegram.sinyalGonder(SINYAL), false)
    assert.ok(loglar.some((m) => /403/.test(m)))

    // Kanal kimligi bos: gonderilmez, uyari BIR kez.
    const bosKanal = { get: (k) => (k === 'apiKeys' ? { telegram: 'GIZLI' } : { enabled: true, chatId: '' }) }
    const uyarilar = []
    telegram.init({ settings: bosKanal, log: (m) => uyarilar.push(m), sender: async () => ({ ok: true }) })
    await telegram.sinyalGonder(SINYAL)
    await telegram.sinyalGonder(SINYAL)
    assert.equal(uyarilar.filter((m) => /kanal kimliği/.test(m)).length, 1)
  } finally {
    delete process.env.ZONE_MEMORY_TELEGRAM_DEV
  }
})
