'use strict'

// Veri saglayici kayit defteri ve tum saglayicilarin paylastigi HTTP yardimcilari.
// CONTRACTS.md bolum 17 ile uyumludur.
//
// Olculmus gercekler (bu makineden test edildi):
//  - Dukascopy (datafeed.dukascopy.com) ERISILEMEZ. Turkiye'de BTK engeli var,
//    alan adi engel sunucusuna cozuluyor ve dogrudan IP baglantisi da dusuyor.
//    Bu yuzden saglayici listesinde YOKTUR.
//  - Yahoo: GC=F sembolu HTTP 200 doner, XAUUSD=X ise 404. Bu yuzden Yahoo
//    saglayicisi COMEX altin vadelisi olan GC=F kullanir ve isProxy: true'dur.
//  - Binance PAXGUSDT ve OKX XAUT-USDT anahtarsiz calisir (HTTP 200), ikisi de
//    vekil fiyattir (isProxy: true).
//  - Twelve Data ve Polygon anahtar ister.
//  - HistData calisir (HTTP 200), ucretsiz ve tam gecmis tick verisi verir.
//
// Modul dongusu olmasin diye saglayici modulleri BURADA ust duzeyde
// require EDILMEZ; ilk erisimde tembel yuklenir. Boylece saglayici dosyalari
// bu dosyadaki yardimcilari sorunsuz require edebilir.

/** Engellenmemek icin gercek bir tarayici kimligi gonderilir. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Saglayici modul yollari, id sirasiyla. */
const MODUL_YOLLARI = [
  './histdata',
  './yahoo',
  './binance',
  './okx',
  './twelvedata',
  './polygon',
]

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

/** Hata mesajlarina eklenecek govde metnini kisaltir. */
function kisalt(metin, uzunluk) {
  if (!metin) return ''
  const lim = uzunluk || 200
  const tek = String(metin).replace(/\s+/g, ' ').trim()
  return tek.length > lim ? tek.slice(0, lim) + '...' : tek
}

/**
 * Ortak HTTP istegi: zaman asimi, User-Agent basligi ve hiz siniri /
 * gecici sunucu hatalari icin geri cekilmeli yeniden deneme.
 *
 * @param {string} url
 * @param {{method?:string, headers?:Object, body?:any, timeoutMs?:number,
 *          retries?:number, retryDelayMs?:number, label?:string}} [opts]
 * @returns {Promise<Response>}
 */
