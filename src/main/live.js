'use strict'

/**
 * Canli veri dongusu.
 *
 * Secili saglayicidan `livePollSeconds` araligiyla son ~200 bar cekilir ve
 * motora yollanir. Agir is (fiyat kaydirmasi, depoya ekleme, indikator,
 * benzerlik) isci ipliginde yapilir; burada yalnizca ag istegi ve olay
 * yayini vardir. Boylece 6 milyon barlik seri ana iplige hic kopyalanmaz.
 *
 * Yayinlanan olaylar:
 *   'live:candle'  her cekimde son bar
 *   'live:signal'  yeni bir bolge olayinda (kutu olusumu veya ilk dokunus)
 *                  uretilen Signal. Ayni barda birden fazla olay olustuysa
 *                  HER BIRI icin ayri olay yayinlanir.
 *   'live:status'  baslama, durma ve durum degisimi
 *   'log'          Turkce bilgi ve hata mesajlari
 */

const engine = require('./engine')
const settings = require('./settings')

const FETCH_BARS = 200
const MIN_POLL_SECONDS = 5
const MAX_POLL_SECONDS = 3600
/**
 * Degerlendirilmis olay anahtarlarindan en fazla bu kadari hatirlanir.
 * Anahtarlar yalnizca "bu olayi zaten olctum" demek icin tutulur; kuyruk
 * penceresi kaydikca eski olaylar indikator ciktisindan zaten dusuyor.
 */
const MAX_SEEN_KEYS = 500

/** @type {((type:string, data:*)=>void)|null} */
let emitter = null

const state = {
  running: false,
  tf: null,
  providerId: null,
  providerName: '',
  isProxy: false,
  pollSeconds: 20,
  basis: null,
  // Vekil kaynagin hacmini depodaki olcege tasiyan katsayi.
  volScale: null,
  sinceTime: 0,
  /**
   * Degerlendirilmis olay anahtarlari. Ayni olayin iki tikte iki kez
   * degerlendirilmesini onler; zoneId'ye guvenilemez, cunku indikator her
   * calismada kutulari sifirdan numaralandirir (bkz. core/learn/liveEvents.js).
   * @type {Set<string>}
   */
  seenKeys: new Set(),
  lastPollTime: null,
  lastBarTime: null,
  lastError: null,
  // ISCININ kendi kontrol hatasi (bar yazildi ama sinyal uretilemedi gibi).
  // `lastError` agdan gelen hatayi tutar; ikisi ayri seylerdir.
  checkError: null,
  // Depoya en son ne zaman bar YAZILDI. "Sinyal yok" ile "akis olmus" ayrimi
  // buradan gorunur: yoklama calisiyor ama bar gelmiyorsa akis olmustur.
  lastAddedTime: null,
  // Ust uste kac tiktir hata aliniyor. Tek bir gecici hata ile surekli hata
  // arasindaki farki gostergede ayirmak icin.
  consecutiveErrors: 0,
  ticks: 0,
  signals: 0,
  addedBars: 0,
  // Duzeltme hesaplanamadi veya akista bosluk var: bar yazilmiyor, once
  // Veri Cek ile eksik donem kapatilmali.
  needsSync: false,
  // Canlinin fiilen YAZDIGI zaman dilimi (1 dakikalik depo varsa '1m').
  writeTf: null,
  // Motor uzun bir isle mesgul: canli tik kuyrukta bekliyor.
  waitingForEngine: false,
  // Oturum kimligi: her start() ile artar (bkz. sessionSeq).
  session: 0,
}

let timer = null
/**
 * Calisan oturumun kimligi. `start()` her cagrildiginda artar.
 *
 * Neden gerekli: tick() iki kez await ediyor (saglayici cekimi ve isci
 * cagrisi). Bu iki nokta arasinda kullanici durdurup baslatabilir ya da zaman
 * dilimini degistirebilir; eski turun sonucu o zaman YENI zaman diliminin
 * etiketiyle grafige, hatta yeni zaman diliminin deposuna yazilabiliyordu.
 */
let sessionSeq = 0
/** Su an tik atan oturumun kimligi (0 = tik atilmiyor). */
let tickingSession = 0
let basisLogged = false
let basisWarned = false

