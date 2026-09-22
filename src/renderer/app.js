/**
 * app.js - Arayuz baslatici ve olay yonlendirici (A10b).
 *
 * Tum komutlar `window.api.call(cmd, payload)` uzerinden gider. Hicbir cagri
 * yakalanmamis hata birakmaz: her hata alt seritte TURKCE gosterilir ve
 * uygulama ayakta kalir. Bulunamayan element kimlikleri sessizce atlanir.
 *
 * Sorumluluklar:
 *   - Acilista ayarlari, veri durumunu, mumlari, bolgeleri ve sinyalleri yukler
 *   - Zaman dilimi, saglayici, canli anahtari, tarama ve test akislarini yurutur
 *   - Grafigi (chart.js) ve bolge katmanini (overlay.js) besler
 *   - Sag paneli (panels.js) cizer ve etkilesimleri geri baglar
 *
 * Element kimlikleri index.html'de ilan edilenlerdir; kisa adli eski sema da
 * yedek olarak denenir, boylece iskelet degisse de uygulama calisir.
 */

import { createChartView } from './chart.js'
import { createZoneOverlay } from './overlay.js'
import { isaretMetni, sinyalOzetiMetni } from './istatistik.mjs'
import {
  renderSignals,
  renderSignalDetail,
  renderZones,
  renderMemory,
  renderSettings,
  renderBacktest,
  renderLiveLog,
  formatNumber,
  formatPercent,
  formatPrice,
  formatDate,
  formatDateTime,
} from './panels.js'

/* ------------------------------------------------------------------ */
/* Sabitler                                                            */
/* ------------------------------------------------------------------ */

const TF_LISTESI = ['1m', '5m', '15m', '30m', '1h', '4h']
const TF_SANIYE = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }

const RENK = { up: '#26a69a', down: '#ef5350', dim: '#787b86', warn: '#f2b40e' }

/** Sag panel sekmeleri: anahtar -> {panel kimlikleri, sekme kimlikleri}. */
// Panel kimlikleri index.html ile birebir. Bir donem her satirda Turkce bir
// YEDEK kimlik de vardi (panelSinyaller gibi); o kimlikler hicbir zaman
// index.html'e girmedi, yani yedek hic calismadi ve yalnizca "iki farkli
// iskelet olabilir" izlenimi verdi.
const PANELLER = {
  signals: { panel: ['panelSignals'], baslik: 'Sinyaller' },
  zones: { panel: ['panelZones'], baslik: 'Bölgeler' },
  memory: { panel: ['panelMemory'], baslik: 'Hafıza' },
  settings: { panel: ['panelSettings'], baslik: 'Ayarlar' },
  test: { panel: ['panelTest'], baslik: 'Test' },
}

const MUM_LIMITI = 4000
const ARALIK_GECIKMESI_MS = 200

/* ------------------------------------------------------------------ */
/* Durum                                                               */
/* ------------------------------------------------------------------ */

const durum = {
  ayarlar: null,
  ayarYamasi: {},
  // Kullanicinin kayitli (diskteki) ayar yamasi; motor bunu hazir ayarla
  // birlestirir. Birlesik ayar gonderilse hazir ayar katmani devre disi kalir.
  ayarYamasiKayitli: null,
  saglayicilar: [],
  tf: '15m',
  bars: [],
  zones: [],
  // Depodaki veri durumu (kac bar, ilk/son zaman). Gecmise dogru
  // genisletme bunun firstTime alanina bakar.
  veriDurumu: null,
  signals: [],
  seciliSinyalId: null,
  // "Benzer gecmis ornekler" listesinden secilen kayit. Grafikte ayri bir
  // isaretle gosterilir, boylece hangi ana gidildigi belli olur.
  vurguluOrnek: null,
  seciliBolgeId: null,
  // U7: "o ana kadar" kipinde grafigin kilitlendigi an (UNIX saniye).
  // null ise kisitlama yok, her sey son durumuyla cizilir.
  asOf: null,
  hafizaOzeti: null,
  prototipler: [],
  testSonucu: null,
  // Canli sinyal gunlugunun ozeti (`engine:live-log`). Canli performans ile
  // Test sekmesinde olculen rakam ancak boylece karsilastirilabilir.
  canliGunluk: null,
  testCalisiyor: false,
  // Otomatik hazirlik (eksik mum indirme ve gerekirse tarama) suruyor mu.
  hazirlikCalisiyor: false,
  taramaCalisiyor: false,
  canli: false,
  // Isciden gelen sinyal listesi kirpildi mi (U8).
  sinyalToplam: 0,
  sinyalKirpildi: false,
  // Alt serit mesaj gecmisi (U8): {t, seviye, metin}
  mesajGecmisi: [],
  sonHataAni: 0,
  motorHatali: false,
  aktifPanel: 'signals',
  aktifGorunum: 'analysis',
  motorMetni: 'Motor: hazır',
}

/** @type {any} */
let view = null
/** @type {any} */
let overlay = null

let aralikZamanlayici = 0
let mesajZamanlayici = 0
let saatZamanlayici = 0

/* ------------------------------------------------------------------ */
/* Kucuk yardimcilar                                                   */
/* ------------------------------------------------------------------ */

/** Verilen kimliklerden ilk bulunani dondurur, yoksa null. */
function el(...kimlikler) {
  for (let i = 0; i < kimlikler.length; i++) {
    const e = document.getElementById(kimlikler[i])
    if (e) return e
  }
  return null
}

/** Sonlu sayi veya yedek. */
function sayi(v, yedek) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : (yedek === undefined ? 0 : yedek)
}

/** Hata nesnesinden okunabilir mesaj. */
function hataMetni(err) {
  if (!err) return 'Bilinmeyen hata'
  if (typeof err === 'string') return err
  if (err.message) return String(err.message)
  return String(err)
}

/** Zaman diliminin saniye karsiligi. */
function tfSaniye(tf) {
  return TF_SANIYE[tf] || 900
}

/** Elementi gosterir veya gizler. */
function goster(e, acikMi) {
  if (!e) return
  e.hidden = !acikMi
  e.style.display = acikMi ? '' : 'none'
}

/** Bir panelin govde kabini bulur (.panel-body varsa onu). */
function panelGovdesi(anahtar) {
  const tanim = PANELLER[anahtar]
  if (!tanim) return null
  const p = el.apply(null, tanim.panel)
  if (!p) return null
  return p.querySelector('.panel-body') || p
}

/* ------------------------------------------------------------------ */
/* Alt serit bildirimleri                                              */
/* ------------------------------------------------------------------ */

// ALT SERIT MESAJLARI (U8)
//
// Alt seritte TEK bir satir vardi ve her mesaj bir oncekini eziyordu. Iki
// somut sonucu: (1) bir hata 20 saniye duracakken hemen ardindan gelen
// siradan bir 'log' satiri onu siliyordu, kullanici hatayi hic gormuyordu;
// (2) hata sonrasi akis `motorDurumu('hazır')` ile bitiyordu ve motor
// gercekte basarisiz olmusken "hazır" yaziyordu.
//
// Artik mesajlar gecmiste tutuluyor, hata 12 saniye boyunca ezilmiyor ve
// hata olduysa motor satiri kirmizi kaliyor. Satira tiklaninca gecmis acilir.

/** Gecmiste tutulan en fazla mesaj sayisi. */
const MESAJ_GECMISI_SINIRI = 50
/** Bir hatanin bilgi mesajiyla ezilemeyecegi sure. */
const HATA_KORUMA_MS = 12000

/** Gecmise bir satir ekler. */
function mesajKaydet(seviye, metin) {
  durum.mesajGecmisi.push({ t: Date.now(), seviye: seviye, metin: String(metin) })
  if (durum.mesajGecmisi.length > MESAJ_GECMISI_SINIRI) {
    durum.mesajGecmisi.splice(0, durum.mesajGecmisi.length - MESAJ_GECMISI_SINIRI)
  }
  if (mesajGecmisiAcik) mesajGecmisiniCiz()
}

/** Motor satirini yazar; hata olduysa kirmizi kalir. */
function motorSatiriniYaz() {
  const e = el('statusEngine')
  if (!e) return
  e.textContent = durum.motorMetni
  if (durum.motorHatali) e.classList.add('hata')
  else e.classList.remove('hata')
}

/** Motor durumunu alt seritte gosterir. */
function motorDurumu(metin) {
  durum.motorMetni = 'Motor: ' + metin
  motorSatiriniYaz()
}

/** Bilgi mesaji (ses ve gorsel efekt yok, yalnizca alt serit satiri). */
function bildir(mesaj) {
  mesajKaydet('bilgi', mesaj)
  // Taze bir hata duruyorsa ustune yazma; mesaj gecmiste zaten duruyor.
  if (durum.sonHataAni && (Date.now() - durum.sonHataAni) < HATA_KORUMA_MS) return
  const e = el('statusMessage', 'statusEngine')
  if (!e) return
  e.textContent = String(mesaj)
  e.style.color = ''
  if (mesajZamanlayici) clearTimeout(mesajZamanlayici)
  mesajZamanlayici = setTimeout(() => {
    mesajZamanlayici = 0
    if (el('statusMessage')) el('statusMessage').textContent = ''
  }, 20000)
}

/** Hatayi alt seritte Turkce gosterir. */
function hataGoster(mesaj) {
  mesajKaydet('hata', mesaj)
  durum.sonHataAni = Date.now()
  durum.motorHatali = true
  motorSatiriniYaz()

  const e = el('statusMessage', 'statusEngine')
  if (e) {
    e.textContent = 'Hata: ' + mesaj
    e.style.color = RENK.down
  }
  if (mesajZamanlayici) clearTimeout(mesajZamanlayici)
  mesajZamanlayici = setTimeout(() => {
    mesajZamanlayici = 0
    const m = el('statusMessage')
    if (m) { m.textContent = 'Son hata için alt şeride tıklayın.'; m.style.color = '' }
  }, HATA_KORUMA_MS)
}

/** Mesaj gecmisi kutusu acik mi. */
let mesajGecmisiAcik = false

/** Gecmis kutusunu doldurur. */
function mesajGecmisiniCiz() {
  const kutu = el('messageLog')
  if (!kutu) return
  while (kutu.firstChild) kutu.removeChild(kutu.firstChild)

  const baslik = document.createElement('div')
  baslik.className = 'msg-head'
  baslik.textContent = 'Son mesajlar'
  const kapat = document.createElement('button')
  kapat.type = 'button'
  kapat.className = 'btn mini'
  kapat.textContent = 'Kapat'
  kapat.addEventListener('click', () => mesajGecmisiniKapat())
  baslik.appendChild(kapat)
  kutu.appendChild(baslik)

  if (durum.mesajGecmisi.length === 0) {
    const bos = document.createElement('div')
    bos.className = 'msg-row'
    bos.textContent = 'Henüz mesaj yok.'
    kutu.appendChild(bos)
    return
  }
  for (let i = durum.mesajGecmisi.length - 1; i >= 0; i--) {
    const m = durum.mesajGecmisi[i]
    const satir = document.createElement('div')
    satir.className = 'msg-row' + (m.seviye === 'hata' ? ' hata' : '')
    const saat = document.createElement('span')
    saat.className = 'msg-time'
    saat.textContent = saatMetni(m.t)
    const metin = document.createElement('span')
    metin.textContent = m.metin
    satir.appendChild(saat)
    satir.appendChild(metin)
    kutu.appendChild(satir)
  }
}

/** Gecmisi acar; hata isareti "gorulmus" sayilir. */
function mesajGecmisiniAc() {
  const kutu = el('messageLog')
  if (!kutu) return
  mesajGecmisiAcik = true
  // Hata gorulmus sayilir: motor satirindaki kirmizi ve alt seritteki
  // "son hataya bakin" hatirlatmasi kalkar.
  durum.motorHatali = false
  durum.sonHataAni = 0
  motorSatiriniYaz()
  const satir = el('statusMessage')
  if (satir && satir.textContent === 'Son hata için alt şeride tıklayın.') {
    satir.textContent = ''
    satir.style.color = ''
  }
  mesajGecmisiniCiz()
  kutu.removeAttribute('hidden')
}

/** Gecmisi kapatir. */
function mesajGecmisiniKapat() {
  mesajGecmisiAcik = false
  const kutu = el('messageLog')
  if (kutu) kutu.setAttribute('hidden', '')
}

/** Canli durum metnini gunceller. */
function canliDurumuYaz() {
  const e = el('statusLive')
  if (!e) return
  if (!durum.canli) {
    e.textContent = 'Canlı: kapalı'
    e.style.color = ''
    e.title = ''
    return
  }

  // CANLI SAGLIK GOSTERGESI.
  //
  // Gosterge onceden hata durumunda da yesil "Canlı: açık" kaliyordu:
  // Binance yanit vermezse "sinyal yok" ile "akis olmus" ayirt edilemiyordu.
  // Uc durum var:
  //   kirmizi  son turda hata alindi
  //   turuncu  yoklama ya da veri bayat (akis duruyor olabilir)
  //   yesil    yoklama guncel ve veri geliyor
  const d = durum.canliDurum || {}
  const simdi = Math.floor(Date.now() / 1000)
  const yoklamaAralik = sayi(d.pollSeconds, 20)
  const sonYoklama = sayi(d.lastPollTime, 0)
  const yoklamaYas = sonYoklama > 0 ? simdi - sonYoklama : Infinity
  const sonVeri = sayi(d.lastBarTime, 0)
  const tfSn = tfSaniye(durum.tf)
  const veriYas = sonVeri > 0 ? simdi - sonVeri : Infinity

  let renk = RENK.up
  if (d.lastError) renk = RENK.down
  else if (yoklamaYas > yoklamaAralik * 3) renk = RENK.warn
  // Veri yasi olcutu bar suresine baglidir: 15 dakikalikta iki bar 30 dakika
  // demektir, bu normaldir; 1 dakikalikta iki dakika gecikme anormaldir.
  // PIYASA KAPALIYKEN bakilmaz: hafta sonu son barin 20 saat eski olmasi
  // normaldir, uyari vermek gostergeyi anlamsizlastirir.
  else if (d.marketOpen !== false && tfSn > 0 && veriYas > tfSn * 2 + yoklamaAralik * 2) {
    renk = RENK.warn
  }

  const parcalar = ['Canlı: açık (' + durum.tf + ')']
  if (Number.isFinite(veriYas)) parcalar.push('son veri ' + sureMetni(veriYas) + ' önce')
  else parcalar.push('henüz veri yok')
  if (d.marketOpen === false) parcalar.push('piyasa kapalı')
  e.textContent = parcalar.join(', ')
  e.style.color = renk

  const ipucu = []
  if (d.lastError) ipucu.push('Hata: ' + d.lastError)
  if (d.checkError) ipucu.push('Kontrol hatası: ' + d.checkError)
  if (sayi(d.consecutiveErrors, 0) > 1) {
    ipucu.push(formatNumber(d.consecutiveErrors, 0) + ' turdur hata alınıyor')
  }
  ipucu.push('Yoklama: ' + (Number.isFinite(yoklamaYas) ? sureMetni(yoklamaYas) + ' önce' : 'yok') +
    ' (her ' + formatNumber(yoklamaAralik, 0) + ' sn)')
  ipucu.push('Tur sayısı: ' + formatNumber(sayi(d.ticks, 0), 0))
  ipucu.push('Eklenen bar: ' + formatNumber(sayi(d.addedBars, 0), 0))
  if (typeof d.basis === 'number' && isFinite(d.basis)) {
    ipucu.push('Fiyat kaydırması: ' + formatNumber(d.basis, 2))
  }
  if (typeof d.volScale === 'number' && isFinite(d.volScale)) {
    ipucu.push('Hacim ölçeği: ' + formatNumber(d.volScale, 1))
  }
  if (d.needsSync) ipucu.push('Eksik dönem var, Veri Çek gerekiyor')
  e.title = ipucu.join('\n')
}

