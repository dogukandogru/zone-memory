/**
 * panels.js - Sag panel cizim fonksiyonlari (A10b).
 *
 * Her fonksiyon saf DOM yazar: IPC bilmez, ag bilmez, durum tutmaz.
 * Kendisine verilen kaba (el) cizer, etkilesimleri geri cagrilarla bildirir.
 *
 * Kullanici verisi HER ZAMAN `textContent` ile basilir, `innerHTML`
 * KULLANILMAZ (XSS'e karsi). Sayilar Intl 'tr-TR' bicimindedir, tarihler
 * Europe/Istanbul saatine cevrilir.
 *
 * Kullanilan sinif adlari index.html'de A10 tarafindan ilan edilen hazir
 * styles.css siniflaridir:
 *   .list .row .row-main .row-sub .row-side .badge .tag .up .down
 *   .muted .small .mono .grow .stat-grid > .stat > (.stat-label + .stat-value)
 *   .table-wrap > table.tbl  .btn .btn-primary .btn-ghost .btn-danger .mini
 *   .field .field-grid .select .input .check .inline
 *   .empty .detail .sec-title .kv .spark .equity-canvas .panel-foot
 *   .row.selected
 *
 * CONTRACTS.md 19. bolum disa acilan API:
 *   renderSignals, renderSignalDetail, renderZones, renderMemory,
 *   renderSettings, renderBacktest, renderLiveLog, drawSparkline
 * (Ek olarak app.js'in de kullandigi bicimlendirme yardimcilari disa acilir.)
 */

import { pozisyonBoyutu } from './risk.mjs'
import {
  sinyalAraligi,
  sinyalSayilari,
  basabasOran,
  aralikSinifi,
  ornekRozeti,
} from './istatistik.mjs'

const TF_SECENEKLERI = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

const SEANS_ADLARI = { Asia: 'Asya', London: 'Londra', 'New York': 'New York', Other: 'Diğer' }

const RENK = { up: '#26a69a', down: '#ef5350', dim: '#787b86', accent: '#2962ff', warn: '#f2b40e' }

/**
 * Baglam degerlerinin okunabilir adlari ("neye gore benzetti" tablosu icin).
 * Kaynak liste: src/core/learn/features.js CTX_NAMES. Listede olmayan bir ad
 * gelirse ham hali yazilir, yani yeni bir deger eklenince ekran bozulmaz.
 */
const CTX_ETIKET = {
  rsi: 'RSI',
  atrPct: 'ATR (fiyatin %)',
  distSma20Atr: 'SMA20 uzaklığı (ATR)',
  distSma50Atr: 'SMA50 uzaklığı (ATR)',
  hourSin: 'Saat (sin)',
  hourCos: 'Saat (cos)',
  dowSin: 'Gün (sin)',
  dowCos: 'Gün (cos)',
  zoneWidthAtr: 'Kutu genişliği (ATR)',
  zoneAge: 'Kutu yaşı',
  zoneFlow: 'Akış gücü',
  penetration: 'Bölgeye giriş',
  scoreRatio: 'Skor oranı',
  pFlow: 'Bileşen: akış',
  pTrend: 'Bileşen: trend',
  pSession: 'Bileşen: seans',
  pRejection: 'Bileşen: fitil reddi',
  pVolume: 'Bileşen: hacim',
  isSupport: 'Destek mi',
  trendState: 'Trend durumu',
  isForm: 'Oluşum mu',
  bbDistAtr: 'Bant dışına taşma (ATR)',
  volRatio: 'Hacim oranı',
  entryDistAtr: 'Giriş uzaklığı (ATR)',
}

/** Listelerde bir kerede cizilecek azami satir (arayuzu tikamamak icin). */
const AZAMI_SATIR = 500

/* ------------------------------------------------------------------ */
/* Bicimlendirme                                                       */
/* ------------------------------------------------------------------ */

const NF = {
  tam: new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }),
  bir: new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  iki: new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  uc: new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
  serbest: new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 6 }),
}

const DTF_TAM = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
})
const DTF_GUN = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
})
const DTF_SAAT = new Intl.DateTimeFormat('tr-TR', {
  timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false,
})

/** Sonlu sayi veya yedek deger. */
function sayi(v, yedek) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : (yedek === undefined ? 0 : yedek)
}

/**
 * Turkce sayi bicimi.
 * @param {number} v
 * @param {number} [basamak] 0, 1, 2 veya 3
 */
export function formatNumber(v, basamak) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '-'
  const b = basamak === undefined ? 2 : basamak
  if (b <= 0) return NF.tam.format(n)
  if (b === 1) return NF.bir.format(n)
  if (b >= 3) return NF.uc.format(n)
  return NF.iki.format(n)
}

/** Fiyat bicimi, buyukluge gore basamak secer. */
export function formatPrice(v) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '-'
  const m = Math.abs(n)
  if (m >= 100) return NF.iki.format(n)
  if (m >= 1) return NF.uc.format(n)
  return NF.serbest.format(n)
}

/** 0..1 arasi orani yuzdeye cevirir: 0.783 -> '%78,3' */
export function formatPercent(v, basamak) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '-'
  return '%' + formatNumber(n * 100, basamak === undefined ? 1 : basamak)
}

/** UNIX saniye -> Istanbul tarih ve saat. */
export function formatDateTime(t) {
  const n = sayi(t, 0)
  if (n <= 0) return '-'
  return DTF_TAM.format(new Date(n * 1000))
}

/** UNIX saniye -> Istanbul tarihi. */
export function formatDate(t) {
  const n = sayi(t, 0)
  if (n <= 0) return '-'
  return DTF_GUN.format(new Date(n * 1000))
}

/** UNIX saniye -> Istanbul saati. */
export function formatTime(t) {
  const n = sayi(t, 0)
  if (n <= 0) return '-'
  return DTF_SAAT.format(new Date(n * 1000))
}

/** Tam sayi metni. */
function tam(v) {
  return NF.tam.format(Math.round(sayi(v, 0)))
}

/**
 * Yil numarasi. `tam` kullanilamaz cunku binlik ayraci ekleyip 2009'u
 * "2.009" yapar.
 */
function yil(v) {
  return String(Math.round(sayi(v, 0)))
}

/* ------------------------------------------------------------------ */
/* DOM yardimcilari                                                    */
/* ------------------------------------------------------------------ */

/** Etiket, sinif ve metinle dugum uretir. */
function h(etiket, sinif, metin) {
  const n = document.createElement(etiket)
  if (sinif) n.className = sinif
  if (metin !== undefined && metin !== null) n.textContent = String(metin)
  return n
}

/** Dugumun icini bosaltir. */
function bosalt(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild)
}

/** Bolum basligi. */
function bolumBasligi(metin) {
  return h('h4', 'sec-title', metin)
}

/** Etiket + deger satiri (.kv). */
function kv(etiket, deger, sinif) {
  const s = h('div', 'kv')
  s.appendChild(h('span', null, etiket))
  s.appendChild(h('span', sinif || null, deger))
  return s
}

/** Istatistik kutucugu (.stat). */
function stat(etiket, deger, sinif) {
  const k = h('div', 'stat')
  k.appendChild(h('span', 'stat-label', etiket))
  k.appendChild(h('span', 'stat-value' + (sinif ? ' ' + sinif : ''), deger))
  return k
}

/** Istatistik kutucuklarini saran izgara. */
function statIzgara(kutular) {
  const g = h('div', 'stat-grid')
  for (let i = 0; i < kutular.length; i++) g.appendChild(kutular[i])
  return g
}

/**
 * Kaydirilabilir tablo uretir.
 * @param {string[]} basliklar
 * @param {Array<Array<string|Node>>} satirlar
 */
function tablo(basliklar, satirlar) {
  const sarmal = h('div', 'table-wrap')
  const t = h('table', 'tbl')
  const thead = h('thead')
  const trh = h('tr')
  for (let i = 0; i < basliklar.length; i++) trh.appendChild(h('th', null, basliklar[i]))
  thead.appendChild(trh)
  t.appendChild(thead)
  const tbody = h('tbody')
  for (let i = 0; i < satirlar.length; i++) {
    const tr = h('tr')
    const hucreler = satirlar[i]
    for (let j = 0; j < hucreler.length; j++) {
      const td = h('td')
      const v = hucreler[j]
      if (v instanceof Node) td.appendChild(v)
      else td.textContent = v === undefined || v === null ? '-' : String(v)
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  t.appendChild(tbody)
  sarmal.appendChild(t)
  return sarmal
}

/** Bos durum kutusu. */
function bosKutu(metin) {
  return h('div', 'empty', metin)
}

/** Yon etiketi (.tag). */
function yonEtiketi(yon) {
  const alis = yon !== 'SELL'
  return h('span', 'tag ' + (alis ? 'buy' : 'sell'), alis ? 'AL' : 'SAT')
}

/** Kucuk uyari kutusu (styles.css'te ayri sinif yok, degiskenlerle boyanir). */
function uyariKutusu(metin) {
  const d = h('div', 'small', metin)
  d.style.color = 'var(--warn, ' + RENK.warn + ')'
  d.style.border = '1px solid var(--border, #2a2e39)'
  d.style.background = 'var(--bg-raise, #222634)'
  d.style.borderRadius = '3px'
  d.style.padding = '5px 7px'
  d.style.marginBottom = '6px'
  return d
}

/** Satira tiklama ve klavye erisimi baglar. */
function tiklamaBagla(satir, geri, veri) {
  if (typeof geri !== 'function') return
  satir.tabIndex = 0
  satir.setAttribute('role', 'button')
  satir.addEventListener('click', () => geri(veri))
  satir.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      geri(veri)
    }
  })
}

/* ------------------------------------------------------------------ */
/* drawSparkline                                                       */
/* ------------------------------------------------------------------ */

/**
 * Mini cizgi grafigi cizer. Dizideki NaN degerler (isinma bolgeleri)
 * atlanir ve cizgi orada kesilir.
 * @param {HTMLCanvasElement} canvas
 * @param {ArrayLike<number>} values
 * @param {{width?:number,height?:number,color?:string,fill?:string,
 *          lineWidth?:number,markerIndex?:number,markerColor?:string,
 *          baseline?:number,background?:string}} [opts]
 */
export function drawSparkline(canvas, values, opts) {
  if (!canvas || typeof canvas.getContext !== 'function') return
  const o = opts || {}
  const genVerildi = Number.isFinite(o.width)
  const yukVerildi = Number.isFinite(o.height)
  const gen = Math.max(8, Math.round(genVerildi ? o.width : (canvas.clientWidth || 120)))
  const yuk = Math.max(6, Math.round(yukVerildi ? o.height : (canvas.clientHeight || 32)))
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1

  canvas.width = Math.round(gen * dpr)
  canvas.height = Math.round(yuk * dpr)
  if (genVerildi) canvas.style.width = gen + 'px'
  if (yukVerildi) canvas.style.height = yuk + 'px'

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, gen, yuk)
  if (o.background) {
    ctx.fillStyle = o.background
    ctx.fillRect(0, 0, gen, yuk)
  }

  const dizi = values || []
  const n = dizi.length | 0
  if (n < 2) return

  let enAz = Infinity
  let enCok = -Infinity
  let sonlu = 0
  for (let i = 0; i < n; i++) {
    const v = dizi[i]
    if (!Number.isFinite(v)) continue
    sonlu++
    if (v < enAz) enAz = v
    if (v > enCok) enCok = v
  }
  if (sonlu < 2) return

  const tabanVar = Number.isFinite(o.baseline)
  if (tabanVar) {
    if (o.baseline < enAz) enAz = o.baseline
    if (o.baseline > enCok) enCok = o.baseline
  }

  const pad = 2
  const ic = Math.max(1, yuk - pad * 2)
  let aralik = enCok - enAz
  if (!(aralik > 1e-12)) {
    enAz -= 0.5
    aralik = 1
  }

  const x = (i) => (i / (n - 1)) * (gen - 1)
  const y = (v) => pad + ic - ((v - enAz) / aralik) * ic

  if (tabanVar) {
    const yb = Math.round(y(o.baseline)) + 0.5
    ctx.strokeStyle = 'rgba(120,123,134,0.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, yb)
    ctx.lineTo(gen, yb)
    ctx.stroke()
  }

  const renk = o.color || RENK.accent

  if (o.fill) {
    const tabanY = tabanVar ? y(o.baseline) : yuk - pad
    ctx.beginPath()
    let acik = false
    let ilkX = 0
    let sonX = 0
    for (let i = 0; i < n; i++) {
      const v = dizi[i]
      if (!Number.isFinite(v)) continue
      const px = x(i)
      const py = y(v)
      if (!acik) {
        ilkX = px
        ctx.moveTo(px, tabanY)
        ctx.lineTo(px, py)
        acik = true
      } else {
        ctx.lineTo(px, py)
      }
      sonX = px
    }
    if (acik) {
      ctx.lineTo(sonX, tabanY)
      ctx.lineTo(ilkX, tabanY)
      ctx.closePath()
      ctx.fillStyle = o.fill
      ctx.fill()
    }
  }

  ctx.beginPath()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.lineWidth = sayi(o.lineWidth, 1.25)
  ctx.strokeStyle = renk
  let kalem = false
  for (let i = 0; i < n; i++) {
    const v = dizi[i]
    if (!Number.isFinite(v)) { kalem = false; continue }
    const px = x(i)
    const py = y(v)
    if (!kalem) { ctx.moveTo(px, py); kalem = true } else { ctx.lineTo(px, py) }
  }
  ctx.stroke()

  // Sinyal ani: kesik dikey cizgi.
  const mi = o.markerIndex
  if (Number.isFinite(mi) && mi >= 0 && mi < n) {
    const px = Math.round(x(mi)) + 0.5
    ctx.strokeStyle = o.markerColor || RENK.warn
    ctx.lineWidth = 1
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, yuk)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

/**
 * Bir eslesme kaydindan mini grafik serisi uretir.
 *
 * Bu SEYIR TASLAGIDIR, gercek mum serisi degil: lehte ve aleyhte azami
 * hareketten cizilen bir siluettir. Once bir de "kayitta shape/values/closes
 * varsa onu kullan" dali vardi; isci eslesme kayitlarina hicbir zaman sekil
 * vektoru koymadigi icin o dal hic calismadi ve kodu, gercek seri
 * gosterilebiliyormus gibi okutuyordu. Gercek seriyi gormek icin ornege
 * tiklanir, grafik o tarihe gider.
 * @returns {{degerler:number[], isaret:number}}
 */
function eslesmeSerisi(m) {
  const mfe = Math.abs(sayi(m && m.mfeAtr, 0))
  const mae = -Math.abs(sayi(m && m.maeAtr, 0))
  const basarili = !!(m && m.success)
  const once = basarili ? mae * 0.45 : mfe * 0.45
  const sonra = basarili ? mfe : mae
  return {
    degerler: [0, 0, 0, 0, 0, 0, 0, 0, once * 0.5, once, sonra * 0.55, sonra, sonra * 0.9],
    isaret: 7,
  }
}

/* ------------------------------------------------------------------ */
/* Olay turu yardimcilari                                              */
/* ------------------------------------------------------------------ */

/**
 * Sinyal SADE kipte mi uretildi ('hepsi')?
 *
 * Alanin VARLIGINA da bakilir: eski kayitlarda `mode` yoktur ama plan ve oran
 * alanlari vardir. Boylece kip degistiginde eski liste bozulmadan gorunur.
 * @param {object} s
 */
export function sadeSinyalMi(s) {
  if (!s) return false
  if (s.mode === 'hepsi') return true
  if (s.mode === 'hafiza') return false
  // Kip yazili degil: plan alani yoksa sade kabul edilir.
  return s.rr === undefined && s.tp1 === undefined && s.winRate === undefined
}

/** Kutu yuksekligini okunabilir yazar (ATR biriminde, varsa). */
function kutuYuksekligi(s) {
  const yuk = Math.abs(sayi(s.zoneTop, 0) - sayi(s.zoneBottom, 0))
  const atr = sayi(s.atr, 0)
  if (!(yuk > 0)) return 'Kutu'
  return atr > 0
    ? 'Kutu ' + formatNumber(yuk / atr, 2) + ' ATR'
    : 'Kutu ' + formatPrice(yuk)
}

/**
 * Olay turunun okunabilir adi: kutu olusumu mu, bolgeye dokunus mu.
 * @param {string} kind
 * @param {boolean} [sniper] Pine'in kendi sinyali mi
 */
function turAdi(kind, sniper) {
  if (sniper) return 'Sniper (bölge dokunuşu)'
  return kind === 'form' ? 'Kutu oluşumu' : 'Bölge dokunuşu'
}

/**
 * Liste satirlarinda yer kaplamayan kisa tur rozeti.
 * @param {string} kind
 * @param {boolean} [sniper]
 */
function turRozeti(kind, sniper) {
  if (sniper) {
    const s = h('span', 'badge tiny badge-sniper', 'SNIPER')
    s.title = 'İndikatörün kendi sinyali: bölge süpürüldü, fitil reddetti, ' +
      'yapı kırıldı ve trend aynı yöndeydi. Nadir çıkar.'
    return s
  }
  // AYRI RENK: listede iki tur yan yana duruyor (olculdu: 11.325 olusum,
  // 12.886 dokunus). Ayni renkte olunca bir bakista ayirt edilemiyorlardi.
  // Yon etiketi zaten yesil/kirmizi kullandigi icin tur rozetleri BASKA
  // renklerden secildi, yoksa "AL/SAT" ile karisir.
  const e = kind === 'form'
    ? h('span', 'badge tiny badge-form', 'OLUŞUM')
    : h('span', 'badge tiny badge-touch', 'DOKUNUŞ')
  e.title = kind === 'form'
    ? 'Kutunun doğduğu an, giriş onay barının kapanışı'
    : 'Kutuya ilk dokunuş, karar bar kapanışında, giriş sonraki barlarda bölge kenarına limit'
  return e
}

/**
 * KANIT ROZETI: bu sinyal turunun katma degeri son olcumde kanitlandi mi.
 *
 * Neden: olcum hicbir zaman diliminde kanitlanmis katma deger gostermiyor
 * (net beklentinin %95 araligi sifiri iceriyor) ama sinyal karti her turu
 * ayni guvenle yayinliyordu. Rozet bu farki gorunur kilar.
 * @param {object} kanit {status, n, netR, netRLo, netRHi, liftPts}
 */