/** ipc.js olay yollayicisini burada kaydeder. */
function setEmitter(fn) {
  emitter = typeof fn === 'function' ? fn : null
}

/** Masaustu bildirimi kancasi (ipc.js kurar). */
let notifier = null
function setNotifier(fn) {
  notifier = typeof fn === 'function' ? fn : null
}

function emitEvent(type, data) {
  if (!emitter) return
  try {
    emitter(type, data)
  } catch (err) {
    // Yayin hatasi dongueyi durdurmasin.
  }
}

function logLine(message) {
  emitEvent('log', { source: 'live', message: String(message), time: Math.floor(Date.now() / 1000) })
}

/** Saglayici modulunu tembel yukler. */
function getProviderById(id) {
  let providerMod
  try {
    providerMod = require('../core/data/provider')
  } catch (err) {
    throw new Error('Sağlayıcı modülü yüklenemedi: ' + (err && err.message ? err.message : String(err)))
  }
  const p = providerMod.getProvider(id)
  if (!p) throw new Error('Canlı sağlayıcı bulunamadı: ' + String(id))
  return p
}

/**
 * Piyasa su an acik mi (kural tabanli New York takvimi).
 *
 * Gosterge bunu bilmek zorunda: hafta sonu son barin 20 saat eski olmasi
 * NORMALDIR, sali ogleden sonra ayni sey akisin oldugunu gosterir.
 */
let piyasaTakvimi = null
function piyasaAcikMi() {
  try {
    if (!piyasaTakvimi) piyasaTakvimi = require('../core/session').createMarketCalendar()
    return piyasaTakvimi(Math.floor(Date.now() / 1000))
  } catch (err) {
    // Takvim kurulamazsa "acik" varsayariz: yanlis alarm, sessiz kalmaktan iyidir.
    return true
  }
}

/** Anlik durum. */
function status() {
  return {
    marketOpen: piyasaAcikMi(),
    running: state.running,
    tf: state.tf,
    providerId: state.providerId,
    providerName: state.providerName,
    isProxy: state.isProxy,
    pollSeconds: state.pollSeconds,
    basis: state.basis,
    volScale: state.volScale,
    lastPollTime: state.lastPollTime,
    lastBarTime: state.lastBarTime,
    lastAddedTime: state.lastAddedTime,
    lastError: state.lastError,
    checkError: state.checkError,
    consecutiveErrors: state.consecutiveErrors,
    ticks: state.ticks,
    signals: state.signals,
    addedBars: state.addedBars,
    needsSync: state.needsSync,
    writeTf: state.writeTf,
    waitingForEngine: state.waitingForEngine,
  }
}

/**
 * Canli akisi baslatir.
 * @param {{tf?:string, providerId?:string}} [opts]
 */
async function start(opts) {
  const cfg = settings.load()
  const tf = (opts && opts.tf) || cfg.timeframe || '15m'
  const providerId = (opts && opts.providerId) || (cfg.providers && cfg.providers.live) || 'yahoo'

  const provider = getProviderById(providerId)
  const apiKey = (cfg.apiKeys && cfg.apiKeys[providerId]) || ''
  if (provider.needsKey && !apiKey) {
    throw new Error(provider.name + ' için API anahtarı gerekli. Ayarlar sekmesinden girin.')
  }
  if (Array.isArray(provider.caps) && provider.caps.indexOf('live') === -1) {
    logLine(provider.name + ' canlı veri için önerilmiyor, yine de denenecek.')
  }

  stopTimer()

  state.running = true
  // Yeni oturum: bu andan once baslamis tiklerin sonucu artik gecersizdir.
  state.session = ++sessionSeq
  state.waitingForEngine = false
  state.tf = tf
  state.providerId = providerId
  state.providerName = provider.name || providerId
  state.isProxy = !!provider.isProxy
  state.pollSeconds = Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.floor(Number(cfg.livePollSeconds) || 20)))
  state.basis = null
  state.volScale = null
  // Yazim zaman dilimi asagida belirlenir; o ana kadar grafik zaman dilimi.
  state.writeTf = tf
  state.lastError = null
  state.ticks = 0
  state.signals = 0
  state.addedBars = 0
  // Baslangictan ONCEKI olaylar icin sinyal uretilmez.
  state.sinceTime = Math.floor(Date.now() / 1000)
  state.seenKeys = new Set()
  basisLogged = false
  basisWarned = false

  logLine('Canlı akış başladı: ' + state.providerName + ', ' + tf + ', ' + state.pollSeconds + ' saniyede bir.')
  emitEvent('live:status', status())

  // 1 dakikalik depo varsa canli akis 1 dakikalik bar ceker ve yalnizca
  // 1m'ye yazar. Depo durumu isciden bir kez sorulur; her tikte sormak
  // gereksiz bir tur ekler.
  yazimTfBelirle(tf).catch(() => {})

  timer = setInterval(() => {
    tick().catch(() => {})
  }, state.pollSeconds * 1000)
  if (timer.unref) timer.unref()

  // Ilk cekimi beklemeden baslat.
  tick().catch(() => {})

  return status()
}