/** Saniyeyi kisa okunabilir sureye cevirir: 35 sn, 4 dk, 2 sa. */
function sureMetni(sn) {
  if (!Number.isFinite(sn)) return '-'
  if (sn < 90) return Math.round(sn) + ' sn'
  if (sn < 5400) return Math.round(sn / 60) + ' dk'
  if (sn < 172800) return Math.round(sn / 3600) + ' sa'
  return Math.round(sn / 86400) + ' gün'
}


/** Kaynak durum metnini gunceller. */
function kaynakDurumuYaz() {
  const e = el('statusProvider')
  if (!e) return
  const ayar = durum.ayarlar && durum.ayarlar.providers ? durum.ayarlar.providers : {}
  const gecmis = ayar.history || '-'
  // Canli akis actiksa GERCEKTEN kullanilan saglayiciyi yaz; ayar dosyasi
  // acilistan sonra degismis olabilir ve eski adi gostermek yaniltir.
  const canliK = (durum.canliDurum && durum.canliDurum.providerId) || ayar.live || '-'
  let metin = 'Kaynak: ' + gecmis + ' / canlı ' + canliK
  // Vekil kaynakta uygulanan fiyat kaydirmasini da gosteririz; kullanicinin
  // grafikteki fiyatin duzeltilmis oldugunu bilmesi gerekir.
  const b = durum.canliDurum && durum.canliDurum.basis
  if (durum.canli && typeof b === 'number' && isFinite(b) && b !== 0) {
    metin += ' (vekil, ' + (b > 0 ? '+' : '') + b.toFixed(2) + ' kaydırma)'
  }
  e.textContent = metin
}

/* ------------------------------------------------------------------ */
/* API koprusu                                                         */
/* ------------------------------------------------------------------ */

/** Komut cagirir, hata firlatir. */
async function cagir(cmd, payload) {
  if (!window.api || typeof window.api.call !== 'function') {
    throw new Error('Uygulama köprüsü hazır değil')
  }
  return await window.api.call(cmd, payload || {})
}

