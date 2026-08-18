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
import {
  renderSignals,
  renderSignalDetail,
  renderZones,
  renderMemory,
  renderSettings,
  renderBacktest,
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
const PANELLER = {
  signals: { panel: ['panelSignals', 'panelSinyaller'], baslik: 'Sinyaller' },
  zones: { panel: ['panelZones', 'panelBolgeler'], baslik: 'Bölgeler' },
  memory: { panel: ['panelMemory', 'panelHafiza'], baslik: 'Hafıza' },
  settings: { panel: ['panelSettings', 'panelAyarlar'], baslik: 'Ayarlar' },
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
  saglayicilar: [],
  tf: '15m',
  bars: [],
  zones: [],
  // Depodaki veri durumu (kac bar, ilk/son zaman). Gecmise dogru
  // genisletme bunun firstTime alanina bakar.
  veriDurumu: null,
  signals: [],
  seciliSinyalId: null,
  seciliBolgeId: null,
  hafizaOzeti: null,
  prototipler: [],
  testSonucu: null,
  testCalisiyor: false,
  taramaCalisiyor: false,
  canli: false,
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

/** Motor durumunu alt seritte gosterir. */
function motorDurumu(metin) {
  durum.motorMetni = 'Motor: ' + metin
  const e = el('statusEngine')
  if (!e) return
  e.textContent = durum.motorMetni
  e.style.color = ''
}

/** Bilgi mesaji (ses ve gorsel efekt yok, yalnizca alt serit satiri). */
function bildir(mesaj) {
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
  const e = el('statusMessage', 'statusEngine')
  if (e) {
    e.textContent = 'Hata: ' + mesaj
    e.style.color = RENK.down
  }
  if (mesajZamanlayici) clearTimeout(mesajZamanlayici)
  mesajZamanlayici = setTimeout(() => {
    mesajZamanlayici = 0
    const m = el('statusMessage')
    if (m) { m.textContent = ''; m.style.color = '' }
    else motorDurumu(durum.motorMetni.replace(/^Motor:\s*/, ''))
  }, 12000)
}

/** Canli durum metnini gunceller. */
function canliDurumuYaz() {
  const e = el('statusLive')
  if (!e) return
  e.textContent = durum.canli ? 'Canlı: açık (' + durum.tf + ')' : 'Canlı: kapalı'
  e.style.color = durum.canli ? RENK.up : ''
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

  // Grafige tiklaninca en yakin sinyali secer (isaret tiklamasi karsiligi).
  if (view.chart && typeof view.chart.subscribeClick === 'function') {
    try {
      view.chart.subscribeClick((param) => {
        if (!param || !Number.isFinite(param.time)) return
        enYakinSinyaliSec(param.time)
      })
    } catch (err) {
      // Tiklama destegi yoksa sessizce gec.
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

/** Verilen zamana en yakin sinyali secer (yarim bar toleransi). */
function enYakinSinyaliSec(zaman) {
  const tolerans = tfSaniye(durum.tf) * 1.5
  let enIyi = null
  let enIyiFark = Infinity
  for (let i = 0; i < durum.signals.length; i++) {
    const s = durum.signals[i]
    if (!s) continue
    const fark = Math.abs(sayi(s.time, 0) - zaman)
    if (fark < enIyiFark) { enIyiFark = fark; enIyi = s }
  }
  if (enIyi && enIyiFark <= tolerans) sinyalSec(enIyi)
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

/** Sinyal isaretlerini grafige koyar. */
function isaretleriCiz() {
  if (!view || typeof view.setMarkers !== 'function') return

  // Isaretler YALNIZCA yuklu mum araligindaki sinyaller icin konur.
  // lightweight-charts, veri araliginin disinda kalan bir isareti serinin ilk
  // barina yaslar; boylece 17 yillik sinyal listesi grafigin sol kenarinda
  // ust uste yigilip yanlis bir gorunti verirdi.
  const barlar = durum.bars
  const ilk = Array.isArray(barlar) && barlar.length ? barlar[0].time : null
  const son = Array.isArray(barlar) && barlar.length ? barlar[barlar.length - 1].time : null

  const isaretler = []
  for (let i = 0; i < durum.signals.length; i++) {
    const s = durum.signals[i]
    if (!s || s.fired === false) continue
    const t = sayi(s.time, 0)
    if (ilk === null || t < ilk || t > son) continue
    const alis = s.direction !== 'SELL'
    isaretler.push({
      id: String(s.id),
      time: t,
      position: alis ? 'belowBar' : 'aboveBar',
      shape: alis ? 'arrowUp' : 'arrowDown',
      color: alis ? RENK.up : RENK.down,
      text: '%' + Math.round(sayi(s.winRate, 0) * 100),
    })
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
    { price: sayi(s.tp2, NaN), color: RENK.up, title: 'TP2', width: 1, dashed: true },
    { price: sayi(s.sl, NaN), color: RENK.down, title: 'SL', width: 1, dashed: true },
  ].filter((c) => Number.isFinite(c.price) && c.price !== 0)
  if (seviyeler.length === 0) return

  const zaman = sayi(s.time, 0)

  // Cizgiler sinyalin verildigi bardan BASLAR ve sonuca kadar uzar.
  // Sonuc biliniyorsa (gecmis sinyal) TP veya SL'in vuruldugu bara,
  // bilinmiyorsa (canli sinyal) degerlendirme ufkunun sonuna kadar.
  const adim = tfSaniye(durum.tf)
  const ufuk = sayi(
    durum.ayarlar && durum.ayarlar.outcomeCfg ? durum.ayarlar.outcomeCfg.horizonBars : NaN,
    48
  )
  const barSayisi = sayi(s.barsToOutcome, -1)
  const bitis = barSayisi > 0 ? zaman + barSayisi * adim : zaman + ufuk * adim

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
  const fEl = el('lastPrice')
  if (fEl) fEl.textContent = formatPrice(kaynak.close)
  const cEl = el('lastChange')
  if (cEl) {
    cEl.textContent = degisimMetni
    cEl.className = 'last-change ' + (artiMi ? 'up' : 'down')
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
  if (barlar.length >= AZAMI_YUKLU_BAR) return

  const adim = tfSaniye(durum.tf)
  const ilkZaman = barlar[0].time
  // Gorunur aralik sol kenara yaklasti mi.
  if (aralik.from > ilkZaman + GENISLETME_ESIGI_BAR * adim) return

  // Depoda daha eski veri var mi.
  const st = durum.veriDurumu
  if (st && Number.isFinite(st.firstTime) && ilkZaman <= st.firstTime) return

  genisletmeSuruyor = true
  try {
    const to = ilkZaman - adim
    const from = to - GENISLETME_PARCASI * adim
    const ham = await cagir('data:candles', { tf: durum.tf, from: from, to: to, limit: GENISLETME_PARCASI })
    const eski = barlariNormalle(ham)
    if (eski.length === 0) return

    // Grafigin gorunur konumu kaymasin diye mantiksal araligi kaydiririz:
    // basa n bar eklendiginde ayni barlarin indeksi n artar.
    let lr = null
    try { lr = view.chart.timeScale().getVisibleLogicalRange() } catch (err) { lr = null }

    durum.bars = eski.concat(barlar)
    grafik('setBars', durum.bars)

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
  goster(el('chartEmpty'), barlar.length === 0)
  grafik('setBars', barlar)
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
  goster(el('chartEmpty'), false)
  grafik('setBars', barlar)
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
  if (durum.seciliBolgeId === null) bolgePaneliniCiz()
}

/** Sinyalleri yukler, isaretleri ve paneli tazeler. */
async function sinyalleriYukle() {
  const ham = await cagirGuvenli('engine:signals', { tf: durum.tf, limit: 500 }, 'Sinyaller alınamadı')
  if (ham === null) return
  durum.signals = sinyalleriNormalle(ham)
  isaretleriCiz()
  if (durum.seciliSinyalId === null) sinyalPaneliniCiz()
}

/** Hafiza ozetini ve ortak yapilari yukler. */
async function hafizayiYukle() {
  const ozet = await cagirGuvenli('engine:memory-summary', { tf: durum.tf }, 'Hafıza özeti alınamadı')
  if (ozet !== null) durum.hafizaOzeti = ozet && ozet.summary ? ozet.summary : ozet
  const proto = await cagirGuvenli('engine:prototypes', { tf: durum.tf }, 'Ortak yapılar alınamadı')
  if (proto !== null) {
    durum.prototipler = Array.isArray(proto)
      ? proto
      : (proto && Array.isArray(proto.prototypes) ? proto.prototypes : [])
  }
  hafizaPaneliniCiz()
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
      if (!tf || tf === durum.tf || durum.taramaCalisiyor) return
      tfDegistir(tf)
    })
  }
  tfDugmeleriniIsaretle()
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

/** Zaman dilimini degistirir ve her seyi yeniden yukler. */
async function tfDegistir(tf) {
  const oncekiCanli = durum.canli
  if (oncekiCanli) await canliDurdur()

  durum.tf = tf
  durum.seciliSinyalId = null
  durum.seciliBolgeId = null
  durum.signals = []
  durum.zones = []
  tfDugmeleriniIsaretle()
  planCizgileri(null)
  tvKaynagiGuncelle()

  const yeni = await cagirGuvenli('settings:set', { timeframe: tf }, 'Zaman dilimi kaydedilemedi')
  if (yeni && typeof yeni === 'object') durum.ayarlar = yeni
  else if (durum.ayarlar) durum.ayarlar.timeframe = tf

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
    const yeni = await cagirGuvenli('settings:set', yama, 'Sağlayıcı kaydedilemedi')
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
  const dugme = el('scanBtn')
  isBasladi(dugme, 'Taranıyor...')
  motorDurumu('geçmiş taranıyor')
  ilerleme(0, 'Tarama başlıyor')

  const ayar = durum.ayarlar || {}
  try {
    await cagir('engine:scan', {
      tf: durum.tf,
      params: ayar.indicatorParams,
      indicatorParams: ayar.indicatorParams,
      outcomeCfg: ayar.outcomeCfg,
      signalCfg: ayar.signalCfg,
    })
    bildir('Tarama tamamlandı, hafıza güncellendi.')
    ilerleme(100, 'Tamamlandı')
  } catch (err) {
    hataGoster('Tarama başarısız: ' + hataMetni(err))
  } finally {
    durum.taramaCalisiyor = false
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
    : [el('tabAnaliz'), el('tabTradingView')].filter(Boolean)
  for (let i = 0; i < dugmeler.length; i++) {
    const b = dugmeler[i]
    const ad = b.dataset && b.dataset.view ? b.dataset.view : (b.id === 'tabTradingView' ? 'tradingview' : 'analysis')
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
      renderSignalDetail(n.ayrinti, s)
      geriDugmesiEkle(n.ayrinti, 'Ayrıntıyı kapat', () => {
        durum.seciliSinyalId = null
        planCizgileri(null)
        sinyalPaneliniCiz()
      })
    } else {
      goster(n.ayrinti, false)
    }
  } else if (s) {
    // Ayri ayrinti kabi yoksa listenin yerine ayrintiyi ciz.
    renderSignalDetail(n.liste, s)
    geriDugmesiEkle(n.liste, 'Sinyal listesine dön', () => {
      durum.seciliSinyalId = null
      planCizgileri(null)
      sinyalPaneliniCiz()
    })
  }
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
  const zaman = sayi(s.time, 0)

  // Sinyal yuklu mum penceresinin disindaysa once o tarihin etrafini yukle,
  // aksi halde grafik bos bir alana kayar.
  if (zamanPencereDisinda(zaman)) {
    const yuklendi = await mumlariZamanEtrafindaYukle(zaman)
    if (yuklendi) {
      const barlar = durum.bars
      const to = barlar.length ? barlar[barlar.length - 1].time + tfSaniye(durum.tf) * 200 : undefined
      await bolgeleriYukle(barlar.length ? barlar[0].time : undefined, to)
      isaretleriCiz()
    }
  }

  planCizgileri(s)
  if (view && typeof view.scrollToTime === 'function') {
    try { view.scrollToTime(zaman) } catch (err) { /* onemsiz */ }
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
  renderZones(liste, durum.zones, {
    onSelect: (z) => bolgeSec(z),
    selectedId: durum.seciliBolgeId,
    filter: suzgec && suzgec.value ? suzgec.value : 'all',
  })
  goster(el('zoneEmpty'), false)

  const rozet = el('zoneCount')
  if (rozet) {
    rozet.textContent = String(durum.zones.length)
    let kirik = 0
    for (let i = 0; i < durum.zones.length; i++) if (durum.zones[i] && durum.zones[i].broken) kirik++
    rozet.title = durum.zones.length + ' bölge, ' + kirik + ' kırılmış'
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
      try { view.scrollToTime(zaman) } catch (err) { /* onemsiz */ }
    }
  }

  if (overlay && typeof overlay.setHighlight === 'function') {
    try { overlay.setHighlight(z.id) } catch (err) { /* onemsiz */ }
  }

  const ham = await cagirGuvenli('engine:touches', { tf: durum.tf, zoneId: z.id }, 'Bölge dokunuşları alınamadı')
  const hepsi = dokunuslariNormalle(ham)
  const dokunuslar = hepsi.filter((t) => t && sayi(t.zoneId, -1) === sayi(z.id, -2))
  bolgeAyrintisiniCiz(z, dokunuslar.length > 0 ? dokunuslar : hepsi)
}

/** Bolge ayrintisini (dokunus gecmisi) cizer. */
function bolgeAyrintisiniCiz(z, dokunuslar) {
  const kap = el('zoneDetail') || panelGovdesi('zones')
  if (!kap) return
  goster(kap, true)
  while (kap.firstChild) kap.removeChild(kap.firstChild)

  const baslik = document.createElement('h4')
  baslik.className = 'sec-title'
  baslik.textContent = (z.isSupport ? 'Destek bölgesi' : 'Direnç bölgesi') +
    ' #' + formatNumber(z.id, 0) + (z.broken ? ' (kırıldı)' : ' (aktif)')
  kap.appendChild(baslik)

  const ciftler = [
    ['Aralık', formatPrice(z.bottom) + ' - ' + formatPrice(z.top)],
    ['Oluşum', formatDateTime(z.createdTime)],
    ['Pivot', formatDateTime(z.pivotTime)],
    ['Bitiş', formatDateTime(z.endTime)],
    ['Akış gücü', formatNumber(z.flow, 2)],
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
  dBaslik.textContent = 'Dokunuş geçmişi (' + formatNumber(dokunuslar.length, 0) + ')'
  kap.appendChild(dBaslik)

  if (dokunuslar.length === 0) {
    const bos = document.createElement('div')
    bos.className = 'small muted'
    bos.textContent = 'Bu bölgeye kayıtlı dokunuş yok.'
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
      const alt = document.createElement('span')
      alt.className = 'row-sub'
      alt.textContent = 'Fiyat ' + formatPrice(t.price) +
        ', giriş derinliği ' + formatPercent(t.penetration, 0)
      orta.appendChild(alt)
      satir.appendChild(orta)

      const sag = document.createElement('span')
      sag.className = 'row-side'
      const skor = document.createElement('span')
      skor.textContent = formatNumber(t.score, 0) + '/' + formatNumber(t.maxScore, 0)
      sag.appendChild(skor)
      const nitelik = document.createElement('span')
      nitelik.className = 'row-sub ' + (t.qualified ? 'up' : 'muted')
      nitelik.textContent = t.qualified ? 'Sinyal' : 'Kayıt'
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

/** Ayar yamasini diske yazar. */
async function ayarlariKaydet(yama) {
  const gonderilecek = yama && Object.keys(yama).length ? yama : durum.ayarYamasi
  if (!gonderilecek || Object.keys(gonderilecek).length === 0) {
    bildir('Kaydedilecek değişiklik yok.')
    return
  }
  const yeni = await cagirGuvenli('settings:set', gonderilecek, 'Ayarlar kaydedilemedi')
  if (yeni === null) return
  if (yeni && typeof yeni === 'object') durum.ayarlar = yeni
  durum.ayarYamasi = {}
  bildir('Ayarlar kaydedildi. Hafızayı etkileyen değişiklikler için "Geçmişi Tara" çalıştırın.')
  ayarPaneliniCiz(true)
  saglayiciSecimleriniKur()
}

/** Ayarlari varsayilanlara dondurur. */
async function ayarlariSifirla() {
  const yeni = await cagirGuvenli('settings:reset', {}, 'Varsayılanlara dönülemedi')
  if (yeni === null) return
  if (yeni && typeof yeni === 'object') durum.ayarlar = yeni
  durum.ayarYamasi = {}
  bildir('Ayarlar varsayılanlara döndü, yeniden tarama gerekir.')
  ayarPaneliniCiz(true)
  saglayiciSecimleriniKur()
}

/** Test panelini cizer. */
function testPaneliniCiz() {
  const kap = panelGovdesi('test')
  if (!kap) return
  renderBacktest(kap, durum.testSonucu, {
    running: durum.testCalisiyor,
    onRun: () => testCalistir(),
  })
}

/** Yuruyen ileri testi calistirir. */
async function testCalistir() {
  if (durum.testCalisiyor) return
  durum.testCalisiyor = true
  const dugme = el('testRunBtn')
  isBasladi(dugme, 'Çalışıyor...')
  testPaneliniCiz()
  motorDurumu('test çalışıyor')
  ilerleme(0, 'Test başlıyor')

  const isinmaEl = el('testWarmup')
  const isinma = isinmaEl ? sayi(isinmaEl.value, 500) : 500

  try {
    const sonuc = await cagir('engine:backtest', {
      tf: durum.tf,
      warmupEvents: isinma,
      signalCfg: (durum.ayarlar || {}).signalCfg,
    })
    durum.testSonucu = sonuc
    bildir('Test tamamlandı.')
    ilerleme(100, 'Tamamlandı')
  } catch (err) {
    hataGoster('Test başarısız: ' + hataMetni(err))
  } finally {
    durum.testCalisiyor = false
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
    grafik('updateBar', bar)
    sonBariGuncelle(bar)
    efsaneyiYaz(null)
  })

  window.api.on('live:signal', (veri) => {
    if (!veri) return
    const gelenTf = veri.tf || (veri.signal && veri.signal.tf)
    if (gelenTf && gelenTf !== durum.tf) return
    const s = veri.signal || veri
    if (!s || s.time === undefined) return
    canliSinyalEkle(s)
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
  if (s.fired) {
    bildir('Yeni sinyal: ' + yon + ' ' + formatPrice(s.price) +
      ', başarı ' + formatPercent(s.winRate, 0) +
      ', güven ' + formatPercent(s.confidence, 0) +
      ', ' + formatDateTime(s.time))
  } else {
    bildir('Dokunuş kaydedildi (' + yon + '), eşikler geçilmedi: ' + formatDateTime(s.time))
  }
}

/* ------------------------------------------------------------------ */
/* Saat ve pencere olaylari                                            */
/* ------------------------------------------------------------------ */

const SAAT_BICIMI = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

/** Alt seritteki saati baslatir (Istanbul saati). */
function saatiBaslat() {
  const e = el('statusClock')
  if (!e) return
  const yaz = () => { e.textContent = SAAT_BICIMI.format(new Date()) }
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
}

/** Ust serit ve panel basligi dugmelerini baglar. */
function dugmeleriBagla() {
  const scan = el('scanBtn')
  if (scan) scan.addEventListener('click', () => taramaCalistir())

  const sync = el('syncBtn')
  if (sync) sync.addEventListener('click', () => veriCek())

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

  const bolgeGoster = el('zoneShowToggle')
  if (bolgeGoster) bolgeGoster.addEventListener('change', () => bolgeleriCiz())

  const kur = el('memoryBuildBtn')
  if (kur) kur.addEventListener('click', () => taramaCalistir())

  const guncelle = el('memoryExtendBtn')
  if (guncelle) guncelle.addEventListener('click', () => taramaCalistir())

  const sil = el('memoryDeleteBtn')
  if (sil) {
    sil.addEventListener('click', async () => {
      const sonuc = await cagirGuvenli('engine:memory-delete', { tf: durum.tf }, 'Hafıza silinemedi')
      if (sonuc === null) return
      durum.hafizaOzeti = null
      durum.prototipler = []
      durum.signals = []
      isaretleriCiz()
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

  tfDugmeleriniKur()
  tvKaynagiGuncelle()
  await saglayicilariYukle()
  grafigiKur()
  await hepsiniYukle()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    baslat().catch((err) => hataGoster('Başlatma hatası: ' + hataMetni(err)))
  })
} else {
  baslat().catch((err) => hataGoster('Başlatma hatası: ' + hataMetni(err)))
}