function kanitRozeti(kanit) {
  const durum = kanit && kanit.status ? kanit.status : 'kanitlanmadi'
  const metin = durum === 'kanitli' ? 'KANITLI' : (durum === 'zayif' ? 'ZAYIF' : 'KANIT YOK')
  const sinif = durum === 'kanitli' ? 'badge tiny up' : (durum === 'zayif' ? 'badge tiny' : 'badge tiny muted')
  const e = h('span', sinif, metin)
  if (kanit && Number.isFinite(kanit.netR)) {
    e.title = 'Son ölçümde bu tür: ' + tam(kanit.n) + ' işlem, net ' +
      formatNumber(kanit.netR, 3) + ' R' +
      (Number.isFinite(kanit.netRLo)
        ? ' (%95 aralık ' + formatNumber(kanit.netRLo, 3) + ' ile ' + formatNumber(kanit.netRHi, 3) + ')'
        : '') +
      (durum === 'kanitli' ? '. Aralık sıfırın üstünde.' : '. Aralık sıfırı içeriyor, sonuç şansla açıklanabilir.')
  } else {
    e.title = 'Bu sinyal türü için henüz ölçüm yok. Test sekmesinden yürüyen ileri testi çalıştırın.'
  }
  return e
}

/**
 * Sinyalin GERCEKLESEN sonucu. Geriye testte uretilen sinyaller bunu tasir;
 * canli sinyallerde sonuc henuz belli olmadigi icin null gelir.
 *
 * `win` ile `outcome` ayni sey DEGILDIR:
 *   outcome  bolgenin tutup tutmadigi etiketi (respect / break / timeout)
 *   win      islemin gercekten kazanip kazanmadigi; bolge tutmus OLSA BILE
 *            plan hedefine ulasilamadiysa kazanc sayilmaz
 * Kullaniciyi ilgilendiren birinci sey `win`, ayrintida ikisi de gosterilir.
 * @returns {{hazir:boolean, kazanc:boolean, etiket:string, sinif:string}}
 */
function sonucBilgisi(s) {
  if (!s || s.win === null || s.win === undefined) {
    return { hazir: false, kazanc: false, etiket: 'Sonuç yok', sinif: 'muted' }
  }
  const kazanc = s.win === true
  return {
    hazir: true,
    kazanc: kazanc,
    etiket: kazanc ? 'Tuttu' : 'Tutmadı',
    sinif: kazanc ? 'up' : 'down',
  }
}

/**
 * Sinyal ayrintisina "Pozisyon" bolumunu ekler.
 *
 * @param {HTMLElement} el
 * @param {Object} signal
 * @param {Object|null} risk Ayarlardaki risk bolumu
 */
function pozisyonBolumu(el, signal, risk) {
  el.appendChild(bolumBasligi('Pozisyon'))
  const r = risk || {}
  const bakiye = sayi(r.balance, 0)
  if (!(bakiye > 0)) {
    el.appendChild(h('div', 'small muted',
      'Hesap bakiyesi girilmedi. Ayarlar > Risk ve pozisyon bölümünden bakiye girin, ' +
      'stop mesafesi lota ve dolara çevrilsin.'))
    return
  }

  const sonuc = pozisyonBoyutu({
    entry: sayi(signal.entry, NaN),
    sl: sayi(signal.sl, NaN),
    tp1: sayi(signal.tp1, NaN),
    balance: bakiye,
    riskPct: sayi(r.riskPct, 1),
    contractSize: sayi(r.contractSize, 100),
    lotStep: sayi(r.lotStep, 0.01),
    minLot: sayi(r.minLot, 0.01),
    // Maliyet verilmediyse testteki ile AYNI oran kullanilir (fiyat x %0,0068).
    //
    // DIKKAT: `Number(null)` SIFIRDIR. Once acikca null/undefined/bos elenir;
    // yoksa "maliyet girilmedi" durumu "maliyet sifir" diye okunuyor ve risk
    // ile TP1 kazanci ayni cikiyordu (olculdu: 97,29 dolar / 97,29 dolar,
    // dogrusu 99,39 / 95,21).
    costUsd: (r.costUsd === null || r.costUsd === undefined || r.costUsd === '' ||
      !Number.isFinite(Number(r.costUsd)) || Number(r.costUsd) < 0)
      ? sayi(signal.entry, 0) * 0.000068
      : Number(r.costUsd),
  })

  if (sonuc.gecersiz) {
    el.appendChild(h('div', 'small muted', 'Pozisyon hesaplanamadı: ' + (sonuc.sebep || 'geçersiz plan')))
    return
  }
  if (sonuc.yetersiz) {
    const uyari = uyariKutusu('Bakiye bu kurulum için yetersiz: en küçük lot bile ' +
      formatNumber(sonuc.enKucukLotRiskPct, 2) + '% risk demek (hedefiniz ' +
      formatNumber(sayi(r.riskPct, 1), 2) + '%).')
    uyari.style.color = 'var(--warn, ' + RENK.warn + ')'
    el.appendChild(uyari)
    return
  }

  el.appendChild(kv('Lot', formatNumber(sonuc.lot, 2)))
  el.appendChild(kv('Risk', formatNumber(sonuc.riskUsd, 2) + ' $ (' +
    formatNumber(sonuc.gerceklesenRiskPct, 2) + '%)', 'down'))
  el.appendChild(kv('TP1 gerçekleşirse', formatNumber(sonuc.tp1KazancUsd, 2) + ' $',
    sonuc.tp1KazancUsd >= 0 ? 'up' : 'down'))
  el.appendChild(h('div', 'small muted',
    'Maliyet dahil. Lot yalnızca riski sınırlar: başarı oranına göre büyütülmez, ' +
    'çünkü sistem henüz kanıtlanmış bir katma değer üretmiyor.'))
}

/** Skor bilesenlerinin okunabilir adlari. */
const PARCA_ADLARI = {
  flow: 'akış gücü',
  trend: 'üst TF trendi',
  session: 'seans',
  rejection: 'fitil reddi',
  volume: 'hacim',
  qualified: 'eşiği geçti (bileşik)',
}

/** outcome etiketinin okunabilir hali. */
function outcomeAdi(outcome) {
  if (outcome === 'respect') return 'Bölge tuttu'
  if (outcome === 'break') return 'Bölge kırıldı'
  if (outcome === 'timeout') return 'Zaman aşımı'
  return 'Sonuç henüz belli değil'
}

/**
 * KISA sonuc etiketi. Grafik isareti de bunu kullanir: sonuc kelimesi TEK
 * YERDE yazilir, yoksa ekranin bir kosesinde "Tuttu", otekinde baska bir
 * sozcuk cikar. Nitekim grafik isareti bir donem "saygi" yaziyordu; bu,
 * `respect` etiketinin birebir cevirisiydi ve kullaniciya hicbir sey
 * anlatmiyordu.
 *
 * Uc degerlidir. Eski hal yalnizca `success` alanina bakip her basarisizligi
 * "Kirilim" diye gosteriyordu; oysa 15m'de form basarisizliklarinin %26'si
 * zaman asimidir, yani bolge kirilmadi, ufuk doldu. Zaman asimi notr renkle
 * gosterilir, cunku ne kazanc ne tam kayiptir.
 *
 * @param {{outcome?:string, success?:boolean}} m
 * @returns {{ad:string, sinif:string}}
 */
export function sonucEtiketi(m) {
  const o = m && typeof m.outcome === 'string' ? m.outcome : ''
  if (o === 'respect') return { ad: 'Tuttu', sinif: 'up' }
  if (o === 'break') return { ad: 'Kırıldı', sinif: 'down' }
  if (o === 'timeout') return { ad: 'Zaman aşımı', sinif: 'muted' }
  if (o === 'nofill') return { ad: 'Emir dolmadı', sinif: 'muted' }
  // Eski kayitlarda outcome alani yok, ikili bilgiye dusulur.
  return m && m.success ? { ad: 'Tuttu', sinif: 'up' } : { ad: 'Kırıldı', sinif: 'down' }
}

/* ------------------------------------------------------------------ */
/* renderSignals                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sinyal listesini cizer (yalnizca satirlar, baslik serisi index.html'de).
 * @param {HTMLElement} el Liste kabi (ornek: #signalList)
 * @param {Array<object>} signals
 * @param {{onSelect?:(s:object)=>void, selectedId?:*, filter?:string,
 *          total?:number, truncated?:boolean}} [opts]
 */
export function renderSignals(el, signals, opts) {
  if (!el) return
  const o = opts || {}
  bosalt(el)

  const hepsi = Array.isArray(signals) ? signals.slice() : []
  hepsi.sort((a, b) => sayi(b && b.time, 0) - sayi(a && a.time, 0))

  const suzgec = o.filter || 'all'
  const liste = hepsi.filter((s) => {
    if (!s) return false
    if (suzgec === 'fired') return !!s.fired
    if (suzgec === 'buy') return s.direction !== 'SELL'
    if (suzgec === 'sell') return s.direction === 'SELL'
    if (suzgec === 'form') return s.kind === 'form'
    if (suzgec === 'touch') return s.kind !== 'form'
    if (suzgec === 'won') return s.win === true
    if (suzgec === 'lost') return s.win === false
    return true
  })

  if (liste.length === 0) {
    // Gecmis sinyaller yalnizca geriye testte olusur. "Gecmisi Tara" hafizayi
    // kurar ve eski sinyalleri SILER, cunku onlar artik gecersiz hafizaya
    // dayanir. Bu yuzden bos liste mesaji kullaniciyi taramaya degil teste
    // yollamali; aksi halde tarayip tarayip ayni bos ekrana bakiyor.
    el.appendChild(bosKutu(hepsi.length === 0
      ? 'Sinyal listesi geriye testten gelir. "Test" sekmesine geçip "Testi Çalıştır" deyin.'
      : 'Bu süzgeçle gösterilecek sinyal yok.'))
    return
  }

  // Sonucu belli olan sinyallerin ozeti. Canli sinyaller henuz sonuclanmadigi
  // icin bu sayima girmez.
  let tutan = 0
  let tutmayan = 0
  let toplamPnl = 0
  for (let i = 0; i < liste.length; i++) {
    const x = liste[i]
    if (x.win === true) { tutan++; toplamPnl += sayi(x.pnlAtr, 0) }
    else if (x.win === false) { tutmayan++; toplamPnl += sayi(x.pnlAtr, 0) }
  }
  const sonuclu = tutan + tutmayan
  if (sonuclu > 0) {
    const oran = tutan / sonuclu
    const ortPnl = toplamPnl / sonuclu
    const ozet = h('div', 'list-summary')
    ozet.appendChild(h('span', oran >= 0.5 ? 'up' : 'down', formatPercent(oran, 1) + ' tuttu'))
    ozet.appendChild(h('span', 'muted', tam(tutan) + ' / ' + tam(sonuclu)))
    ozet.appendChild(h('span', ortPnl >= 0 ? 'up' : 'down',
      (ortPnl >= 0 ? '+' : '') + formatNumber(ortPnl, 3) + ' ATR'))
    ozet.title = 'Sonucu belli olan ' + sonuclu + ' sinyalin isabet oranı ve işlem başına net kazancı'
    el.appendChild(ozet)
  }

  // KIRPILMIS LISTE ACIKCA SOYLENIR (U8).
  //
  // Arayuz isciden yalnizca son N sinyali istiyor. Bugun 15m'de 252 sinyal
  // oldugu icin fark etmiyor, ama kirpma basladigi anda buradaki isabet
  // orani Test sekmesindekinden sessizce ayrilir ve hangisinin dogru oldugu
  // anlasilmaz. Kirpma varsa yaziyor.
  const toplam = sayi(o.total, 0)
  if (o.truncated === true && toplam > hepsi.length) {
    el.appendChild(h('div', 'small muted',
      'Aşağıdaki oran yalnızca son ' + tam(hepsi.length) + ' sinyale ait, toplam ' +
      tam(toplam) + ' sinyal var. Tamamı için Test sekmesindeki özete bakın.'))
  }

  const adet = Math.min(liste.length, AZAMI_SATIR)
  for (let i = 0; i < adet; i++) {
    const s = liste[i]
    const alis = s.direction !== 'SELL'
    const satir = h('div', 'row ' + (alis ? 'buy' : 'sell') + (s.fired ? '' : ' dim') +
      (o.selectedId !== undefined && o.selectedId !== null && String(s.id) === String(o.selectedId) ? ' selected' : ''))

    satir.appendChild(yonEtiketi(s.direction))

    const orta = h('span', 'row-main')
    orta.appendChild(document.createTextNode(formatDateTime(s.time) + '  ' + formatPrice(s.price)))
    orta.appendChild(turRozeti(s.kind, s.sniper))
    if (s.evidence) orta.appendChild(kanitRozeti(s.evidence))
    // 'hepsi' KIPI: gecmis sonuc, isabet orani ve R/R HIC hesaplanmaz.
    // Ekranda kurulumun KENDI bilgisi gosterilir.
    const sade = sadeSinyalMi(s)
    const altMetin = sade
      ? (kutuYuksekligi(s) + (sayi(s.zoneAgeBars, 0) > 0
        ? ', kutu yaşı ' + tam(s.zoneAgeBars) + ' bar'
        : ''))
      : (s.fired
        ? (tam(s.matchCount) + ' benzer kayıt, R/R ' + formatNumber(s.rr, 2))
        : ('Üretilmedi: ' + (Array.isArray(s.reasons) && s.reasons.length
          ? String(s.reasons[s.reasons.length - 1])
          : 'eşikler geçilmedi')))
    orta.appendChild(h('span', 'row-sub', altMetin))
    satir.appendChild(orta)

    const sag = h('span', 'row-side')
    const sonuc = sonucBilgisi(s)
    if (sade) {
      // Yalnizca kurulumun kendi gucu: indikatorun bilesik skoru.
      const enCok = sayi(s.maxScore, 0)
      sag.appendChild(h('span', null,
        enCok > 0 ? tam(sayi(s.score, 0)) + '/' + tam(enCok) : '-'))
      sag.appendChild(h('span', 'row-sub', 'skor'))
    } else if (sonuc.hazir) {
      // Gerceklesen sonuc, beklentiden daha onemli oldugu icin ust satirda.
      const rozet = h('span', sonuc.sinif, sonuc.etiket)
      rozet.title = outcomeAdi(s.outcome) + ', beklenti %' +
        Math.round(sayi(s.winRate, 0) * 100) + ', R/R ' + formatNumber(s.rr, 2)
      sag.appendChild(rozet)
      sag.appendChild(h('span', 'row-sub ' + (sayi(s.pnlAtr, 0) >= 0 ? 'up' : 'down'),
        (sayi(s.pnlAtr, 0) >= 0 ? '+' : '') + formatNumber(s.pnlAtr, 2) + ' ATR'))
    } else {
      // ORAN TEK BASINA YANILTIYOR: 5 eslesmeli %60 ile 25 eslesmeli %60
      // ekranda ayni gorunuyordu. Artik "9/15" sayimi, %95 araligi ve
      // BASABASA gore renk gosteriliyor (sabit %50 esigi, risk/odulu hesaba
      // katmadigi icin basabasi %31 olan kurulumu kirmizi gosterebiliyordu).
      const sayimlar = sinyalSayilari(s)
      const aralik = sinyalAraligi(s)
      const bb = basabasOran(s.rr)
      const oran = h('span', aralikSinifi(aralik, bb),
        sayimlar ? tam(sayimlar.k) + '/' + tam(sayimlar.n) : formatPercent(s.winRate, 0))
      oran.title = 'Benzer geçmiş kurulumların tutma oranı: ' +
        formatPercent(s.winRate, 0) +
        (aralik ? ', %95 aralık ' + formatPercent(aralik.lo, 0) + ' - ' + formatPercent(aralik.hi, 0) : '') +
        '. Başabaş ' + formatPercent(bb, 0) + ' (R/R ' + formatNumber(s.rr, 2) + ').'
      sag.appendChild(oran)
      const rozet = ornekRozeti(s.matchCount)
      sag.appendChild(h('span', 'row-sub' + (rozet ? ' ' + rozet.sinif : ''),
        rozet ? rozet.metin : (aralik
          ? formatPercent(aralik.lo, 0) + '-' + formatPercent(aralik.hi, 0)
          : 'RR ' + formatNumber(s.rr, 2))))
    }
    satir.appendChild(sag)

    tiklamaBagla(satir, o.onSelect, s)
    el.appendChild(satir)
  }

  if (liste.length > adet) {
    el.appendChild(h('div', 'empty small',
      tam(liste.length - adet) + ' kayıt daha var, süzgeci daraltın.'))
  }
}

/* ------------------------------------------------------------------ */
/* renderSignalDetail                                                  */
/* ------------------------------------------------------------------ */

/**
 * Tek bir sinyalin ayrintisini cizer.
 * @param {HTMLElement} el Ayrinti kabi (ornek: #signalDetail)
 * @param {object} signal
 * @param {{onMatchSelect?:(match:object)=>void}} [opts]
 *        onMatchSelect verilirse "Benzer gecmis ornekler" satirlari tiklanabilir
 *        olur ve secilen ornek geri cagriya gecer (grafikte o ana gitmek icin).
 */