async function httpRequest(url, opts) {
  const o = opts || {}
  const method = o.method || 'GET'
  const timeoutMs = o.timeoutMs || 30000
  const retries = o.retries === undefined ? 3 : o.retries
  const retryDelayMs = o.retryDelayMs || 800
  const label = o.label || 'Veri saglayici'

  const basliklar = Object.assign(
    {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    o.headers || {}
  )

  let sonHata = null
  // Bir sonraki denemeden once beklenecek sure. `Retry-After` gelirse o
  // kullanilir, yoksa ussel geri cekilme + rastgele pay (jitter).
  let bekle = 0
  for (let deneme = 0; deneme <= retries; deneme++) {
    if (deneme > 0) {
      // USSEL GERI CEKILME VE JITTER.
      //
      // Duz carpim (gecikme * deneme) ayni anda hiz sinirina carpan iki
      // istemciyi ayni ritimde yeniden denemeye sokuyordu. Rastgele pay
      // bunu dagitir. `Retry-After` varsa sunucunun dedigi sure kullanilir
      // ama 60 saniyeyle sinirlanir: daha uzun beklemek arayuzu kilitler.
      const ussel = retryDelayMs * Math.pow(2, deneme - 1) * (0.5 + Math.random())
      await sleep(bekle > 0 ? bekle : ussel)
      bekle = 0
    }

    let res = null
    try {
      res = await fetch(url, {
        method: method,
        body: o.body === undefined ? null : o.body,
        headers: basliklar,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const sebep = err && err.message ? err.message : 'bilinmeyen ag hatasi'
      sonHata = new Error(label + ': sunucuya ulasilamadi (' + sebep + ')')
      continue
    }

    // 429 hiz siniri, 5xx gecici sunucu hatasi: yeniden dene.
    if (res.status === 429 || res.status >= 500) {
      // Govde okunmadan birakilirsa baglanti havuzda asili kalir.
      if (res.body && typeof res.body.cancel === 'function') {
        try { await res.body.cancel() } catch (err) { /* onemsiz */ }
      }
      const ra = res.headers && typeof res.headers.get === 'function'
        ? Number(res.headers.get('retry-after'))
        : NaN
      if (Number.isFinite(ra) && ra > 0) bekle = Math.min(ra, 60) * 1000
      sonHata = new Error(
        label + ': sunucu HTTP ' + res.status + ' dondu (hiz siniri veya gecici hata)'
      )
      continue
    }
    if (!res.ok) {
      const govde = await res.text().catch(function () {
        return ''
      })
      // 401/403 "anahtar yok" degil "anahtar GECERSIZ" demektir. Ayni metni
      // kullanmak kullaniciyi Ayarlar'a gonderip anahtari yeniden girmeye
      // itiyordu, oysa sorun anahtarin kendisi ya da planin kapsamiydi.
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          label + ': API anahtari gecersiz ya da bu veriye yetkisi yok (HTTP ' +
          res.status + '). ' + kisalt(govde)
        )
      }
      throw new Error(label + ': HTTP ' + res.status + '. ' + kisalt(govde))
    }
    return res
  }
  throw sonHata || new Error(label + ': istek basarisiz oldu')
}

/**
 * JSON bekleyen istek.
 * @param {string} url
 * @param {Object} [opts] httpRequest ile ayni
 * @returns {Promise<any>}
 */
async function httpJson(url, opts) {
  const o = opts || {}
  const res = await httpRequest(url, Object.assign({}, o, {
    headers: Object.assign({ Accept: 'application/json' }, o.headers || {}),
  }))
  const metin = await res.text()
  try {
    return JSON.parse(metin)
  } catch (err) {
    const label = o.label || 'Veri saglayici'
    throw new Error(label + ': yanit JSON olarak cozulemedi. ' + kisalt(metin))
  }
}

/**
 * Duz metin bekleyen istek.
 * @param {string} url
 * @param {Object} [opts]
 * @returns {Promise<string>}
 */
async function httpText(url, opts) {
  const res = await httpRequest(url, opts)
  return res.text()
}

/**
 * Ikili govde bekleyen istek (zip indirme).
 * @param {string} url
 * @param {Object} [opts]
 * @returns {Promise<Buffer>}
 */
async function httpBuffer(url, opts) {
  const res = await httpRequest(url, opts)
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

/**
 * Saglayicinin dogrudan destekledigi zaman dilimlerinden, istenen tfSec'e
 * bolen EN BUYUK olani secer. Tam eslesme yoksa donen mumlar sonradan
 * `resample` ile hedef zaman dilimine cikarilir.
 *
 * @param {number} tfSec Istenen zaman dilimi (saniye)
 * @param {number[]} destekliSaniyeler Artan sirali olmasi gerekmez
 * @returns {{kaynakSec:number, yenidenOrnekle:boolean}}
 */
function kaynakZamanDilimi(tfSec, destekliSaniyeler) {
  if (!(tfSec > 0)) throw new Error('Gecersiz zaman dilimi: ' + String(tfSec))
  let enIyi = 0
  for (let i = 0; i < destekliSaniyeler.length; i++) {
    const sec = destekliSaniyeler[i]
    if (sec === tfSec) return { kaynakSec: sec, yenidenOrnekle: false }
    if (tfSec % sec === 0 && sec > enIyi) enIyi = sec
  }
  if (enIyi === 0) {
    // Bolen yoksa en kucuk destekli zaman dilimini kullan.
    enIyi = destekliSaniyeler[0]
    for (let i = 1; i < destekliSaniyeler.length; i++) {
      if (destekliSaniyeler[i] < enIyi) enIyi = destekliSaniyeler[i]
    }
  }
  return { kaynakSec: enIyi, yenidenOrnekle: true }
}

/**
 * onProgress geri cagrisini guvenli sekilde cagirir; hata firlatirsa yutar.
 * @param {Function|undefined} onProgress
 * @param {number} pct 0..100
 * @param {string} msg
 */
function bildir(onProgress, pct, msg) {
  if (typeof onProgress !== 'function') return
  let p = pct
  if (!Number.isFinite(p)) p = 0
  if (p < 0) p = 0
  if (p > 100) p = 100
  try {
    onProgress(p, msg)
  } catch (err) {
    // Ilerleme bildirimi hatasi veri cekmeyi durdurmamali.
  }
}

/** Tembel yuklenen saglayici listesi. */
let kayitlar = null

/** Saglayici modullerini ilk erisimde yukler ve dogrular. */
function yukle() {
  if (kayitlar) return kayitlar
  const liste = []
  for (let i = 0; i < MODUL_YOLLARI.length; i++) {
    const p = require(MODUL_YOLLARI[i])
    if (!p || !p.id || typeof p.fetchCandles !== 'function') {
      throw new Error('Gecersiz saglayici modulu: ' + MODUL_YOLLARI[i])
    }
    liste.push(p)
  }
  kayitlar = liste
  return kayitlar
}

/**
 * Id ile saglayici dondurur.
 * @param {string} id
 * @returns {Object} Provider
 */
function getProvider(id) {
  const liste = yukle()
  for (let i = 0; i < liste.length; i++) {
    if (liste[i].id === id) return liste[i]
  }
  const idler = liste
    .map(function (p) {
      return p.id
    })
    .join(', ')
  throw new Error('Bilinmeyen veri saglayici: ' + String(id) + '. Secenekler: ' + idler)
}

/**
 * Arayuz ve IPC icin serilestirilebilir saglayici ozetleri (fetchCandles yok).
 * @returns {Array<{id:string,name:string,needsKey:boolean,caps:string[],
 *                  isProxy:boolean,note:string}>}
 */
function listProviders() {
  return yukle().map(function (p) {
    return {
      id: p.id,
      name: p.name,
      needsKey: p.needsKey,
      caps: p.caps.slice(),
      isProxy: p.isProxy,
      note: p.note,
    }
  })
}

const disaAktarim = {
  getProvider: getProvider,
  listProviders: listProviders,
  // Saglayicilarin ortak kullandigi yardimcilar:
  USER_AGENT: USER_AGENT,
  sleep: sleep,
  kisalt: kisalt,
  httpRequest: httpRequest,
  httpJson: httpJson,
  httpText: httpText,
  httpBuffer: httpBuffer,
  kaynakZamanDilimi: kaynakZamanDilimi,
  bildir: bildir,
}

// PROVIDERS tam Provider nesnelerinin dizisidir; ilk okunusta tembel yuklenir.
Object.defineProperty(disaAktarim, 'PROVIDERS', {
  enumerable: true,
  get: function () {
    return yukle()
  },
})

module.exports = disaAktarim
