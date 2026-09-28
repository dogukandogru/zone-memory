'use strict'

/**
 * Canli sinyalleri Telegram kanalina gonderir.
 *
 * Kullanici istedi: "sinyal geldiginde Telegram kanalina gondersin, fakat
 * sadece musterinin bilgisayarinda olusan sinyalleri".
 *
 * NE GONDERILIR: yalnizca CANLI dongunun urettigi, tetiklenmis (fired) ve
 * gecikmemis (stale degil) sinyaller. Tarama ile uretilen gecmis liste
 * gonderilmez; ekrandaki 18 bin satirin Telegram'a akmasi istenmiyor.
 *
 * NEREDEN GONDERILIR: yalnizca PAKETLENMIS uygulamadan (app.isPackaged).
 * Gelistirme calistirmasi (npm run dev) hicbir zaman gondermez; yoksa her
 * denemede kanala mesaj duserdi. Gerekirse ZONE_MEMORY_TELEGRAM_DEV=1 ile
 * gelistirmede de acilir. Kullanicinin kendi kurulumu varsa Ayarlar'daki
 * "Telegram'a gonder" kutusuyla kapatilir.
 *
 * TOKEN: pakete gomulu (apiKeys.local.json, GitHub sirri TELEGRAM_BOT_TOKEN),
 * depoya GIRMEZ; OANDA anahtariyla ayni yol. Gunluge asla yazilmaz.
 *
 * KANAL: `telegram.chatId` ayari (@kullaniciadi ya da -100... sayisal kimlik).
 * Bos ise gonderim yapilmaz ve gunluge bir kez yazilir.
 */

const https = require('https')

/** @type {((message:string)=>void)|null} */
let logla = null
/** @type {((tur:string, veri:any)=>void)|null} */
let emit = null
/** Ayarlari saglayan kaynak (test icin degistirilebilir). */
let ayarKaynagi = null
/** HTTP gonderici (test icin degistirilebilir). */
let gonderici = null
/** Bos kanal uyarisi bir kez yazilir. */
let kanalUyarildi = false

function isoTarih(t) {
  const d = new Date(Number(t) * 1000)
  if (!Number.isFinite(d.getTime())) return '-'
  const iki = (n) => String(n).padStart(2, '0')
  return iki(d.getUTCDate()) + '.' + iki(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() +
    ' ' + iki(d.getUTCHours()) + ':' + iki(d.getUTCMinutes()) + ' UTC'
}

function fiyat(v) {
  const x = Number(v)
  return Number.isFinite(x) ? x.toFixed(2) : '-'
}

/**
 * Mesaj metni. Kisa, tek ekrana sigacak; markdown YOK (fiyatlardaki nokta ve
 * yildiz kacisi gerektirir, duz metin daha guvenli).
 * @param {{tf?:string, signal:Object}} veri
 * @returns {string}
 */
function metinKur(veri) {
  const s = veri && veri.signal ? veri.signal : {}
  const yon = s.direction === 'SELL' ? 'SAT' : 'AL'
  const tur = s.kind === 'form' ? 'kutu oluşumu' : 'bölge dokunuşu'
  const satirlar = [
    (yon === 'AL' ? '🟢 ' : '🔴 ') + yon + ' sinyali, ' + tur + ' (' + String(veri.tf || s.tf || '-') + ')',
    isoTarih(s.time),
    'Fiyat ' + fiyat(s.price),
  ]
  if (Number.isFinite(Number(s.zoneBottom)) && Number.isFinite(Number(s.zoneTop))) {
    satirlar.push('Kutu ' + fiyat(s.zoneBottom) + ' - ' + fiyat(s.zoneTop))
  }
  if (Number.isFinite(Number(s.confidence))) {
    satirlar.push('Güven %' + Math.round(Number(s.confidence)) +
      (Number.isFinite(Number(s.similarCount)) ? ', ' + Math.round(Number(s.similarCount)) + ' benzer kurulum' : ''))
  }
  if (s.plan && Number.isFinite(Number(s.plan.tp)) && Number.isFinite(Number(s.plan.sl))) {
    satirlar.push('TP ' + fiyat(s.plan.tp) + ' · SL ' + fiyat(s.plan.sl))
  }
  if (Number.isFinite(Number(s.score)) && Number.isFinite(Number(s.maxScore)) && Number(s.maxScore) > 0) {
    satirlar.push('İndikatör skoru ' + Math.round(Number(s.score)) + '/' + Math.round(Number(s.maxScore)))
  }
  return satirlar.join('\n')
}

/**
 * Gonderilmeli mi ve degilse neden. Saf fonksiyon, test edilir.
 * @param {{signal?:Object}} veri
 * @param {{paketli:boolean, enabled:boolean, token:string, chatId:string}} ort
 * @returns {{gonder:boolean, sebep:string}}
 */
function gonderilmeliMi(veri, ort) {
  const s = veri && veri.signal ? veri.signal : null
  if (!s) return { gonder: false, sebep: 'sinyal yok' }
  if (s.fired === false) return { gonder: false, sebep: 'tetiklenmedi' }
  if (s.stale === true) return { gonder: false, sebep: 'gecikmeli' }
  if (!ort.paketli) return { gonder: false, sebep: 'gelistirme calistirmasi' }
  if (ort.enabled === false) return { gonder: false, sebep: 'ayardan kapali' }
  if (!ort.token) return { gonder: false, sebep: 'token yok' }
  if (!ort.chatId) return { gonder: false, sebep: 'kanal kimligi yok' }
  return { gonder: true, sebep: '' }
}

/** Varsayilan gonderici: Telegram Bot API sendMessage. */
function httpsGonder(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const govde = JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true })
    const istek = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: '/bot' + token + '/sendMessage',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(govde) },
      timeout: 10000,
    }, (yanit) => {
      let veri = ''
      yanit.setEncoding('utf8')
      yanit.on('data', (p) => { veri += p })
      yanit.on('end', () => {
        let j = null
        try { j = JSON.parse(veri) } catch (err) { j = null }
        if (yanit.statusCode === 200 && j && j.ok) resolve(j)
        else reject(new Error('Telegram ' + yanit.statusCode + ': ' + (j && j.description ? j.description : veri.slice(0, 120))))
      })
    })
    istek.on('timeout', () => { istek.destroy(new Error('Telegram zaman aşımı')) })
    istek.on('error', reject)
    istek.write(govde)
    istek.end()
  })
}