export function renderSignalDetail(el, signal, opts) {
  if (!el) return
  const o = opts || {}
  bosalt(el)
  if (!signal) {
    el.appendChild(bosKutu('Ayrıntı için listeden bir sinyal seçin.'))
    return
  }

  const alis = signal.direction !== 'SELL'

  // BASLIK: sinyal uretilmediyse bunu sakla.
  const baslikSonek = signal.fired === false ? ' (sinyal üretilmedi)' : ''
  el.appendChild(bolumBasligi((alis ? 'AL sinyali' : 'SAT sinyali') + ' - ' +
    turAdi(signal.kind, signal.sniper) + ' - ' + formatDateTime(signal.time) + baslikSonek))

  // 'hepsi' KIPI: plan, oran, benzer ornekler ve gerceklesen sonuc YOKTUR.
  // Bu kipte oyle bir hesap yapilmiyor; hedef ve zarar durdur kullanicinin
  // kendi karari. Ekrana kurulumun KENDI bilgileri yazilir.
  if (sadeSinyalMi(signal)) {
    const enCok = sayi(signal.maxScore, 0)
    el.appendChild(statIzgara([
      stat('Fiyat', formatPrice(signal.price)),
      stat('Kutu', kutuYuksekligi(signal).replace('Kutu ', '')),
      stat('Kutu yaşı', tam(signal.zoneAgeBars) + ' bar'),
      stat('İndikatör skoru', enCok > 0 ? tam(signal.score) + '/' + tam(enCok) : '-'),
    ]))
    el.appendChild(kv('Bölge aralığı',
      formatPrice(signal.zoneBottom) + ' - ' + formatPrice(signal.zoneTop)))
    el.appendChild(kv('Akış gücü', formatNumber(signal.zoneFlow, 2)))
    el.appendChild(kv('Hacim oranı', formatNumber(signal.volRatio, 2)))
    el.appendChild(kv('ATR', formatNumber(signal.atr, 2)))
    el.appendChild(h('div', 'small muted',
      'Hedef ve zarar durdur bilinçli olarak hesaplanmıyor: bu kipte sistem ' +
      'yalnızca kurulumu gösterir, seviyeleri siz belirlersiniz.'))

    // BENZER GECMIS KURULUMLAR. Bu kipte sinyalin CIKMA SEBEBI zaten bunlar:
    // gecmiste ayni yapi bulundugu icin sinyal uretildi. Tutma orani ve sonuc
    // BILEREK gosterilmez, yalnizca ne zaman ve ne kadar benzer.
    const eslesmeler = Array.isArray(signal.topMatches) ? signal.topMatches : []
    if (eslesmeler.length > 0) {
      el.appendChild(bolumBasligi('Geçmişte bulunan benzer ' +
        tam(signal.matchCount) + ' kurulum'))
      el.appendChild(h('div', 'small muted',
        'Sinyalin çıkma sebebi bu: aynı yapı geçmişte de oluşmuş. ' +
        'Ortalama benzerlik ' + formatNumber(signal.avgSimilarity, 3) + '.'))
      const ornegeGit2 = typeof o.onMatchSelect === 'function' ? o.onMatchSelect : null
      const karsilastir2 = typeof o.onMatchCompare === 'function' ? o.onMatchCompare : null
      for (let i = 0; i < eslesmeler.length; i++) {
        const m = eslesmeler[i]
        const satir = h('div', 'row' + (ornegeGit2 ? ' clickable' : ''))
        if (ornegeGit2) {
          satir.title = 'Grafikte bu örneğe git'
          tiklamaBagla(satir, ornegeGit2, m)
        }
        const sol = h('span', 'row-side')
        sol.appendChild(h('span', null, formatDate(m.time)))
        sol.appendChild(h('span', 'row-sub', formatTime(m.time)))
        satir.appendChild(sol)
        const orta = h('span', 'row-main grow')
        orta.appendChild(h('span', 'row-sub', 'benzerlik ' + formatNumber(m.similarity, 3)))
        satir.appendChild(orta)
        const sag = h('span', 'row-side')
        if (karsilastir2) {
          const kutu = h('div', 'match-compare')
          kutu.hidden = true
          const dugme = h('button', 'btn mini compare-btn', 'Neye göre?')
          dugme.type = 'button'
          dugme.title = 'Bu örnekle şimdiki kurulumun şekillerini grafik üzerinde karşılaştır'
          sag.appendChild(dugme)
          let yuklendi = false
          dugme.addEventListener('click', async (olay) => {
            olay.stopPropagation()
            if (!kutu.hidden) {
              kutu.hidden = true
              dugme.classList.remove('active')
              try { karsilastir2(signal, null) } catch (err) { /* onemsiz */ }
              return
            }
            kutu.hidden = false
            dugme.classList.add('active')
            if (yuklendi) {
              try { karsilastir2(signal, m) } catch (err) { /* onemsiz */ }
              return
            }
            yuklendi = true
            kutu.appendChild(h('div', 'small muted', 'Karşılaştırma hazırlanıyor...'))
            try {
              const veri = await karsilastir2(signal, m)
              bosalt(kutu)
              if (veri) karsilastirmayiCiz(kutu, veri, signal, m)
              else kutu.appendChild(h('div', 'small muted', 'Karşılaştırma alınamadı.'))
            } catch (err) {
              bosalt(kutu)
              kutu.appendChild(h('div', 'small muted', 'Karşılaştırma alınamadı: ' +
                (err && err.message ? err.message : String(err))))
              yuklendi = false
            }
          })
          satir.appendChild(sag)
          el.appendChild(satir)
          el.appendChild(kutu)
          continue
        }
        satir.appendChild(sag)
        el.appendChild(satir)
      }
    }
    return
  }

  // ORNEKLEM ROZETI: 5 kayitlik bir oran ile 40 kayitlik oran ayni
  // gorunmesin. Olculdu: gosterilen oran gerceklesenden ortalama 16,6 puan
  // yuksek ve orneklem kucukken sapma buyuyor.
  const rozet = ornekRozeti(signal.matchCount)
  if (rozet) {
    const uyari = uyariKutusu('Örneklem küçük (' + tam(signal.matchCount) +
      ' benzer kayıt): ' + rozet.metin + '. Bu orandaki belirsizlik yüksektir.')
    uyari.style.color = rozet.sinif === 'down'
      ? 'var(--down, ' + RENK.down + ')'
      : 'var(--warn, ' + RENK.warn + ')'
    el.appendChild(uyari)
  }

  const sayimlar = sinyalSayilari(signal)
  const aralik = sinyalAraligi(signal)
  const basabas = basabasOran(signal.rr)
  const oranSinifi = aralikSinifi(aralik, basabas)

  el.appendChild(statIzgara([
    // Ana sayi artik "kacindan kaci": tek basina yuzde, orneklem buyuklugunu
    // gizliyordu.
    stat('Tuttu', sayimlar ? tam(sayimlar.k) + '/' + tam(sayimlar.n) : '-', oranSinifi),
    stat('Oran', formatPercent(signal.winRate, 0), oranSinifi),
    stat('%95 aralık',
      aralik ? formatPercent(aralik.lo, 0) + ' - ' + formatPercent(aralik.hi, 0) : '-'),
    stat('Başabaş', formatPercent(basabas, 0)),
  ]))

  // KALIBRE ORAN ILE HAM ORAN AYRI. Gosterilen oran havuz tabanina dogru
  // cekilmis oranlardir (bkz. S1); ham oran bilgi olarak durur.
  if (Number.isFinite(Number(signal.winRateRaw)) &&
      Math.abs(Number(signal.winRateRaw) - sayi(signal.winRate, 0)) > 1e-9) {
    el.appendChild(kv('Ham oran (kalibrasyon öncesi)', formatPercent(signal.winRateRaw, 1)))
  }
  if (Number.isFinite(Number(signal.baseRate))) {
    const fark = sayi(signal.winRate, 0) - Number(signal.baseRate)
    el.appendChild(kv('Bu türün havuz tabanı',
      formatPercent(signal.baseRate, 1) + ', fark ' +
      (fark >= 0 ? '+' : '') + formatNumber(fark * 100, 1) + ' puan',
      Math.abs(fark) < 0.005 ? 'muted' : (fark > 0 ? 'up' : 'down')))
  }

  // "Guven skoru" KALDIRILDI: bir olasilik degil, uc bilesenin agirlikli
  // toplamiydi ve olculdu, guven yukseldikce GERCEKLESEN oran dusuyordu.
  // Bilgi amacli, ikincil bir satir olarak duruyor.
  el.appendChild(kv('Kanıt puanı (olasılık değil)', formatPercent(signal.confidence, 0), 'muted'))
  el.appendChild(kv('En yüksek benzerlik', formatNumber(signal.bestSimilarity, 3)))
  // "Beklenen" kelimesi bir tahmin gibi okunuyordu; sayi aslinda benzer
  // kayitlarin SONUCA KADAR olan ortalama hareketidir. Plan riski (SL
  // mesafesi) ayri satirda: bir donem ikisi ayni etiketle gosteriliyordu.
  el.appendChild(kv('Benzerlerde sonuca kadar ortalama lehte hareket',
    formatNumber(signal.expectedMfeAtr, 2) + ' ATR'))
  el.appendChild(kv('Benzerlerde sonuca kadar ortalama aleyhte hareket',
    formatNumber(signal.expectedMaeAtr, 2) + ' ATR'))
  const planRiski = Number.isFinite(Number(signal.planRiskAtr))
    ? Number(signal.planRiskAtr)
    : Number(signal.slAtr)
  if (Number.isFinite(planRiski) && planRiski > 0) {
    el.appendChild(kv('Plan riski (SL mesafesi)', formatNumber(planRiski, 2) + ' ATR'))
  }
  el.appendChild(kv('Bölge aralığı', formatPrice(signal.zoneBottom) + ' - ' + formatPrice(signal.zoneTop)))
  el.appendChild(kv('Sinyal türü', signal.kind === 'form'
    ? 'Kutu oluşumu, giriş onay barının kapanışı'
    : 'Bölgeye geri dönüş, karar bar kapanışında, giriş sonraki barlarda bölge kenarına limit'))
  el.appendChild(kv('Durum', signal.fired ? 'Sinyal üretildi' : 'Eşikler geçilmedi',
    signal.fired ? 'up' : 'muted'))

  // UST ZAMAN DILIMI BAGLAMI: BILGI, sinyale katilmaz. Olculdu (15m olaylari,
  // 4h bolgeleri, dogru zamanlamayla): ayni yonlu ust bolge yakinindaki olusum
  // olaylari %30,3 tutuyor, tabani %42,8. Yani katki yok, hatta ters yonde;
  // bu yuzden satir bir tavsiye degil bir gozlem olarak duruyor.
  if (signal.htf && signal.htf.state) {
    el.appendChild(kv(String(signal.htf.tf || 'Üst TF') + ' bölgesi',
      String(signal.htf.state) + (signal.htf.inside ? ' (bölge içinde)' : '') +
      ' - bilgi, sinyale katılmaz', 'muted'))
  }

  // YUKSEK ETKILI VERI: kapi kapali olsa bile uyari gosterilir. Bolgeler bu
  // anlarda daha hizli kiriliyor (olculdu, ama orneklem kucuk ve araliklar
  // ortusuyor), yani bu bir kanit degil bir dikkat notudur.
  if (signal.news && Number.isFinite(signal.news.deltaMin) && Math.abs(signal.news.deltaMin) <= 60) {
    const dk = Math.round(signal.news.deltaMin)
    const metin = 'Yüksek etkili veri: ' + String(signal.news.code || 'veri') + ' ' +
      (dk >= 0 ? dk + ' dk sonra' : (-dk) + ' dk önce') +
      (signal.newsBlocked ? ' (sinyal bu yüzden üretilmedi)' : '')
    const uyari = uyariKutusu(metin)
    uyari.style.color = 'var(--warn, ' + RENK.warn + ')'
    el.appendChild(uyari)
  }

  // KANIT DURUMU: bu turun katma degeri son olcumde kanitlandi mi. Bu satir
  // olmadan her sinyal ayni guvenle okunuyordu.
  if (signal.evidence) {
    const k = signal.evidence
    const metin = k.status === 'kanitli'
      ? 'Kanıtlı: son ölçümde bu türün net beklentisi sıfırın üstünde'
      : (k.status === 'zayif'
        ? 'Zayıf: nokta tahmin pozitif ama %95 aralık sıfırı içeriyor'
        : 'Kanıt yok: son ölçümde bu türün katma değeri gösterilemedi')
    el.appendChild(kv('Kanıt durumu', metin,
      k.status === 'kanitli' ? 'up' : (k.status === 'zayif' ? 'muted' : 'down')))
    if (Number.isFinite(k.netR)) {
      el.appendChild(kv('Ölçümde bu tür',
        tam(k.n) + ' işlem, net ' + formatNumber(k.netR, 3) + ' R' +
        (Number.isFinite(k.netRLo)
          ? ' (%95 aralık ' + formatNumber(k.netRLo, 3) + ' ile ' + formatNumber(k.netRHi, 3) + ')'
          : ''), 'muted'))
    }
  }

  // Gercek sonuc. Geriye testte uretilen sinyallerde bellidir; canli
  // sinyallerde henuz olusmadigi icin bolum hic cizilmez.
  const sonuc = sonucBilgisi(signal)
  if (sonuc.hazir) {
    el.appendChild(bolumBasligi('Gerçekleşen sonuç'))
    el.appendChild(statIzgara([
      stat('Sonuç', sonuc.etiket, sonuc.sinif),
      stat('Net kazanç', (sayi(signal.pnlAtr, 0) >= 0 ? '+' : '') +
        formatNumber(signal.pnlAtr, 3) + ' ATR', sayi(signal.pnlAtr, 0) >= 0 ? 'up' : 'down'),
    ]))
    el.appendChild(kv('Bölgenin durumu', outcomeAdi(signal.outcome),
      signal.outcome === 'respect' ? 'up' : (signal.outcome === 'break' ? 'down' : 'muted')))
    const barSayisi = sayi(signal.barsToOutcome, -1)
    el.appendChild(kv('Sonuca kadar geçen bar', barSayisi >= 0 ? tam(barSayisi) : 'ufuk doldu'))
    // "Bolge tuttu" ile "islem kazandi" ayni sey degil; fark gorunur kalsin.
    if (signal.outcome === 'respect' && signal.win === false) {
      el.appendChild(h('div', 'small muted',
        'Bölge tuttu ama fiyat plandaki TP1 seviyesine ulaşmadı, o yüzden işlem kazanç sayılmadı.'))
    }
  }

  // PROTOTIP SATIRLARI KALDIRILDI: sekil kumelerinin basari orani tabandan
  // ayirt edilemiyordu, "En yakin ortak yapi" satiri olmayan bir dayanak
  // hissi veriyordu. Kumeler yalnizca Hafiza panelinde bilgi olarak duruyor.

  // Islem plani
  el.appendChild(bolumBasligi('İşlem planı'))
  const giris = sayi(signal.entry, 0)
  function uzaklik(p) {
    if (!Number.isFinite(p) || p === 0 || giris === 0) return '-'
    const fark = p - giris
    const yuzde = (fark / giris) * 100
    return (fark >= 0 ? '+' : '') + formatPrice(fark) + ' (' + (yuzde >= 0 ? '+' : '') + formatNumber(yuzde, 2) + '%)'
  }
  const planSatirlari = [
    ['Giriş', formatPrice(giris), '-'],
    ['TP1', formatPrice(signal.tp1), uzaklik(sayi(signal.tp1, NaN))],
  ]
  // TP2 UYDURULMAZ: yeterli sayida tutmus benzer kayit yoksa satir hic
  // gosterilmez. Eski davranis TP2'yi sessizce TP1'e esitliyordu ve ekranda
  // ayni fiyat iki kez goruluyordu.
  const tp2Deger = Number(signal.tp2)
  if (Number.isFinite(tp2Deger) && tp2Deger > 0) {
    planSatirlari.push(['TP2 (uzatma)', formatPrice(tp2Deger), uzaklik(tp2Deger)])
  }
  planSatirlari.push(['SL', formatPrice(signal.sl), uzaklik(sayi(signal.sl, NaN))])
  planSatirlari.push(['RR', formatNumber(signal.rr, 2), '-'])
  el.appendChild(tablo(['Seviye', 'Fiyat', 'Girişe uzaklık'], planSatirlari))
  if (!(Number.isFinite(tp2Deger) && tp2Deger > 0)) {
    el.appendChild(h('div', 'small muted',
      'Uzatma hedefi (TP2) yok: yeterli sayıda tutmuş benzer kayıt bulunamadı.'))
  }

  // POZISYON: stop mesafesini dolara ve lota cevirir.
  //
  // Turler arasinda risk UC KAT farkli (olculdu: olusum ortalama 2,02-2,10
  // ATR, dokunus 0,68-0,75 ATR). Sabit lotla acan kullanici olusumda uc kat
  // fazla risk aliyordu. Hesaplayici yalnizca riski SINIRLAR; basari oranina
  // gore lot buyutmez, cunku sistem henuz pozitif net beklenti uretmiyor.
  pozisyonBolumu(el, signal, o.risk)

  // Gerekceler
  el.appendChild(bolumBasligi('Gerekçeler'))
  const nedenler = Array.isArray(signal.reasons) ? signal.reasons : []
  if (nedenler.length === 0) {
    el.appendChild(h('div', 'small muted', 'Gerekçe kaydı yok.'))
  } else {
    for (let i = 0; i < nedenler.length; i++) {
      el.appendChild(h('div', 'small muted', '- ' + String(nedenler[i])))
    }
  }

  // Benzer gecmis ornekler
  const eslesmeler = Array.isArray(signal.topMatches) ? signal.topMatches : []
  const toplamEslesme = sayi(signal.matchCount, eslesmeler.length)
  el.appendChild(bolumBasligi('En benzer ' + tam(eslesmeler.length) +
    (toplamEslesme > eslesmeler.length ? ' / ' + tam(toplamEslesme) : '') + ' geçmiş örnek'))
  if (eslesmeler.length === 0) {
    el.appendChild(h('div', 'small muted', 'Eşik üstünde benzer kayıt bulunamadı.'))
    return
  }

  const cizimler = []
  const ornegeGit = typeof o.onMatchSelect === 'function' ? o.onMatchSelect : null
  const karsilastir = typeof o.onMatchCompare === 'function' ? o.onMatchCompare : null

  for (let i = 0; i < eslesmeler.length; i++) {
    const m = eslesmeler[i]
    const satir = h('div', 'row' + (ornegeGit ? ' clickable' : ''))
    if (ornegeGit) {
      satir.title = 'Grafikte bu örneğe git'
      tiklamaBagla(satir, ornegeGit, m)
    } else {
      satir.style.cursor = 'default'
    }

    const sol = h('span', 'row-side')
    sol.appendChild(h('span', null, formatDate(m.time)))
    sol.appendChild(h('span', 'row-sub', formatTime(m.time)))
    satir.appendChild(sol)

    const orta = h('span', 'row-main grow')
    const cnv = document.createElement('canvas')
    cnv.className = 'spark'
    orta.appendChild(cnv)
    satir.appendChild(orta)

    const sag = h('span', 'row-side')
    sag.appendChild(h('span', null, formatNumber(m.similarity, 3)))
    // UC DEGERLI SONUC: zaman asimi "Kirilim" degildir. 15m'de form
    // basarisizliklarinin %26'si zaman asimi, yani bolge kirilmadi.
    const sonuc = sonucEtiketi(m)
    sag.appendChild(h('span', 'row-sub ' + sonuc.sinif, sonuc.ad))
    // Lehte / aleyhte sayilar da sonuca kadarki olcuden gelir (varsa).
    const lehte = Number.isFinite(Number(m.mfeExitAtr)) ? Number(m.mfeExitAtr) : sayi(m.mfeAtr, 0)
    const aleyhte = Number.isFinite(Number(m.maeExitAtr)) ? Number(m.maeExitAtr) : sayi(m.maeAtr, 0)
    sag.appendChild(h('span', 'row-sub',
      '+' + formatNumber(Math.abs(lehte), 2) + ' / -' + formatNumber(Math.abs(aleyhte), 2)))
    satir.appendChild(sag)

    el.appendChild(satir)

    // NEYE GORE BENZETTI: AYRI BIR DUGME.
    //
    // Satira tiklamak grafigi ORNEGIN tarihine goturur. Karsilastirma ise
    // SINYALIN yerinde cizilir (iki egri ayni yerde olmali ki karsilastirma
    // anlamli olsun). Ikisini ayni tiklamaya baglamak, grafigi once bir yere
    // goturup sonra baska bir yere cekmek olurdu; bu yuzden ayri dugme.
    if (karsilastir) {
      const kutu = h('div', 'match-compare')
      kutu.hidden = true
      const dugme = h('button', 'btn mini compare-btn', 'Neye göre?')
      dugme.type = 'button'
      dugme.title = 'Bu örnekle şimdiki kurulumun şekillerini grafik üzerinde karşılaştır'
      sag.appendChild(dugme)
      let yuklendi = false
      dugme.addEventListener('click', async (olay) => {
        // Satirin "ornege git" davranisi tetiklenmesin.
        olay.stopPropagation()
        if (!kutu.hidden) {
          kutu.hidden = true
          dugme.classList.remove('active')
          try { karsilastir(signal, null) } catch (err) { /* onemsiz */ }
          return
        }
        kutu.hidden = false
        dugme.classList.add('active')
        if (yuklendi) {
          // Egriler grafikten silinmis olabilir, yeniden ciz.
          try { karsilastir(signal, m) } catch (err) { /* onemsiz */ }
          return
        }
        yuklendi = true
        kutu.appendChild(h('div', 'small muted', 'Karşılaştırma hazırlanıyor...'))
        try {
          const veri = await karsilastir(signal, m)
          bosalt(kutu)
          if (veri) karsilastirmayiCiz(kutu, veri, signal, m)
          else kutu.appendChild(h('div', 'small muted', 'Karşılaştırma alınamadı.'))
        } catch (err) {
          bosalt(kutu)
          kutu.appendChild(h('div', 'small muted',
            'Karşılaştırma alınamadı: ' + (err && err.message ? err.message : String(err))))
          yuklendi = false
        }
      })
      el.appendChild(kutu)
    }

    const seri = eslesmeSerisi(m)
    cizimler.push({ cnv, seri, basarili: sonuc.sinif === 'up', notr: sonuc.sinif === 'muted' })
  }

  // Canvas olculeri yerlesim sonrasi bellidir, cizimi simdi yap.
  for (let i = 0; i < cizimler.length; i++) {
    const c = cizimler[i]
    drawSparkline(c.cnv, c.seri.degerler, {
      color: c.notr ? RENK.dim : (c.basarili ? RENK.up : RENK.down),
      fill: c.notr
        ? 'rgba(128,128,128,0.10)'
        : (c.basarili ? 'rgba(38,166,154,0.14)' : 'rgba(239,83,80,0.14)'),
      markerIndex: c.seri.isaret,
      baseline: 0,
    })
  }

  const notlar = ['Mini grafikler seyir taslağıdır: kesik dikey çizgi sinyal anını, ' +
    'sonrası lehte ve aleyhte azami hareketi gösterir.']
  if (ornegeGit) notlar.push('Bir örneğe tıklayınca grafik o tarihe gider.')
  if (karsilastir) {
    notlar.push('"Neye göre?" düğmesi şekilleri GRAFİK ÜZERİNDE karşılaştırır: ' +
      'yeşil çizgi şimdiki kurulum, sarı kesikli çizgi seçilen örnek. ' +
      'Noktalar ikişer barın ortalamasıdır, yani eğri mumlarla bire bir örtüşmez.')
  }
  for (let i = 0; i < notlar.length; i++) {
    el.appendChild(h('div', 'small muted', notlar[i]))
  }
}

