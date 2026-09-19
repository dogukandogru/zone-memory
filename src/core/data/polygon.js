'use strict'

// Polygon.io saglayicisi (C:XAUUSD spot).
//
// Olculmus gercek: API anahtari ZORUNLUDUR. Fiyat gercek spot XAUUSD'dir
// (isProxy: false) ve barlarda hem `v` (hacim) hem `n` (islem/tick sayisi)
// gelir. Bu yuzden onerilen ucretli secenektir: indikatorun flow bileseni
// icin gercek bir hacim vekili sunar.
//
// Sinirlar: istek basina en fazla 50000 satir; ucretsiz planda dakikada 5
// istek. Sayfalama `next_url` ile yapilir ve o adrese apiKey eklenmelidir.

const { fromArrays, sanitize, resample, emptySeries } = require('../series')
const { httpJson, sleep, kaynakZamanDilimi, bildir } = require('./provider')

const ETIKET = 'Polygon'
const TICKER = 'C:XAUUSD'
const TEMEL = 'https://api.polygon.io/v2/aggs/ticker/'
const LIMIT = 50000

/** Saniye -> {carpan, birim} Polygon toplama penceresi. */
const PENCERELER = {
  60: { carpan: 1, birim: 'minute' },
  300: { carpan: 5, birim: 'minute' },
  900: { carpan: 15, birim: 'minute' },
  1800: { carpan: 30, birim: 'minute' },
  3600: { carpan: 1, birim: 'hour' },
  7200: { carpan: 2, birim: 'hour' },
  14400: { carpan: 4, birim: 'hour' },
  86400: { carpan: 1, birim: 'day' },
}
const DESTEKLI = [60, 300, 900, 1800, 3600, 7200, 14400, 86400]

/**
 * @param {{tfSec:number, from:number, to:number, apiKey?:string,
 *          onProgress?:Function}} opts
 * @returns {Promise<import('../series').Series>}
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const apiKey = o.apiKey ? String(o.apiKey).trim() : ''
  if (!apiKey) {
    throw new Error(
      ETIKET + ': API anahtari gerekli. Ayarlar sekmesinden polygon anahtarini girin.'
    )
  }

  const secim = kaynakZamanDilimi(o.tfSec, DESTEKLI)
  const kaynakSec = secim.kaynakSec
  const pencere = PENCERELER[kaynakSec]

  const simdi = Math.floor(Date.now() / 1000)
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : simdi
  let from = Number.isFinite(o.from) ? Math.floor(o.from) : to - 7 * 86400
  if (to > simdi) to = simdi
  if (from >= to) return emptySeries()

  const fromMs = from * 1000
  const toMs = to * 1000

  const t = []
  const ac = []
  const yuk = []
  const dus = []
  const kap = []
  const hac = []

  let imlecMs = fromMs
  let sonrakiUrl = null
  let tur = 0
  bildir(o.onProgress, 0, ETIKET + ': ' + pencere.carpan + ' ' + pencere.birim + ' mumlari indiriliyor')

  while (true) {
    const url = sonrakiUrl || (
      TEMEL +
      encodeURIComponent(TICKER) +
      '/range/' + pencere.carpan + '/' + pencere.birim +
      '/' + imlecMs + '/' + toMs +
      '?adjusted=true&sort=asc&limit=' + LIMIT
    )

    // ANAHTAR URL'DE DEGIL BASLIKTA. URL'deki anahtar vekil sunucu
    // gunluklerine ve hata mesajlarina dusebilir; Polygon Bearer destekler.
    const govde = await httpJson(url, {
      label: ETIKET,
      timeoutMs: 60000,
      headers: { Authorization: 'Bearer ' + apiKey },
    })
    if (govde && govde.status === 'ERROR') {
      throw new Error(ETIKET + ': ' + (govde.error || govde.message || 'sunucu hatasi'))
    }

    const satirlar = govde && govde.results
    if (!Array.isArray(satirlar) || satirlar.length === 0) break

    let sonMs = imlecMs
    for (let i = 0; i < satirlar.length; i++) {
      const r = satirlar[i]
      const ms = +r.t
      if (!Number.isFinite(ms)) continue
      if (ms > sonMs) sonMs = ms
      const sn = Math.floor(ms / 1000)
      if (sn < from || sn > to) continue
      const c = +r.c
      if (!Number.isFinite(c)) continue
      t.push(sn)
      ac.push(+r.o)
      yuk.push(+r.h)
      dus.push(+r.l)
      kap.push(c)
      // Spot altinda `v` cogu zaman tick sayisidir; yoksa islem sayisi `n` kullanilir.
      const v = Number.isFinite(+r.v) && +r.v > 0 ? +r.v : Number.isFinite(+r.n) ? +r.n : 0
      hac.push(v)
    }

    if (govde.next_url) {
      sonrakiUrl = govde.next_url
    } else if (satirlar.length >= LIMIT) {
      // next_url gelmediyse son bardan devam et.
      const sonraki = sonMs + kaynakSec * 1000
      if (sonraki <= imlecMs) break
      imlecMs = sonraki
      sonrakiUrl = null
      if (imlecMs > toMs) break
    } else {
      break
    }

    tur++
    const ilerlemeMs = sonMs - fromMs
    const pct = toMs > fromMs ? (ilerlemeMs / (toMs - fromMs)) * 100 : 100
    bildir(o.onProgress, pct, ETIKET + ': ' + t.length + ' mum indirildi')
    // UCRETSIZ PLANDA DAKIKADA 5 ISTEK. 300 ms ile dakikada 200 istek
    // atiliyordu: ilk birkac sayfadan sonra her istek 429 donuyor ve uzun
    // indirme yarida kaliyordu. 12 saniye tam olarak dakikada 5 istektir.
    // Ucretli planda bu bekleme gereksiz ama zararsiz; hizli plan kullanan
    // `pollMs` secenegiyle kisaltabilir.
    await sleep(Number.isFinite(o.pollMs) && o.pollMs >= 0 ? o.pollMs : 12000)
    if (tur > 20000) break // guvenlik freni
  }

  let seri = sanitize(fromArrays({
    time: t,
    open: ac,
    high: yuk,
    low: dus,
    close: kap,
    volume: hac,
  }))
  if (secim.yenidenOrnekle && seri.length > 0) seri = resample(seri, o.tfSec)
  bildir(o.onProgress, 100, ETIKET + ': ' + seri.length + ' mum hazir')
  return seri
}

module.exports = {
  id: 'polygon',
  name: 'Polygon.io (C:XAUUSD)',
  needsKey: true,
  caps: ['history', 'live'],
  isProxy: false,
  note:
    'API anahtari gerekir. Gercek spot XAUUSD fiyati ve tick sayisina dayali hacim verir. ' +
    'Onerilen ucretli secenektir. Ucretsiz planda dakikada 5 istek siniri vardir.',
  fetchCandles: fetchCandles,
}