/**
 * Canlinin hangi zaman dilimine yazacagini belirler.
 *
 * 1 dakikalik depo varsa 1m'ye yazilir ve grafik ondan turetilir; boylece
 * turetilmis dosyalar 1 dakikalikla ayrismaz (V6). Depo durumu okunamazsa
 * eski davranisa (grafik zaman dilimine yazma) dusulur.
 */
async function yazimTfBelirle(tf) {
  if (tf === '1m') {
    state.writeTf = '1m'
    return
  }
  try {
    const durumBilgisi = await engine.call('data:status', {})
    const satir = durumBilgisi && durumBilgisi.byTf ? durumBilgisi.byTf['1m'] : null
    const varMi = !!(satir && Number(satir.count) > 0)
    state.writeTf = varMi ? '1m' : tf
    if (varMi) {
      logLine('Canlı barlar 1 dakikalık depoya yazılıyor, ' + tf + ' serisi ondan türetiliyor.')
    }
  } catch (err) {
    state.writeTf = tf
  }
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Canli akisi durdurur. */
function stop() {
  const wasRunning = state.running
  stopTimer()
  state.running = false
  // Oturum kimligi degisir: suren tikin sonucu kullanilmaz.
  state.session = ++sessionSeq
  state.waitingForEngine = false
  if (wasRunning) {
    logLine('Canlı akış durduruldu.')
    emitEvent('live:status', status())
  }
  return status()
}

/** Tek bir cekim adimi. */
async function tick() {
  if (!state.running) return
  // Ayni OTURUMUN tiki calisiyorsa atla. Global bir bayrak, yeni oturumun ilk
  // tikini de atliyordu: durdur/baslat sonrasi ilk veri bir tur gecikiyordu.
  const oturum = state.session
  if (tickingSession === oturum) return
  tickingSession = oturum
  try {
    const cfg = settings.load()
    // Tur boyunca kullanilacak DEGERLER BASTA alinir. Onceden tf iki ayri
    // yerden okunuyordu (cekimden once ve sonra) ve arada degisebiliyordu.
    const tf = state.tf
    const providerId = state.providerId
    const provider = getProviderById(providerId)
    const apiKey = (cfg.apiKeys && cfg.apiKeys[providerId]) || ''
    const tfmod = require('../core/tf')
    // YAZIM ZAMAN DILIMI (V6): 1 dakikalik depo varsa canli akis 1 dakikalik
    // bar ceker ve YALNIZCA 1m'ye yazar; grafigin zaman dilimi ondan
    // turetilir. Onceden her zaman dilimi kendi dosyasina yaziliyordu ve
    // dosyalar sessizce ayrisiyordu (olculdu: 5m 323 bar geride, 15m'de 181
    // fazla / 95 eksik bar).
    const yazimTf = state.writeTf || tf
    const tfSec = tfmod.tfSeconds(yazimTf)

    // Kapanmis bar olcutu bu an uzerinden hesaplanir. Istegin GONDERILDIGI
    // ani kullaniriz: isci uzun bir isle mesgulse mesaj dakikalar sonra
    // islenebilir ve o sirada acik olan bar kapanmis sayilirdi.
    const now = Math.floor(Date.now() / 1000)
    let from = now - tfSec * (FETCH_BARS + 5)
    // Ilk turda ve iki tur arasi sure beklenenin iki katini astiysa (uyku,
    // uzun surmus bir is, ag kesintisi) 200 barlik pencere yetmez: depodaki
    // son bardan itibaren cekeriz, yoksa aradaki barlar kalici olarak eksik
    // kalir ve seride delik olusur.
    const gecen = state.lastPollTime ? now - state.lastPollTime : Infinity
    if (gecen > state.pollSeconds * 2 && state.lastBarTime) {
      from = Math.min(from, state.lastBarTime)
    }

    const fetched = await provider.fetchCandles({
      tfSec: tfSec,
      from: from,
      to: now,
      apiKey: apiKey,
    })

    // Cekim sirasinda durdurulmus, yeniden baslatilmis ya da zaman dilimi
    // degistirilmis olabiliriz. Oturum degistiyse bu turun sonucu ARTIK
    // BASKA BIR SEYE ait: kullanilmaz.
    if (!state.running || state.session !== oturum) return

    if (!fetched || !fetched.length) {
      state.lastError = 'Sağlayıcıdan mum gelmedi.'
      logLine(state.providerName + ': mum gelmedi, tekrar denenecek.')
      return
    }

    // MOTOR MESGULSE ARAYUZ BILSIN. Tek isci oldugu icin uzun bir geriye test
    // suruyorken canli tik kuyrukta bekler (olculdu: 1m testi 53-60 sn) ve
    // arayuzde bu hic gorunmuyordu.
    try {
      const motor = engine.status()
      const bekleyen = motor && Number.isFinite(motor.pending) ? motor.pending : 0
      if (bekleyen > 0 && !state.waitingForEngine) {
        state.waitingForEngine = true
        emitEvent('live:status', status())
      }
    } catch (err) {
      // Durum okunamazsa tik yine denenir.
    }

    const res = await engine.call('engine:live-tick', {
      tf: tf,
      series: {
        length: fetched.length,
        time: fetched.time,
        open: fetched.open,
        high: fetched.high,
        low: fetched.low,
        close: fetched.close,
        volume: fetched.volume,
      },
      // Grafik zaman dilimi (sinyal ve hafiza bunun uzerinden).
      writeTf: yazimTf,
      isProxy: state.isProxy,
      // Hangi saglayicidan geldigi canli sinyal gunlugune yazilir: sonradan
      // "bu olcu hangi kaynakla alindi" sorusu cevaplanabilmeli.
      providerId: providerId,
      basis: state.basis,
      volScale: state.volScale,
      basisWarned: basisWarned,
      fetchedAt: now,
      sinceTime: state.sinceTime,
      // Zaten degerlendirilmis olaylar tekrar degerlendirilmez.
      seenKeys: Array.from(state.seenKeys),
      params: cfg.indicatorParams || {},
      // Esikler ve hedef, isci tarafinda presets.resolveCfg ile cozulur:
      // tarama, test ve canli AYNI birlestirmeyi kullanmak zorunda
      // (onceden canli varsayilan 1.0 ATR hedefle plan kuruyordu, hafiza ise
      // 1.5 ATR ile etiketlenmisti).
      cfgPatch: settings.loadPatch(),
    })

    state.waitingForEngine = false
    // ISCI YANITI ARTIK BASKA BIR OTURUMA AIT OLABILIR.
    //
    // Isci tf'yi yanitinda geri donuyor; eslesmiyorsa yanit ATILIR. Aksi
    // halde eski zaman diliminin barlari yeni zaman diliminin etiketiyle
    // grafige ve duruma yazilabiliyordu.
    if (!state.running || state.session !== oturum) return
    if (res && res.tf && res.tf !== tf) return

    state.ticks += 1
    state.lastPollTime = Math.floor(Date.now() / 1000)
    state.lastError = null
    state.consecutiveErrors = 0
    // Isci kendi icinde bir kontrol hatasi bildirdiyse gostergede gorunmeli:
    // bar yaziliyor ama sinyal uretilemiyor olabilir.
    state.checkError = res && res.checkError ? String(res.checkError) : null

    if (res && res.basisWarned) basisWarned = true
    if (res && typeof res.volScale === 'number' && isFinite(res.volScale) && res.volScale > 0) {
      state.volScale = res.volScale
    }
    if (res && typeof res.basis === 'number' && isFinite(res.basis)) {
      state.basis = res.basis
      if (!basisLogged) {
        basisLogged = true
        logLine('Vekil kaynak fiyatı spot seviyesine ' + res.basis.toFixed(2) + ' birim kaydırılarak kullanılıyor.')
      }
    }
    if (res && Array.isArray(res.logs)) {
      for (const line of res.logs) logLine(line)
    }
    if (res && res.lastBar) {
      state.lastBarTime = res.lastBar.time
      emitEvent('live:candle', { tf: state.tf, bar: res.lastBar, providerId: state.providerId })
    }
    if (res && res.added > 0) {
      state.addedBars += res.added
      state.lastAddedTime = Math.floor(Date.now() / 1000)
    }
    // Duzeltme hesaplanamadi ya da akista bosluk olustu: bar YAZILMADI.
    // Arayuz bunu gorunce eksik donemi Veri Cek ile kapatir, yoksa canli
    // akis sessizce durur.
    if (res && res.needsSync) {
      state.needsSync = true
      emitEvent('live:gap', {
        tf: state.tf,
        providerId: state.providerId,
        lastBarTime: state.lastBarTime,
      })
    } else if (res && res.added > 0) {
      state.needsSync = false
    }
    // BU TIKTE YENI OLAN TUM OLAYLAR. Onceden yalnizca bir tanesi
    // yayinlaniyordu ve `sinceTime` onun zamanina cekildigi icin ayni bardaki
    // diger olaylar kalici olarak kayboluyordu.
    const yeniOlaylar = res && Array.isArray(res.events) ? res.events : []
    for (const olay of yeniOlaylar) {
      if (!olay) continue
      const anahtar = olay.key ? String(olay.key) : ''
      if (anahtar) state.seenKeys.add(anahtar)
      const zaman = olay.touch && typeof olay.touch.time === 'number' ? olay.touch.time : null
      if (zaman !== null && zaman > state.sinceTime) state.sinceTime = zaman
      if (!olay.signal) continue
      state.signals += 1
      emitEvent('live:signal', { tf: tf, signal: olay.signal, touch: olay.touch || null })
      // MASAUSTU BILDIRIMI: sinyal seyrek gelir, kacan her sinyal pahali.
      // Kural katmani notify.js'te (yalnizca tetiklenen, gecikmemis ve
      // kanitli turler).
      if (notifier) {
        try {
          notifier({ tf: tf, signal: olay.signal })
        } catch (err) {
          // Bildirim gosterilemezse akis durmamali.
        }
      }
      const dir = olay.signal.direction === 'BUY' ? 'ALIŞ' : 'SATIŞ'
      if (olay.signal.fired) {
        const tur = olay.signal.kind === 'form' ? 'kutu oluşumu' : 'bölge dokunuşu'
        // Ozet metin isciden gelir (learn/signalText.js): "9/15 tuttu,
        // %95 aralik %36-80, tur tabani %40". "Basari beklentisi %X" tek
        // basina orneklem buyuklugunu gizliyordu.
        const ozet = olay.signal.summaryText || ''
        logLine('Yeni sinyal: ' + dir + ' (' + tur + ')' + (ozet ? ', ' + ozet : '') +
          (olay.signal.stale ? ', gecikmeli değerlendirildi' : '') + '.')
      } else {
        logLine('Yeni bölge olayı bulundu ama eşikler geçilmedi, sinyal yayınlanmadı.')
      }
    }
    // Hafizanin sinirini as: eski anahtarlar dusurulur.
    if (state.seenKeys.size > MAX_SEEN_KEYS) {
      const hepsi = Array.from(state.seenKeys)
      state.seenKeys = new Set(hepsi.slice(hepsi.length - MAX_SEEN_KEYS))
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    state.lastError = message
    state.consecutiveErrors += 1
    // Durdurulduktan sonra gelen hatalar icin gurultu yapma.
    if (state.running) logLine('Canlı veri hatası: ' + message + ' Denemeye devam ediliyor.')
  } finally {
    if (tickingSession === oturum) tickingSession = 0
    // HER TIKTE DURUM YAYINLANIR.
    //
    // Gosterge onceden yalnizca baslama ve durmada guncelleniyordu: Binance
    // yanit vermese bile "Canli: acik" yesil kaliyordu ve "sinyal yok" ile
    // "akis olmus" ayirt edilemiyordu.
    emitEvent('live:status', status())
  }
}

module.exports = {
  setEmitter,
  setNotifier,
  start,
  stop,
  status,
}