/**
 * "NEYE GORE BENZETTI" karsilastirmasini cizer.
 *
 * Uc parca: iki sekil egrisi ust uste, benzerlik dokumu (hangi bilesen hangi
 * agirlikla toplama katildi) ve baglam degerlerinin yan yana karsilastirmasi.
 *
 * Agirligi SIFIR olan bilesenler de gosterilir, ama katkisi "-" yazilir:
 * kullanici hem neye bakildigini hem neye BAKILMADIGINI gormeli.
 *
 * @param {HTMLElement} kap
 * @param {object} veri engine:compare ciktisi
 * @param {object} signal
 * @param {object} eslesme
 */
function karsilastirmayiCiz(kap, veri, signal, eslesme) {
  const w = veri.weights || { shape: 0, ctx: 0, dtw: 0 }
  const c = veri.components || { shape: 0, ctx: 0, dtw: 0, total: 0 }

  // 1) Egriler GRAFIGE cizilir, burada yalnizca efsane durur.
  //
  // Once bu kutuda kucuk bir grafik ciziliyordu ve kullanici onu asil
  // grafikle bagdastiramiyordu: sekil vektoru mumlarin birebir kopyasi
  // degil, yumusatilmis ve 16 kovaya indirgenmis halidir. Iki ayri resmi
  // zihinde ust uste koymak gerekiyordu. Artik egriler gercek mumlarin
  // uzerinde, kendi fiyatlarinda ciziliyor.
  const efsane = h('div', 'small muted')
  efsane.appendChild(h('span', 'compare-key now', '\u25ac'))
  efsane.appendChild(document.createTextNode(' şimdi (' + formatDateTime(signal.time) + ')  '))
  efsane.appendChild(h('span', 'compare-key past', '\u25ac'))
  efsane.appendChild(document.createTextNode(' örnek (' + formatDateTime(eslesme.time) + ')'))
  kap.appendChild(efsane)
  kap.appendChild(h('div', 'small muted',
    'Eğriler grafiğin üzerinde çizildi. Her nokta ikişer barın ortalamasıdır, ' +
    'bu yüzden eğri mumlarla bire bir örtüşmez.'))

  // 2) Benzerlik dokumu.
  const satirlar = [
    ['Şekil (görsel eğri)', c.shape, w.shape],
    ['Bağlam (24 değer)', c.ctx, w.ctx],
    ['Getiri dizisi', c.dtw, w.dtw],
  ].map(([ad, deger, agirlik]) => [
    ad,
    formatNumber(deger, 3),
    formatPercent(agirlik, 0),
    agirlik > 0 ? formatNumber(deger * agirlik, 3) : '-',
  ])
  satirlar.push(['TOPLAM BENZERLİK', '', '', formatNumber(c.total, 3)])
  kap.appendChild(tablo(['Bileşen', 'Değer', 'Ağırlık', 'Katkı'], satirlar))

  // 3) Baglam degerleri yan yana. Agirligi sifir olsa bile neyin tuttugunu
  //    gormek isteyen olur; en cok AYRISAN alanlar basa alinir.
  const adlar = Array.isArray(veri.ctxNames) ? veri.ctxNames : []
  const a = Array.isArray(veri.a && veri.a.ctx) ? veri.a.ctx : []
  const b = Array.isArray(veri.b && veri.b.ctx) ? veri.b.ctx : []
  if (adlar.length > 0 && a.length === adlar.length && b.length === adlar.length) {
    const kayitlar = []
    for (let i = 0; i < adlar.length; i++) {
      const fark = Math.abs(sayi(a[i], 0) - sayi(b[i], 0))
      kayitlar.push({ ad: adlar[i], a: a[i], b: b[i], fark: fark })
    }
    kayitlar.sort((x, y) => y.fark - x.fark)
    const gosterilen = kayitlar.slice(0, 8).map((k) => [
      CTX_ETIKET[k.ad] || k.ad,
      formatNumber(k.a, 2),
      formatNumber(k.b, 2),
      formatNumber(k.fark, 2),
    ])
    kap.appendChild(h('div', 'small muted', 'EN ÇOK AYRIŞAN BAĞLAM DEĞERLERİ'))
    kap.appendChild(tablo(['Değer', 'Şimdi', 'Örnek', 'Fark'], gosterilen))
  }

}

/* ------------------------------------------------------------------ */
/* renderZones                                                         */
/* ------------------------------------------------------------------ */

/**
 * Bolge listesini cizer.
 * @param {HTMLElement} el Liste kabi (ornek: #zoneList)
 * @param {Array<object>} zones
 * @param {{onSelect?:(z:object)=>void, selectedId?:*, filter?:string, now?:number}} [opts]
 */
export function renderZones(el, zones, opts) {
  if (!el) return
  const o = opts || {}
  bosalt(el)

  const hepsi = Array.isArray(zones) ? zones.slice() : []
  hepsi.sort((a, b) => sayi(b && b.createdTime, 0) - sayi(a && a.createdTime, 0))

  // U7: "Aktif" gercekten aktif olani gostersin.
  //
  // Onceden yalnizca `!broken` bakiliyordu, ama bir kutu kirilmadan da olur:
  // Pine kutusu belirli bir bar sayisi yasar ve suresi dolunca artik
  // fiyatla ilgisi kalmaz. Bunlar "Aktif" listesinde duruyordu ve kullanici
  // aylar once sonlanmis bir destegi bugun gecerliymis gibi okuyordu.
  const simdi = (o.now === null || o.now === undefined || !Number.isFinite(Number(o.now)))
    ? null
    : Number(o.now)
  /** Kutunun omru, gorulen son bardan once dolduysa true. */
  const suresiDoldu = (z) => (
    !z.broken && simdi !== null &&
    Number.isFinite(Number(z.endTime)) && Number(z.endTime) < simdi
  )

  const suzgec = o.filter || 'all'
  const liste = hepsi.filter((z) => {
    if (!z) return false
    if (suzgec === 'active') return !z.broken && !suresiDoldu(z)
    if (suzgec === 'broken') return !!z.broken
    if (suzgec === 'support') return !!z.isSupport
    if (suzgec === 'resistance') return !z.isSupport
    return true
  })

  if (liste.length === 0) {
    el.appendChild(bosKutu(hepsi.length === 0
      ? 'Görünür aralıkta bölge yok. Önce tarama yapın.'
      : 'Bu süzgeçle gösterilecek bölge yok.'))
    return
  }

  const adet = Math.min(liste.length, AZAMI_SATIR)
  for (let i = 0; i < adet; i++) {
    const z = liste[i]
    const destek = !!z.isSupport
    const bitti = suresiDoldu(z)
    const satir = h('div', 'row ' + (destek ? 'buy' : 'sell') + (z.broken || bitti ? ' dim' : '') +
      (o.selectedId !== undefined && o.selectedId !== null && String(z.id) === String(o.selectedId) ? ' selected' : ''))

    satir.appendChild(h('span', 'tag ' + (destek ? 'buy' : 'sell'), destek ? 'DESTEK' : 'DİRENÇ'))

    const orta = h('span', 'row-main')
    orta.appendChild(document.createTextNode(formatPrice(z.bottom) + ' - ' + formatPrice(z.top)))
    orta.appendChild(h('span', 'row-sub',
      formatDateTime(z.createdTime) + '  akış ' + formatNumber(z.flow, 2)))
    satir.appendChild(orta)

    const sag = h('span', 'row-side')
    const durumSinifi = (z.broken || bitti) ? 'muted' : (destek ? 'up' : 'down')
    const durumMetni = z.broken ? 'Kırıldı' : (bitti ? 'Süresi doldu' : 'Aktif')
    sag.appendChild(h('span', durumSinifi, durumMetni))
    sag.appendChild(h('span', 'row-sub', tam(z.touchCount) + ' dokunuş'))
    satir.appendChild(sag)

    tiklamaBagla(satir, o.onSelect, z)
    el.appendChild(satir)
  }

  if (liste.length > adet) {
    el.appendChild(h('div', 'empty small',
      tam(liste.length - adet) + ' bölge daha var, süzgeci daraltın.'))
  }
}

/* ------------------------------------------------------------------ */
/* renderMemory                                                        */
/* ------------------------------------------------------------------ */

/**
 * Hafiza ozetini ve ortak yapilari cizer.
 * @param {HTMLElement} el Govde kabi (ornek: #panelMemory .panel-body)
 * @param {object} summary   memory.summarize ciktisi
 * @param {Array<object>} prototypes  cluster.buildPrototypes ciktisi
 */
export function renderMemory(el, summary, prototypes) {
  if (!el) return
  bosalt(el)

  const s = summary || null
  const protolar = Array.isArray(prototypes) ? prototypes : []

  if (!s || sayi(s.total, 0) === 0) {
    el.appendChild(bosKutu('Hafıza boş. "Geçmişi Tara" ile geçmiş bölge olaylarını öğrenin.'))
    return
  }

  el.appendChild(bolumBasligi('Özet' + (s.tf ? ' (' + String(s.tf) + ')' : '')))
  el.appendChild(statIzgara([
    stat('Toplam olay', tam(s.total)),
    stat('Etiketlenmiş', tam(s.labeled)),
    stat('Başarı oranı', formatPercent(s.winRate, 1), sayi(s.winRate, 0) >= 0.5 ? 'up' : 'down'),
    stat('Saygı', tam(s.success), 'up'),
    stat('Kırılım', tam(s.fail), 'down'),
    stat('Zaman aşımı', tam(s.timeout), 'muted'),
  ]))
  el.appendChild(kv('Kapsanan aralık', formatDate(s.firstTime) + ' - ' + formatDate(s.lastTime)))
  el.appendChild(kv('Ortalama lehte hareket', formatNumber(s.avgMfeAtr, 2) + ' ATR'))
  el.appendChild(kv('Ortalama aleyhte hareket', formatNumber(s.avgMaeAtr, 2) + ' ATR'))

  // Yon dagilimi
  el.appendChild(bolumBasligi('Yön dağılımı'))
  const yonlar = s.byDirection || {}
  const yonAdlari = { BUY: 'AL (destek)', SELL: 'SAT (direnç)' }
  const yonSatirlari = []
  for (const anahtar of ['BUY', 'SELL']) {
    const b = yonlar[anahtar]
    if (!b) continue
    yonSatirlari.push([yonAdlari[anahtar], tam(b.total), tam(b.success), tam(b.fail), formatPercent(b.winRate, 1)])
  }
  el.appendChild(yonSatirlari.length
    ? tablo(['Yön', 'Toplam', 'Saygı', 'Kırılım', 'Oran'], yonSatirlari)
    : h('div', 'small muted', 'Yön dağılımı yok.'))

  // Olay turu dagilimi
  el.appendChild(bolumBasligi('Olay türü dağılımı'))
  const turler = s.byKind || {}
  const turSatirlari = []
  for (const anahtar of ['form', 'touch']) {
    const b = turler[anahtar]
    if (!b) continue
    turSatirlari.push([turAdi(anahtar), tam(b.total), tam(b.success), tam(b.fail), formatPercent(b.winRate, 1)])
  }
  el.appendChild(turSatirlari.length
    ? tablo(['Tür', 'Toplam', 'Saygı', 'Kırılım', 'Oran'], turSatirlari)
    : h('div', 'small muted', 'Tür dağılımı yok.'))

  // SKOR BILESENLERI: her bilesen gercekten ayirt ediyor mu.
  //
  // Skor "eşik geçti" etiketini uretiyor ama bilesenlerin ayirt edip etmedigi
  // hic olculmemisti. Tablo her bilesen icin bilesenin DOGRU oldugu ve
  // OLMADIGI olaylarin oranini yan yana koyar; son sutun iki %95 araliginin
  // ortusup ortusmedigini soyler.
  const parcalar = s.byPart || null
  if (parcalar) {
    el.appendChild(bolumBasligi('Skor bileşenleri (gerçekten ayırt ediyor mu)'))
    // Tur basina AYRI tablo: her satira "Kutu olusumu - " onekini koymak yan
    // paneldeki dar tabloyu tasiriyordu.
    let parcaVar = false
    for (const tur of ['form', 'touch']) {
      const grup = parcalar[tur]
      if (!grup) continue
      const parcaSatirlari = []
      for (const ad of Object.keys(grup)) {
        const g = grup[ad]
        if (!g || !g.evet || !g.hayir) continue
        if (g.evet.total === 0 || g.hayir.total === 0) continue
        const fark = Number.isFinite(g.diffPts)
          ? (g.diffPts >= 0 ? '+' : '') + formatNumber(g.diffPts, 1)
          : '-'
        // Yan panel dar: sutunlar KISA tutulur, ornek sayisi bilesen adinin
        // yanindadir ve hukum farkin yanina sigar.
        parcaSatirlari.push([
          (PARCA_ADLARI[ad] || ad) + ' (' + tam(g.evet.total) + ')',
          formatPercent(g.evet.winRate, 1),
          formatPercent(g.hayir.winRate, 1),
          fark + (g.separates ? (g.diffPts >= 0 ? '*' : ' TERS') : ''),
        ])
      }
      if (parcaSatirlari.length === 0) continue
      parcaVar = true
      el.appendChild(h('div', 'small muted', turAdi(tur)))
      el.appendChild(tablo(['Bileşen', 'Var', 'Yok', 'Fark'], parcaSatirlari))
    }
    if (!parcaVar) {
      el.appendChild(h('div', 'small muted', 'Bileşen kırılımı yok, hafızayı yeniden tarayın.'))
    }
    el.appendChild(h('div', 'small muted',
      'Bileşen adının yanındaki sayı, bileşenin doğru olduğu olay sayısıdır. Son sütun iki ' +
      '%95 Wilson aralığının örtüşüp örtüşmediğine bakar: işaretsiz fark, aralıklar örtüştüğü ' +
      'için "bir şey söylemiyor" demektir; * ayırt ettiğini, TERS ise bileşen doğru olduğunda ' +
      'sonucun daha KÖTÜ olduğunu gösterir. Skor sinyal kararına girmez, bilgi amaçlıdır.'))
  }

  // Seans dagilimi
  el.appendChild(bolumBasligi('Seans dağılımı'))
  const seanslar = s.bySession || {}
  const seansSatirlari = []
  const seansAnahtarlari = Object.keys(seanslar)
  for (let i = 0; i < seansAnahtarlari.length; i++) {
    const ad = seansAnahtarlari[i]
    const b = seanslar[ad]
    if (!b || sayi(b.total, 0) === 0) continue
    seansSatirlari.push([SEANS_ADLARI[ad] || ad, tam(b.total), tam(b.success), tam(b.fail), formatPercent(b.winRate, 1)])
  }
  el.appendChild(seansSatirlari.length
    ? tablo(['Seans', 'Toplam', 'Saygı', 'Kırılım', 'Oran'], seansSatirlari)
    : h('div', 'small muted', 'Seans dağılımı yok.'))

  // Yillara gore
  el.appendChild(bolumBasligi('Yıllara göre'))
  const yillar = Array.isArray(s.byYear) ? s.byYear : []
  if (yillar.length === 0) {
    el.appendChild(h('div', 'small muted', 'Yıl kırılımı yok.'))
  } else {
    const satirlar = []
    for (let i = 0; i < yillar.length; i++) {
      const y = yillar[i]
      satirlar.push([
        yil(y.year), tam(y.total), tam(y.success), tam(y.fail),
        formatPercent(y.winRate, 1), formatNumber(y.avgMfeAtr, 2), formatNumber(y.avgMaeAtr, 2),
      ])
    }
    el.appendChild(tablo(['Yıl', 'Toplam', 'Saygı', 'Kırılım', 'Oran', 'Ort. MFE', 'Ort. MAE'], satirlar))
  }

  // SEKIL KUMELERI: BILGI AMACLI, SINYALE KATILMAZ.
  //
  // Olculdu: kumelerin basari orani hafiza tabanindan ayirt edilemiyor
  // (15m'de sekiz kumenin orani %31,2 - %35,5, taban %33,4). Once bu satirlar
  // "gercekten ise yaramis kalip" diye sunuluyordu; simdi her kumenin yaninda
  // tabana gore fark yaziyor ve renk yalnizca fark guven araliginin disinda
  // kalirsa kullaniliyor.
  el.appendChild(bolumBasligi('Şekil kümeleri (' + tam(protolar.length) + ', tahmin gücü yok)'))
  if (protolar.length === 0) {
    el.appendChild(h('div', 'small muted', 'Şekil kümesi çıkarılmadı, tarama sonrası oluşur.'))
    return
  }
  const hafizaTabani = sayi(s.winRate, NaN)
  el.appendChild(h('div', 'small muted',
    'Kümeler sinyal kararına katılmaz. Karşılaştırma tabanı, hafızanın tamamının ' +
    'tutma oranı: ' + (Number.isFinite(hafizaTabani) ? formatPercent(hafizaTabani, 1) : '-') + '.'))

  const cizimler = []
  for (let i = 0; i < protolar.length; i++) {
    const p = protolar[i]
    const kutu = h('div', 'stat')
    kutu.style.marginBottom = '5px'

    // Fark anlamli mi: kumenin Wilson araligi hafiza tabanini ICERIYORSA
    // "fark yok" demektir ve renk kullanilmaz.
    const etiketli = sayi(p.labeled, 0)
    const kazanan = sayi(p.wins, 0)
    const aralik = etiketli > 0 ? wilsonAralik(kazanan, etiketli) : null
    const ayirdedici = !!(aralik && Number.isFinite(hafizaTabani) &&
      (aralik.lo > hafizaTabani || aralik.hi < hafizaTabani))
    const fark = Number.isFinite(hafizaTabani) ? (sayi(p.winRate, 0) - hafizaTabani) * 100 : NaN

    const bas = h('div', 'kv')
    bas.appendChild(h('span', null, p.label ? String(p.label) : ('Küme #' + tam(p.id))))
    const sinif = ayirdedici ? (fark >= 0 ? 'up' : 'down') : 'muted'
    bas.appendChild(h('span', sinif, formatPercent(p.winRate, 0) +
      (Number.isFinite(fark) ? '  (' + (fark >= 0 ? '+' : '') + formatNumber(fark, 1) + ' puan)' : '')))
    kutu.appendChild(bas)

    const cnv = document.createElement('canvas')
    cnv.className = 'spark'
    kutu.appendChild(cnv)

    kutu.appendChild(h('div', 'row-sub',
      tam(p.size) + ' üye, lehte ' + formatNumber(p.avgMfeAtr, 2) +
      ' ATR, aleyhte ' + formatNumber(p.avgMaeAtr, 2) + ' ATR' +
      (aralik ? ', %95 aralık ' + formatPercent(aralik.lo, 1) + ' - ' + formatPercent(aralik.hi, 1) : '') +
      (ayirdedici ? '' : ', taban ile fark yok')))
    el.appendChild(kutu)

    const merkez = p.centroid
    const degerler = []
    if (merkez && merkez.length) {
      for (let j = 0; j < merkez.length; j++) degerler.push(sayi(merkez[j], NaN))
    }
    cizimler.push({ cnv, degerler, ayirdedici: ayirdedici, iyi: fark >= 0 })
  }
  for (let i = 0; i < cizimler.length; i++) {
    const c = cizimler[i]
    drawSparkline(c.cnv, c.degerler, {
      color: c.ayirdedici ? (c.iyi ? RENK.up : RENK.down) : RENK.dim,
      fill: c.ayirdedici
        ? (c.iyi ? 'rgba(38,166,154,0.14)' : 'rgba(239,83,80,0.14)')
        : 'rgba(128,128,128,0.10)',
      lineWidth: 1.5,
    })
  }
}

