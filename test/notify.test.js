'use strict'

// C5 - src/main/notify.js kural katmani.
//
// Karar desteginin degeri sinyali ZAMANINDA gormekte, ama bildirim gondermek
// tek basina iyi degil: kanitlanmamis bir sinyal icin bildirim gondermek,
// olculmemis bir seyi acil gibi gostermek olur. Bu yuzden kurallar test
// edilir, bildirimin kendisi degil.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

/** Electron ve ayarlar sahtelenerek notify.js yuklenir. */
function notifyYukle(ayarlar) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-notify-'))
  process.env.ZONE_MEMORY_USER_DIR = dir
  process.env.ZONE_MEMORY_DATA_DIR = path.join(dir, 'data')

  const gosterilen = []
  class SahteNotification {
    constructor(opts) {
      this.opts = opts
      this.dinleyiciler = {}
    }
    on(ad, fn) { this.dinleyiciler[ad] = fn }
    show() { gosterilen.push(this.opts) }
    static isSupported() { return true }
  }

  const sahteElectron = {
    Notification: SahteNotification,
    app: { dock: { setBadge() {}, bounce() {} } },
    shell: {},
  }
  const sahteSettings = {
    get: (anahtar) => (anahtar === 'notify' ? (ayarlar || {}) : null),
  }

  const asilYukle = Module._load
  Module._load = function (istek) {
    if (istek === 'electron') return sahteElectron
    if (istek === './settings') return sahteSettings
    return asilYukle.apply(this, arguments)
  }
  for (const anahtar of Object.keys(require.cache)) {
    if (anahtar.includes(path.join('src', 'main'))) delete require.cache[anahtar]
  }
  const notify = require('../src/main/notify')
  Module._load = asilYukle
  return { notify, gosterilen }
}

/** Ornek sinyal (tetiklenmis, gecikmemis, kanitli). */
function sinyal(ek) {
  return Object.assign({
    id: 'sig-1',
    kind: 'form',
    direction: 'BUY',
    fired: true,
    stale: false,
    entry: 2650.1,
    sl: 2645.3,
    tp1: 2656,
    winRate: 0.58,
    evidence: { status: 'kanitli' },
  }, ek || {})
}

test('kanitli, tetiklenmis ve gecikmemis sinyal bildirilir', () => {
  const { notify, gosterilen } = notifyYukle({})
  assert.strictEqual(notify.signalGeldi({ tf: '15m', signal: sinyal() }), true)
  assert.strictEqual(gosterilen.length, 1)
  assert.match(gosterilen[0].title, /AL sinyali/)
  assert.match(gosterilen[0].title, /15m/)
  // Govde plan seviyelerini tasir: bildirime bakip karar verilebilmeli.
  assert.match(gosterilen[0].body, /Giriş 2650\.10/)
  assert.match(gosterilen[0].body, /SL 2645\.30/)
  assert.match(gosterilen[0].body, /TP1 2656\.00/)
  assert.strictEqual(notify.unreadCount(), 1)
})

test('tetiklenmemis, gecikmis ve kanitsiz sinyaller bildirilmez', () => {
  const { notify, gosterilen } = notifyYukle({})
  assert.strictEqual(notify.signalGeldi({ tf: '15m', signal: sinyal({ fired: false }) }), false)
  assert.strictEqual(notify.signalGeldi({ tf: '15m', signal: sinyal({ stale: true }) }), false)
  assert.strictEqual(
    notify.signalGeldi({ tf: '15m', signal: sinyal({ evidence: { status: 'zayif' } }) }),
    false
  )
  assert.strictEqual(
    notify.signalGeldi({ tf: '15m', signal: sinyal({ evidence: null }) }),
    false
  )
  assert.strictEqual(gosterilen.length, 0)
})

test('onlyProven kapatilirsa kanitsiz sinyal de bildirilir', () => {
  const { notify, gosterilen } = notifyYukle({ onlyProven: false })
  assert.strictEqual(
    notify.signalGeldi({ tf: '15m', signal: sinyal({ evidence: { status: 'zayif' } }) }),
    true
  )
  assert.strictEqual(gosterilen.length, 1)
})

test('desktop kapaliysa hic bildirim gosterilmez', () => {
  const { notify, gosterilen } = notifyYukle({ desktop: false })
  assert.strictEqual(notify.signalGeldi({ tf: '15m', signal: sinyal() }), false)
  assert.strictEqual(gosterilen.length, 0)
})

test('ses ayari bildirimin silent alanina yansir', () => {
  const sesli = notifyYukle({ sound: true })
  sesli.notify.signalGeldi({ tf: '15m', signal: sinyal() })
  assert.strictEqual(sesli.gosterilen[0].silent, false)

  const sessiz = notifyYukle({ sound: false })
  sessiz.notify.signalGeldi({ tf: '15m', signal: sinyal() })
  assert.strictEqual(sessiz.gosterilen[0].silent, true)
})

test('okunmamis sayaci pencere odaklaninca sifirlanir', () => {
  const { notify } = notifyYukle({})
  notify.signalGeldi({ tf: '15m', signal: sinyal() })
  notify.signalGeldi({ tf: '15m', signal: sinyal({ id: 'sig-2' }) })
  assert.strictEqual(notify.unreadCount(), 2)
  notify.okundu()
  assert.strictEqual(notify.unreadCount(), 0)
})
