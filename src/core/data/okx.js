'use strict'

// OKX saglayicisi (XAUT-USDT).
//
// Olculmus gercek: https://www.okx.com/api/v5/market/candles?instId=XAUT-USDT
// anahtarsiz HTTP 200 doner. XAUT (Tether Gold) bir onsluk altina karsilik
// gelen bir token oldugu icin fiyat XAUUSD'ye yakindir, aynisi degildir
// (isProxy: true).
//
// Onemli sinir: 1 dakikalik barlarin cogunda hacim SIFIRDIR, bu yuzden
// indikatorun flow bileseni bu kaynakta zayif calisir.
//
// Gecmis icin /market/history-candles uc noktasi kullanilir; /market/candles
// yalnizca son birkac yuz bari verir. Sayfalama `after` parametresiyle
// GERIYE dogru yapilir ve yanit yeniden eskiye siralidir.

const { fromArrays, sanitize, resample, emptySeries } = require('../series')
const { httpJson, sleep, kaynakZamanDilimi, bildir } = require('./provider')

const ETIKET = 'OKX'
const INST = 'XAUT-USDT'
const SON_URL = 'https://www.okx.com/api/v5/market/candles'
const GECMIS_URL = 'https://www.okx.com/api/v5/market/history-candles'
const LIMIT = 100

/**
 * Saniye -> OKX bar kodu.
 * Gunluk barda UTC hizalamasi icin `1Dutc` kullanilir; varsayilan `1D`
 * Hong Kong saatine (UTC+8) gore hizalidir ve epoch katlarina oturmaz.
 * 4 saat ve altindaki barlarda iki hizalama da ayni sonucu verir.
 */
const BARLAR = {
  60: '1m',
  180: '3m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '1H',
  7200: '2H',
  14400: '4H',
  86400: '1Dutc',
}
const DESTEKLI = [60, 180, 300, 900, 1800, 3600, 7200, 14400, 86400]

/**
 * @param {{tfSec:number, from:number, to:number, apiKey?:string,
 *          onProgress?:Function}} opts
 * @returns {Promise<import('../series').Series>}
 */
async function fetchCandles(opts) {
  const o = opts || {}
  const secim = kaynakZamanDilimi(o.tfSec, DESTEKLI)
  const kaynakSec = secim.kaynakSec
  const bar = BARLAR[kaynakSec]

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

  // `after` bu zamandan ESKI barlari getirir; ilk turda en son bari da almak
  // icin bir milisaniye ileriden baslanir.
  let after = toMs + 1
  let tur = 0
  let sonUrl = SON_URL
  bildir(o.onProgress, 0, ETIKET + ': ' + bar + ' mumlari indiriliyor')

  while (after > fromMs) {
    const url =
      sonUrl +
      '?instId=' + INST +
      '&bar=' + bar +
      '&after=' + after +
      '&limit=' + LIMIT

    const govde = await httpJson(url, { label: ETIKET, timeoutMs: 30000 })
    if (!govde || govde.code === undefined) {
      throw new Error(ETIKET + ': beklenmeyen yanit bicimi')
    }
    if (String(govde.code) !== '0') {
      throw new Error(ETIKET + ': ' + (govde.msg || 'sunucu hatasi') + ' (kod ' + govde.code + ')')
    }
    const veri = govde.data
    if (!Array.isArray(veri) || veri.length === 0) {
      // Guncel uc nokta bittiyse gecmis uc noktasina gec, o da bostuysa dur.
      if (sonUrl === SON_URL) {
        sonUrl = GECMIS_URL
        continue
      }
      break
    }

    let enEski = after
    for (let i = 0; i < veri.length; i++) {
      const satir = veri[i]
      const ms = +satir[0]
      if (!Number.isFinite(ms)) continue
      if (ms < enEski) enEski = ms
      const sn = Math.floor(ms / 1000)
      if (sn < from || sn > to) continue
      t.push(sn)
      ac.push(+satir[1])
      yuk.push(+satir[2])
      dus.push(+satir[3])
      kap.push(+satir[4])
      hac.push(+satir[5])
    }

    if (enEski >= after) break // ilerleme yok
    after = enEski
    // Guncel uc nokta yalnizca yakin gecmisi tutar, sonrasi icin gecmis uc noktasi.
    sonUrl = GECMIS_URL

    tur++
    const pct = toMs > fromMs ? ((toMs - after) / (toMs - fromMs)) * 100 : 100
    bildir(o.onProgress, pct, ETIKET + ': ' + t.length + ' mum indirildi')
    if (after > fromMs) await sleep(140)
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
  id: 'okx',
  name: 'OKX (XAUT-USDT)',
  needsKey: false,
  caps: ['history', 'live'],
  isProxy: true,
  note:
    'Anahtarsiz. Tether Gold fiyatidir, spot XAUUSD ile fark tasir. ' +
    '1 dakikalik barlarin cogunda hacim sifir geldigi icin flow bileseni zayiftir. ' +
    'Istek basina en fazla 100 mum verdiginden uzun gecmis yavas iner.',
  fetchCandles: fetchCandles,
}