/**
 * Wilson %95 araligi (arayuz kopyasi).
 *
 * Cekirdekteki learn/stats.js CommonJS'tir ve renderer ESM oldugu icin
 * dogrudan yuklenemez; formul tek satirlik oldugu icin burada tekrarlaniyor.
 * Degistirirken iki dosya birlikte degismeli.
 *
 * @param {number} k Kazanan sayisi
 * @param {number} n Toplam
 * @returns {{lo:number, hi:number}|null}
 */
function wilsonAralik(k, n) {
  if (!(n > 0)) return null
  const z = 1.959963984540054
  const p = k / n
  const z2 = z * z
  const merkez = p + z2 / (2 * n)
  const yayilim = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  const bolen = 1 + z2 / n
  const lo = (merkez - yayilim) / bolen
  const hi = (merkez + yayilim) / bolen
  return { lo: lo < 0 ? 0 : lo, hi: hi > 1 ? 1 : hi }
}

/* ------------------------------------------------------------------ */
/* renderSettings                                                      */
/* ------------------------------------------------------------------ */

/** Nokta ile ayrilmis yoldan deger okur. */
function yoldanOku(nesne, yol) {
  const parcalar = String(yol).split('.')
  let cur = nesne
  for (let i = 0; i < parcalar.length; i++) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[parcalar[i]]
  }
  return cur
}