function ortamOku() {
  const s = ayarKaynagi
  const anahtarlar = (s && typeof s.get === 'function' ? s.get('apiKeys') : null) || {}
  const tg = (s && typeof s.get === 'function' ? s.get('telegram') : null) || {}
  let paketli = false
  try {
    paketli = !!require('electron').app.isPackaged
  } catch (err) {
    paketli = false
  }
  if (process.env.ZONE_MEMORY_TELEGRAM_DEV === '1') paketli = true
  return {
    paketli: paketli,
    enabled: tg.enabled !== false,
    token: typeof anahtarlar.telegram === 'string' ? anahtarlar.telegram.trim() : '',
    chatId: typeof tg.chatId === 'string' ? tg.chatId.trim() : '',
  }
}

/**
 * Canli sinyali kanala gonderir. Hata akisi durdurmaz; gunluge yazilir.
 * @param {{tf:string, signal:Object}} veri
 * @returns {Promise<boolean>} gonderildiyse true
 */
async function sinyalGonder(veri) {
  const ort = ortamOku()
  const karar = gonderilmeliMi(veri, ort)
  if (!karar.gonder) {
    if (karar.sebep === 'kanal kimligi yok' && !kanalUyarildi && logla) {
      kanalUyarildi = true
      logla('Telegram: kanal kimliği boş, sinyal gönderilmedi. Ayarlar > Telegram > Kanal kimliği.')
    }
    return false
  }
  const metin = metinKur(veri)
  try {
    await (gonderici || httpsGonder)(ort.token, ort.chatId, metin)
    if (logla) logla('Telegram: sinyal kanala gönderildi (' + String(veri.tf || '') + ').')
    if (emit) emit('telegram:sent', { tf: veri.tf, time: veri.signal.time })
    return true
  } catch (err) {
    // Token gunluge girmez: hata metni Telegram'in aciklamasidir.
    if (logla) logla('Telegram: gönderilemedi, ' + (err && err.message ? err.message : String(err)))
    return false
  }
}

/**
 * @param {{emit?:(tur:string, veri:any)=>void, log?:(m:string)=>void,
 *          settings?:{get:(k:string)=>any}, sender?:Function}} opts
 */
function init(opts) {
  const o = opts || {}
  emit = typeof o.emit === 'function' ? o.emit : null
  logla = typeof o.log === 'function' ? o.log : null
  ayarKaynagi = o.settings || require('./settings')
  gonderici = typeof o.sender === 'function' ? o.sender : null
  kanalUyarildi = false
}

module.exports = { init, sinyalGonder, metinKur, gonderilmeliMi }