/** Komut cagirir, hatayi alt seritte gosterir ve null doner. */
async function cagirGuvenli(cmd, payload, etiket) {
  try {
    return await cagir(cmd, payload)
  } catch (err) {
    hataGoster((etiket || cmd) + ': ' + hataMetni(err))
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Veri normallestirme                                                 */
/* ------------------------------------------------------------------ */

/** Tek bir mumu duz nesneye cevirir. */
function barNesnesi(b) {
  if (!b) return null
  const t = sayi(b.time, NaN)
  if (!Number.isFinite(t)) return null
  return {
    time: t,
    open: sayi(b.open, NaN),
    high: sayi(b.high, NaN),
    low: sayi(b.low, NaN),
    close: sayi(b.close, NaN),
    volume: sayi(b.volume, 0),
  }
}

/**
 * Motordan gelen mum verisini duz bar dizisine cevirir.
 * Hem sutunsal Series hem bar dizisi kabul edilir.
 */
function barlariNormalle(ham) {
  if (!ham) return []
  if (Array.isArray(ham)) {
    const cikti = []
    for (let i = 0; i < ham.length; i++) {
      const b = barNesnesi(ham[i])
      if (b) cikti.push(b)
    }
    return cikti
  }
  if (Array.isArray(ham.bars)) return barlariNormalle(ham.bars)
  if (Array.isArray(ham.candles)) return barlariNormalle(ham.candles)
  if (ham.series) return barlariNormalle(ham.series)

  const zaman = ham.time
  if (zaman && typeof zaman.length === 'number') {
    const n = sayi(ham.length, zaman.length) | 0
    const acilis = ham.open || []
    const yuksek = ham.high || []
    const dusuk = ham.low || []
    const kapanis = ham.close || []
    const hacim = ham.volume || []
    const cikti = []
    for (let i = 0; i < n; i++) {
      const t = sayi(zaman[i], NaN)
      if (!Number.isFinite(t)) continue
      cikti.push({
        time: t,
        open: sayi(acilis[i], NaN),
        high: sayi(yuksek[i], NaN),
        low: sayi(dusuk[i], NaN),
        close: sayi(kapanis[i], NaN),
        volume: sayi(hacim[i], 0),
      })
    }
    return cikti
  }
  return []
}

/** Bolge yanitini diziye cevirir. */
function bolgeleriNormalle(ham) {
  if (Array.isArray(ham)) return ham
  if (ham && Array.isArray(ham.zones)) return ham.zones
  return []
}

/** Sinyal yanitini diziye cevirir ve kimliksiz kayitlara kimlik uretir. */
function sinyalleriNormalle(ham) {
  let liste = []
  if (Array.isArray(ham)) liste = ham
  else if (ham && Array.isArray(ham.signals)) liste = ham.signals
  else if (ham && ham.signal) liste = [ham.signal]
  // Kirpma bilgisi: isci son N sinyali doner, panel bunu yazmali.
  durum.sinyalToplam = (ham && Number.isFinite(Number(ham.total))) ? Number(ham.total) : liste.length
  durum.sinyalKirpildi = !!(ham && ham.truncated === true)
  for (let i = 0; i < liste.length; i++) {
    const s = liste[i]
    if (!s) continue
    if (s.id === undefined || s.id === null || s.id === '') {
      s.id = 'sig-' + sayi(s.time, i) + '-' + (s.direction === 'SELL' ? 'S' : 'B')
    }
  }
  return liste
}

/** Dokunus yanitini diziye cevirir. */
function dokunuslariNormalle(ham) {
  if (Array.isArray(ham)) return ham
  if (ham && Array.isArray(ham.touches)) return ham.touches
  return []
}

/** Veri durumu yanitindan secili zaman dilimine ait kaydi cikarir. */
function veriDurumuKaydi(ham, tf) {
  if (!ham || typeof ham !== 'object') return null
  if (ham[tf] && typeof ham[tf] === 'object') return ham[tf]
  if (ham.byTf && ham.byTf[tf]) return ham.byTf[tf]
  if (Array.isArray(ham.timeframes)) {
    for (let i = 0; i < ham.timeframes.length; i++) {
      if (ham.timeframes[i] && ham.timeframes[i].tf === tf) return ham.timeframes[i]
    }
  }
  return ham
}

/* ------------------------------------------------------------------ */
/* Grafik ve bolge katmani                                             */
/* ------------------------------------------------------------------ */

/** Grafigi ve bolge katmanini kurar. */
function grafigiKur() {
  const kap = el('chart') || el('chartWrap')
  const sarmal = el('chartWrap') || kap
  if (!kap) return

  try {
    view = createChartView(kap)
  } catch (err) {
    view = null
    hataGoster('Grafik kurulamadı: ' + hataMetni(err))
    return
  }

  // Hata ayiklama tutamagi: gelistirici konsolundan grafik ve durum incelenebilir.
  // contextIsolation acik oldugu icin bu yalnizca renderer icinde gorunur,
  // ana surece veya dosya sistemine erisim vermez.
  window.__zm = { view: view, durum: durum }

  try {
    overlay = createZoneOverlay(view, sarmal)
    if (overlay && typeof overlay.onZoneClick === 'function') {
      overlay.onZoneClick((z) => { if (z) bolgeSec(z) })
    }
    window.__zm.overlay = overlay
  } catch (err) {
    overlay = null
    hataGoster('Bölge katmanı kurulamadı: ' + hataMetni(err))
  }

  if (typeof view.onVisibleRangeChange === 'function') {
    try {
      view.onVisibleRangeChange(gorunurAralikDegisti)
    } catch (err) {
      hataGoster('Görünür aralık dinlenemedi: ' + hataMetni(err))
    }
  }

  if (typeof view.onCrosshairMove === 'function') {
    try {
      view.onCrosshairMove((bar) => efsaneyiYaz(bar))
    } catch (err) {
      // Efsane kutusu olmasa da uygulama calisir.
    }
  }

  // ISARETE tiklaninca o sinyal secilir.
  //
  // Onceden grafigin HERHANGI bir yerine tiklamak, 1,5 bar icindeki sinyali
  // seciyordu. Bir kutunun sol kenarina tiklayip bolgeyi incelemek isteyen
  // kullanici, kutu bir sinyalin yaninda dogdugu icin sinyal paneline
  // atiyordu: iki tiklama ayni noktada carpisiyordu. Isaret tiklamasi zaten
  // vardi ama chart.js'te ad cakismasi yuzunden hic calismiyordu (duzeltildi).
  if (typeof view.onMarkerClick === 'function') {
    try {
      view.onMarkerClick((bilgi) => {
        if (!bilgi || bilgi.id === undefined || bilgi.id === null) return
        const s = durum.signals.find((x) => x && String(x.id) === String(bilgi.id))
        if (s) sinyalSec(s)
      })
    } catch (err) {
      // Isaret tiklamasi olmasa da uygulama calisir.
    }
  }
}

/** Grafik cagrilarini guvenli sarar. */
function grafik(fnAdi, arg) {
  if (!view || typeof view[fnAdi] !== 'function') return
  try {
    view[fnAdi](arg)
  } catch (err) {
    hataGoster('Grafik güncellenemedi: ' + hataMetni(err))
  }
}

/** Bolgeleri katmana verir. */
function bolgeleriCiz() {
  if (!overlay || typeof overlay.setZones !== 'function') return
  const anahtar = el('zoneShowToggle')
  const acik = anahtar ? !!anahtar.checked : true
  try {
    overlay.setZones(acik ? durum.zones : [])
  } catch (err) {
    hataGoster('Bölgeler çizilemedi: ' + hataMetni(err))
  }
}

/* ------------------------------------------------------------------ */
/* U7 - "O ana kadar goster" (gorsel ileriye bakma)                    */
/* ------------------------------------------------------------------ */
//
// Gecmis bir sinyale tiklandiginda grafik, o sinyalden SONRAKI her seyi de
// gosteriyordu: sonraki mumlar ve kutularin bugunku durumu. Sinyal aninda
// saglam olan bir destek, iki hafta sonra kirildigi icin kesikli ciziliyordu.
// Kullanici "zaten kirilacakmis" diye okuyup kendi degerlendirmesini gecmise
// uyduruyordu. Bu kip, ekrani o anda gerceklen gorulebilecek bilgiyle
// sinirlar. Kapatilinca sonuc gorunur, zaten inceleme icin o da gerekir.

/** Kip acik mi (kutu isaretli). */
function anaKadarAcikMi() {
  const anahtar = el('asOfToggle')
  return anahtar ? !!anahtar.checked : false
}

/**
 * Verilen an icin kilit ANLAMLI mi.
 *
 * Gizlenecek bir gelecek yoksa kilit kurulmaz. Canli sinyal tam da son barda
 * dogar: orada kilit kurmak yalnizca canli akisi durdururdu.
 * @param {number} zaman
 */
function anaKadarGerekliMi(zaman) {
  if (!(zaman > 0)) return false
  const barlar = durum.bars
  if (!Array.isArray(barlar) || barlar.length === 0) return false
  return sayi(barlar[barlar.length - 1].time, 0) > zaman
}

/** Mumlari, varsa "o an" kisitiyla grafige basar. */
function barlariGrafigeBas(barlar) {
  const hepsi = Array.isArray(barlar) ? barlar : []
  if (durum.asOf === null) {
    grafik('setBars', hepsi)
    return
  }
  const kirpik = []
  for (let i = 0; i < hepsi.length; i++) {
    if (hepsi[i] && sayi(hepsi[i].time, 0) <= durum.asOf) kirpik.push(hepsi[i])
  }
  // Hic bar kalmadiysa kisit anlamsizdir (yanlis zaman dilimi, bos pencere).
  // Bos grafik gostermektense kisiti yok sayariz.
  grafik('setBars', kirpik.length > 0 ? kirpik : hepsi)
}

/**
 * "O an" degerini durumda, katmanda ve rozette ayarlar. Grafige DOKUNMAZ:
 * mumlari zaten yeniden yukleyecek cagiranlar icin.
 * @param {number|null} zaman UNIX saniye; null kisiti kaldirir
 * @returns {number|null} yerlesen deger
 */
function anaKadarAyarla(zaman) {
  const yeni = (zaman === null || !Number.isFinite(Number(zaman)) || Number(zaman) <= 0)
    ? null
    : Number(zaman)
  durum.asOf = yeni
  if (overlay && typeof overlay.setAsOf === 'function') {
    try { overlay.setAsOf(yeni) } catch (err) { /* onemsiz */ }
  }
  anaKadarRozetiniTazele()
  return yeni
}

/** "O an" degerini ayarlar ve grafigi de o anda yeniden cizer. */
function anaKadarUygula(zaman) {
  const onceki = durum.asOf
  const yeni = anaKadarAyarla(zaman)
  if (onceki === yeni) return
  barlariGrafigeBas(durum.bars)
  isaretleriCiz()
}

/** Grafik efsanesindeki "o an" rozetini yazar. */
function anaKadarRozetiniTazele() {
  const rozet = el('legendAsOf')
  if (!rozet) return
  if (durum.asOf === null) {
    rozet.textContent = ''
    goster(rozet, false)
    return
  }
  rozet.textContent = 'o an: ' + formatDateTime(durum.asOf)
  rozet.removeAttribute('hidden')
}

/** Sinyal isaretlerini grafige koyar. */
function isaretleriCiz() {
  if (!view || typeof view.setMarkers !== 'function') return

  // Isaretler YALNIZCA yuklu mum araligindaki sinyaller icin konur.
  // lightweight-charts, veri araliginin disinda kalan bir isareti serinin ilk
  // barina yaslar; boylece 17 yillik sinyal listesi grafigin sol kenarinda
  // ust uste yigilip yanlis bir gorunti verirdi.
  const barlar = durum.bars
  const ilk = Array.isArray(barlar) && barlar.length ? barlar[0].time : null
  let son = Array.isArray(barlar) && barlar.length ? barlar[barlar.length - 1].time : null
  // "O ana kadar" kipinde grafikte o andan sonraki bar YOKTUR. Isaret
  // sinirlanmazsa lightweight-charts sonraki sinyalleri son bara yaslar ve
  // gizledigimiz gelecek, ok yigini olarak geri gelir.
  if (durum.asOf !== null && son !== null && son > durum.asOf) son = durum.asOf

  const isaretler = []
  for (let i = 0; i < durum.signals.length; i++) {
    const s = durum.signals[i]
    if (!s || s.fired === false) continue
    const t = sayi(s.time, 0)
    if (ilk === null || t < ilk || t > son) continue
    const alis = s.direction !== 'SELL'
    // Isaret metni "kac kayittan kaci" gosterir: onceden "O %53" yaziyordu ve
    // 3 kayittan 3'u ile 30 kayittan 16'si AYNI gorunuyordu. Onek OL = kutu
    // olusumu, DK = bolgeye donus (tek harf yeterince acik degildi).
    isaretler.push({
      id: String(s.id),
      time: t,
      position: alis ? 'belowBar' : 'aboveBar',
      shape: alis ? 'arrowUp' : 'arrowDown',
      color: alis ? RENK.up : RENK.down,
      text: isaretMetni(s),
    })
  }
  // Benzer gecmis ornek isareti. Sinyal oklarindan ayrilsin diye daire ve
  // altin rengi; yalnizca yuklu mum araliginda gosterilir.
  const ornek = durum.vurguluOrnek
  if (ornek) {
    const ot = sayi(ornek.time, 0)
    if (ilk !== null && ot >= ilk && ot <= son) {
      isaretler.push({
        id: 'ornek',
        time: ot,
        position: 'aboveBar',
        shape: 'circle',
        color: RENK.warn,
        text: 'ÖRNEK ' + (ornek.success ? 'saygı' : 'kırılım'),
      })
    }
  }

  isaretler.sort((a, b) => a.time - b.time)
  try {
    view.setMarkers(isaretler)
  } catch (err) {
    hataGoster('Sinyal işaretleri konulamadı: ' + hataMetni(err))
  }
}

/**
 * Sinyalin plan cizgilerini grafige dusurur.
 * chart.js `setPriceLines` alanlari: {price, color, title, width, style}
 */
/**
 * Plan cizgilerinin bitecegi zamani hesaplar.
 *
 * `barsToOutcome` bir BAR sayisidir, saniye degil. Barlar surekli degildir
 * (hafta sonu, gunluk seans arasi, eksik dakikalar), bu yuzden
 * `zaman + bar * adim` seklinde duvar saatine cevirmek yanlis sonuc verir:
 * Cuma aksami acilan ve 20 bar sonra biten bir plan, gercekte Pazartesi
 * sabahi biterken duvar saati hesabiyla ayni gece bitmis gorunur.
 *
 * Dogrusu, sinyalin bar INDEKSINI bulup `indeks + barsToOutcome` barinin
 * zamanini almaktir. Bar dizisinde bulunamazsa duvar saati tahminine duseriz.
 *
 * @param {object} s Sinyal
 * @param {number} zaman Sinyal zamani (UNIX saniye)
 * @returns {number} Bitis zamani
 */
function planBitisZamani(s, zaman) {
  const adim = tfSaniye(durum.tf)
  const ufuk = sayi(
    durum.ayarlar && durum.ayarlar.outcomeCfg ? durum.ayarlar.outcomeCfg.horizonBars : NaN,
    48
  )
  // -1 "sonuc bilinmiyor" demektir (canli sinyal veya eski kayit).
  // 0 ise "kendi barinda bitti" demektir, ufka uzatilmamalidir.
  const barSayisi = sayi(s.barsToOutcome, -1)
  const kacBar = barSayisi >= 0 ? barSayisi : ufuk

  const barlar = durum.bars
  if (Array.isArray(barlar) && barlar.length > 0) {
    // Sinyal barinin indeksi (ikili arama).
    let lo = 0
    let hi = barlar.length - 1
    let idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const t = barlar[mid].time
      if (t === zaman) { idx = mid; break }
      if (t < zaman) { idx = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (idx >= 0) {
      const hedefIdx = idx + kacBar
      if (hedefIdx <= barlar.length - 1) return barlar[hedefIdx].time
      // HEDEF SON BARIN OTESINDE: CANLI sinyalde bu normaldir, plan daha
      // bitmedi. Son bara kirpmak cizgileri 18 piksellik bir cikintiya
      // ceviriyordu ve yeni barlarla uzamiyordu. Kalan sureyi bar adimiyla
      // ileri tasiriz; grafik zaten son barin otesini cizebiliyor.
      const fazla = hedefIdx - (barlar.length - 1)
      return barlar[barlar.length - 1].time + fazla * adim
    }
  }
  return zaman + kacBar * adim
}

function planCizgileri(s) {
  if (!view) return
  if (!s) {
    if (typeof view.clearPlanLines === 'function') {
      try { view.clearPlanLines() } catch (err) { /* onemsiz */ }
    }
    if (typeof view.clearPriceLines === 'function') {
      try { view.clearPriceLines() } catch (err) { /* onemsiz */ }
    }
    return
  }

  const seviyeler = [
    { price: sayi(s.entry, NaN), color: '#d1d4dc', title: 'Giriş', width: 1, dashed: false },
    { price: sayi(s.tp1, NaN), color: RENK.up, title: 'TP1', width: 1, dashed: true },
    // TP2 artik null olabilir (yeterli sayida tutmus benzer kayit yoksa).
    // Number(null) sifir oldugu icin asagidaki `price !== 0` suzgeci bu
    // durumda cizgiyi elemis olur; yine de niyet burada yazili olsun.
    // TP2 OLCULMUS BIR HEDEF DEGIL: yalnizca tutmus komsularin gittigi yolun
    // yuzdeligi. TP1 ile ayni stilde cizilince ayni guvenilirlikte
    // gorunuyordu; artik gri ve baslikta "olculmedi" yaziyor.
    { price: sayi(s.tp2, NaN), color: RENK.dim, title: 'TP2 (ölçülmedi)', width: 1, dash: [2, 4] },
    { price: sayi(s.sl, NaN), color: RENK.down, title: 'SL', width: 1, dashed: true },
  ].filter((c) => Number.isFinite(c.price) && c.price !== 0)

  // Cizilecek gecerli seviye yoksa ONCEKI planin cizgileri ekranda kalmamali,
  // yoksa kullanici onlari yeni sinyalin plani sanar.
  if (seviyeler.length === 0) {
    if (typeof view.clearPlanLines === 'function') {
      try { view.clearPlanLines() } catch (err) { /* onemsiz */ }
    }
    return
  }

  const zaman = sayi(s.time, 0)
  const bitis = planBitisZamani(s, zaman)

  if (typeof view.setPlanLines === 'function') {
    try {
      view.setPlanLines({ time: zaman, endTime: bitis, levels: seviyeler })
    } catch (err) {
      hataGoster('Plan çizgileri konulamadı: ' + hataMetni(err))
    }
    return
  }

  // Eski yol (zaman araligi desteklenmiyorsa): panel boyu yatay cizgi.
  if (typeof view.setPriceLines !== 'function') return
  try {
    view.setPriceLines(seviyeler.map((c) => ({
      price: c.price, color: c.color, title: c.title, width: 1, style: c.dashed ? 2 : 0,
    })))
  } catch (err) {
    hataGoster('Plan çizgileri konulamadı: ' + hataMetni(err))
  }
}

/** Efsane kutusunu ve ust seritteki son fiyati yazar. */
function efsaneyiYaz(bar) {
  const kaynak = bar || (durum.bars.length ? durum.bars[durum.bars.length - 1] : null)
  const alanlar = [
    ['legendO', kaynak ? kaynak.open : NaN],
    ['legendH', kaynak ? kaynak.high : NaN],
    ['legendL', kaynak ? kaynak.low : NaN],
    ['legendC', kaynak ? kaynak.close : NaN],
  ]
  for (let i = 0; i < alanlar.length; i++) {
    const e = el(alanlar[i][0])
    if (e) e.textContent = formatPrice(alanlar[i][1])
  }
  const tfEt = el('legendTf')
  if (tfEt) tfEt.textContent = durum.tf

  if (!kaynak) return
  const degisim = kaynak.open ? (kaynak.close - kaynak.open) / kaynak.open : 0
  const artiMi = kaynak.close >= kaynak.open
  const degisimMetni = (artiMi ? '+' : '') + formatNumber(degisim * 100, 2) + '%'

  const dEl = el('legendChange')
  if (dEl) {
    dEl.textContent = degisimMetni
    dEl.className = artiMi ? 'up' : 'down'
  }
  // UST SERITTEKI SON FIYAT, NISANGAH BARINI DEGIL CANLI FIYATI GOSTERIR.
  //
  // Efsane kutusu (sol ust) fareyle gezilen barin OHLC'sini yazar; ust
  // seritteki "son fiyat" ise piyasanin su anki fiyatidir. `bar` verilmisse
  // (yani fare bir barin uzerindeyse) ust serit GUNCELLENMEZ, yoksa gecmise
  // bakarken ust seritte 2015 fiyati gorunuyordu.
  if (!bar) {
    const fEl = el('lastPrice')
    if (fEl) fEl.textContent = formatPrice(kaynak.close)
    const cEl = el('lastChange')
    if (cEl) {
      cEl.textContent = degisimMetni
      cEl.className = 'last-change ' + (artiMi ? 'up' : 'down')
    }
  }
}

/* ------------------------------------------------------------------ */
/* Gorunur aralik                                                      */
/* ------------------------------------------------------------------ */

/** Gorunur aralik degisince alt seridi yazar ve bolgeleri geciktirmeli yeniler. */
function gorunurAralikDegisti(aralik) {
  const rEl = el('statusRange')
  if (rEl) {
    rEl.textContent = aralik && Number.isFinite(aralik.from) && Number.isFinite(aralik.to)
      ? 'Aralık: ' + formatDate(aralik.from) + ' - ' + formatDate(aralik.to)
      : 'Aralık: -'
  }
  if (!aralik || !Number.isFinite(aralik.from) || !Number.isFinite(aralik.to)) return

  if (aralikZamanlayici) clearTimeout(aralikZamanlayici)
  aralikZamanlayici = setTimeout(() => {
    aralikZamanlayici = 0
    bolgeleriYukle(Math.floor(aralik.from), Math.ceil(aralik.to))
    gecmiseDogruGenislet(aralik)
  }, ARALIK_GECIKMESI_MS)
}

/** Grafikte tutulacak azami bar sayisi. */
const AZAMI_YUKLU_BAR = 20000
/** Sol kenara bu kadar bar kala yeni parca yuklenir. */
const GENISLETME_ESIGI_BAR = 300
/** Her seferinde bu kadar eski bar eklenir. */
const GENISLETME_PARCASI = 4000

let genisletmeSuruyor = false
/** Bar siniri uyarisi bir kez verilir. */
let genisletmeSiniriBildirildi = false

/**
 * Kullanici gecmise dogru kaydirirken yuklu pencereyi sola dogru buyutur.
 *
 * Grafik acilista yalnizca son birkac bin bari tutar. Depoda 17 yillik veri
 * varken sol kenarda duvara carpmak dogru degil; kenara yaklasildikca eski
 * mumlar yuklenir. Bellek buyumesin diye toplam bar sayisi sinirlanir.
 *
 * @param {{from:number,to:number}} aralik Gorunur zaman araligi
 */
async function gecmiseDogruGenislet(aralik) {
  if (genisletmeSuruyor) return
  const barlar = durum.bars
  if (!Array.isArray(barlar) || barlar.length === 0) return
  if (barlar.length >= AZAMI_YUKLU_BAR) {
    // Sinira bir kez deginildigini soyle: onceden kaydirma sessizce
    // duruyordu ve kullanici veri bittigini saniyordu.
    if (!genisletmeSiniriBildirildi) {
      genisletmeSiniriBildirildi = true
      bildir('Grafikte ' + formatNumber(AZAMI_YUKLU_BAR, 0) + ' mum yüklü, daha eskisi için ' +
        'bir sinyale veya bölgeye tıklayın.')
    }
    return
  }

  const adim = tfSaniye(durum.tf)
  const ilkZaman = barlar[0].time
  // Gorunur aralik sol kenara yaklasti mi.
  if (aralik.from > ilkZaman + GENISLETME_ESIGI_BAR * adim) return

  // Depoda daha eski veri var mi.
  const st = durum.veriDurumu
  if (st && Number.isFinite(st.firstTime) && ilkZaman <= st.firstTime) return

  genisletmeSuruyor = true
  try {
    // ALT SINIR VERILMEZ, BILEREK.
    //
    // Onceden `from = to - 4000 * adim` idi, yani duvar saatine gore bir
    // pencere. Piyasa kapaliyken bar olusmadigindan uzun bir tatil bu
    // pencerenin TAMAMINI yutabiliyordu: istek bos donuyor, fonksiyon
    // ilerlemeden cikiyor ve kaydirma orada takiliyordu (1m serisinde 4000
    // dakikadan uzun 30 bosluk var, en uzunu 3,2 gun). Isci zaten araligin
    // SON `limit` barini kesiyor, dolayisiyla ust sinir ve limit yeterli.
    const to = ilkZaman - adim
    const ham = await cagir('data:candles', { tf: durum.tf, from: 0, to: to, limit: GENISLETME_PARCASI })
    const eski = barlariNormalle(ham)
    if (eski.length === 0) return

    // Grafigin gorunur konumu kaymasin diye mantiksal araligi kaydiririz:
    // basa n bar eklendiginde ayni barlarin indeksi n artar.
    let lr = null
    try { lr = view.chart.timeScale().getVisibleLogicalRange() } catch (err) { lr = null }

    durum.bars = eski.concat(barlar)
    barlariGrafigeBas(durum.bars)

    if (lr && Number.isFinite(lr.from) && Number.isFinite(lr.to)) {
      try {
        view.chart.timeScale().setVisibleLogicalRange({
          from: lr.from + eski.length,
          to: lr.to + eski.length,
        })
      } catch (err) { /* onemsiz */ }
    }

    isaretleriCiz()
    await bolgeleriYukle(durum.bars[0].time, durum.bars[durum.bars.length - 1].time + adim * 200)
  } catch (err) {
    // Sessiz gec: kaydirma sirasinda hata mesaji basmak rahatsiz edici olur.
  } finally {
    genisletmeSuruyor = false
  }
}

/* ------------------------------------------------------------------ */
/* Yukleme akislari                                                    */
/* ------------------------------------------------------------------ */

/** Veri durumunu alt seritte gosterir. */
async function veriDurumunuYukle() {
  const ham = await cagirGuvenli('data:status', { tf: durum.tf }, 'Veri durumu okunamadı')
  const st0 = veriDurumuKaydi(ham, durum.tf)
  // Gecmise dogru genisletme, depoda daha eski veri olup olmadigini buradan bilir.
  durum.veriDurumu = st0
  const e = el('statusData')
  if (!e) return
  const st = st0
  if (!st) {
    e.textContent = 'Veri: -'
    return
  }
  const adet = sayi(st.count !== undefined ? st.count : (st.bars !== undefined ? st.bars : st.total), 0)
  if (adet <= 0) {
    // "KAYIT YOK" YANLISTI.
    //
    // Durum, zaman dilimi basina bir .bin dosyasina bakiyor. 30m gibi
    // turetilen dilimlerin kendi dosyasi yok, seri 1m'den uretiliyor;
    // ekranda "kayıt yok (30m)" yaziyor ama grafikte binlerce mum
    // gorunuyordu. Dosya yoksa turetilmis serinin sayisini soruyoruz.
    const turetilmis = await cagirGuvenli('data:candles',
      { tf: durum.tf, limit: 1 }, 'Veri durumu okunamadı')
    const tAdet = turetilmis ? sayi(turetilmis.total, 0) : 0
    if (tAdet > 0) {
      durum.veriDurumu = veriDurumuKaydi(turetilmis, durum.tf) || st0
      e.textContent = 'Veri: ' + formatNumber(tAdet, 0) + ' mum (türetilmiş), ' +
        formatDateTime(turetilmis.firstTime) + ' - ' + formatDateTime(turetilmis.lastTime) +
        ' (' + durum.tf + ')'
      return
    }
    e.textContent = 'Veri: kayıt yok (' + durum.tf + ')'
    return
  }
  e.textContent = 'Veri: ' + formatNumber(adet, 0) + ' mum, ' +
    formatDateTime(st.firstTime) + ' - ' + formatDateTime(st.lastTime) + ' (' + durum.tf + ')'
}

/** Mumlari yukler ve grafige basar. */
async function mumlariYukle() {
  goster(el('chartLoading'), true)
  const ham = await cagirGuvenli('data:candles',
    { tf: durum.tf, limit: MUM_LIMITI }, 'Mumlar yüklenemedi')
  goster(el('chartLoading'), false)

  const barlar = barlariNormalle(ham)
  durum.bars = barlar
  durum.pencereliMumlar = false
  pencereDugmesiniTazele()

  // HATAYI "veri yok" diye gostermeyi birakti.
  //
  // `cagirGuvenli` hata durumunda null dondurur ve bu da bos bar dizisine
  // ceviriliyordu. Ekranda "Veri yok. Once Veri Cek..." yaziyordu; kullanici
  // saatlerce veri indirmeye calisiyor, oysa sorun motorun cevap
  // verememesiydi. Artik iki hal ayri yaziliyor.
  const kutu = el('chartEmpty')
  if (kutu) {
    if (ham === null) {
      kutu.textContent = 'Mumlar yüklenemedi. Alt şeritteki hata mesajına bakın.'
    } else if (barlar.length === 0) {
      kutu.textContent = 'Veri yok. Önce Veri Çek, sonra Geçmişi Tara düğmesini kullanın.'
    }
    goster(kutu, ham === null || barlar.length === 0)
  }

  barlariGrafigeBas(barlar)
  if (barlar.length > 0) {
    grafik('fitContent')
    efsaneyiYaz(null)
  }
}

/**
 * Verilen zamanin ETRAFINDAKI mumlari yukler.
 *
 * Grafik varsayilan olarak yalnizca son MUM_LIMITI kadar mumu tutar. Kullanici
 * 2015 tarihli bir sinyale tikladiginda o mumlar yuklu olmadigi icin grafik
 * bos bir alana kayiyordu. Bu fonksiyon hedef zamani ortalayan bir pencere
 * yukler, boylece sinyal, bolgeleri ve isaretleriyle birlikte gorunur.
 *
 * @param {number} hedefZaman UNIX saniye
 * @returns {Promise<boolean>} yukleme yapildiysa true
 */
async function mumlariZamanEtrafindaYukle(hedefZaman) {
  if (!Number.isFinite(hedefZaman) || hedefZaman <= 0) return false
  const adim = tfSaniye(durum.tf)
  const yariPencere = (MUM_LIMITI / 2) * adim
  const from = hedefZaman - yariPencere
  const to = hedefZaman + yariPencere

  goster(el('chartLoading'), true)
  const ham = await cagirGuvenli('data:candles',
    { tf: durum.tf, from: from, to: to, limit: MUM_LIMITI }, 'Mumlar yüklenemedi')
  goster(el('chartLoading'), false)
  if (ham === null) return false

  const barlar = barlariNormalle(ham)
  if (barlar.length === 0) return false

  durum.bars = barlar
  // Grafik artik son mumlari degil, gecmiste bir pencereyi gosteriyor.
  durum.pencereliMumlar = true
  pencereDugmesiniTazele()
  goster(el('chartEmpty'), false)
  barlariGrafigeBas(barlar)
  return true
}

/** Hedef zaman yuklu mum penceresinin disinda mi. */
function zamanPencereDisinda(t) {
  const b = durum.bars
  if (!Array.isArray(b) || b.length === 0) return true
  const adim = tfSaniye(durum.tf)
  // Kenara cok yakinsa da yeniden yukle: sinyalin saginda ve solunda
  // baglam gorunsun.
  return t < b[0].time + adim * 5 || t > b[b.length - 1].time - adim * 5
}

/** Bolgeleri yukler, katmana ve panele verir. */
async function bolgeleriYukle(from, to) {
  const yuk = { tf: durum.tf }
  if (Number.isFinite(from)) yuk.from = from
  if (Number.isFinite(to)) yuk.to = to
  const ham = await cagirGuvenli('engine:zones', yuk, 'Bölgeler alınamadı')
  if (ham === null) return
  durum.zones = bolgeleriNormalle(ham)
  bolgeleriCiz()
  // Panel gorunur degilken cizmek bos is: her kaydirmada yuzlerce DOM
  // dugumu uretiliyor ve hicbiri ekrana girmiyordu.
  if (durum.seciliBolgeId === null && durum.aktifPanel === 'zones') bolgePaneliniCiz()
}

/** Sinyalleri yukler, isaretleri ve paneli tazeler. */
async function sinyalleriYukle() {
  const ham = await cagirGuvenli('engine:signals', { tf: durum.tf, limit: 500 }, 'Sinyaller alınamadı')
  if (ham === null) return
  durum.signals = sinyalleriNormalle(ham)
  isaretleriCiz()
  if (durum.seciliSinyalId === null && durum.aktifPanel === 'signals') sinyalPaneliniCiz()
}

/** Hafiza ozetini ve sekil kumelerini yukler. */
async function hafizayiYukle() {
  const ozet = await cagirGuvenli('engine:memory-summary', { tf: durum.tf }, 'Hafıza özeti alınamadı')
  if (ozet !== null) durum.hafizaOzeti = ozet && ozet.summary ? ozet.summary : ozet
  const proto = await cagirGuvenli('engine:prototypes', { tf: durum.tf }, 'Şekil kümeleri alınamadı')
  if (proto !== null) {
    durum.prototipler = Array.isArray(proto)
      ? proto
      : (proto && Array.isArray(proto.prototypes) ? proto.prototypes : [])
  }
  // Diske yazilmis son test ozeti. Onceden olcum yalnizca bellekteydi ve
  // uygulama kapaninca kayboluyordu; "hangi ayarla ne olculdu" bilgisi
  // kaybolmasin diye artik dosyadan geri yuklenir.
  const sonTest = await cagirGuvenli('engine:backtest-last', { tf: durum.tf }, null)
  if (sonTest && sonTest.found) durum.testSonucu = sonTest
  else durum.testSonucu = null
  // Canli sinyal gunlugu: canli uretilen sinyaller ve sonuclanan etiketleri.
  // Bu dosya taramadan ve hafiza silmeden bagimsiz birikir.
  const canliGunluk = await cagirGuvenli('engine:live-log', { tf: durum.tf, limit: 50 }, null)
  durum.canliGunluk = canliGunluk && canliGunluk.found ? canliGunluk : null
  hafizaPaneliniCiz()
  testPaneliniCiz()
}

/** Saglayici listesini yukler, komut yoksa yerlesik listeye duser. */
async function saglayicilariYukle() {
  let liste = null
  try {
    liste = await cagir('data:providers', {})
  } catch (err) {
    liste = null
  }
  if (Array.isArray(liste)) durum.saglayicilar = liste
  else if (liste && Array.isArray(liste.providers)) durum.saglayicilar = liste.providers
  else durum.saglayicilar = []
  saglayiciSecimleriniKur()
}

/** Tum ekrani yeniden yukler. */
async function hepsiniYukle() {
  motorDurumu('yükleniyor')
  await veriDurumunuYukle()
  await mumlariYukle()
  const barlar = durum.bars
  const from = barlar.length ? barlar[0].time : undefined
  const to = barlar.length ? barlar[barlar.length - 1].time + tfSaniye(durum.tf) * 200 : undefined
  await bolgeleriYukle(from, to)
  await sinyalleriYukle()
  await hafizayiYukle()
  paneliCiz()
  motorDurumu('hazır')
}

/* ------------------------------------------------------------------ */
/* Ust serit                                                           */
/* ------------------------------------------------------------------ */

/** Zaman dilimi dugmelerini kurar (yoksa uretir). */
function tfDugmeleriniKur() {
  const kap = el('tfButtons')
  if (!kap) return
  let dugmeler = Array.prototype.slice.call(kap.querySelectorAll('[data-tf]'))
  if (dugmeler.length === 0) {
    for (let i = 0; i < TF_LISTESI.length; i++) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'tf-btn'
      b.dataset.tf = TF_LISTESI[i]
      b.textContent = TF_LISTESI[i]
      kap.appendChild(b)
    }
    dugmeler = Array.prototype.slice.call(kap.querySelectorAll('[data-tf]'))
  }
  for (let i = 0; i < dugmeler.length; i++) {
    const b = dugmeler[i]
    b.addEventListener('click', () => {
      const tf = b.dataset.tf
      if (!tf || tf === durum.tf || mesgulMu()) return
      tfDegistir(tf)
    })
  }
  tfDugmeleriniIsaretle()
}

/**
 * Uzun bir is suruyor mu (tarama, test ya da otomatik hazirlik).
 *
 * Bu sirada zaman dilimi ve saglayici degistirilirse eski isin sonucu yeni
 * secimin etiketiyle gosterilebiliyor, hatta yeni zaman diliminin deposuna
 * yazilabiliyordu.
 */
function mesgulMu() {
  return !!(durum.taramaCalisiyor || durum.testCalisiyor || durum.hazirlikCalisiyor)
}

/** Mesgulken degistirilemeyecek denetimleri kilitler. */
function mesgulKilidiUygula() {
  const kilitli = mesgulMu()
  const kap = el('tfButtons')
  if (kap) {
    const dugmeler = kap.querySelectorAll('[data-tf]')
    for (let i = 0; i < dugmeler.length; i++) {
      dugmeler[i].disabled = kilitli
      dugmeler[i].title = kilitli ? 'İşlem sürerken zaman dilimi değiştirilemez' : ''
    }
  }
  for (const id of ['providerSelect', 'liveProviderSelect']) {
    const e = el(id)
    if (e) {
      e.disabled = kilitli
      e.title = kilitli ? 'İşlem sürerken kaynak değiştirilemez' : ''
    }
  }
}

/** Secili zaman dilimi dugmesini isaretler. */
function tfDugmeleriniIsaretle() {
  const kap = el('tfButtons')
  if (!kap) return
  const dugmeler = kap.querySelectorAll('[data-tf]')
  for (let i = 0; i < dugmeler.length; i++) {
    const b = dugmeler[i]
    const secili = b.dataset.tf === durum.tf
    b.classList.toggle('active', secili)
    b.setAttribute('aria-pressed', secili ? 'true' : 'false')
  }
}

/**
 * Zaman dilimi basina son veri cekme denemesinin zamani. Piyasa kapaliyken
 * (hafta sonu) depo hep "geride" gorunur ve her sekme degisiminde bosuna
 * indirme baslardi; bu sayac onu engeller.
 * @type {Object<string, number>}
 */
const sonSenkronDenemesi = {}
const SENKRON_BEKLEME_SN = 300

/** Bu zaman dilimi icin son denemenin uzerinden yeterli sure gecti mi. */
function senkronBeklemede(tf, simdi) {
  const son = sonSenkronDenemesi[tf]
  return typeof son === 'number' && (simdi - son) < SENKRON_BEKLEME_SN
}

/**
 * Yeni secilen zaman dilimini KULLANILABILIR hale getirir: eksik mumlari
 * indirir, gerekiyorsa hafizayi kurar.
 *
 * Ne zaman ne yapilir:
 *   veri cek  : deponun son bari 3 bardan fazla geride kaldiysa
 *   tarama    : hafiza hic yoksa, ESKI indikator surumunden kalmissa
 *               (memoryCurrent false) veya veri cekimi yeni bar ekledi ise
 *
 * Geriye test (sinyal listesi) BILEREK otomatik calistirilmaz: 1 dakikalikta
 * on binlerce olay uzerinde dakikalar suruyor ve zaman dilimi degistirmeyi
 * kullanilamaz hale getirirdi. Kullanici Test sekmesinden kendisi baslatir.
 *
 * @param {string} tf
 * @returns {Promise<boolean>} bir sey degistiyse true
 */
async function tfHazirla(tf) {
  const ayar = durum.ayarlar || {}
  if (ayar.autoPrepareOnTfChange === false) return false
  // Hazirlik da uzun bir istir: sirasinda zaman dilimi ve kaynak kilitlenir.
  durum.hazirlikCalisiyor = true
  mesgulKilidiUygula()
  try {
    return await tfHazirlaIc(tf, ayar)
  } finally {
    durum.hazirlikCalisiyor = false
    mesgulKilidiUygula()
  }
}

/** tfHazirla'nin govdesi (kilit disarida tutuluyor). */
async function tfHazirlaIc(tf, ayar) {

  const durumBilgisi = await cagirGuvenli('data:status', {}, 'Veri durumu okunamadı')
  const satir = durumBilgisi && durumBilgisi.byTf ? durumBilgisi.byTf[tf] : null
  if (!satir) return false

  const tfSec = tfSaniye(tf)
  const simdi = Math.floor(Date.now() / 1000)
  let degisti = false

  // --- 1) Eksik mumlar -----------------------------------------------------
  // Hangi kaynak: depo BOSSA gecmis kaynagi (HistData) tum tarihi verir.
  // Depo doluysa eksik olan yalnizca SON gunlerdir ve gecmis kaynagi orayi
  // veremez; olculdu, HistData icinde bulunulan ayi yayinlamiyor ve 12 gunluk
  // bosluk icin 78 saniye harcayip 0 bar ekliyor. Ayni bosluk canli kaynaktan
  // (Binance PAXG) 11 saniyede doluyor. Vekil kaynagin fiyat ve hacim farki
  // loader icinde zaten duzeltiliyor.
  const sonBar = sayi(satir.lastTime, 0)
  const geride = !satir.hasData || (simdi - sonBar) > tfSec * 3
  let yeniBar = 0
  if (geride && !senkronBeklemede(tf, simdi)) {
    const saglayici = satir.hasData
      ? ((ayar.providers && ayar.providers.live) || undefined)
      : ((ayar.providers && ayar.providers.history) || undefined)
    sonSenkronDenemesi[tf] = simdi
    motorDurumu('eksik veri indiriliyor')
    ilerleme(0, tf + ' için eksik mumlar indiriliyor')
    const sonuc = await cagirGuvenli('data:sync',
      { tf: tf, providerId: saglayici, provider: saglayici }, 'Eksik veri indirilemedi')
    yeniBar = sonuc && typeof sonuc === 'object' ? sayi(sonuc.added, 0) : 0
    if (yeniBar > 0) {
      degisti = true
      bildir(tf + ' için ' + formatNumber(yeniBar, 0) + ' yeni mum indirildi.')
    }
  }

  // --- 2) Hafiza -----------------------------------------------------------
  // Veri cekimi 1 dakikalik tabani gunceller ve TUM ust zaman dilimlerini
  // yeniden uretir. Yani baska bir dilimde yapilan cekim bu dilimin deposunu
  // da ilerletmis olabilir; bu yuzden "yeni bar indirdim mi" sorusu yetmez,
  // hafizanin hangi bara kadar kuruldugu deponun son bariyla karsilastirilir.
  const durumBilgisi2 = yeniBar > 0
    ? await cagirGuvenli('data:status', {}, 'Veri durumu okunamadı')
    : durumBilgisi
  const satir2 = (durumBilgisi2 && durumBilgisi2.byTf ? durumBilgisi2.byTf[tf] : null) || satir

  const hafizaYok = !satir2.hasMemory
  const hafizaEski = satir2.hasMemory && satir2.memoryCurrent === false
  const kuruldugu = sayi(satir2.memoryBuiltToTime, 0)
  const veriSonu = sayi(satir2.lastTime, 0)
  const hafizaGeride = kuruldugu <= 0 || (veriSonu - kuruldugu) > tfSec * 2

  if (hafizaYok || hafizaEski || hafizaGeride) {
    if (durum.taramaCalisiyor) return degisti
    // Tarama bayragi: Durdur dugmesi gorunur olsun ve ikinci bir tarama
    // kuyruga girmesin (otomatik hazirlik uzun surebilir).
    durum.taramaCalisiyor = true
    const taraDugmesi = el('scanBtn')
    isBasladi(taraDugmesi, 'Taranıyor...')
    motorDurumu('geçmiş taranıyor')
    ilerleme(0, tf + ' için hafıza kuruluyor')
    try {
      const sonuc = await cagirGuvenli('engine:scan', {
        tf: tf,
        params: ayar.indicatorParams,
        cfgPatch: durum.ayarYamasiKayitli || null,
      }, 'Geçmiş taranamadı')
      if (sonuc) {
        degisti = true
        bildir(tf + ' hafızası hazır: ' + formatNumber(sayi(sonuc.events, 0), 0) + ' kayıt. ' +
          'Sinyal listesi için Test sekmesinden testi çalıştırın.')
      }
    } finally {
      durum.taramaCalisiyor = false
    mesgulKilidiUygula()
      isBitti(taraDugmesi)
    }
  }

  ilerleme(100, 'Hazır')
  motorDurumu('hazır')
  setTimeout(ilerlemeyiKapat, 1200)
  return degisti
}

/** Zaman dilimini degistirir ve her seyi yeniden yukler. */
async function tfDegistir(tf) {
  const oncekiCanli = durum.canli
  if (oncekiCanli) await canliDurdur()

  durum.tf = tf
  durum.seciliSinyalId = null
  durum.seciliBolgeId = null
  anaKadarAyarla(null)
  durum.signals = []
  durum.zones = []
  // ONCEKI ZAMAN DILIMININ SAYILARI EKRANDA KALMASIN.
  //
  // Test sonucu, hafiza ozeti ve sekil kumeleri tf degisince oldugu gibi
  // duruyordu; basligta tf yazmadigi icin kullanici 1 dakikaligin sayilarini
  // 15 dakikaliga ait sanip karar verebiliyordu.
  durum.testSonucu = null
  durum.hafizaOzeti = null
  durum.prototipler = []
  durum.canliGunluk = null
  tfDugmeleriniIsaretle()
  planCizgileri(null)
  tvKaynagiGuncelle()

  const yeni = await cagirGuvenli('settings:set', { patch: { timeframe: tf } }, 'Zaman dilimi kaydedilemedi')
  if (yeni && typeof yeni === 'object') durum.ayarlar = yeni
  else if (durum.ayarlar) durum.ayarlar.timeframe = tf

  // Once eksigi tamamla, sonra yukle: aksi halde bos bir grafik cizilip
  // hemen ardindan yeniden cizilirdi.
  await tfHazirla(tf)

  await hepsiniYukle()
  if (oncekiCanli) await canliBaslat()
}

/** Saglayici secim kutularini doldurur ve baglar. */
function saglayiciSecimleriniKur() {
  const ayar = durum.ayarlar && durum.ayarlar.providers ? durum.ayarlar.providers : {}
  kutuyuDoldur(el('providerSelect'), durum.saglayicilar, ayar.history, 'history')
  kutuyuDoldur(el('liveProviderSelect'), durum.saglayicilar, ayar.live, 'live')
  kaynakDurumuYaz()
}

/** Bir select kutusunu saglayici listesiyle doldurur. */
function kutuyuDoldur(kutu, liste, secili, tur) {
  if (!kutu) return
  if (liste && liste.length > 0) {
    while (kutu.firstChild) kutu.removeChild(kutu.firstChild)
    for (let i = 0; i < liste.length; i++) {
      const p = liste[i]
      if (tur === 'live' && Array.isArray(p.caps) && p.caps.indexOf('live') < 0) continue
      const op = document.createElement('option')
      op.value = String(p.id)
      op.textContent = String(p.name || p.id) + (p.isProxy ? ' (vekil)' : '')
      if (p.note) op.title = String(p.note)
      kutu.appendChild(op)
    }
  }
  if (secili) {
    kutu.value = String(secili)
    if (kutu.value !== String(secili) && kutu.options.length > 0) kutu.selectedIndex = 0
  }
  if (kutu.dataset.zmBagli) return
  kutu.dataset.zmBagli = '1'
  kutu.addEventListener('change', async () => {
    const yama = tur === 'live' ? { providers: { live: kutu.value } } : { providers: { history: kutu.value } }
    const yeni = await cagirGuvenli('settings:set', { patch: yama }, 'Sağlayıcı kaydedilemedi')
    if (yeni && typeof yeni === 'object') durum.ayarlar = yeni
    kaynakDurumuYaz()
    if (tur === 'live' && durum.canli) await canliBaslat()
    if (durum.aktifPanel === 'settings') ayarPaneliniCiz()
  })
}

/** Ilerleme cubugunu gunceller. */
function ilerleme(yuzde, mesaj) {
  const p = Math.max(0, Math.min(100, sayi(yuzde, 0)))
  const dolgu = el('progressBar')
  if (dolgu) dolgu.style.width = p.toFixed(1) + '%'
  const yol = el('progressTrack')
  if (yol) yol.setAttribute('aria-valuenow', String(Math.round(p)))
  const metin = el('progressText')
  if (metin) {
    if (mesaj) metin.textContent = Math.round(p) + '% ' + mesaj
    else if (p > 0) metin.textContent = Math.round(p) + '%'
    else metin.textContent = 'Hazır'
  }
}

/** Ilerlemeyi bosa alir. */
function ilerlemeyiKapat() {
  ilerleme(0, '')
}

/** Uzun is basladiginda dugmeleri kilitler. */
function isBasladi(dugme, calisiyorMetni) {
  if (!dugme) return
  dugme.disabled = true
  if (!dugme.dataset.zmEski) dugme.dataset.zmEski = dugme.textContent || ''
  if (calisiyorMetni) dugme.textContent = calisiyorMetni
  goster(el('cancelBtn'), true)
}

/** Uzun is bitince dugmeleri serbest birakir. */
function isBitti(dugme) {
  if (dugme) {
    dugme.disabled = false
    if (dugme.dataset.zmEski) dugme.textContent = dugme.dataset.zmEski
  }
  goster(el('cancelBtn'), false)
}

/** 'Veri Çek' akisi: eksik gecmisi indirir. */
async function veriCek() {
  const dugme = el('syncBtn')
  const kaynak = el('providerSelect')
  const saglayici = kaynak && kaynak.value
    ? kaynak.value
    : (durum.ayarlar && durum.ayarlar.providers ? durum.ayarlar.providers.history : undefined)
  isBasladi(dugme, 'İndiriliyor...')
  motorDurumu('veri indiriliyor')
  ilerleme(0, 'Veri indiriliyor')
  try {
    await cagir('data:sync', { tf: durum.tf, providerId: saglayici, provider: saglayici })
    bildir('Veri indirme tamamlandı.')
    ilerleme(100, 'Tamamlandı')
  } catch (err) {
    hataGoster('Veri indirilemedi: ' + hataMetni(err))
  } finally {
    isBitti(dugme)
    motorDurumu('hazır')
  }
  await veriDurumunuYukle()
  await mumlariYukle()
  setTimeout(ilerlemeyiKapat, 1500)
}

/** 'Geçmişi Tara' akisi: hafizayi kurar. */
async function taramaCalistir() {
  if (durum.taramaCalisiyor) return
  durum.taramaCalisiyor = true
  mesgulKilidiUygula()
  const dugme = el('scanBtn')
  isBasladi(dugme, 'Taranıyor...')
  motorDurumu('geçmiş taranıyor')
  ilerleme(0, 'Tarama başlıyor')

  const ayar = durum.ayarlar || {}
  try {
    await cagir('engine:scan', {
      tf: durum.tf,
      params: ayar.indicatorParams,
      // Esikler ve hedef isci tarafinda hazir ayarla birlestirilir.
      cfgPatch: durum.ayarYamasiKayitli || null,
    })
    bildir('Tarama tamamlandı, hafıza güncellendi.')
    ilerleme(100, 'Tamamlandı')
  } catch (err) {
    hataGoster('Tarama başarısız: ' + hataMetni(err))
  } finally {
    durum.taramaCalisiyor = false
    mesgulKilidiUygula()
    isBitti(dugme)
  }

  await veriDurumunuYukle()
  const barlar = durum.bars
  const from = barlar.length ? barlar[0].time : undefined
  const to = barlar.length ? barlar[barlar.length - 1].time + tfSaniye(durum.tf) * 200 : undefined
  await bolgeleriYukle(from, to)
  await sinyalleriYukle()
  await hafizayiYukle()
  paneliCiz()
  setTimeout(ilerlemeyiKapat, 1500)
  motorDurumu('hazır')
}

/** Canli anahtarini kurar. */
function canliAnahtariniKur() {
  const e = el('liveToggle')
  if (!e) return
  if (e.tagName === 'INPUT' && e.type === 'checkbox') {
    e.addEventListener('change', async () => {
      if (e.checked) await canliBaslat()
      else await canliDurdur()
    })
  } else {
    e.addEventListener('click', async () => {
      if (durum.canli) await canliDurdur()
      else await canliBaslat()
    })
  }
  canliAnahtariniIsaretle()
}

/** Canli anahtarinin gorunumunu durumla esitler. */
function canliAnahtariniIsaretle() {
  const e = el('liveToggle')
  if (e) {
    if (e.tagName === 'INPUT' && e.type === 'checkbox') e.checked = durum.canli
    else {
      e.classList.toggle('active', durum.canli)
      e.setAttribute('aria-pressed', durum.canli ? 'true' : 'false')
    }
  }
  canliDurumuYaz()
}

/**
 * Hafiza olaylarini ya da test islemlerini CSV olarak kaydeder.
 *
 * Amac kullanicinin sistemin iddialarini (tur tabani, isabet, net beklenti,
 * kalibrasyon) Excel ya da Python ile BAGIMSIZ dogrulayabilmesi.
 *
 * @param {'events'|'trades'} ne
 */
async function csvDisaAktar(ne) {
  const sonuc = await cagirGuvenli('export:csv', { tf: durum.tf, what: ne },
    'CSV yazılamadı')
  if (!sonuc || sonuc.cancelled) return
  bildir(formatNumber(sayi(sonuc.rows, 0), 0) + ' satır yazıldı: ' + String(sonuc.filePath))
}

/** Test CSV dugmesi yalnizca elde olcum varken etkin. */
function csvDugmeleriniTazele() {
  const testCsv = el('testExportBtn')
  if (testCsv) testCsv.disabled = !(durum.testSonucu && durum.testSonucu.tf === durum.tf)
}

/**
 * Gecmis pencereden GUNCEL mumlara doner.
 *
 * Onceden guncele donmenin tek yolu zaman dilimi degistirmekti.
 */
async function guncelMumlaraDon() {
  durum.pencereliMumlar = false
  // Guncele donunce gecmise kilit de kalkar, aksi halde mumlar yine
  // sinyal aninda dururdu.
  anaKadarAyarla(null)
  await mumlariYukle()
  await bolgeleriYukle()
  isaretleriCiz()
  pencereDugmesiniTazele()
}

/** "Guncele don" dugmesini pencere durumuna gore gosterir. */
function pencereDugmesiniTazele() {
  goster(el('goLatestBtn'), !!durum.pencereliMumlar)
}

/**
 * Ust seritteki son fiyat ve degisim alanlarini canli bardan yazar.
 *
 * Gecmis bir pencereye bakilirken grafige canli mum eklenmez ama kullanici
 * guncel fiyati gormeye devam etmeli.
 */
function sonFiyatiYaz(bar) {
  if (!bar) return
  const fiyatEl = el('lastPrice')
  if (fiyatEl) fiyatEl.textContent = formatPrice(bar.close)
  const degisimEl = el('lastChange')
  if (degisimEl && Number.isFinite(Number(bar.open)) && Number(bar.open) !== 0) {
    const fark = Number(bar.close) - Number(bar.open)
    const yuzde = (fark / Number(bar.open)) * 100
    degisimEl.textContent = (fark >= 0 ? '+' : '') + formatNumber(yuzde, 2) + '%'
    degisimEl.className = fark >= 0 ? 'up' : 'down'
  }
}

/** Canli takibi baslatir. */
async function canliBaslat() {
  const kutu = el('liveProviderSelect', 'providerSelect')
  const saglayici = kutu && kutu.value
    ? kutu.value
    : (durum.ayarlar && durum.ayarlar.providers ? durum.ayarlar.providers.live : undefined)
  const sonuc = await cagirGuvenli('live:start',
    { tf: durum.tf, providerId: saglayici, provider: saglayici }, 'Canlı takip başlatılamadı')
  if (sonuc === null) {
    durum.canli = false
    canliAnahtariniIsaretle()
    return
  }
  durum.canli = true
  durum.canliDurum = sonuc && typeof sonuc === 'object' ? sonuc : null
  canliAnahtariniIsaretle()
  kaynakDurumuYaz()
  bildir('Canlı takip açıldı (' + durum.tf + ', kaynak ' + (saglayici || '-') + ').')
  canliDurumuTazele()
}

/**
 * Canli durumu belirli araliklarla tazeler.
 * Fiyat kaydirmasi ilk cekimde degil, ortak zaman bulununca hesaplanir; bu
 * yuzden baslangictaki durum nesnesinde henuz olmayabilir.
 */
function canliDurumuTazele() {
  if (durum.canliDurumZamanlayici) clearInterval(durum.canliDurumZamanlayici)
  durum.canliDurumZamanlayici = setInterval(async () => {
    if (!durum.canli) return
    // Arka plan yoklamasi: hata olursa kullaniciya uyari basmayiz, sonraki
    // turda yeniden denenir. Aksi halde gecici bir ag hatasi ekrani doldurur.
    try {
      const d = await cagir('live:status', {})
      if (d && typeof d === 'object') {
        durum.canliDurum = d
        kaynakDurumuYaz()
      }
    } catch (err) { /* sessiz gec */ }
  }, 15000)
}

/** Canli takibi durdurur. */
async function canliDurdur() {
  await cagirGuvenli('live:stop', {}, 'Canlı takip durdurulamadı')
  durum.canli = false
  durum.canliDurum = null
  if (durum.canliDurumZamanlayici) {
    clearInterval(durum.canliDurumZamanlayici)
    durum.canliDurumZamanlayici = null
  }
  canliAnahtariniIsaretle()
  kaynakDurumuYaz()
  bildir('Canlı takip kapatıldı.')
}

/* ------------------------------------------------------------------ */
/* Gorunum ve panel sekmeleri                                          */
/* ------------------------------------------------------------------ */

/** Analiz ve TradingView gorunum sekmelerini kurar. */
function gorunumSekmeleriniKur() {
  const kap = el('mainTabs')
  const dugmeler = kap
    ? Array.prototype.slice.call(kap.querySelectorAll('[data-view]'))
    : []
  for (let i = 0; i < dugmeler.length; i++) {
    const b = dugmeler[i]
    const ad = b.dataset.view
    b.addEventListener('click', () => gorunumSec(ad))
  }
  gorunumSec(durum.aktifGorunum)
}

/** Gorunum secer (analiz veya TradingView). */
function gorunumSec(ad) {
  const analiz = ad !== 'tradingview'
  durum.aktifGorunum = analiz ? 'analysis' : 'tradingview'

  goster(el('chartWrap'), analiz)
  goster(el('tvPanel'), !analiz)
  if (!el('tvPanel')) goster(el('tvFrame'), !analiz)

  const kap = el('mainTabs')
  if (kap) {
    const dugmeler = kap.querySelectorAll('[data-view]')
    for (let i = 0; i < dugmeler.length; i++) {
      const b = dugmeler[i]
      const secili = (b.dataset.view === 'tradingview') === !analiz
      b.classList.toggle('active', secili)
      b.setAttribute('aria-selected', secili ? 'true' : 'false')
    }
  }

  if (analiz) setTimeout(() => grafik('resize'), 0)
  else tvKaynagiGuncelle()
}

/** TradingView cercevesini secili zaman dilimine gore ayarlar. */
function tvKaynagiGuncelle() {
  const cerceve = el('tvFrame')
  if (!cerceve) return
  const url = 'tradingview.html?interval=' + encodeURIComponent(durum.tf)
  const mevcut = cerceve.getAttribute('src') || ''
  if (mevcut.indexOf('interval=' + encodeURIComponent(durum.tf)) >= 0) return
  cerceve.setAttribute('src', url)
}

/** Sag panel sekmelerini kurar. */
function panelSekmeleriniKur() {
  const kap = el('sideTabs', 'panelTabs')
  if (!kap) return
  const dugmeler = Array.prototype.slice.call(kap.querySelectorAll('[data-tab], [data-panel]'))
  for (let i = 0; i < dugmeler.length; i++) {
    const b = dugmeler[i]
    const ad = (b.dataset && (b.dataset.tab || b.dataset.panel)) || ''
    if (!ad) continue
    b.addEventListener('click', () => panelSec(ad))
  }
  panelSec(durum.aktifPanel)
}

/** Sag panel secer ve cizer. */
function panelSec(ad) {
  if (!PANELLER[ad]) ad = 'signals'
  durum.aktifPanel = ad

  const anahtarlar = Object.keys(PANELLER)
  for (let i = 0; i < anahtarlar.length; i++) {
    const anahtar = anahtarlar[i]
    const p = el.apply(null, PANELLER[anahtar].panel)
    if (!p) continue
    const acik = anahtar === ad
    p.classList.toggle('active', acik)
    // .panel sinifi yoksa (farkli iskelet) gorunurlugu dogrudan ayarla.
    if (!p.classList.contains('panel')) goster(p, acik)
  }

  const kap = el('sideTabs', 'panelTabs')
  if (kap) {
    const dugmeler = kap.querySelectorAll('[data-tab], [data-panel]')
    for (let i = 0; i < dugmeler.length; i++) {
      const b = dugmeler[i]
      const secili = ((b.dataset.tab || b.dataset.panel) === ad)
      b.classList.toggle('active', secili)
      b.setAttribute('aria-selected', secili ? 'true' : 'false')
    }
  }
  paneliCiz()
}

/** Aktif paneli cizer. */
function paneliCiz() {
  switch (durum.aktifPanel) {
    case 'zones': bolgePaneliniCiz(); break
    case 'memory': hafizaPaneliniCiz(); break
    case 'settings': ayarPaneliniCiz(); break
    case 'test': testPaneliniCiz(); break
    default: sinyalPaneliniCiz(); break
  }
}

/* ------------------------------------------------------------------ */
/* Sinyaller paneli                                                    */
/* ------------------------------------------------------------------ */

/** Sinyal listesini cizer. */
function sinyalPaneliNoktalari() {
  return {
    liste: el('signalList') || panelGovdesi('signals'),
    ayrinti: el('signalDetail'),
    bos: el('signalEmpty'),
    rozet: el('signalCount'),
    suzgec: el('signalFilter'),
  }
}

/** Sinyaller panelini cizer. */
function sinyalPaneliniCiz() {
  const n = sinyalPaneliNoktalari()
  if (!n.liste) return

  const suzgec = n.suzgec && n.suzgec.value ? n.suzgec.value : 'all'
  renderSignals(n.liste, durum.signals, {
    onSelect: (s) => sinyalSec(s),
    selectedId: durum.seciliSinyalId,
    filter: suzgec,
    total: durum.sinyalToplam,
    truncated: durum.sinyalKirpildi,
  })
  goster(n.bos, false)

  if (n.rozet) {
    let uretilen = 0
    for (let i = 0; i < durum.signals.length; i++) if (durum.signals[i] && durum.signals[i].fired) uretilen++
    n.rozet.textContent = String(uretilen)
    n.rozet.title = durum.signals.length + ' kayıt, ' + uretilen + ' üretilen sinyal'
  }

  const s = seciliSinyal()
  if (n.ayrinti) {
    if (s) {
      // Once gorunur yapilir: mini grafiklerin genisligi yerlesimden okunur.
      goster(n.ayrinti, true)
      renderSignalDetail(n.ayrinti, s, {
        onMatchSelect: ornegeGit,
        risk: durum.ayarlar ? durum.ayarlar.risk : null,
      })
      geriDugmesiEkle(n.ayrinti, 'Ayrıntıyı kapat', () => {
        durum.seciliSinyalId = null
        durum.vurguluOrnek = null
        anaKadarUygula(null)
        planCizgileri(null)
        isaretleriCiz()
        sinyalPaneliniCiz()
      })
    } else {
      goster(n.ayrinti, false)
    }
  } else if (s) {
    // Ayri ayrinti kabi yoksa listenin yerine ayrintiyi ciz.
    renderSignalDetail(n.liste, s, {
      onMatchSelect: ornegeGit,
      risk: durum.ayarlar ? durum.ayarlar.risk : null,
    })
    geriDugmesiEkle(n.liste, 'Sinyal listesine dön', () => {
      durum.seciliSinyalId = null
      durum.vurguluOrnek = null
      anaKadarUygula(null)
      planCizgileri(null)
      isaretleriCiz()
      sinyalPaneliniCiz()
    })
  }
}

/**
 * "Benzer gecmis ornekler" listesinden bir kayda tiklandiginda grafigi o ana
 * goturur. Ornek, hafizadaki bir olaydir; sinyal degildir, bu yuzden plan
 * cizgileri KURULMAZ, yalnizca konum gosterilir.
 *
 * Ornek cogu zaman yuklu mum penceresinin cok disindadir (2011 gibi), o yuzden
 * once o tarihin etrafindaki mumlar ve bolgeler yuklenir; aksi halde grafik
 * bos bir alana kayar.
 */
async function ornegeGit(m) {
  if (!m) return
  const zaman = sayi(m.time, 0)
  if (!(zaman > 0)) return

  durum.vurguluOrnek = { time: zaman, success: !!m.success }

  // Kip aciksa kilit ORNEGIN anina tasinir. Sinyalin anini birakmak,
  // ornegin sonucunu da gostermek demekti ve rozet yanlis tarihi yazardi.
  const onceki = durum.asOf
  const anaKadar = anaKadarAyarla(anaKadarAcikMi() && anaKadarGerekliMi(zaman) ? zaman : null)

  let yenidenYuklendi = false
  if (zamanPencereDisinda(zaman)) {
    yenidenYuklendi = await mumlariZamanEtrafindaYukle(zaman)
    if (yenidenYuklendi) {
      const barlar = durum.bars
      const to = barlar.length ? barlar[barlar.length - 1].time + tfSaniye(durum.tf) * 200 : undefined
      await bolgeleriYukle(barlar.length ? barlar[0].time : undefined, to)
    }
  }
  if (!yenidenYuklendi && onceki !== anaKadar) barlariGrafigeBas(durum.bars)

  isaretleriCiz()
  if (view && typeof view.scrollToTime === 'function') {
    try { view.scrollToTime(zaman, { minSpan: 80, maxSpan: 900 }) } catch (err) { /* onemsiz */ }
  }
  bildir('Örneğe gidildi: ' + formatDateTime(zaman) +
    ', sonuç ' + (m.success ? 'bölge tuttu' : 'bölge kırıldı'))
}

/** Ayrinti kabina geri dugmesi ekler. */
function geriDugmesiEkle(kap, metin, geri) {
  const d = document.createElement('button')
  d.type = 'button'
  d.className = 'btn mini'
  d.textContent = metin
  d.style.marginBottom = '6px'
  d.addEventListener('click', geri)
  kap.insertBefore(d, kap.firstChild)
}

/** Secili sinyal nesnesi. */
function seciliSinyal() {
  if (durum.seciliSinyalId === null) return null
  for (let i = 0; i < durum.signals.length; i++) {
    const s = durum.signals[i]
    if (s && String(s.id) === String(durum.seciliSinyalId)) return s
  }
  return null
}

/** Bir sinyali secer: plan cizgileri, ayrinti paneli ve grafige kaydirma. */
async function sinyalSec(s) {
  if (!s) return
  durum.seciliSinyalId = s.id
  // Yeni bir sinyale gecilince onceki ornek vurgusu anlamini yitirir.
  durum.vurguluOrnek = null
  const zaman = sayi(s.time, 0)

  // "O ana kadar" kisiti mumlar yuklenmeden ONCE kurulur: aksi halde pencere
  // once tam cizilir, hemen ardindan kirpilir ve ekran titrer.
  const onceki = durum.asOf
  const anaKadar = anaKadarAyarla(anaKadarAcikMi() && anaKadarGerekliMi(zaman) ? zaman : null)

  // Sinyal yuklu mum penceresinin disindaysa once o tarihin etrafini yukle,
  // aksi halde grafik bos bir alana kayar.
  let yenidenYuklendi = false
  if (zamanPencereDisinda(zaman)) {
    yenidenYuklendi = await mumlariZamanEtrafindaYukle(zaman)
    if (yenidenYuklendi) {
      const barlar = durum.bars
      const to = barlar.length ? barlar[barlar.length - 1].time + tfSaniye(durum.tf) * 200 : undefined
      await bolgeleriYukle(barlar.length ? barlar[0].time : undefined, to)
      isaretleriCiz()
    }
  }
  if (!yenidenYuklendi && onceki !== anaKadar) {
    barlariGrafigeBas(durum.bars)
    isaretleriCiz()
  }

  planCizgileri(s)
  if (view && typeof view.scrollToTime === 'function') {
    // Yakinlastirma seviyesi korunur ama makul araliga sinirlanir; aksi halde
    // asiri yakinlasmis bir gorunumden baska sinyale atlayinca ekranda birkac
    // mum kalir ve kullanici her seferinde elle uzaklastirmak zorunda kalir.
    try { view.scrollToTime(zaman, { minSpan: 80, maxSpan: 900 }) } catch (err) { /* onemsiz */ }
  }
  if (durum.aktifPanel !== 'signals') panelSec('signals')
  else sinyalPaneliniCiz()
}

/* ------------------------------------------------------------------ */
/* Bolgeler paneli                                                     */
/* ------------------------------------------------------------------ */

/** Bolgeler panelini cizer. */
function bolgePaneliniCiz() {
  const liste = el('zoneList') || panelGovdesi('zones')
  if (!liste) return
  const suzgec = el('zoneFilter')
  // "Aktif" suzgecinin omru dolan kutulari ayirabilmesi icin son bar gerekir.
  const son = durum.asOf !== null
    ? durum.asOf
    : (durum.bars.length ? sayi(durum.bars[durum.bars.length - 1].time, 0) : 0)

  renderZones(liste, durum.zones, {
    onSelect: (z) => bolgeSec(z),
    selectedId: durum.seciliBolgeId,
    filter: suzgec && suzgec.value ? suzgec.value : 'all',
    now: son > 0 ? son : null,
  })
  goster(el('zoneEmpty'), false)

  const rozet = el('zoneCount')
  if (rozet) {
    rozet.textContent = String(durum.zones.length)
    let kirik = 0
    let bitti = 0
    for (let i = 0; i < durum.zones.length; i++) {
      const z = durum.zones[i]
      if (!z) continue
      if (z.broken) kirik++
      else if (son > 0 && sayi(z.endTime, 0) < son) bitti++
    }
    rozet.title = durum.zones.length + ' bölge, ' + kirik + ' kırılmış, ' + bitti + ' süresi dolmuş'
  }
  if (durum.seciliBolgeId === null) goster(el('zoneDetail'), false)
}

/** Bir bolgeyi secer ve dokunus gecmisini gosterir. */
async function bolgeSec(z) {
  if (!z) return
  durum.seciliBolgeId = z.id === undefined ? null : z.id
  if (durum.aktifPanel !== 'zones') panelSec('zones')
  else bolgePaneliniCiz()

  // Sinyallerde oldugu gibi: bolge yuklu pencerenin disindaysa once o tarihin
  // etrafi yuklenir, sonra grafik oraya kaydirilir.
  const zaman = sayi(z.createdTime, 0)
  if (zaman > 0) {
    if (zamanPencereDisinda(zaman)) {
      const yuklendi = await mumlariZamanEtrafindaYukle(zaman)
      if (yuklendi) {
        const barlar = durum.bars
        const to = barlar.length ? barlar[barlar.length - 1].time + tfSaniye(durum.tf) * 200 : undefined
        await bolgeleriYukle(barlar.length ? barlar[0].time : undefined, to)
        isaretleriCiz()
      }
    }
    if (view && typeof view.scrollToTime === 'function') {
      try { view.scrollToTime(zaman, { minSpan: 80, maxSpan: 900 }) } catch (err) { /* onemsiz */ }
    }
  }

  if (overlay && typeof overlay.setHighlight === 'function') {
    try { overlay.setHighlight(z.id) } catch (err) { /* onemsiz */ }
  }

  // YEDEK LISTE KALDIRILDI. Isci artik yalnizca bu bolgenin olaylarini
  // donduruyor; eslesme yoksa dogru cevap BOS LISTEDIR. Onceki hal, eslesme
  // bulamayinca son 5000 olayin tamamini o bolgeninmis gibi gosteriyordu
  // (olculdu: 15m'de bolgelerin %42'si, 1m'de %92,4'u yanlis liste goruyordu).
  const ham = await cagirGuvenli('engine:touches', { tf: durum.tf, zoneId: z.id }, 'Bölge dokunuşları alınamadı')
  const hepsi = dokunuslariNormalle(ham)
  const dokunuslar = hepsi.filter((t) => t && sayi(t.zoneId, -1) === sayi(z.id, -2))
  bolgeAyrintisiniCiz(z, dokunuslar)
}

/** Bolge ayrintisini (dokunus gecmisi) cizer. */
function bolgeAyrintisiniCiz(z, dokunuslar) {
  const kap = el('zoneDetail') || panelGovdesi('zones')
  if (!kap) return
  goster(kap, true)
  while (kap.firstChild) kap.removeChild(kap.firstChild)

  const baslik = document.createElement('h4')
  baslik.className = 'sec-title'
  // "Aktif" yalnizca kirilmamis DEGIL, omru de dolmamis kutu demektir.
  const sonBar = durum.bars.length ? sayi(durum.bars[durum.bars.length - 1].time, 0) : 0
  const omruBitti = !z.broken && sonBar > 0 && sayi(z.endTime, 0) < sonBar
  baslik.textContent = (z.isSupport ? 'Destek bölgesi' : 'Direnç bölgesi') +
    ' #' + formatNumber(z.id, 0) +
    (z.broken ? ' (kırıldı)' : (omruBitti ? ' (süresi doldu)' : ' (aktif)'))
  kap.appendChild(baslik)

  const ciftler = [
    ['Aralık', formatPrice(z.bottom) + ' - ' + formatPrice(z.top)],
    ['Oluşum', formatDateTime(z.createdTime)],
    ['Pivot', formatDateTime(z.pivotTime)],
    [z.broken ? 'Kırılma' : 'Bitiş', formatDateTime(z.endTime)],
    ['Akış gücü', formatNumber(z.flow, 2) + ' / 10'],
    ['Doğuştaki akış', formatNumber(z.flowAtBirth, 2) + ' / 10'],
    ['Bant dışına taşma', formatNumber(z.bbDistAtr, 2) + ' ATR'],
    ['Birleşme sayısı', formatNumber(z.mergeCount, 0)],
    ['Dokunuş sayısı', formatNumber(z.touchCount, 0)],
  ]
  for (let i = 0; i < ciftler.length; i++) {
    const satir = document.createElement('div')
    satir.className = 'kv'
    const a = document.createElement('span')
    a.textContent = ciftler[i][0]
    const b = document.createElement('span')
    b.textContent = ciftler[i][1]
    satir.appendChild(a)
    satir.appendChild(b)
    kap.appendChild(satir)
  }

  const dBaslik = document.createElement('h4')
  dBaslik.className = 'sec-title'
  dBaslik.textContent = 'Bölge olayları (' + formatNumber(dokunuslar.length, 0) + ')'
  kap.appendChild(dBaslik)

  if (dokunuslar.length === 0) {
    const bos = document.createElement('div')
    bos.className = 'small muted'
    bos.textContent = 'Bu bölgeye kayıtlı olay yok.'
    kap.appendChild(bos)
  } else {
    for (let i = 0; i < dokunuslar.length; i++) {
      const t = dokunuslar[i]
      const satir = document.createElement('div')
      satir.className = 'row ' + (t.direction === 'SELL' ? 'sell' : 'buy')
      satir.style.cursor = 'default'

      const etiket = document.createElement('span')
      etiket.className = 'tag ' + (t.direction === 'SELL' ? 'sell' : 'buy')
      etiket.textContent = t.direction === 'SELL' ? 'SAT' : 'AL'
      satir.appendChild(etiket)

      const orta = document.createElement('span')
      orta.className = 'row-main'
      orta.appendChild(document.createTextNode(formatDateTime(t.time)))
      const rozet = document.createElement('span')
      rozet.className = 'badge tiny'
      rozet.textContent = t.kind === 'form' ? 'OLUŞUM' : 'DOKUNUŞ'
      rozet.title = t.kind === 'form'
        ? 'Kutunun doğduğu an, giriş onay barının kapanışı'
        : 'Fiyatın bölgeye geri dönüşü, giriş bölge kenarı'
      orta.appendChild(rozet)
      const alt = document.createElement('span')
      alt.className = 'row-sub'
      alt.textContent = t.kind === 'form'
        ? ('Fiyat ' + formatPrice(t.price) + ', kutuya uzaklık ' +
           formatNumber(t.entryDistAtr, 2) + ' ATR')
        : ('Fiyat ' + formatPrice(t.price) + ', giriş derinliği ' +
           formatPercent(t.penetration, 0))
      orta.appendChild(alt)
      satir.appendChild(orta)

      const sag = document.createElement('span')
      sag.className = 'row-side'
      const skor = document.createElement('span')
      skor.textContent = formatNumber(t.score, 0) + '/' + formatNumber(t.maxScore, 0)
      sag.appendChild(skor)
      // "Sinyal" / "Kayit" YAZMIYOR: olculdu, indikator esigini gecen olaylar
      // gecmeyenlerden DAHA IYI degil, hatta daha kotu (15m dokunusta %15,9'a
      // karsi %20,8). Etiket artik yalnizca esigin gecildigini soyluyor,
      // kalite iddiasi tasimiyor; sinyal karari kNN esikleriyle verilir.
      const nitelik = document.createElement('span')
      nitelik.className = 'row-sub muted'
      nitelik.textContent = t.qualified ? 'eşik geçti' : 'eşik altı'
      sag.appendChild(nitelik)
      satir.appendChild(sag)

      kap.appendChild(satir)
    }
  }

  geriDugmesiEkle(kap, 'Bölge listesine dön', () => {
    durum.seciliBolgeId = null
    if (overlay && typeof overlay.setHighlight === 'function') {
      try { overlay.setHighlight(null) } catch (err) { /* onemsiz */ }
    }
    goster(el('zoneDetail'), false)
    bolgePaneliniCiz()
  })
}

/* ------------------------------------------------------------------ */
/* Hafiza, ayarlar ve test panelleri                                   */
/* ------------------------------------------------------------------ */

/** Hafiza panelini cizer. */
function hafizaPaneliniCiz() {
  const kap = panelGovdesi('memory')
  if (!kap) return
  renderMemory(kap, durum.hafizaOzeti, durum.prototipler)
}

/**
 * Ayarlar panelini cizer.
 * Kaydedilmemis degisiklik varken yeniden cizmez (sekme degisiminde
 * kullanicinin yazdiklari kaybolmasin diye); `zorla` ile yenilenir.
 */
function ayarPaneliniCiz(zorla) {
  const kap = el('settingsForm') || panelGovdesi('settings')
  if (!kap) return
  if (!zorla && kap.childElementCount > 0 && Object.keys(durum.ayarYamasi).length > 0) return
  durum.ayarYamasi = {}
  renderSettings(kap, durum.ayarlar || {}, {
    providerList: durum.saglayicilar,
    onChange: (_yama, bilgi) => {
      if (bilgi && bilgi.patch) durum.ayarYamasi = bilgi.patch
      const st = el('settingsStatus')
      if (st) st.textContent = 'Kaydedilmemiş değişiklik var.'
    },
    onSave: (yama) => ayarlariKaydet(yama),
    onReset: () => ayarlariSifirla(),
  })
}

/**
 * Yamanin her yapragini kaydedilen ayarla karsilastirir ve tutmayanlari
 * "alan: istenen -> yazilan" listesi olarak dondurur. Ayarlar bir donem
 * sessizce kaydedilmiyordu; artik kaydin gercekten tuttugunu dogruluyoruz.
 */
function tutmayanAlanlar(yeni, yama, onek) {
  const fark = []
  if (!yama || typeof yama !== 'object') return fark
  for (const anahtar of Object.keys(yama)) {
    const yol = onek ? onek + '.' + anahtar : anahtar
    const istenen = yama[anahtar]
    const yazilan = yeni && typeof yeni === 'object' ? yeni[anahtar] : undefined
    if (istenen && typeof istenen === 'object' && !Array.isArray(istenen)) {
      fark.push(...tutmayanAlanlar(yazilan, istenen, yol))
    } else if (String(yazilan) !== String(istenen)) {
      fark.push(yol + ': ' + String(istenen) + ' -> ' + String(yazilan))
    }
  }
  return fark
}

/** Kullanicinin kayitli ayar yamasini motor icin tazeler. */
async function ayarYamasiniYenile() {
  const yama = await cagirGuvenli('settings:patch', {}, 'Ayar yaması okunamadı')
  if (yama && typeof yama === 'object') durum.ayarYamasiKayitli = yama
  return durum.ayarYamasiKayitli
}

/** Ayar yamasini diske yazar. */
async function ayarlariKaydet(yama) {
  const gonderilecek = yama && Object.keys(yama).length ? yama : durum.ayarYamasi
  if (!gonderilecek || Object.keys(gonderilecek).length === 0) {
    bildir('Kaydedilecek değişiklik yok.')
    return
  }
  const yeni = await cagirGuvenli('settings:set', { patch: gonderilecek }, 'Ayarlar kaydedilemedi')
  if (yeni === null) return
  if (yeni && typeof yeni === 'object') durum.ayarlar = yeni
  durum.ayarYamasi = {}
  const fark = tutmayanAlanlar(yeni, gonderilecek)
  if (fark.length > 0) {
    hataGoster('Bazı ayarlar istenen değerle kaydedilmedi (geçerli aralığa kırpılmış olabilir): ' + fark.join(', '))
  } else {
    bildir('Ayarlar kaydedildi. Hafızayı etkileyen değişiklikler için "Geçmişi Tara" çalıştırın.')
  }
  await ayarYamasiniYenile()
  ayarPaneliniCiz(true)
  saglayiciSecimleriniKur()
}

/** Ayarlari varsayilanlara dondurur (API anahtarlari ve saglayicilar korunur). */
async function ayarlariSifirla() {
  const onay = window.confirm(
    'Tüm ayarlar varsayılanlara dönecek. API anahtarları, sağlayıcı seçimi ve açık zaman dilimi korunur, ' +
    'elle girdiğiniz eşikler kaybolur ve hafızayı yeniden taramanız gerekir. Devam edilsin mi?'
  )
  if (!onay) return
  const yeni = await cagirGuvenli('settings:reset', {}, 'Varsayılanlara dönülemedi')
  if (yeni === null) return
  if (yeni && typeof yeni === 'object') durum.ayarlar = yeni
  durum.ayarYamasi = {}
  bildir('Ayarlar varsayılanlara döndü, yeniden tarama gerekir.')
  await ayarYamasiniYenile()
  ayarPaneliniCiz(true)
  saglayiciSecimleriniKur()
}

/** Test panelini cizer. */
function testPaneliniCiz() {
  const kap = panelGovdesi('test')
  if (!kap) return
  // SONUC BASKA BIR ZAMAN DILIMINE AITSE SOYLE. Test sururken zaman dilimi
  // degistirilebiliyordu ve sonuc kontrol edilmeden gosteriliyordu.
  const sonuc = durum.testSonucu
  const baskaTf = sonuc && sonuc.tf && sonuc.tf !== durum.tf ? sonuc.tf : null
  renderBacktest(kap, sonuc, {
    running: durum.testCalisiyor,
    otherTf: baskaTf,
  })
  // Test ozetinin ALTINA canli gunluk bolumu eklenir: "olculen" ile "canlida
  // olan" yan yana durmadikca aradaki sapma gorunmez.
  renderLiveLog(kap, durum.canliGunluk, { test: durum.testSonucu })
  csvDugmeleriniTazele()
}

/** Yuruyen ileri testi calistirir. */
async function testCalistir() {
  if (durum.testCalisiyor) return
  durum.testCalisiyor = true
  mesgulKilidiUygula()
  const dugme = el('testRunBtn')
  isBasladi(dugme, 'Çalışıyor...')
  testPaneliniCiz()
  motorDurumu('test çalışıyor')
  ilerleme(0, 'Test başlıyor')

  // Bos birakilan kutu "degisiklik yok" demektir; sayi('') 0 dondugu icin
  // isinma sessizce kapanip testi butun hafizaya acardi.
  const isinmaEl = el('testWarmup')
  const varsayilanIsinma = 500
  const isinma = isinmaEl && isinmaEl.value.trim() !== ''
    ? sayi(isinmaEl.value, varsayilanIsinma)
    : varsayilanIsinma

  try {
    // Yuk BICIMI onemli: isci `payload.cfg` okur. Bir donem ust duzeyde
    // gonderiliyordu ve sessizce yok sayiliyordu, yani Test sekmesi
    // kullanicinin esiklerini degil hazir ayari olcuyordu.
    const sonuc = await cagir('engine:backtest', {
      tf: durum.tf,
      cfg: {
        warmupEvents: isinma,
        cfgPatch: durum.ayarYamasiKayitli || null,
      },
    })
    // Sonuc HANGI zaman dilimine ve NE ZAMAN ait oldugunu tasisin: test
    // sururken tf degistirilebiliyor ve panel eski sonucu yeni tf'ye aitmis
    // gibi gosteriyordu.
    durum.testSonucu = Object.assign({ tf: durum.tf, olcumZamani: Math.floor(Date.now() / 1000) }, sonuc)
    // Geriye test sinyal listesini de URETIR ve diske yazar. Yeniden okunmazsa
    // Sinyaller sekmesi taramadan kalma bos listeyi gostermeye devam eder ve
    // kullanici "testi calistirdim ama sinyal gelmedi" diye bakar.
    await sinyalleriYukle()
    const uretilen = sonuc && sonuc.summary ? sayi(sonuc.summary.fired, 0) : durum.signals.length
    bildir('Test tamamlandı, ' + formatNumber(uretilen, 0) + ' sinyal Sinyaller sekmesine yazıldı.')
    ilerleme(100, 'Tamamlandı')
  } catch (err) {
    hataGoster('Test başarısız: ' + hataMetni(err))
  } finally {
    durum.testCalisiyor = false
    mesgulKilidiUygula()
    isBitti(dugme)
    testPaneliniCiz()
    setTimeout(ilerlemeyiKapat, 1500)
    motorDurumu('hazır')
  }
}

/* ------------------------------------------------------------------ */
/* Ana surecten gelen olaylar                                          */
/* ------------------------------------------------------------------ */

/** Olay dinleyicilerini baglar. */
function olaylariBagla() {
  if (!window.api || typeof window.api.on !== 'function') return

  window.api.on('progress', (veri) => {
    if (!veri) return
    ilerleme(veri.pct !== undefined ? veri.pct : veri.percent, veri.msg || veri.message || '')
  })

  window.api.on('live:candle', (veri) => {
    if (!veri) return
    const gelenTf = veri.tf || (veri.bar && veri.bar.tf)
    if (gelenTf && gelenTf !== durum.tf) return
    const bar = barNesnesi(veri.bar || veri.candle || veri)
    if (!bar) return
    // GECMIS BIR PENCEREYE BAKILIYORSA CANLI MUM GRAFIGE EKLENMEZ.
    //
    // Onceden 2015 penceresinin yanina 2026 mumu ekleniyordu: fiyat olcegi
    // yaklasik 1.200'den 4.400'e sicriyor ve guncele donmenin tek yolu zaman
    // dilimi degistirmek oluyordu. Canli fiyat yine ust seritte gorunur.
    // Ayni sebeple "o ana kadar" kipinde de eklenmez: gecmis bir ana kilitli
    // grafige bugunun mumunu koymak kipin butun anlamini bozar.
    if (durum.pencereliMumlar || durum.asOf !== null) {
      sonFiyatiYaz(bar)
      return
    }
    grafik('updateBar', bar)
    sonBariGuncelle(bar)
    efsaneyiYaz(null)
    // Secili canli sinyalin plan cizgileri yeni barla birlikte uzasin.
    if (durum.seciliSinyalId !== null) {
      const secili = durum.signals.find((x) => x && String(x.id) === String(durum.seciliSinyalId))
      if (secili && sayi(secili.barsToOutcome, -1) < 0) planCizgileri(secili)
    }
  })

  window.api.on('live:signal', (veri) => {
    if (!veri) return
    const gelenTf = veri.tf || (veri.signal && veri.signal.tf)
    if (gelenTf && gelenTf !== durum.tf) return
    const s = veri.signal || veri
    if (!s || s.time === undefined) return
    canliSinyalEkle(s)
  })

  // Canli akista bosluk olustu ya da vekil duzeltmesi hesaplanamadi: bar
  // YAZILMADI. Eksik donemi kapatmadan devam etmek seride kalici delik
  // birakacagi icin hemen veri tamamlama calistirilir.
  // CANLI DURUM: her tikte gelir. Gosterge rengi ve ipucu buradan tazelenir;
  // onceden yalnizca baslama ve durmada guncelleniyordu, yani akis olse bile
  // yesil kaliyordu.
  window.api.on('live:status', (veri) => {
    if (!veri) return
    durum.canliDurum = veri
    durum.canli = !!veri.running
    canliDurumuYaz()
    kaynakDurumuYaz()
  })

  // Bildirime tiklandi: ilgili sinyali sec ve Sinyaller sekmesini ac.
  window.api.on('live:focus-signal', (veri) => {
    if (!veri || veri.id === undefined || veri.id === null) return
    const hedef = durum.signals.find((x) => x && String(x.id) === String(veri.id))
    if (!hedef) return
    panelSec('signals')
    sinyalSec(hedef)
  })

  window.api.on('live:gap', async (veri) => {
    if (!veri) return
    if (veri.tf && veri.tf !== durum.tf) return
    if (durum.bosluKapatiliyor) return
    durum.bosluKapatiliyor = true
    try {
      bildir('Canlı akışta boşluk var, eksik dönem indiriliyor.')
      await tfHazirla(durum.tf)
      await hepsiniYukle()
    } catch (err) {
      hataGoster('Eksik dönem kapatılamadı: ' + (err && err.message ? err.message : String(err)))
    } finally {
      durum.bosluKapatiliyor = false
    }
  })

  // OTOMATIK GUNCELLEME DURUMU (alt serit).
  //
  // Indirme arka planda oluyor; hicbir sey yazmazsak kullanici uygulamanin
  // neden ag kullandigini ve neden birden "guncelleme hazir" penceresi
  // ciktigini anlamaz.
  window.api.on('update:status', (veri) => {
    if (!veri) return
    const surum = veri.surum ? ' ' + veri.surum : ''
    switch (veri.durum) {
      case 'indiriliyor':
        bildir('Güncelleme indiriliyor' + surum +
          (Number.isFinite(veri.yuzde) ? ', %' + veri.yuzde : ''))
        break
      case 'indirildi':
        bildir('Güncelleme indirildi' + surum + ', kurulum için onayınız bekleniyor.')
        break
      case 'cikista-kurulacak':
        bildir('Güncelleme' + surum + ' uygulamayı kapatınca kurulacak.')
        break
      case 'hata':
        // Guncelleme hatasi UYGULAMAYI etkilemez, o yuzden hata degil bilgi.
        bildir('Güncelleme denetlenemedi: ' + (veri.mesaj || 'bilinmeyen sebep'))
        break
      default:
        // 'bakiliyor' ve 'guncel' sessiz: her acilista satir kirletmesin.
        break
    }
  })

  window.api.on('log', (veri) => {
    const mesaj = typeof veri === 'string' ? veri : (veri && (veri.message || veri.msg))
    if (mesaj) bildir(String(mesaj))
  })
}

/** Canli gelen bari yerel dizide gunceller. */
function sonBariGuncelle(bar) {
  const barlar = durum.bars
  if (barlar.length === 0) {
    barlar.push(bar)
    return
  }
  const son = barlar[barlar.length - 1]
  if (bar.time === son.time) barlar[barlar.length - 1] = bar
  else if (bar.time > son.time) barlar.push(bar)
}

/** Canli sinyali listeye ve grafige ekler, alt seritte bildirir. */
function canliSinyalEkle(s) {
  if (s.id === undefined || s.id === null || s.id === '') {
    s.id = 'sig-' + sayi(s.time, Date.now()) + '-' + (s.direction === 'SELL' ? 'S' : 'B')
  }
  let yer = -1
  for (let i = 0; i < durum.signals.length; i++) {
    if (durum.signals[i] && String(durum.signals[i].id) === String(s.id)) { yer = i; break }
  }
  if (yer >= 0) durum.signals[yer] = s
  else durum.signals.push(s)

  isaretleriCiz()
  if (durum.aktifPanel === 'signals') sinyalPaneliniCiz()

  const yon = s.direction === 'SELL' ? 'SAT' : 'AL'
  const tur = s.kind === 'form' ? 'kutu oluşumu' : 'bölge dokunuşu'
  // YUKSEK ETKILI VERI: kapi kapali olsa bile bildirimde gorunur. Bolgeler bu
  // anlarda daha hizli kiriliyor; bu bir kanit degil, en riskli anda verilen
  // bir dikkat notudur.
  let haberNotu = ''
  if (s.news && Number.isFinite(Number(s.news.deltaMin)) && Math.abs(Number(s.news.deltaMin)) <= 60) {
    const dk = Math.round(Number(s.news.deltaMin))
    haberNotu = ' | Yüksek etkili veri: ' + String(s.news.code || 'veri') + ' ' +
      (dk >= 0 ? dk + ' dk sonra' : (-dk) + ' dk önce')
  }
  if (s.fired) {
    // "Guven" ifadesi KALDIRILDI: bir olasilik degildi ve olculdu, guven
    // yukseldikce gerceklesen oran dusuyordu. Yerine kac kayittan kaci
    // tuttugu, %95 araligi ve turun tabani yaziliyor.
    const ozet = s.summaryText || sinyalOzetiMetni(s)
    bildir('Yeni sinyal: ' + yon + ' (' + tur + ') ' + formatPrice(s.price) +
      (ozet ? ', ' + ozet : '') +
      ', ' + formatDateTime(s.time) + haberNotu)
  } else {
    bildir('Olay kaydedildi (' + yon + ', ' + tur + '), eşikler geçilmedi: ' +
      formatDateTime(s.time) + haberNotu)
  }
}

/* ------------------------------------------------------------------ */
/* Saat ve pencere olaylari                                            */
/* ------------------------------------------------------------------ */

const SAAT_BICIMI = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

/** Milisaniye damgasini Istanbul saatine cevirir (mesaj gecmisi icin). */
function saatMetni(ms) {
  try {
    return SAAT_BICIMI.format(new Date(ms))
  } catch (err) {
    return ''
  }
}

/**
 * Uygulama surumunu ve yapi damgasini pencere basligina yazar.
 *
 * Surum numarasi her pakette ayni oldugu icin tek basina hangi yapinin
 * calistigini soylemiyordu; bir hata bildirildiginde eski bir paketten mi
 * geldigi anlasilmadigi icin bosuna arama yapiliyordu. Damga paketleme
 * sirasinda yazilir (scripts/stamp-build.mjs).
 */
async function yapiDamgasiniYaz() {
  let bilgi = null
  try {
    bilgi = await cagir('app:info', {})
  } catch (err) {
    return
  }
  if (!bilgi) return

  const parcalar = ['Zone Memory', 'XAUUSD']
  if (bilgi.version) parcalar.push('v' + bilgi.version)
  if (bilgi.builtAt) {
    const d = new Date(bilgi.builtAt)
    if (!isNaN(d.getTime())) {
      parcalar.push(formatDate(Math.floor(d.getTime() / 1000)) +
        ' ' + SAAT_BICIMI.format(d))
    }
  }
  if (bilgi.commit) {
    // Kirli agacta commit tek basina yanlis yonlendirir: calisan kod o commit
    // degildir. Kac dosyanin commit edilmedigini basliga yaziyoruz, boylece
    // bir olcumun izlenemez olduguna bakarak karar verilebilir.
    let damga = bilgi.commit
    if (bilgi.dirty && bilgi.changedFiles > 0) {
      damga += ' (commit edilmemiş ' + bilgi.changedFiles + ' değişiklik)'
    } else if (bilgi.dirty) {
      damga += ' (commit edilmemiş değişiklik var)'
    }
    parcalar.push(damga)
  }
  // Paketlenmemis calistirmada kaynak her an degisebilir, damga bir paketi
  // isaret etmez; bunu ayrica belirtiyoruz.
  if (bilgi.dev) parcalar.push('geliştirme')
  document.title = parcalar.join(' - ')

  // Alt seritte gorunur surum. Kirli agacta ve gelistirme calistirmasinda
  // isaretlenir: "v0.2.2" yazan bir ekran goruntusu, aslinda commit
  // edilmemis bir koddan geliyorsa yanlis yonlendirir.
  const sv = el('statusVersion')
  if (sv) {
    let metin = 'v' + (bilgi.version || '?')
    if (bilgi.dev) metin += ' (geliştirme)'
    else if (bilgi.dirty) metin += ' (değiştirilmiş)'
    sv.textContent = metin
    sv.title = 'Sürüm ' + (bilgi.version || '?') +
      (bilgi.builtAt ? ', yapı ' + bilgi.builtAt : '') +
      (bilgi.commit ? ', commit ' + bilgi.commit : '')
  }

  const e = el('statusClock')
  if (e) {
    e.title = 'Sürüm ' + (bilgi.version || '?') +
      (bilgi.builtAt ? ', yapı ' + bilgi.builtAt : '') +
      (bilgi.commit ? ', commit ' + bilgi.commit : '') +
      (bilgi.srcHash ? ', kaynak ' + bilgi.srcHash : '') +
      (bilgi.dirty ? ', commit edilmemiş ' + (bilgi.changedFiles || 0) + ' değişiklik' : '') +
      (bilgi.dev ? ', geliştirme çalıştırması' : '')
  }
}

/** Alt seritteki saati baslatir (Istanbul saati). */
function saatiBaslat() {
  const e = el('statusClock')
  if (!e) return
  // "TSİ" eki: listelerdeki ve grafikteki butun saatler Istanbul saatine
  // gore ama bunu hicbir yer soylemiyordu; UTC sanan kullanici sinyal
  // saatlerini uc saat yanlis okuyabiliyordu.
  const yaz = () => { e.textContent = SAAT_BICIMI.format(new Date()) + ' TSİ' }
  yaz()
  if (saatZamanlayici) clearInterval(saatZamanlayici)
  saatZamanlayici = setInterval(yaz, 1000)
}

/** Pencere olaylarini baglar. */
function pencereOlaylari() {
  let bekleyen = false
  window.addEventListener('resize', () => {
    if (bekleyen) return
    bekleyen = true
    window.requestAnimationFrame(() => {
      bekleyen = false
      grafik('resize')
    })
  })
  window.addEventListener('beforeunload', () => {
    if (saatZamanlayici) clearInterval(saatZamanlayici)
    if (view && typeof view.destroy === 'function') {
      try { view.destroy() } catch (err) { /* onemsiz */ }
    }
  })
  window.addEventListener('keydown', kisayol)
}

/**
 * KLAVYE KISAYOLLARI (U8)
 *
 * Sinyal listesini gozden gecirmek tamamen fareyle yapiliyordu: her sinyal
 * icin listeye git, tikla, grafige bak, geri don. Yuzlerce sinyali boyle
 * taramak pratikte imkansiz. J/K listede gezdirir, Esc ayrintiyi kapatir.
 *
 * Bir metin alanina yaziliyorsa hicbir kisayol calismaz.
 */
function kisayol(ev) {
  if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return
  const hedef = ev.target
  if (hedef && (hedef.tagName === 'INPUT' || hedef.tagName === 'TEXTAREA' ||
      hedef.tagName === 'SELECT' || hedef.isContentEditable)) return

  const tus = ev.key

  if (tus === 'Escape') {
    if (mesajGecmisiAcik) { mesajGecmisiniKapat(); ev.preventDefault(); return }
    if (durum.seciliSinyalId !== null || durum.seciliBolgeId !== null) {
      durum.seciliSinyalId = null
      durum.seciliBolgeId = null
      durum.vurguluOrnek = null
      anaKadarUygula(null)
      planCizgileri(null)
      if (overlay && typeof overlay.setHighlight === 'function') {
        try { overlay.setHighlight(null) } catch (err) { /* onemsiz */ }
      }
      isaretleriCiz()
      paneliCiz()
      ev.preventDefault()
    }
    return
  }

  if (tus === 'j' || tus === 'J' || tus === 'k' || tus === 'K') {
    const ileri = (tus === 'j' || tus === 'J')
    komsuSinyaliSec(ileri)
    ev.preventDefault()
    return
  }

  if (tus === 'l' || tus === 'L') {
    const anahtar = el('liveToggle')
    if (anahtar && !anahtar.disabled) anahtar.click()
    ev.preventDefault()
    return
  }

  if (tus === 'End') {
    if (durum.pencereliMumlar || durum.asOf !== null) {
      guncelMumlaraDon()
      ev.preventDefault()
    }
    return
  }

  // 1-6: zaman dilimi. TF_LISTESI ile ayni sira.
  if (tus >= '1' && tus <= '6') {
    const tf = TF_LISTESI[Number(tus) - 1]
    if (tf && tf !== durum.tf && !mesgulMu()) {
      tfDegistir(tf)
      ev.preventDefault()
    }
  }
}

/**
 * Listedeki bir onceki veya sonraki sinyali secer.
 *
 * Sira LISTEDEKI siradir (yeniden eskiye), aksi halde J tusu bazen yukari
 * bazen asagi gidiyormus gibi olurdu.
 * @param {boolean} ileri true ise listede bir asagi (daha eski)
 */
function komsuSinyaliSec(ileri) {
  const kap = el('signalList')
  if (!kap) return
  const satirlar = kap.querySelectorAll('.row')
  if (satirlar.length === 0) return

  let yer = -1
  for (let i = 0; i < satirlar.length; i++) {
    if (satirlar[i].classList.contains('selected')) { yer = i; break }
  }
  let hedef = yer < 0 ? 0 : yer + (ileri ? 1 : -1)
  if (hedef < 0) hedef = 0
  if (hedef > satirlar.length - 1) hedef = satirlar.length - 1
  const satir = satirlar[hedef]
  if (!satir) return
  satir.click()
  try { satir.scrollIntoView({ block: 'nearest' }) } catch (err) { /* onemsiz */ }
}

/** Ust serit ve panel basligi dugmelerini baglar. */
function dugmeleriBagla() {
  const scan = el('scanBtn')
  if (scan) scan.addEventListener('click', () => taramaCalistir())

  const sync = el('syncBtn')
  if (sync) sync.addEventListener('click', () => veriCek())

  const guncele = el('goLatestBtn')
  if (guncele) guncele.addEventListener('click', () => guncelMumlaraDon())

  // Alt serit mesaj satiri: son mesajlari acar (U8).
  const mesajSatiri = el('statusMessage')
  if (mesajSatiri) {
    const ac = () => { if (mesajGecmisiAcik) mesajGecmisiniKapat(); else mesajGecmisiniAc() }
    mesajSatiri.addEventListener('click', ac)
    mesajSatiri.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ac() }
    })
  }
  // Motor satiri hata rengindeyken de ayni gecmise goturur.
  const motorSatiri = el('statusEngine')
  if (motorSatiri) motorSatiri.addEventListener('click', () => mesajGecmisiniAc())

  const hafizaCsv = el('memoryExportBtn')
  if (hafizaCsv) hafizaCsv.addEventListener('click', () => csvDisaAktar('events'))
  const testCsv = el('testExportBtn')
  if (testCsv) testCsv.addEventListener('click', () => csvDisaAktar('trades'))

  const iptal = el('cancelBtn')
  if (iptal) {
    iptal.addEventListener('click', async () => {
      await cagirGuvenli('engine:cancel', {}, 'İşlem durdurulamadı')
    })
    goster(iptal, false)
  }

  const yenile = el('signalRefreshBtn')
  if (yenile) yenile.addEventListener('click', () => sinyalleriYukle())

  const sinyalSuzgec = el('signalFilter')
  if (sinyalSuzgec) sinyalSuzgec.addEventListener('change', () => sinyalPaneliniCiz())

  const bolgeSuzgec = el('zoneFilter')
  if (bolgeSuzgec) bolgeSuzgec.addEventListener('change', () => bolgePaneliniCiz())

  // U7: kip acilip kapandiginda secili sinyal icin hemen uygulanir.
  const anaKadarKutu = el('asOfToggle')
  if (anaKadarKutu) {
    anaKadarKutu.addEventListener('change', () => {
      const secili = durum.signals.find((x) => x && String(x.id) === String(durum.seciliSinyalId))
      const ornek = durum.vurguluOrnek
      const hedef = ornek ? sayi(ornek.time, 0) : (secili ? sayi(secili.time, 0) : 0)

      anaKadarUygula(anaKadarKutu.checked && anaKadarGerekliMi(hedef) ? hedef : null)

      // Kip kapatilinca grafik, yuklu pencerenin SAG UCUNA atliyordu: kullanici
      // "sonrasini gorecegim" diye kutuyu kaldirinca sinyali ekrandan
      // kaybediyordu. Gorunum sinyalin etrafinda kalir.
      if (hedef > 0 && view && typeof view.scrollToTime === 'function') {
        try { view.scrollToTime(hedef, { minSpan: 80, maxSpan: 900 }) } catch (err) { /* onemsiz */ }
      }
    })
  }

  const bolgeGoster = el('zoneShowToggle')
  if (bolgeGoster) bolgeGoster.addEventListener('change', () => bolgeleriCiz())

  const kur = el('memoryBuildBtn')
  if (kur) kur.addEventListener('click', () => taramaCalistir())

  const sil = el('memoryDeleteBtn')
  if (sil) {
    sil.addEventListener('click', async () => {
      const olay = durum.hafizaOzeti ? sayi(durum.hafizaOzeti.total, 0) : 0
      const onay = window.confirm(
        durum.tf + ' hafızası silinecek: ' + formatNumber(olay, 0) + ' olay, bölgeler, ortak yapılar ve ' +
        formatNumber(durum.signals.length, 0) + ' sinyal. Bu işlem geri alınamaz, yeniden tarama gerekir. Devam edilsin mi?'
      )
      if (!onay) return
      const sonuc = await cagirGuvenli('engine:memory-delete', { tf: durum.tf }, 'Hafıza silinemedi')
      if (sonuc === null) return
      durum.hafizaOzeti = null
      durum.prototipler = []
      durum.signals = []
      durum.zones = []
      durum.seciliBolgeId = null
      durum.seciliSinyalId = null
      durum.testSonucu = null
      anaKadarAyarla(null)
      isaretleriCiz()
      bolgeleriCiz()
      planCizgileri(null)
      bildir('Hafıza silindi, yeniden tarama gerekir.')
      paneliCiz()
    })
  }

  const kaydet = el('settingsSaveBtn')
  if (kaydet) kaydet.addEventListener('click', () => ayarlariKaydet(durum.ayarYamasi))

  const varsayilan = el('settingsResetBtn')
  if (varsayilan) varsayilan.addEventListener('click', () => ayarlariSifirla())

  const testDugmesi = el('testRunBtn')
  if (testDugmesi) testDugmesi.addEventListener('click', () => testCalistir())

  const form = el('settingsForm')
  if (form) form.addEventListener('submit', (ev) => ev.preventDefault())
}