/** Nokta ile ayrilmis yola deger yazar, ara nesneleri olusturur. */
function yolaYaz(nesne, yol, deger) {
  const parcalar = String(yol).split('.')
  let cur = nesne
  for (let i = 0; i < parcalar.length - 1; i++) {
    const p = parcalar[i]
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[parcalar[parcalar.length - 1]] = deger
  return nesne
}

/** Nokta ile ayrilmis yoldaki degeri siler, bosalan ara nesneleri de temizler. */
function yoldanSil(nesne, yol) {
  const parcalar = String(yol).split('.')
  const zincir = [nesne]
  let cur = nesne
  for (let i = 0; i < parcalar.length - 1; i++) {
    const p = parcalar[i]
    if (cur[p] === null || typeof cur[p] !== 'object') return nesne
    cur = cur[p]
    zincir.push(cur)
  }
  delete cur[parcalar[parcalar.length - 1]]
  for (let i = zincir.length - 1; i > 0; i--) {
    if (Object.keys(zincir[i]).length === 0) delete zincir[i - 1][parcalar[i - 1]]
  }
  return nesne
}

/**
 * Trend zaman dilimi grafikten buyuk degilse uyarir.
 *
 * `fillHtfTrend` bu durumda sessizce grafik zaman dilimine duser: 15m grafikte
 * trendTf de 15m ise "ust zaman dilimi trendi" bileseni aslinda AYNI zaman
 * diliminin EMA'sini sorar. Bir donem varsayilan sabit '15m' oldugu icin bu
 * sessizce boyle calisiyordu.
 *
 * @param {(yol:string)=>*} oku
 * @returns {string}
 */
function trendTfUyarisi(oku) {
  const trend = oku('indicatorParams.trendTf')
  if (!trend || trend === 'auto') return ''
  const grafik = oku('timeframe')
  if (!grafik) return ''
  const sn = (tf) => {
    const m = String(tf).match(/^(\d+)([mhd])$/)
    if (!m) return NaN
    const k = m[2] === 'm' ? 60 : (m[2] === 'h' ? 3600 : 86400)
    return Number(m[1]) * k
  }
  const t = sn(trend)
  const g = sn(grafik)
  if (!Number.isFinite(t) || !Number.isFinite(g)) return ''
  if (t > g) return ''
  return 'Trend zaman dilimi (' + trend + ') grafiğin zaman diliminden (' + grafik +
    ') büyük değil. Bu durumda "üst zaman dilimi trendi" bileşeni kendi grafiğinin ' +
    'EMA\'sını sorar, yani adı yanıltıcı olur. "auto" seçeneği grafiğin 4 katını kullanır.'
}

/**
 * Esik birlesimi hic sinyal uretemiyorsa uyarir.
 *
 * Kalibrasyon (onsel) gosterilen orani havuz tabanina dogru ceker: az
 * eslesmede oran tabanin cok uzagina cikamaz. Bu yuzden "en az eslesme 5,
 * onsel 20, en az tutma %60" gibi bir birlesim, kayitlarin TAMAMI tutmus
 * olsa bile hicbir zaman saglanamaz. Uygulama bir donem bunu sessizce
 * yapiyordu: kullanici sinyal beklerken ekran bos kaliyordu.
 *
 * @param {(yol:string)=>*} oku Yamayi da gozeten deger okuyucu
 * @returns {string} Bos dize uyari yoksa
 */
function ulasilmazEsikUyarisi(oku) {
  const sayi = (x, v) => (Number.isFinite(Number(x)) ? Number(x) : v)
  const m = sayi(oku('signalCfg.minMatches'), 15)
  const p = Math.max(0, sayi(oku('signalCfg.priorStrength'), 20))
  const esik = sayi(oku('signalCfg.minWinRate'), 0.62)
  if (!(m > 0) || p === 0) return ''
  // Havuz tabani ancak testte bilinir; burada olculmus araligin ortasi
  // (form %39-50, dokunus %23-28) temkinli bir varsayim olarak kullanilir.
  const taban = 0.40
  const enYuksek = (m + p * taban) / (m + p)
  if (esik <= enYuksek) return ''
  return 'Bu birleşim hiçbir sinyal üretemez: en az eşleşme ' + m + ' ve önsel ' + p +
    ' ile, eşleşmelerin tamamı tutmuş olsa bile gösterilen oran en fazla %' +
    Math.round(enYuksek * 100) + ' olur (havuz tabanı %40 varsayımıyla), eşiğiniz ise %' +
    Math.round(esik * 100) + '. Eşleşme sayısını artırın, önseli düşürün ya da eşiği indirin.'
}

/** Ayar gruplari tanimi (sira arayuzdeki siradir). */
function ayarGruplari(saglayiciSecenekleri) {
  return [
    {
      baslik: 'Bölge (kutu) ayarları',
      bozar: true,
      not: 'Kutu, hacimli bir pivotun Bollinger bandı dışına taştığı yerde doğar. ' +
        'Bu bölümdeki değerler kutunun nerede doğduğunu ve ne kadar yaşadığını belirler.',
      alanlar: [
        { yol: 'indicatorParams.pivotLen', ad: 'Pivot hassasiyeti', tip: 'sayi', adim: 1, min: 2, max: 20,
          not: 'Pivotun iki yanında aranan bar sayısı. Kutu, pivot barından bu kadar bar SONRA onaylanır.' },
        { yol: 'indicatorParams.zoneAtrMult', ad: 'Kutu kalınlığı (ATR)', tip: 'sayi', adim: 0.05, min: 0.05, max: 2,
          not: 'Kutunun yüksekliği, pivot barındaki ATR ile çarpılır.' },
        { yol: 'indicatorParams.mergeAtrMult', ad: 'Yakın kutuları birleştir (ATR)', tip: 'sayi', adim: 0.05, min: 0, max: 3,
          not: 'Bu mesafeden yakın aynı yönlü kutu varsa yeni kutu açılmaz, mevcut kutu büyür. 0 kapatır.' },
        { yol: 'indicatorParams.maxAgeBars', ad: 'Kutu ömrü (bar)', tip: 'sayi', adim: 1, min: 50, max: 5000,
          not: 'Kutu pivot barından itibaren kaç bar canlı kalır. Süre dolunca dokunuş aranmaz.' },
        { yol: 'indicatorParams.boxLengthBars', ad: 'Kutu çizim uzunluğu (bar)', tip: 'sayi', adim: 1, min: 1, max: 5000,
          not: 'Kutunun grafikte ileriye doğru uzatıldığı bar sayısı.' },
        { yol: 'indicatorParams.maxZones', ad: 'Azami canlı kutu', tip: 'sayi', adim: 1, min: 5, max: 100,
          not: 'Aynı anda takip edilen kutu sayısı. Aşılınca en eski kutu takipten düşer.' },
        { yol: 'indicatorParams.breakAtrMult', ad: 'Kırılım payı (ATR)', tip: 'sayi', adim: 0.05, min: 0,
          not: 'Kapanış kutunun bu kadar dışına taşarsa kutu kırılır. Onay barı yoktur, tek bar yeter.' },
        { yol: 'indicatorParams.touchCooldown', ad: 'Dokunuş sayım aralığı (bar)', tip: 'sayi', adim: 1, min: 1, max: 100,
          not: 'Aynı kutuya yapılan dokunuşların akış gücünü kaç barda bir artıracağı.' },
        { yol: 'indicatorParams.atrLen', ad: 'ATR uzunluğu', tip: 'sayi', adim: 1, min: 5, max: 100,
          not: 'Kutu kalınlığında, kırılım payında ve plan mesafelerinde kullanılan ATR periyodu.' },
      ],
    },
    {
      baslik: 'Hacim filtresi',
      bozar: true,
      not: 'Kutunun açılması için pivot barında hacim patlaması aranır. ' +
        'Akış gücü = (hacim / hacim ortalaması) * 3, tavanı 10.',
      onaylar: [
        { yol: 'indicatorParams.useVolumeFilter', ad: 'Hacim filtresini kullan' },
      ],
      alanlar: [
        { yol: 'indicatorParams.volumeLen', ad: 'Hacim ortalaması (bar)', tip: 'sayi', adim: 1, min: 10, max: 300,
          not: 'Hacim oranının paydası olan hareketli ortalamanın uzunluğu.' },
        { yol: 'indicatorParams.minVolRatio', ad: 'En az hacim oranı', tip: 'sayi', adim: 0.05, min: 0.1, max: 5,
          not: 'Pivot barının hacmi ortalamanın en az bu katı olmalı.' },
        { yol: 'indicatorParams.minFlowToShow', ad: 'En az akış gücü', tip: 'sayi', adim: 0.1, min: 1, max: 10,
          not: 'Kutu açılması için gereken akış gücü eşiği. 6,0 yaklaşık iki kat hacim demektir.' },
      ],
    },
    {
      baslik: 'Bollinger filtresi',
      bozar: true,
      not: 'Kutu yalnızca pivot bandın dışına taştığında açılır. Kurulumu bir ' +
        '"aşırılık + hacim" kurulumu yapan şey budur, sinyalin yönü de buradan gelir.',
      onaylar: [
        { yol: 'indicatorParams.useBBFilter', ad: 'Bollinger filtresini kullan' },
      ],
      alanlar: [
        { yol: 'indicatorParams.bbLen', ad: 'Bollinger periyodu', tip: 'sayi', adim: 1, min: 1, max: 1000,
          not: 'Orta bandın hareketli ortalama uzunluğu.' },
        { yol: 'indicatorParams.bbMult', ad: 'Bollinger std sapma', tip: 'sayi', adim: 0.1, min: 0.1,
          not: 'Bant genişliği çarpanı. Büyütmek kutu sayısını azaltır.' },
      ],
    },
    {
      baslik: 'Sinyal üretimi',
      bozar: true,
      not: 'İki sinyal türü vardır ve ikisi de ayrı ayrı öğrenilir: kutunun ' +
        'doğduğu an (oluşum) ve kutuya yapılan ilk dokunuş.',
      onaylar: [
        { yol: 'indicatorParams.signalOnForm', ad: 'Kutu oluşumunda sinyal üret' },
        { yol: 'indicatorParams.signalOnTouch', ad: 'Bölgeye dokunuşta sinyal üret' },
      ],
      alanlar: [
        { yol: 'indicatorParams.minScoreForSignal', ad: 'En az skor (yalnızca etiket)', tip: 'sayi', adim: 1, min: 0, max: 5,
          not: 'Beş bileşenden kaçı doğru olursa olay "nitelikli" sayılır (akış, trend, seans, fitil reddi, hacim). ' +
            'DİKKAT: bu eşik sinyalin üretilip üretilmeyeceğini BELİRLEMEZ, yalnızca olayı etiketler. ' +
            'Sinyali belirleyen eşikler aşağıdaki "Sinyal kararı" bölümündedir.' },
        { yol: 'indicatorParams.strongScoreLevel', ad: 'Güçlü sinyal skoru (yalnızca etiket)', tip: 'sayi', adim: 1, min: 0, max: 5,
          not: 'Bu skorun üstündeki olaylar güçlü olarak işaretlenir. Sinyal kararına girmez.' },
        { yol: 'indicatorParams.strongFlowLevel', ad: 'Güçlü akış eşiği', tip: 'sayi', adim: 0.5, min: 1, max: 10,
          not: 'Akış skoru bunun üstündeyse skorun akış bileşeni sayılır.' },
        { yol: 'indicatorParams.wickMinRatio', ad: 'Fitil reddi oranı', tip: 'sayi', adim: 0.05, min: 0, max: 1,
          not: 'Olay barının fitili bar aralığının bu kadarını kaplarsa red bileşeni sayılır.' },
        { yol: 'indicatorParams.trendTf', ad: 'Trend zaman dilimi', tip: 'secim',
          secenekler: [{ deger: 'auto', ad: 'auto (grafiğin 4 katı)' }]
            .concat(TF_SECENEKLERI.map((t) => ({ deger: t, ad: t }))),
          not: 'Üst zaman dilimi trend süzgeci. Grafiğin zaman diliminden BÜYÜK olmalı: ' +
            'eşit ya da küçük seçilirse bileşen kendi grafiğinin EMA\'sını sorar ve ' +
            '"üst zaman dilimi trendi" adı yanıltıcı olur. Kutu oluşumunu etkilemez, yalnızca skora girer.' },
      ],
      capraz: trendTfUyarisi,
    },
    {
      baslik: 'Seans seçimleri',
      bozar: true,
      not: 'Seans, skorun bir bileşenidir. Sert kapı açıksa seçili seans dışındaki ' +
        'olaylar hiç sinyal sayılmaz.',
      onaylar: [
        { yol: 'indicatorParams.useAsia', ad: 'Asya' },
        { yol: 'indicatorParams.useLondon', ad: 'Londra' },
        { yol: 'indicatorParams.useNewYork', ad: 'New York' },
        { yol: 'indicatorParams.useOther', ad: 'Diğer' },
        { yol: 'indicatorParams.hardSessionGate', ad: 'Sert seans kapısı' },
      ],
    },
    {
      baslik: 'Sonuç etiketleme',
      bozar: true,
      not: 'Hafızanın öğrendiği "bölge tuttu mu" sorusunun tanımı. Buradaki hedef ' +
        've geçersizlik seviyeleri, sinyal planındaki TP1 ve SL ile AYNI seviyelerdir.',
      alanlar: [
        { yol: 'outcomeCfg.horizonBars', ad: 'Sonuç ufku (bar)', tip: 'sayi', adim: 1, min: 1,
          not: 'Sonucun beklendiği azami bar sayısı, aşılırsa zaman aşımı sayılır.' },
        { yol: 'outcomeCfg.targetAtr', ad: 'Hedef mesafesi (ATR)', tip: 'sayi', adim: 0.1, min: 0.1,
          not: 'Dokunuş olayında hedef, bölge kenarından bu kadar uzaktadır. Uzun zaman diliminde büyütün.' },
        { yol: 'outcomeCfg.breakBufferAtr', ad: 'Geçersizlik payı (ATR)', tip: 'sayi', adim: 0.05, min: 0,
          not: 'Fiyat bölgenin uzak kenarından bu kadar dışarı taşarsa bölge kırılmış sayılır.' },
        { yol: 'outcomeCfg.formTargetRr', ad: 'Oluşum hedefi (risk katı)', tip: 'sayi', adim: 0.1, min: 0,
          not: 'Kutu oluşumu olayında hedef, riskin bu katı kadar uzaktadır. 0 yaparsanız sabit ATR mesafesi kullanılır.' },
        { yol: 'outcomeCfg.maxFormRiskAtr', ad: 'Oluşumda azami risk (ATR)', tip: 'sayi', adim: 0.5, min: 0,
          not: 'Kutu onaylanana kadar fiyat çok kaçtıysa olay hafızaya alınmaz. 0 sınırı kapatır.' },
      ],
    },
    {
      // SINYALI FIILEN BELIRLEYEN ESIKLER BURADADIR. Yukaridaki skor ayarlari
      // yalnizca olayi etiketler; sinyal karari bu dort esik ve asagidaki
      // beklenen deger kapisiyla verilir.
      baslik: 'Sinyal kararı (sinyalin üretilmesini bunlar belirler)',
      bozar: false,
      not: 'Bir sinyal ancak şu dördü birden sağlanınca üretilir: yeterli sayıda ' +
        'benzer kayıt, o kayıtlarda yeterli tutma oranı, yeterli risk/ödül ve ' +
        'pozitif beklenen değer. Bu eşikleri değiştirmek yeniden tarama gerektirmez, ' +
        'ama Test sekmesini yeniden çalıştırmadan etkisini bilemezsiniz.',
      alanlar: [
        { yol: 'signalCfg.k', ad: 'Komşu sayısı (k)', tip: 'sayi', adim: 1, min: 1, max: 200,
          not: 'Hafızadan alınan en benzer kayıt sayısı.' },
        { yol: 'signalCfg.mode', ad: 'Sinyal kipi', tip: 'secim',
          secenekler: [
            { deger: 'benzerlik', ad: 'Geçmişte aynı yapı varsa sinyal' },
            { deger: 'hepsi', ad: 'Her kurulum sinyal (benzerlik aranmaz)' },
            { deger: 'hafiza', ad: 'Hafızadan süz (geçmiş tutma oranına göre)' },
          ],
          not: 'GEÇMİŞTE AYNI YAPI: kutu oluştuğunda o andaki grafiğin şekli ' +
            'alınır, geçmişte aynı yapı aranır ve yeterince benzer kurulum ' +
            'bulunursa sinyal üretilir. Hedef, zarar durdur, tutma oranı ve R/R ' +
            'hiç hesaplanmaz; seviyeleri siz belirlersiniz. Kaç benzer kurulum ' +
            'gerektiğini "En az eşleşme", ne kadar benzer olacağını "En az ' +
            'benzerlik" belirler. ' +
            'HER KURULUM: benzerlik de aranmaz, her kutu oluşumu ve her dönüş ' +
            'sinyaldir. ' +
            'HAFIZADAN SÜZ: eski davranış; benzerlere ek olarak geçmiş tutma ' +
            'oranı ve plan matematiği de hesaplanır, eşiği geçmeyen kurulum ' +
            'sinyal olmaz.' },
        { yol: 'featureCfg.shapeWindowBars', ad: 'Şekil penceresi (bar)',
          tip: 'sayi', adim: 8, min: 16, max: 512,
          not: 'Geçmişte benzer kurulum aranırken şeklin KAÇ BARA baktığı. ' +
            'Varsayılan 32. Şekil her zaman 16 noktadır; pencere büyüdükçe her ' +
            'nokta daha çok barın ortalaması olur, yani daha geniş ama daha kaba ' +
            'bir biçim karşılaştırılır. 5 dakikalıkta 32 bar yaklaşık 2,5 saat, ' +
            '96 bar yaklaşık 8 saattir. ' +
            'DİKKAT: bu değer özellik vektörünü değiştirir, yani HAFIZANIN ' +
            'YENİDEN KURULMASI gerekir. Kaydettikten sonra tarama kendiliğinden ' +
            'istenir ve ölçüm de yeniden hesaplanır. Pencere büyüdükçe serinin ' +
            'başındaki olaylar kullanılamaz hale gelir (ilk pencere kadar bar).' },
        { yol: 'signalCfg.weightPreset', ad: 'Benzerlik neye baksın', tip: 'secim',
          secenekler: [
            { deger: 'sekil', ad: 'Yalnızca görsel şekil' },
            { deger: 'sekilAgirlikli', ad: 'Ağırlıkla şekil (%85 şekil)' },
            { deger: 'dengeli', ad: 'Dengeli (%40 şekil, %40 bağlam)' },
            { deger: 'baglamAgirlikli', ad: 'Ağırlıkla bağlam (%70 bağlam)' },
            { deger: 'baglam', ad: 'Yalnızca bağlam' },
            { deger: 'ozel', ad: 'Özel (aşağıdaki sayılar)' },
          ],
          not: 'Geçmişte benzer kurulum aranırken neye bakılacağı. ŞEKİL: son 32 ' +
            'kapanışın normalize edilmiş eğrisi, yani grafiğin görünümü. BAĞLAM: ' +
            'RSI, ATR, ortalamalara uzaklık, saat, kutu genişliği, kutu yaşı, hacim ' +
            'oranı gibi 24 değer. Ölçüldü (doğrulama dilimi, eşikler kullanılmadan, ' +
            'ölçüt AUC): 5m\'de yalnız şekil 0,6155 ve yalnız bağlam 0,6254; ' +
            '15m\'de 0,5899 ve 0,6055. İki zaman diliminde de bağlam arttıkça ' +
            'tahmin iyileşiyor, yani "yalnızca görsel şekil" ölçümde en zayıf ' +
            'seçenektir. Aradaki fark küçüktür (0,01 AUC bandı). ' +
            'Değiştirince sinyal listesi yeniden hesaplanır.' },
        { yol: 'signalCfg.minSimilarity', ad: 'En az benzerlik', tip: 'sayi', adim: 0.01, min: 0, max: 0.999,
          not: 'Bu eşiğin altındaki eşleşmeler sayılmaz. Ölçüldü: 0,80 eşiği rastgele ' +
            'çiftlerin yaklaşık %41\'ini geçiriyor, yani tek başına seçici değildir.' },
        { yol: 'signalCfg.minMatches', ad: 'En az eşleşme', tip: 'sayi', adim: 1, min: 1, max: 1000,
          not: 'Sinyal üretmek için gereken eşik üstü kayıt sayısı. Küçük değerlerde ' +
            'oran gürültüden ibaret olur (5 kayıtta %60, 3 kayıt demektir).' },
        { yol: 'signalCfg.minWinRate', ad: 'En az başarı oranı', tip: 'sayi', adim: 0.01, min: 0, max: 1,
          not: 'Benzer kayıtlarda aranan asgari tutma oranı. Türlerin taban oranları ' +
            'çok farklıdır (ölçüldü: oluşum %39-50, dokunuş %23-28), bu yüzden mutlak ' +
            'bir eşik bir türü tamamen kapatabilir.' },
        { yol: 'signalCfg.minRr', ad: 'En az risk/ödül', tip: 'sayi', adim: 0.1, min: 0, max: 10,
          not: 'Planın ödül/risk oranı bunun altındaysa sinyal üretilmez. 0 kapatır.' },
        { yol: 'signalCfg.minExpectancy', ad: 'En az beklenen değer (R)', tip: 'sayi', adim: 0.05, min: -1, max: 5,
          not: 'Beklenen değer = tutma oranı x R/R - kırılma oranı + zaman aşımı katkısı. ' +
            'Yüksek isabet tek başına yetmez, matematiğin de olumlu olması gerekir.' },
        { yol: 'signalCfg.touchMinWinRate', ad: 'Dokunuşta en az isabet oranı',
          tip: 'sayi', adim: 0.01, min: 0, max: 1,
          not: 'Fiyat kutuya geri döndüğünde üretilen sinyal için ayrı eşik. ' +
            'Boş bırakılırsa üstteki genel eşik kullanılır. Neden ayrı: eşikler ' +
            'mutlak sayıdır ama türlerin taban oranı çok farklıdır. Ölçüldü ' +
            '(5m, 24.218 olay): oluşum geçmişte %46,6 tutmuş, dokunuş %18,1. Tek ' +
            'bir eşik dokunuşu kurulum kötü olduğu için değil ölçü başka olduğu ' +
            'için eliyordu. Başabaş noktaları da farklı: dokunuşta medyan R/R ' +
            '2,45 olduğu için %28,9 isabet yeter, oluşumda R/R 1,00 ve %50 gerekir.' },
        { yol: 'signalCfg.maxZoneAgeBars', ad: 'En fazla kutu yaşı (bar)',
          tip: 'sayi', adim: 10, min: 0, max: 2000,
          not: 'Olay anındaki kutu yaşı bunu aşarsa sinyal üretilmez. 0 kapatır. ' +
            'Kutunun çizim ömrü 100 bardır ama izlenmeye 600 bara kadar devam ' +
            'eder, yani çok eski bir kutuya gelen dokunuş da olay üretebiliyordu. ' +
            'Ölçüldü: dokunuşların %82,6\'sı zaten 100 bardan genç kutulara geliyor.' },
        { yol: 'signalCfg.priorStrength', ad: 'Kalibrasyon önseli (sanal gözlem)', tip: 'sayi', adim: 1, min: 0, max: 200,
          not: 'Gösterilen oran, havuzun taban oranına doğru bu ağırlıkta çekilir. ' +
            '20 değeri "20 kayıtlık bir ön bilgi" demektir ve 5 eşleşmelik bir oranın ' +
            'neredeyse tamamen tabana yakın kalmasını sağlar. 0 kapatır, ham oran gösterilir.' },
        { yol: 'signalCfg.minLift', ad: 'En az katma değer', tip: 'sayi', adim: 0.01, min: 0, max: 0.5,
          not: 'Gösterilen oran, aynı türün taban oranından en az bu kadar yüksek ' +
            'olmalı. 0 kapatır. Ölçülmeden açılmamalı: bkz. scripts/search-params.mjs.' },
        { yol: 'signalCfg.newsBlackoutMin', ad: 'Veri penceresi (dk)', tip: 'sayi', adim: 5, min: 0, max: 240,
          not: 'Karar anı yüksek etkili bir veriye bu kadar yakınsa sinyal üretilmez. ' +
            '0 kapatır. Ölçüldü: NFP penceresinde 15m dokunuş isabeti %15,3 (n=59), ' +
            'diğer zamanlarda %28,1; ama örneklem küçük ve aralıklar örtüşüyor, yani ' +
            'faydası kanıtlı değil. Takvim dosyası yoksa bu ayar etkisizdir: ' +
            'veri klasöründe calendar/high_impact.csv gerekir.' },
        { yol: 'signalCfg.halfLifeYears', ad: 'Eşleşme yarı ömrü (yıl)', tip: 'sayi', adim: 1, min: 0, max: 30,
          not: 'Eski eşleşmeler bu yarı ömürle hafifler ve güven aralığı etkin örnekleme ' +
            'göre hesaplanır. 0 kapatır. Ölçüldü: doğrulama diliminde kazanç 0,002 Brier, ' +
            'yani ölçüm hatasının içinde. Kendi verinizde denemek için: ' +
            'node scripts/search-params.mjs --ablation' },
      ],
      capraz: ulasilmazEsikUyarisi,
    },
    {
      // Olcumun en belirleyici girdisi: maliyet. 1 dakikalikta brut edimin
      // tamamini yiyor. Bir donem yalnizca kodda sabitti.
      baslik: 'İşlem maliyeti ve ölçüm',
      bozar: false,
      not: 'Bu değerler hem Test sekmesinde hem de sinyalin beklenen değer ' +
        'hesabında kullanılır. Kendi spreadinizi girin: ölçülen sonuç buna çok duyarlıdır.',
      alanlar: [
        { yol: 'backtestCfg.costPct', ad: 'Maliyet (fiyata oran)', tip: 'sayi', adim: 0.00001, min: 0, max: 0.01,
          not: '0,000068 = 4400 dolarlık altında yaklaşık 0,30 dolar gidiş dönüş. ' +
            '17 yıllık testte doğru ölçü budur, çünkü altın 900 dolardan 4400 dolara çıktı.' },
        { yol: 'backtestCfg.costUsd', ad: 'Maliyet (sabit dolar)', tip: 'sayi', adim: 0.01, min: 0, max: 100,
          not: 'Yalnızca oran 0 ise kullanılır.' },
        { yol: 'backtestCfg.slippageAtr', ad: 'Kayma (ATR)', tip: 'sayi', adim: 0.01, min: 0, max: 2,
          not: 'Limit emrin beklenenden kötü dolması payı. Girişin aleyhine eklenir.' },
        { yol: 'backtestCfg.warmupPerBucket', ad: 'Isınma: tür ve yön başına asgari aday', tip: 'sayi', adim: 10, min: 0, max: 5000,
          not: 'Bir olay ancak hafızada aynı türden ve aynı yönden bu kadar aday varsa ' +
            'değerlendirilir. Sabit olay sayısı yüksek zaman dilimlerinde testi anlamsız kılıyordu.' },
      ],
    },
    {
      // Bu grup hafizayi ETKILEMEZ: yeniden tarama uyarisi cikmamali.
      baslik: 'Risk ve pozisyon',
      bozar: false,
      not: 'Bakiye girilince sinyal kartında lot ve dolar riski görünür. Türler arasında ' +
        'risk üç kat farklı (ölçüldü: oluşum 2,02-2,10 ATR, dokunuş 0,68-0,75 ATR), ' +
        'bu yüzden sabit lotla işlem açmak oluşumda üç kat fazla risk demek.',
      alanlar: [
        { yol: 'risk.balance', ad: 'Hesap bakiyesi ($)', tip: 'sayi', adim: 100, min: 0,
          not: '0 bırakılırsa pozisyon hesaplayıcı gizli kalır.' },
        { yol: 'risk.riskPct', ad: 'İşlem başına risk (%)', tip: 'sayi', adim: 0.1, min: 0.01, max: 100,
          not: 'Stop vurulursa kaybedilecek bakiye yüzdesi.' },
        { yol: 'risk.contractSize', ad: 'Sözleşme büyüklüğü (ons)', tip: 'sayi', adim: 1, min: 1,
          not: 'XAUUSD standart lotta 100 onstur.' },
        { yol: 'risk.lotStep', ad: 'Lot adımı', tip: 'sayi', adim: 0.01, min: 0.001,
          not: 'Brokerinizin izin verdiği en küçük artış.' },
        { yol: 'risk.minLot', ad: 'En küçük lot', tip: 'sayi', adim: 0.01, min: 0.001,
          not: 'Bunun altına düşen hesaplarda uyarı gösterilir.' },
        { yol: 'risk.costUsd', ad: 'Gidiş dönüş maliyet ($)', tip: 'sayi', adim: 0.01, min: 0,
          not: 'Boş bırakılırsa fiyatın %0,0068\'i kullanılır (ölçüm ile aynı).' },
      ],
    },
    {
      baslik: 'Sağlayıcı ve anahtarlar',
      bozar: false,
      onaylar: [
        { yol: 'autoStartLive', ad: 'Program açılınca canlı takibi başlat' },
        { yol: 'autoPrepareOnTfChange', ad: 'Zaman dilimi değişince eksikleri tamamla' },
        { yol: 'notify.desktop', ad: 'Sinyal gelince masaüstü bildirimi göster' },
        { yol: 'notify.sound', ad: 'Bildirimde ses çal' },
        { yol: 'notify.onlyProven', ad: 'Yalnızca kanıtlı sinyal türlerinde bildir' },
      ],
      alanlar: [
        { yol: 'providers.history', ad: 'Geçmiş kaynağı', tip: 'secim', secenekler: saglayiciSecenekleri,
          not: 'Geçmiş mumların indirileceği kaynak.' },
        { yol: 'providers.live', ad: 'Canlı kaynak', tip: 'secim', secenekler: saglayiciSecenekleri,
          not: 'Canlı takipte kullanılan kaynak, vekil kaynaklarda fiyat farkı düzeltilir.' },
        { yol: 'apiKeys.twelvedata', ad: 'TwelveData anahtarı', tip: 'gizli',
          not: 'Spot fiyat verir, forex serilerinde hacim gelmez.' },
        { yol: 'apiKeys.polygon', ad: 'Polygon anahtarı', tip: 'gizli',
          not: 'Spot fiyat ve tick sayısı hacmi verir, önerilen ücretli seçenek.' },
        { yol: 'apiKeys.oanda', ad: 'OANDA anahtarı', tip: 'gizli',
          not: 'Ücretsiz deneme hesabı anahtarı yeterli. Spot XAU_USD ve TradingView ' +
            'OANDA grafiğiyle aynı akıştan tick hacmi verir.' },
        { yol: 'livePollSeconds', ad: 'Canlı sorgu aralığı (sn)', tip: 'sayi', adim: 1, min: 3,
          not: 'Canlı modda sağlayıcının kaç saniyede bir sorgulanacağı.' },
      ],
    },
  ]
}

/**
 * Ayarlar panelini cizer.
 * @param {HTMLElement} el Form veya govde kabi (ornek: #settingsForm)
 * @param {object} settings
 * @param {{onChange?:(patch:object, meta?:object)=>void, onReset?:()=>void,
 *          onSave?:(patch:object)=>void, providerList?:Array}} [opts]
 */
export function renderSettings(el, settings, opts) {
  if (!el) return
  const o = opts || {}
  bosalt(el)
  const s = settings || {}

  const saglayicilar = Array.isArray(o.providerList) ? o.providerList : []
  const saglayiciSecenekleri = saglayicilar.length
    ? saglayicilar.map((p) => ({ deger: p.id, ad: (p.name || p.id) + (p.isProxy ? ' (vekil)' : '') }))
    // Liste gelmediyse tek kaynak yazilir; ana surec de yalnizca OANDA
    // donduruyor (bkz. ipc.js listProviders).
    : [{ deger: 'oanda', ad: 'OANDA (XAU_USD spot)' }]

  // Bekleyen degisiklikler burada birikir, 'Kaydet' ile gonderilir.
  const yama = {}
  let bozuldu = false

  el.appendChild(uyariKutusu(
    'İndikatör, seans ve sonuç ayarlarını değiştirmek mevcut hafızayı geçersiz kılar. ' +
    'Kaydettikten sonra "Geçmişi Tara" ile yeniden tarama yapmanız gerekir.'))

  const bozulmaUyarisi = uyariKutusu(
    'Hafızayı etkileyen bir ayar değişti. Kaydedip yeniden tarama yapılana kadar sinyaller eski hafızaya dayanır.')
  bozulmaUyarisi.style.display = 'none'
  bozulmaUyarisi.style.color = 'var(--down, ' + RENK.down + ')'
  el.appendChild(bozulmaUyarisi)

  // Gecersiz (aralik disi) alanlar. Bunlar varken kaydetmek engellenir:
  // bos birakilan bir kutu 0 olarak, aralik disi bir esik oldugu gibi
  // kaydediliyordu ve sonuclari sessizce anlamsiz hale getiriyordu.
  const gecersizler = new Set()
  let kaydetDugmesi = null
  const gecersizUyarisi = uyariKutusu('')
  gecersizUyarisi.style.display = 'none'
  gecersizUyarisi.style.color = 'var(--down, ' + RENK.down + ')'
  el.appendChild(gecersizUyarisi)

  /** Gecerlilik durumunu kaydet dugmelerine ve uyariya yansitir. */
  function gecerliligiUygula() {
    const bozukVar = gecersizler.size > 0
    const liste = Array.from(gecersizler).join(', ')
    gecersizUyarisi.textContent = bozukVar
      ? 'Geçerli aralık dışında değer var, kaydetme kapalı: ' + liste
      : ''
    gecersizUyarisi.style.display = bozukVar ? '' : 'none'
    if (kaydetDugmesi) kaydetDugmesi.disabled = bozukVar
    const ustKaydet = document.getElementById('settingsSaveBtn')
    if (ustKaydet) ustKaydet.disabled = bozukVar
  }

  /** Bir alanin gecerliligini bildirir. */
  function gecerlilik(yol, gecerliMi) {
    if (gecerliMi) gecersizler.delete(yol)
    else gecersizler.add(yol)
    gecerliligiUygula()
  }

  /** Bos birakilan alani yamadan cikarir ("degisiklik yok" anlamina gelir). */
  function yamadanCikar(yol) {
    yoldanSil(yama, yol)
    caprazlariYenile()
    if (typeof o.onChange === 'function') {
      o.onChange({}, { path: yol, value: undefined, invalidatesMemory: false, patch: yama })
    }
  }

  // Birden fazla alani birlikte degerlendiren kontroller (ornek: esik
  // birlesimi hic sinyal uretemiyor mu). Her degisiklikte yeniden cizilir.
  const caprazlar = []

  /** Yamayi gozeterek yururlukteki degeri okur. */
  function efektif(yol) {
    const yamada = yoldanOku(yama, yol)
    return yamada === undefined ? yoldanOku(s, yol) : yamada
  }

  /** Capraz kontrollerin metnini tazeler. */
  function caprazlariYenile() {
    for (let i = 0; i < caprazlar.length; i++) {
      const metin = caprazlar[i].fn(efektif) || ''
      caprazlar[i].el.textContent = metin
      caprazlar[i].el.style.display = metin ? '' : 'none'
    }
  }

  /** Bir alan degistiginde yamayi gunceller ve onChange cagirir. */
  function degisti(yol, deger, bozarMi) {
    yolaYaz(yama, yol, deger)
    caprazlariYenile()
    if (bozarMi) {
      bozuldu = true
      bozulmaUyarisi.style.display = ''
    }
    if (typeof o.onChange === 'function') {
      o.onChange(yolaYaz({}, yol, deger), {
        path: yol, value: deger, invalidatesMemory: !!bozarMi, patch: yama,
      })
    }
  }

  const gruplar = ayarGruplari(saglayiciSecenekleri)
  for (let g = 0; g < gruplar.length; g++) {
    const grup = gruplar[g]
    el.appendChild(bolumBasligi(grup.baslik + (grup.bozar ? ' (yeniden tarama gerektirir)' : '')))
    if (grup.not) el.appendChild(h('div', 'small muted', grup.not))

    const alanlar = grup.alanlar || []
    if (alanlar.length) {
      const izgara = h('div', 'field-grid')
      const kanca = { degisti, gecerlilik, yamadanCikar }
      for (let i = 0; i < alanlar.length; i++) izgara.appendChild(alanDugumu(alanlar[i], s, grup.bozar, kanca))
      el.appendChild(izgara)
    }

    if (typeof grup.capraz === 'function') {
      const kutu = uyariKutusu('')
      kutu.style.color = 'var(--warn, ' + RENK.warn + ')'
      kutu.style.display = 'none'
      el.appendChild(kutu)
      caprazlar.push({ el: kutu, fn: grup.capraz })
    }

    const onaylar = grup.onaylar || []
    if (onaylar.length) {
      const izgara = h('div', 'field-grid')
      for (let i = 0; i < onaylar.length; i++) {
        const t = onaylar[i]
        const etiket = h('label', 'check')
        const kutu = document.createElement('input')
        kutu.type = 'checkbox'
        kutu.checked = yoldanOku(s, t.yol) === true
        kutu.dataset.key = t.yol
        kutu.addEventListener('change', () => degisti(t.yol, kutu.checked, grup.bozar))
        etiket.appendChild(kutu)
        etiket.appendChild(h('span', null, t.ad))
        izgara.appendChild(etiket)
      }
      el.appendChild(izgara)
    }
  }

  const ayak = h('div', 'panel-foot')
  const kaydet = h('button', 'btn btn-primary mini', 'Kaydet')
  kaydet.type = 'button'
  kaydetDugmesi = kaydet
  gecerliligiUygula()
  caprazlariYenile()
  kaydet.addEventListener('click', () => {
    if (gecersizler.size > 0) return
    if (typeof o.onSave === 'function') o.onSave(yama)
    else if (typeof o.onChange === 'function') o.onChange(yama, { save: true, invalidatesMemory: bozuldu })
  })
  const geriDon = h('button', 'btn mini', 'Varsayılanlara Dön')
  geriDon.type = 'button'
  geriDon.addEventListener('click', () => {
    if (typeof o.onReset === 'function') o.onReset()
  })
  ayak.appendChild(kaydet)
  ayak.appendChild(geriDon)
  ayak.appendChild(h('span', 'small muted', 'Kaydet diske yazar, Varsayılanlara Dön fabrika değerlerine çeker.'))
  el.appendChild(ayak)
}

/**
 * Tek bir ayar alani icin .field dugumu uretir.
 * @param {object} kanca {degisti, gecerlilik, yamadanCikar}
 */
function alanDugumu(tanim, ayarlar, bozar, kanca) {
  const degisti = kanca.degisti
  const alan = h('label', 'field')
  alan.appendChild(h('span', null, tanim.ad))

  const mevcut = yoldanOku(ayarlar, tanim.yol)
  let giris

  if (tanim.tip === 'secim') {
    giris = document.createElement('select')
    giris.className = 'select'
    const secenekler = tanim.secenekler || []
    let bulundu = false
    for (let i = 0; i < secenekler.length; i++) {
      const op = document.createElement('option')
      op.value = String(secenekler[i].deger)
      op.textContent = String(secenekler[i].ad)
      if (String(secenekler[i].deger) === String(mevcut)) bulundu = true
      giris.appendChild(op)
    }
    if (!bulundu && mevcut !== undefined && mevcut !== null && mevcut !== '') {
      const op = document.createElement('option')
      op.value = String(mevcut)
      op.textContent = String(mevcut)
      giris.appendChild(op)
    }
    giris.value = mevcut === undefined || mevcut === null ? '' : String(mevcut)
    giris.addEventListener('change', () => degisti(tanim.yol, giris.value, bozar))
  } else if (tanim.tip === 'gizli' || tanim.tip === 'metin') {
    giris = document.createElement('input')
    giris.className = 'input'
    giris.type = tanim.tip === 'gizli' ? 'password' : 'text'
    giris.value = mevcut === undefined || mevcut === null ? '' : String(mevcut)
    giris.addEventListener('change', () => degisti(tanim.yol, giris.value, bozar))
  } else {
    giris = document.createElement('input')
    giris.className = 'input'
    giris.type = 'number'
    if (tanim.adim !== undefined) giris.step = String(tanim.adim)
    if (tanim.min !== undefined) giris.min = String(tanim.min)
    if (tanim.max !== undefined) giris.max = String(tanim.max)
    giris.value = Number.isFinite(Number(mevcut)) ? String(Number(mevcut)) : ''
    // Bos deger "degisiklik yok" demektir (Number('') 0 doner, o yuzden ayri
    // ele aliniyor). Aralik disi deger yamaya girmez ve kaydetmeyi kilitler.
    const kontrol = () => {
      const ham = String(giris.value).trim()
      if (ham === '') {
        giris.classList.remove('invalid')
        kanca.gecerlilik(tanim.yol, true)
        kanca.yamadanCikar(tanim.yol)
        return
      }
      const v = Number(ham)
      const gecerli = Number.isFinite(v) &&
        (tanim.min === undefined || v >= Number(tanim.min)) &&
        (tanim.max === undefined || v <= Number(tanim.max))
      giris.classList.toggle('invalid', !gecerli)
      kanca.gecerlilik(tanim.yol, gecerli)
      if (!gecerli) {
        kanca.yamadanCikar(tanim.yol)
        return
      }
      degisti(tanim.yol, v, bozar)
    }
    giris.addEventListener('input', kontrol)
    giris.addEventListener('change', kontrol)
  }

  giris.dataset.key = tanim.yol
  if (tanim.not) giris.title = tanim.not
  alan.appendChild(giris)
  if (tanim.not) alan.appendChild(h('span', 'row-sub', tanim.not))
  return alan
}

/* ------------------------------------------------------------------ */
/* renderBacktest                                                      */
/* ------------------------------------------------------------------ */

/**
 * Yuruyen ileri test sonuclarini cizer.
 * @param {HTMLElement} el Govde kabi (ornek: #panelTest .panel-body)
 * @param {object} result {trades, summary, byYear, equity}
 * @param {{running?:boolean, otherTf?:string|null}} [opts]
 */
export function renderBacktest(el, result, opts) {
  if (!el) return
  const o = opts || {}
  bosalt(el)

  // IKINCI CALISTIR DUGMESI KALDIRILDI.
  //
  // Panel basligindaki #testRunBtn ile burada cizilen dugme ayni isi
  // yapiyordu; bastaki her zaman gorunur, buradaki icerik kaydirilinca
  // kayboluyordu. Iki dugmeden hangisinin "asil" oldugu belli degildi ve
  // calisma durumu ikisinde ayri ayri yonetiliyordu. Not satiri kaldi.
  const ayak = h('div', 'panel-foot')
  ayak.appendChild(h('span', 'small muted', o.running
    ? 'Test çalışıyor...'
    : 'Her olay yalnızca kendinden önceki hafızayla değerlendirilir, ileriye bakma yoktur.'))
  el.appendChild(ayak)

  const r = result || null
  if (!r || !r.summary) {
    el.appendChild(bosKutu('Henüz test sonucu yok.'))
    return
  }
  const s = r.summary

  // BASKA BIR ZAMAN DILIMINE AIT SONUC. Test sururken zaman dilimi
  // degistirilebiliyordu ve sonuc kontrol edilmeden gosteriliyordu.
  if (o.otherTf) {
    const uyari = uyariKutusu(
      'Bu sonuç ' + String(o.otherTf) + ' zaman dilimine ait. Görüntülenen zaman ' +
      'dilimi için ölçüm almak istiyorsanız testi yeniden çalıştırın.')
    uyari.style.color = 'var(--warn, ' + RENK.warn + ')'
    el.appendChild(uyari)
  }

  // Hafizanin kuruldugu ayar ile su anki ayar uyusmuyorsa bu olcum eski
  // etiketlere aittir. Onceden bu hicbir yerde gorunmuyordu.
  if (r.cfgMatch === false) {
    const uyari = uyariKutusu(
      'Bu sonuç, hafızanın kurulduğu ayarlardan farklı bir ayarla alındı. ' +
      'Ölçümün geçerli olması için "Geçmişi Tara" ile hafızayı yeniden kurun.')
    uyari.style.color = 'var(--down, ' + RENK.down + ')'
    el.appendChild(uyari)
  }
  if (r.stillValid === false) {
    const uyari = uyariKutusu('Bu sonuç eski ayarlara ait, hafıza o zamandan beri yeniden kuruldu.')
    uyari.style.color = 'var(--down, ' + RENK.down + ')'
    el.appendChild(uyari)
  }

  // Basligta ZAMAN DILIMI ve olcum zamani: hangi tf'ye ait oldugu ekranda
  // yazmadigi icin kullanici baska bir dilimin sayilarina bakabiliyordu.
  el.appendChild(bolumBasligi('Özet' +
    (r.tf ? ': ' + String(r.tf) : '') +
    (Number.isFinite(Number(r.olcumZamani)) ? ', ' + formatDateTime(r.olcumZamani) : '') +
    ' (' + tam(s.total) + ' olay değerlendirildi)'))

  // Orneklem yetersizse katki rakami yaniltir; sayinin yerine uyari gosterilir.
  if (s.warning) {
    const uyari = uyariKutusu('Bu ölçüm güvenilir değil: ' + s.warning +
      '. Değerlendirilen olay sayısı istatistik için yetersiz.')
    uyari.style.color = 'var(--warn, ' + RENK.warn + ')'
    el.appendChild(uyari)
  }

  const pf = sayi(s.profitFactor, 0)
  // TABAN: ayni tur, ayni donem, ayni plan. Karisik taban (tum olaylar, tum
  // turler) ekranda +9 ile +13 puanlik sahte katki gosteriyordu.
  const tabanOran = Number.isFinite(s.baselineWinRate) ? s.baselineWinRate : null
  el.appendChild(statIzgara([
    stat('Üretilen sinyal', tam(s.fired)),
    stat('Başarı oranı', formatPercent(s.winRate, 1),
      tabanOran === null ? 'muted' : (sayi(s.winRate, 0) >= tabanOran ? 'up' : 'down')),
    stat('Beklenti (ATR)', formatNumber(s.expectancyAtr, 3), sayi(s.expectancyAtr, 0) >= 0 ? 'up' : 'down'),
    stat('Kâr faktörü', Number.isFinite(pf) && pf !== Infinity ? formatNumber(pf, 2) : (s.fired > 0 ? 'Sonsuz' : '-'),
      pf >= 1 ? 'up' : 'down'),
    stat('Azami geri çekilme', formatNumber(s.maxDrawdownAtr, 2) + ' ATR', 'down'),
    stat('Taban başarı oranı (aynı tür)', tabanOran === null ? '-' : formatPercent(tabanOran, 1), 'muted'),
  ]))

  // ISTATISTIK: nokta tahmin tek basina yaniltir. Isabetin guven araligi,
  // tabana gore farkin p degeri ve net beklentinin araligi birlikte okunur.
  const ci = s.winRateCI && Number.isFinite(s.winRateCI.lo) ? s.winRateCI : null
  if (ci) {
    el.appendChild(kv('İsabet %95 aralığı',
      formatPercent(ci.lo, 1) + ' - ' + formatPercent(ci.hi, 1), 'muted'))
  }
  if (Number.isFinite(s.baselinePValue)) {
    const p = s.baselinePValue
    el.appendChild(kv('Tabandan farkın p değeri',
      formatNumber(p, 3) + (p < 0.05 ? ' (anlamlı)' : ' (anlamsız, şansla açıklanabilir)'),
      p < 0.05 ? 'up' : 'muted'))
  }
  if (s.expectancyCI && Number.isFinite(s.expectancyCI.lo)) {
    el.appendChild(kv('Net beklenti %95 aralığı',
      formatNumber(s.expectancyCI.lo, 3) + ' - ' + formatNumber(s.expectancyCI.hi, 3) + ' ATR',
      s.expectancyCI.lo > 0 ? 'up' : 'muted'))
  }
  if (Number.isFinite(s.permHitP)) {
    el.appendChild(kv('Aynı türden rastgele seçim bu kadar iyi olabilir mi',
      'isabet ' + formatPercent(s.permHitP, 0) + ', net ' +
      (Number.isFinite(s.permNetP) ? formatPercent(s.permNetP, 0) : '-'), 'muted'))
  }
  if (s.edgeProven !== null && s.edgeProven !== undefined) {
    el.appendChild(kv('Katma değer kanıtlandı mı',
      s.edgeProven ? 'Evet, net beklentinin alt sınırı tabanın üstünde' : 'Hayır, aralık tabanı içeriyor',
      s.edgeProven ? 'up' : 'down'))
  }

  const katkiPuan = Number.isFinite(s.edgePts) ? s.edgePts : null
  const katkiNet = Number.isFinite(s.edgeNetAtr) ? s.edgeNetAtr : null
  el.appendChild(kv('Tabana göre katkı (isabet)',
    katkiPuan === null ? '-' : (katkiPuan >= 0 ? '+' : '') + formatNumber(katkiPuan, 1) + ' puan',
    katkiPuan === null ? 'muted' : (katkiPuan >= 0 ? 'up' : 'down')))
  el.appendChild(kv('Tabana göre katkı (net)',
    katkiNet === null ? '-' : (katkiNet >= 0 ? '+' : '') + formatNumber(katkiNet, 3) + ' ATR',
    katkiNet === null ? 'muted' : (katkiNet >= 0 ? 'up' : 'down')))
  el.appendChild(kv('Taban beklentisi',
    Number.isFinite(s.baselineExpectancyAtr) ? formatNumber(s.baselineExpectancyAtr, 3) + ' ATR' : '-', 'muted'))
  el.appendChild(kv('Kazanan / kaybeden', tam(s.wins) + ' / ' + tam(s.losses)))
  // Zaman asimi: hedefe de stopa da degmeyen islemler ufuk sonu kapanisiyla
  // degerlenir, tam stop zarari sayilmaz.
  if (Number.isFinite(s.timeouts)) {
    el.appendChild(kv('Zaman aşımı', tam(s.timeouts) +
      (s.timeouts > 0 ? ' işlem, ' + formatNumber(s.timeoutPnlAtr, 2) + ' ATR' : '')))
  }
  if (Number.isFinite(s.nofill) && s.nofill > 0) {
    el.appendChild(kv('Limit emir dolmadı', tam(s.nofill) + ' olay' +
      (Number.isFinite(s.fillRate) ? ' (dolum oranı ' + formatPercent(s.fillRate, 0) + ')' : '')))
  }
  el.appendChild(kv('Ortalama RR', formatNumber(s.avgRr, 2)))
  if (Number.isFinite(s.evalFrom) && Number.isFinite(s.evalTo)) {
    el.appendChild(kv('Değerlendirilen dönem',
      new Date(s.evalFrom * 1000).toISOString().slice(0, 10) + ' - ' +
      new Date(s.evalTo * 1000).toISOString().slice(0, 10)))
  }
  el.appendChild(kv('Isınma (tür ve yön başına asgari aday)',
    tam(Number.isFinite(s.warmupPerBucket) ? s.warmupPerBucket : s.warmupEvents)))

  // MALIYET KIRILIMI: kucuk zaman dilimlerinde maliyet edimin tamamini
  // yiyebilir, bu yuzden brut ve net ayri gosterilir.
  el.appendChild(bolumBasligi('Maliyet ve risk birimi'))
  el.appendChild(kv('Brüt / işlem', formatNumber(s.grossExpectancyAtr, 3) + ' ATR'))
  el.appendChild(kv('Maliyet / işlem', formatNumber(s.costPerTradeAtr, 3) + ' ATR'))
  el.appendChild(kv('Maliyetin brüt edimdeki payı',
    Number.isFinite(s.costShare) && s.costShare !== Infinity ? formatPercent(s.costShare, 0) : '-'))
  el.appendChild(kv('Maliyet iki kat olsaydı net',
    formatNumber(s.expectancyAtrDoubleCost, 3) + ' ATR',
    sayi(s.expectancyAtrDoubleCost, 0) >= 0 ? 'up' : 'down'))
  if (Number.isFinite(s.breakEvenWinRate)) {
    el.appendChild(kv('Maliyet dahil başa baş isabet', formatPercent(s.breakEvenWinRate, 1),
      sayi(s.winRate, 0) >= s.breakEvenWinRate ? 'up' : 'down'))
  }
  el.appendChild(kv('Beklenti (R)', formatNumber(s.expectancyR, 3) +
    (s.expectancyRCI && Number.isFinite(s.expectancyRCI.lo)
      ? '  [' + formatNumber(s.expectancyRCI.lo, 3) + ', ' + formatNumber(s.expectancyRCI.hi, 3) + ']'
      : ''),
  sayi(s.expectancyR, 0) >= 0 ? 'up' : 'down'))
  el.appendChild(kv('Azami geri çekilme (R)', formatNumber(s.maxDrawdownR, 2), 'down'))

  // KALIBRASYON: sistemin soyledigi oran ile gerceklesen oran. Iyi kalibre
  // bir sistemde ikisi birbirine yakindir; sapma, ekrandaki yuzdeye
  // guvenilemeyecegi anlamina gelir.
  const kalib = Array.isArray(s.calibration) ? s.calibration.filter((k) => k.n > 0) : []
  if (kalib.length > 0) {
    el.appendChild(bolumBasligi('Kalibrasyon (söylenen oran ile gerçekleşen)'))
    el.appendChild(tablo(
      ['Tahmin aralığı', 'İşlem', 'Ortalama tahmin', 'Gerçekleşen', 'Fark'],
      kalib.map((k) => [
        formatPercent(k.from, 0) + ' - ' + formatPercent(k.to, 0),
        tam(k.n),
        k.predMean === null ? '-' : formatPercent(k.predMean, 1),
        k.actual === null ? '-' : formatPercent(k.actual, 1),
        k.predMean === null || k.actual === null
          ? '-'
          : ((k.actual - k.predMean >= 0 ? '+' : '') + formatNumber((k.actual - k.predMean) * 100, 1) + ' puan'),
      ])))
    if (s.brier && Number.isFinite(s.brier.model)) {
      el.appendChild(kv('Brier skoru (küçük daha iyi)',
        formatNumber(s.brier.model, 4) +
        (Number.isFinite(s.brier.base) ? '  (sabit taban tahmini: ' + formatNumber(s.brier.base, 4) + ')' : ''),
        Number.isFinite(s.brier.base) && s.brier.model < s.brier.base ? 'up' : 'down'))
    }
  }

  // FIILEN KULLANILAN AYAR. Test sekmesi bir donem kullanicinin esiklerini
  // motora hic iletmiyordu; ne olculdugu artik ekranda yazili.
  const kullanilan = r.usedCfg || null
  if (kullanilan && kullanilan.signalCfg) {
    const sc = kullanilan.signalCfg
    const oc = kullanilan.outcomeCfg || {}
    el.appendChild(bolumBasligi('Kullanılan ayar'))
    el.appendChild(kv('Benzerlik eşiği', formatNumber(sc.minSimilarity, 2)))
    el.appendChild(kv('En az eşleşme', tam(sc.minMatches)))
    el.appendChild(kv('En az tutma oranı', formatPercent(sc.minWinRate, 0)))
    el.appendChild(kv('En az R/R', formatNumber(sc.minRr, 2)))
    el.appendChild(kv('En az beklenti', formatNumber(sc.minExpectancy, 2)))
    // Kalibrasyon onseli gosterilen orani dogrudan degistirir, bu yuzden
    // "hangi ayarla olculdu" listesinde yer almasi sart.
    el.appendChild(kv('Kalibrasyon önseli', tam(sc.priorStrength) + ' sanal gözlem'))
    if (Number(sc.minLift) > 0) el.appendChild(kv('En az katma değer', formatPercent(sc.minLift, 0)))
    el.appendChild(kv('Hedef (plan)', formatNumber(oc.targetAtr, 2) + ' ATR' +
      (kullanilan.sources && kullanilan.sources.plan ? ' (' + kullanilan.sources.plan + ')' : '')))
    el.appendChild(kv('Ufuk', tam(oc.horizonBars) + ' bar'))
    if (r.memory && r.memory.builtAt) {
      el.appendChild(kv('Hafıza kuruldu', String(r.memory.builtAt).slice(0, 16).replace('T', ' ')))
    }
  }

  // Iki sinyal turu ayri ayri. Toplam rakam, birinin digerini tasidigi
  // durumlari gizler; asil karar bu tabloda verilir.
  const turler = Array.isArray(s.byKind) ? s.byKind : []
  if (turler.length > 0) {
    el.appendChild(bolumBasligi('Sinyal türüne göre'))
    const satirlar = []
    for (let i = 0; i < turler.length; i++) {
      const k = turler[i]
      const katki = Number.isFinite(k.edgePts) ? (k.edgePts >= 0 ? '+' : '') + formatNumber(k.edgePts, 1) : '-'
      const katkiNet = Number.isFinite(k.edgeNetAtr) ? (k.edgeNetAtr >= 0 ? '+' : '') + formatNumber(k.edgeNetAtr, 3) : '-'
      satirlar.push([
        turAdi(k.kind), tam(k.total), tam(k.fired),
        formatPercent(k.winRate, 1),
        Number.isFinite(k.baselineWinRate) ? formatPercent(k.baselineWinRate, 1) : '-',
        katki,
        formatNumber(k.expectancyAtr, 3),
        Number.isFinite(k.baselineExpectancyAtr) ? formatNumber(k.baselineExpectancyAtr, 3) : '-',
        katkiNet,
      ])
    }
    // Her turun tabani KENDI turunun taban oranidir: form ve dokunusun taban
    // oranlari birbirinden cok farklidir, karistirmak sahte katki uretir.
    el.appendChild(tablo(
      ['Tür', 'Olay', 'Sinyal', 'Oran', 'Taban', 'Katkı', 'Beklenti', 'Taban bek.', 'Net katkı'],
      satirlar))
  }

  // ALT KUME KIRILIMI (yalnizca ekonomik takvim dosyasi varsa dolar).
  // Her alt kumenin tabani AYNI ALT KUMENIN ayni turdeki tum olaylaridir;
  // karisik taban veri penceresi karsilastirmasini anlamsiz kilardi.
  // ALT KUME KIRILIMLARI. Her boyut (veri penceresi, ust zaman dilimi bolgesi)
  // kendi icinde tum olaylari boler ve KENDI tabaniyla karsilastirilir.
  const altKumeler = Array.isArray(s.bySubset) ? s.bySubset : []
  if (altKumeler.length > 0) {
    const boyutlar = []
    const boyutMap = new Map()
    for (const a of altKumeler) {
      const ad = a.dim || 'Alt küme'
      if (!boyutMap.has(ad)) { boyutMap.set(ad, []); boyutlar.push(ad) }
      boyutMap.get(ad).push(a)
    }
    for (const ad of boyutlar) {
      el.appendChild(bolumBasligi(ad))
      const akSatirlari = []
      for (const a of boyutMap.get(ad)) {
        akSatirlari.push([
          (a.label || a.subset) + ' - ' + turAdi(a.kind),
          tam(a.total), tam(a.fired),
          Number.isFinite(a.winRate) ? formatPercent(a.winRate, 1) : '-',
          a.winRateCI ? formatPercent(a.winRateCI.lo, 1) + ' - ' + formatPercent(a.winRateCI.hi, 1) : '-',
          Number.isFinite(a.baselineWinRate) ? formatPercent(a.baselineWinRate, 1) : '-',
          Number.isFinite(a.edgePts) ? (a.edgePts >= 0 ? '+' : '') + formatNumber(a.edgePts, 1) : '-',
          Number.isFinite(a.expectancyAtr) ? formatNumber(a.expectancyAtr, 3) : '-',
        ])
      }
      el.appendChild(tablo(
        ['Alt küme', 'Olay', 'Sinyal', 'Oran', '%95 aralık', 'Taban', 'Katkı', 'Beklenti'],
        akSatirlari))
    }
    el.appendChild(h('div', 'small muted',
      'Karar anı bar kapanışıdır ve her alt kümenin tabanı KENDİ alt kümesinin ' +
      'aynı türdeki tüm olaylarıdır. Aralıklar örtüşüyorsa o alt kümenin sonucu ' +
      'değiştirdiği söylenemez. Bu kırılımlar sinyal kararına girmez; veri ' +
      'penceresi kapısını açmak için Ayarlar > Sinyal kararı > "Veri penceresi (dk)".'))
  }

  // Sermaye egrisi
  el.appendChild(bolumBasligi('Sermaye eğrisi (birikimli ATR)'))
  const noktalar = Array.isArray(r.equity) ? r.equity : []
  if (noktalar.length < 2) {
    el.appendChild(h('div', 'small muted', 'Eğri çizmek için yeterli işlem yok.'))
  } else {
    const cnv = document.createElement('canvas')
    cnv.className = 'equity-canvas'
    el.appendChild(cnv)

    const alt = h('div', 'kv')
    alt.appendChild(h('span', null, formatDate(noktalar[0].time) + ' - ' + formatDate(noktalar[noktalar.length - 1].time)))
    const sonDeger = sayi(noktalar[noktalar.length - 1].value, 0)
    alt.appendChild(h('span', sonDeger >= 0 ? 'up' : 'down', formatNumber(sonDeger, 2) + ' ATR'))
    el.appendChild(alt)

    const degerler = new Array(noktalar.length)
    for (let i = 0; i < noktalar.length; i++) degerler[i] = sayi(noktalar[i].value, NaN)
    drawSparkline(cnv, degerler, {
      color: sonDeger >= 0 ? RENK.up : RENK.down,
      fill: sonDeger >= 0 ? 'rgba(38,166,154,0.16)' : 'rgba(239,83,80,0.16)',
      baseline: 0,
      lineWidth: 1.5,
    })
  }

  // Yillara gore
  el.appendChild(bolumBasligi('Yıllara göre'))
  const yillar = Array.isArray(r.byYear) ? r.byYear : []
  if (yillar.length === 0) {
    el.appendChild(h('div', 'small muted', 'Yıl kırılımı yok.'))
  } else {
    const satirlar = []
    for (let i = 0; i < yillar.length; i++) {
      const y = yillar[i]
      // Yilin tabani, o yil tetiklenen islemlerin tur karisimiyla agirliklanir.
      satirlar.push([
        yil(y.year), tam(y.fired), tam(y.wins), tam(y.losses),
        formatPercent(y.winRate, 1),
        Number.isFinite(y.baselineWinRate) ? formatPercent(y.baselineWinRate, 1) : '-',
        Number.isFinite(y.edgePts) ? (y.edgePts >= 0 ? '+' : '') + formatNumber(y.edgePts, 1) : '-',
        formatNumber(y.expectancyAtr, 3),
        Number.isFinite(y.edgeNetAtr) ? (y.edgeNetAtr >= 0 ? '+' : '') + formatNumber(y.edgeNetAtr, 3) : '-',
      ])
    }
    el.appendChild(tablo(
      ['Yıl', 'Sinyal', 'Kazanan', 'Kaybeden', 'Oran', 'Taban', 'Katkı', 'Beklenti', 'Net katkı'],
      satirlar))
  }

  // Son islemler
  const islemler = Array.isArray(r.trades) ? r.trades : []
  if (islemler.length > 0) {
    el.appendChild(bolumBasligi('Son işlemler'))
    const bas = Math.max(0, islemler.length - 100)
    const satirlar = []
    for (let i = islemler.length - 1; i >= bas; i--) {
      const t = islemler[i]
      satirlar.push([
        formatDateTime(t.time),
        t.direction === 'SELL' ? 'SAT' : 'AL',
        t.kind === 'form' ? 'Oluşum' : 'Dokunuş',
        formatPercent(t.winRate, 0),
        t.win ? 'Kazanç' : 'Kayıp',
        formatNumber(t.pnlAtr, 2),
        formatNumber(t.equityAtr, 2),
      ])
    }
    el.appendChild(tablo(['Zaman', 'Yön', 'Tür', 'Beklenen', 'Sonuç', 'Kazanç', 'Birikim'], satirlar))
  }
}

/* ------------------------------------------------------------------ */
/* renderLiveLog                                                       */
/* ------------------------------------------------------------------ */

/**
 * Canli sinyal gunlugunun ozeti. Test panelinin ALTINA cizilir.
 *
 * Neden: canli uretilen sinyaller hicbir yere kaydedilmiyordu, bu yuzden
 * canli performans ile Test sekmesinde olculen rakam hic karsilastirilamiyordu.
 * Ayni satirda "canli" ve "testte olculen" degerler yan yana durur, aradaki
 * fark (drift) acikca yazilir.
 *
 * @param {HTMLElement} el Govde kabi (Test panelinin icine eklenir)
 * @param {object|null} log `engine:live-log` ozeti
 * @param {{test?:object|null}} [opts] test: son `engine:backtest` sonucu
 */
export function renderLiveLog(el, log, opts) {
  if (!el) return
  const o = opts || {}
  el.appendChild(bolumBasligi('Canlı sinyal günlüğü'))

  const g = log || null
  if (!g || !g.found || sayi(g.count, 0) === 0) {
    el.appendChild(h('div', 'small muted', 'Henüz canlı sinyal kaydı yok.'))
    return
  }

  const etiketlenen = sayi(g.labeled, 0)
  const canliOran = Number.isFinite(g.winRate) ? g.winRate : null
  const canliBeklenti = Number.isFinite(g.expectancyAtr) ? g.expectancyAtr : null

  el.appendChild(statIzgara([
    stat('Kayıt', tam(g.count)),
    stat('Tetiklenen', tam(g.fired)),
    stat('Etiketlenen', tam(etiketlenen)),
    stat('Canlı başarı oranı', canliOran === null ? '-' : formatPercent(canliOran, 1),
      canliOran === null ? 'muted' : (canliOran >= 0.5 ? 'up' : 'down')),
    stat('Net ATR', formatNumber(g.netAtr, 2), sayi(g.netAtr, 0) >= 0 ? 'up' : 'down'),
    stat('Gecikmeli', tam(g.stale)),
  ]))

  // KARSILASTIRMA: ayni olcuyu test ozeti de verir. Etiketlenen kayit yoksa
  // kiyas yapilmaz, cunku canli tarafta daha hicbir sonuc belli degil.
  const test = o.test && o.test.summary ? o.test.summary : null
  const testOran = test && Number.isFinite(test.winRate) ? test.winRate : null
  const testBeklenti = test && Number.isFinite(test.expectancyAtr) ? test.expectancyAtr : null

  el.appendChild(kv('Testte ölçülen başarı oranı',
    testOran === null ? '-' : formatPercent(testOran, 1), 'muted'))
  el.appendChild(kv('Testte ölçülen beklenti',
    testBeklenti === null ? '-' : formatNumber(testBeklenti, 3) + ' ATR', 'muted'))

  if (etiketlenen === 0) {
    el.appendChild(h('div', 'small muted',
      'Canlı kayıtların ufku henüz dolmadı, sonuçlar belli olunca karşılaştırma yazılacak.'))
  } else {
    const oranFark = canliOran !== null && testOran !== null ? (canliOran - testOran) * 100 : null
    const beklentiFark = canliBeklenti !== null && testBeklenti !== null
      ? canliBeklenti - testBeklenti
      : null
    el.appendChild(kv('Fark (isabet)',
      oranFark === null ? '-' : (oranFark >= 0 ? '+' : '') + formatNumber(oranFark, 1) + ' puan',
      oranFark === null ? 'muted' : (oranFark >= 0 ? 'up' : 'down')))
    el.appendChild(kv('Fark (beklenti)',
      beklentiFark === null ? '-' : (beklentiFark >= 0 ? '+' : '') + formatNumber(beklentiFark, 3) + ' ATR',
      beklentiFark === null ? 'muted' : (beklentiFark >= 0 ? 'up' : 'down')))
    el.appendChild(h('div', 'small muted',
      'Canlı beklenti ' + formatNumber(canliBeklenti, 3) + ' ATR, ' + tam(etiketlenen) +
      ' sonuçlanmış sinyal üzerinden. Az sayıda kayıtta fark tesadüf olabilir.'))
  }

  const kayitlar = Array.isArray(g.records) ? g.records : []
  if (kayitlar.length > 0) {
    const satirlar = []
    const sinir = Math.min(kayitlar.length, 50)
    for (let i = 0; i < sinir; i++) {
      const k = kayitlar[i]
      satirlar.push([
        formatDateTime(k.time),
        k.direction === 'SELL' ? 'SAT' : 'AL',
        k.kind === 'form' ? 'Oluşum' : 'Dokunuş',
        k.fired ? 'Evet' : 'Hayır',
        k.outcome ? sonucAdi(k.outcome) : 'Bekliyor',
        Number.isFinite(k.pnlAtr) ? formatNumber(k.pnlAtr, 2) : '-',
        sayi(k.ageBars, 0) > 1 ? formatNumber(k.ageBars, 1) : '-',
      ])
    }
    el.appendChild(tablo(['Zaman', 'Yön', 'Tür', 'Tetik', 'Sonuç', 'Kazanç', 'Gecikme'], satirlar))
  }
}

/** Sonuc etiketinin Turkce adi. */
function sonucAdi(outcome) {
  if (outcome === 'respect') return 'Bölge tuttu'
  if (outcome === 'break') return 'Bölge kırıldı'
  if (outcome === 'nofill') return 'Emir dolmadı'
  return 'Zaman aşımı'
}