/* ------------------------------------------------------------------ */
/* Baslatma                                                            */
/* ------------------------------------------------------------------ */

/** Uygulamayi baslatir. */
async function baslat() {
  saatiBaslat()
  yapiDamgasiniYaz()
  pencereOlaylari()
  olaylariBagla()
  dugmeleriBagla()
  gorunumSekmeleriniKur()
  panelSekmeleriniKur()
  canliAnahtariniKur()
  ilerlemeyiKapat()

  const ayarlar = await cagirGuvenli('settings:get', {}, 'Ayarlar okunamadı')
  if (ayarlar && typeof ayarlar === 'object') {
    durum.ayarlar = ayarlar
    if (ayarlar.timeframe && TF_SANIYE[ayarlar.timeframe]) durum.tf = ayarlar.timeframe
  }
  // Kullanicinin ACIKCA degistirdigi alanlar. Motor bunu zaman dilimine ait
  // hazir ayarla birlestirir (presets.resolveCfg); birlesik ayari gondermek
  // hazir ayarlari fiilen devre disi birakirdi.
  await ayarYamasiniYenile()

  tfDugmeleriniKur()
  tvKaynagiGuncelle()
  await saglayicilariYukle()
  grafigiKur()

  // Acilista da eksigi tamamla: uygulama gunlerce kapali kalmis olabilir.
  await tfHazirla(durum.tf)

  await hepsiniYukle()

  // Canli takip: ayar aciksa uygulama acilir acilmaz baslar. En SONA birakildi,
  // cunku grafik ve saglayici listesi hazir olmadan baslatmak anlamsiz. Hata
  // olursa `canliBaslat` icindeki `cagirGuvenli` uyariyi basar ve anahtar
  // kapali kalir; acilis bundan etkilenmez.
  const otomatikCanli = !durum.ayarlar || durum.ayarlar.autoStartLive !== false
  if (otomatikCanli && !durum.canli) {
    await canliBaslat()
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    baslat().catch((err) => hataGoster('Başlatma hatası: ' + hataMetni(err)))
  })
} else {
  baslat().catch((err) => hataGoster('Başlatma hatası: ' + hataMetni(err)))
}
