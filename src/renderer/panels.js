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
 *   renderSettings, renderBacktest, drawSparkline
 * (Ek olarak app.js'in de kullandigi bicimlendirme yardimcilari disa acilir.)
 */

const TF_SECENEKLERI = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

const SEANS_ADLARI = { Asia: 'Asya', London: 'Londra', 'New York': 'New York', Other: 'Diğer' }

const RENK = { up: '#26a69a', down: '#ef5350', dim: '#787b86', accent: '#2962ff', warn: '#f2b40e' }

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
 * Kayitta gercek sekil vektoru varsa (shape/values/closes) o kullanilir,
 * yoksa mfeAtr / maeAtr degerlerinden seyir taslagi cizilir.
 * @returns {{degerler:number[], isaret:number, gercek:boolean}}
 */
function eslesmeSerisi(m) {
  const ham = m && (m.shape || m.values || m.closes)
  if (ham && ham.length >= 4) {
    const d = new Array(ham.length)
    for (let i = 0; i < ham.length; i++) d[i] = sayi(ham[i], NaN)
    return { degerler: d, isaret: d.length - 1, gercek: true }
  }
  const mfe = Math.abs(sayi(m && m.mfeAtr, 0))
  const mae = -Math.abs(sayi(m && m.maeAtr, 0))
  const basarili = !!(m && m.success)
  const once = basarili ? mae * 0.45 : mfe * 0.45
  const sonra = basarili ? mfe : mae
  return {
    degerler: [0, 0, 0, 0, 0, 0, 0, 0, once * 0.5, once, sonra * 0.55, sonra, sonra * 0.9],
    isaret: 7,
    gercek: false,
  }
}

/* ------------------------------------------------------------------ */
/* Olay turu yardimcilari                                              */
/* ------------------------------------------------------------------ */

/** Olay turunun okunabilir adi: kutu olusumu mu, bolgeye dokunus mu. */
function turAdi(kind) {
  return kind === 'form' ? 'Kutu oluşumu' : 'Bölge dokunuşu'
}

/** Liste satirlarinda yer kaplamayan kisa tur rozeti. */
function turRozeti(kind) {
  const e = h('span', 'badge tiny', kind === 'form' ? 'OLUŞUM' : 'DOKUNUŞ')
  e.title = kind === 'form'
    ? 'Kutunun doğduğu an, giriş onay barının kapanışı'
    : 'Kutuya ilk dokunuş, giriş bölge kenarı'
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

/** outcome etiketinin okunabilir hali. */
function outcomeAdi(outcome) {
  if (outcome === 'respect') return 'Bölge tuttu'
  if (outcome === 'break') return 'Bölge kırıldı'
  if (outcome === 'timeout') return 'Zaman aşımı'
  return 'Sonuç henüz belli değil'
}

/* ------------------------------------------------------------------ */
/* renderSignals                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sinyal listesini cizer (yalnizca satirlar, baslik serisi index.html'de).
 * @param {HTMLElement} el Liste kabi (ornek: #signalList)
 * @param {Array<object>} signals
 * @param {{onSelect?:(s:object)=>void, selectedId?:*, filter?:string}} [opts]
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

  const adet = Math.min(liste.length, AZAMI_SATIR)
  for (let i = 0; i < adet; i++) {
    const s = liste[i]
    const alis = s.direction !== 'SELL'
    const satir = h('div', 'row ' + (alis ? 'buy' : 'sell') + (s.fired ? '' : ' dim') +
      (o.selectedId !== undefined && o.selectedId !== null && String(s.id) === String(o.selectedId) ? ' selected' : ''))

    satir.appendChild(yonEtiketi(s.direction))

    const orta = h('span', 'row-main')
    orta.appendChild(document.createTextNode(formatDateTime(s.time) + '  ' + formatPrice(s.price)))
    orta.appendChild(turRozeti(s.kind))
    const altMetin = s.fired
      ? (tam(s.matchCount) + ' benzer kayıt, güven ' + formatPercent(s.confidence, 0))
      : ('Üretilmedi: ' + (Array.isArray(s.reasons) && s.reasons.length
        ? String(s.reasons[s.reasons.length - 1])
        : 'eşikler geçilmedi'))
    orta.appendChild(h('span', 'row-sub', altMetin))
    satir.appendChild(orta)

    const sag = h('span', 'row-side')
    const sonuc = sonucBilgisi(s)
    if (sonuc.hazir) {
      // Gerceklesen sonuc, beklentiden daha onemli oldugu icin ust satirda.
      const rozet = h('span', sonuc.sinif, sonuc.etiket)
      rozet.title = outcomeAdi(s.outcome) + ', beklenti %' +
        Math.round(sayi(s.winRate, 0) * 100) + ', R/R ' + formatNumber(s.rr, 2)
      sag.appendChild(rozet)
      sag.appendChild(h('span', 'row-sub ' + (sayi(s.pnlAtr, 0) >= 0 ? 'up' : 'down'),
        (sayi(s.pnlAtr, 0) >= 0 ? '+' : '') + formatNumber(s.pnlAtr, 2) + ' ATR'))
    } else {
      const oran = h('span', sayi(s.winRate, 0) >= 0.5 ? 'up' : 'down', formatPercent(s.winRate, 0))
      oran.title = 'Benzer geçmiş kurulumların tutma oranı'
      sag.appendChild(oran)
      sag.appendChild(h('span', 'row-sub', 'RR ' + formatNumber(s.rr, 2)))
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
  const yonSinifi = alis ? 'up' : 'down'

  el.appendChild(bolumBasligi((alis ? 'AL sinyali' : 'SAT sinyali') + ' - ' +
    turAdi(signal.kind) + ' - ' + formatDateTime(signal.time)))

  el.appendChild(statIzgara([
    stat('Güven skoru', formatPercent(signal.confidence, 0), yonSinifi),
    stat('Başarı oranı', formatPercent(signal.winRate, 0), sayi(signal.winRate, 0) >= 0.5 ? 'up' : 'down'),
    stat('Benzer kayıt', tam(signal.matchCount)),
    stat('Ort. benzerlik', formatNumber(signal.avgSimilarity, 3)),
  ]))

  el.appendChild(kv('En yüksek benzerlik', formatNumber(signal.bestSimilarity, 3)))
  el.appendChild(kv('Beklenen lehte hareket', formatNumber(signal.expectedMfeAtr, 2) + ' ATR'))
  el.appendChild(kv('Beklenen aleyhte hareket', formatNumber(signal.expectedMaeAtr, 2) + ' ATR'))
  el.appendChild(kv('Bölge aralığı', formatPrice(signal.zoneBottom) + ' - ' + formatPrice(signal.zoneTop)))
  el.appendChild(kv('Sinyal türü', signal.kind === 'form'
    ? 'Kutu oluşumu, giriş onay barının kapanışı'
    : 'Bölgeye geri dönüş, giriş bölge kenarına limit emir'))
  el.appendChild(kv('Durum', signal.fired ? 'Sinyal üretildi' : 'Eşikler geçilmedi',
    signal.fired ? 'up' : 'muted'))

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

  // En yakin ortak yapi (prototip)
  el.appendChild(bolumBasligi('En yakın ortak yapı'))
  el.appendChild(kv('Yapı', signal.prototypeLabel && String(signal.prototypeLabel).length
    ? String(signal.prototypeLabel) : 'Eşleşen ortak yapı bulunamadı'))
  if (signal.prototypeId !== null && signal.prototypeId !== undefined) {
    el.appendChild(kv('Yapı numarası', '#' + tam(signal.prototypeId)))
  }
  el.appendChild(kv('Yapı benzerliği', formatNumber(signal.prototypeSim, 3)))

  // Islem plani
  el.appendChild(bolumBasligi('İşlem planı'))
  const giris = sayi(signal.entry, 0)
  function uzaklik(p) {
    if (!Number.isFinite(p) || p === 0 || giris === 0) return '-'
    const fark = p - giris
    const yuzde = (fark / giris) * 100
    return (fark >= 0 ? '+' : '') + formatPrice(fark) + ' (' + (yuzde >= 0 ? '+' : '') + formatNumber(yuzde, 2) + '%)'
  }
  el.appendChild(tablo(['Seviye', 'Fiyat', 'Girişe uzaklık'], [
    ['Giriş', formatPrice(giris), '-'],
    ['TP1', formatPrice(signal.tp1), uzaklik(sayi(signal.tp1, NaN))],
    ['TP2', formatPrice(signal.tp2), uzaklik(sayi(signal.tp2, NaN))],
    ['SL', formatPrice(signal.sl), uzaklik(sayi(signal.sl, NaN))],
    ['RR', formatNumber(signal.rr, 2), '-'],
  ]))

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
  el.appendChild(bolumBasligi('Benzer geçmiş örnekler (' + tam(eslesmeler.length) + ')'))
  if (eslesmeler.length === 0) {
    el.appendChild(h('div', 'small muted', 'Eşik üstünde benzer kayıt bulunamadı.'))
    return
  }

  let taslakVar = false
  const cizimler = []
  const ornegeGit = typeof o.onMatchSelect === 'function' ? o.onMatchSelect : null

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
    sag.appendChild(h('span', 'row-sub ' + (m.success ? 'up' : 'down'), m.success ? 'Saygı' : 'Kırılım'))
    sag.appendChild(h('span', 'row-sub',
      '+' + formatNumber(Math.abs(sayi(m.mfeAtr, 0)), 2) + ' / -' + formatNumber(Math.abs(sayi(m.maeAtr, 0)), 2)))
    satir.appendChild(sag)

    el.appendChild(satir)

    const seri = eslesmeSerisi(m)
    if (!seri.gercek) taslakVar = true
    cizimler.push({ cnv, seri, basarili: !!m.success })
  }

  // Canvas olculeri yerlesim sonrasi bellidir, cizimi simdi yap.
  for (let i = 0; i < cizimler.length; i++) {
    const c = cizimler[i]
    drawSparkline(c.cnv, c.seri.degerler, {
      color: c.basarili ? RENK.up : RENK.down,
      fill: c.basarili ? 'rgba(38,166,154,0.14)' : 'rgba(239,83,80,0.14)',
      markerIndex: c.seri.isaret,
      baseline: c.seri.gercek ? undefined : 0,
    })
  }

  const notlar = [taslakVar
    ? 'Mini grafikler seyir taslağıdır: kesik dikey çizgi sinyal anını, sonrası lehte ve aleyhte azami hareketi gösterir.'
    : 'Kesik dikey çizgi sinyal anını gösterir.']
  if (ornegeGit) notlar.push('Bir örneğe tıklayınca grafik o tarihe gider.')
  for (let i = 0; i < notlar.length; i++) {
    el.appendChild(h('div', 'small muted', notlar[i]))
  }
}

/* ------------------------------------------------------------------ */
/* renderZones                                                         */
/* ------------------------------------------------------------------ */

/**
 * Bolge listesini cizer.
 * @param {HTMLElement} el Liste kabi (ornek: #zoneList)
 * @param {Array<object>} zones
 * @param {{onSelect?:(z:object)=>void, selectedId?:*, filter?:string}} [opts]
 */
export function renderZones(el, zones, opts) {
  if (!el) return
  const o = opts || {}
  bosalt(el)

  const hepsi = Array.isArray(zones) ? zones.slice() : []
  hepsi.sort((a, b) => sayi(b && b.createdTime, 0) - sayi(a && a.createdTime, 0))

  const suzgec = o.filter || 'all'
  const liste = hepsi.filter((z) => {
    if (!z) return false
    if (suzgec === 'active') return !z.broken
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
    const satir = h('div', 'row ' + (destek ? 'buy' : 'sell') + (z.broken ? ' dim' : '') +
      (o.selectedId !== undefined && o.selectedId !== null && String(z.id) === String(o.selectedId) ? ' selected' : ''))

    satir.appendChild(h('span', 'tag ' + (destek ? 'buy' : 'sell'), destek ? 'DESTEK' : 'DİRENÇ'))

    const orta = h('span', 'row-main')
    orta.appendChild(document.createTextNode(formatPrice(z.bottom) + ' - ' + formatPrice(z.top)))
    orta.appendChild(h('span', 'row-sub',
      formatDateTime(z.createdTime) + '  akış ' + formatNumber(z.flow, 2)))
    satir.appendChild(orta)

    const sag = h('span', 'row-side')
    sag.appendChild(h('span', z.broken ? 'muted' : (destek ? 'up' : 'down'), z.broken ? 'Kırıldı' : 'Aktif'))
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

  // Ortak yapilar (prototipler)
  el.appendChild(bolumBasligi('Ortak yapılar (' + tam(protolar.length) + ')'))
  if (protolar.length === 0) {
    el.appendChild(h('div', 'small muted', 'Ortak yapı çıkarılmadı, tarama sonrası oluşur.'))
    return
  }

  const cizimler = []
  for (let i = 0; i < protolar.length; i++) {
    const p = protolar[i]
    const kutu = h('div', 'stat')
    kutu.style.marginBottom = '5px'

    const bas = h('div', 'kv')
    bas.appendChild(h('span', null, p.label ? String(p.label) : ('Yapı #' + tam(p.id))))
    bas.appendChild(h('span', sayi(p.winRate, 0) >= 0.5 ? 'up' : 'down', formatPercent(p.winRate, 0)))
    kutu.appendChild(bas)

    const cnv = document.createElement('canvas')
    cnv.className = 'spark'
    kutu.appendChild(cnv)

    kutu.appendChild(h('div', 'row-sub',
      tam(p.size) + ' üye, lehte ' + formatNumber(p.avgMfeAtr, 2) +
      ' ATR, aleyhte ' + formatNumber(p.avgMaeAtr, 2) + ' ATR'))
    el.appendChild(kutu)

    const merkez = p.centroid
    const degerler = []
    if (merkez && merkez.length) {
      for (let j = 0; j < merkez.length; j++) degerler.push(sayi(merkez[j], NaN))
    }
    cizimler.push({ cnv, degerler, iyi: sayi(p.winRate, 0) >= 0.5 })
  }
  for (let i = 0; i < cizimler.length; i++) {
    drawSparkline(cizimler[i].cnv, cizimler[i].degerler, {
      color: cizimler[i].iyi ? RENK.up : RENK.down,
      fill: cizimler[i].iyi ? 'rgba(38,166,154,0.14)' : 'rgba(239,83,80,0.14)',
      lineWidth: 1.5,
    })
  }
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
        { yol: 'indicatorParams.minScoreForSignal', ad: 'En az skor', tip: 'sayi', adim: 1, min: 0, max: 5,
          not: 'Beş bileşenden kaçı doğru olursa olay "nitelikli" sayılır (akış, trend, seans, fitil reddi, hacim).' },
        { yol: 'indicatorParams.strongScoreLevel', ad: 'Güçlü sinyal skoru', tip: 'sayi', adim: 1, min: 0, max: 5,
          not: 'Bu skorun üstündeki olaylar güçlü olarak işaretlenir.' },
        { yol: 'indicatorParams.strongFlowLevel', ad: 'Güçlü akış eşiği', tip: 'sayi', adim: 0.5, min: 1, max: 10,
          not: 'Akış skoru bunun üstündeyse skorun akış bileşeni sayılır.' },
        { yol: 'indicatorParams.wickMinRatio', ad: 'Fitil reddi oranı', tip: 'sayi', adim: 0.05, min: 0, max: 1,
          not: 'Olay barının fitili bar aralığının bu kadarını kaplarsa red bileşeni sayılır.' },
        { yol: 'indicatorParams.trendTf', ad: 'Trend zaman dilimi', tip: 'secim',
          secenekler: TF_SECENEKLERI.map((t) => ({ deger: t, ad: t })),
          not: 'Üst zaman dilimi trend süzgeci, büyük seçilirse seri yeniden örneklenir. Kutu oluşumunu etkilemez, yalnızca skora girer.' },
      ],
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
      baslik: 'Sinyal motoru',
      bozar: false,
      alanlar: [
        { yol: 'signalCfg.k', ad: 'Komşu sayısı (k)', tip: 'sayi', adim: 1, min: 1,
          not: 'Hafızadan alınan en benzer kayıt sayısı.' },
        { yol: 'signalCfg.minSimilarity', ad: 'En az benzerlik', tip: 'sayi', adim: 0.01, min: 0, max: 1,
          not: 'Bu eşiğin altındaki eşleşmeler sayılmaz, 0 ile 1 arası.' },
        { yol: 'signalCfg.minMatches', ad: 'En az eşleşme', tip: 'sayi', adim: 1, min: 1,
          not: 'Sinyal üretmek için gereken eşik üstü kayıt sayısı.' },
        { yol: 'signalCfg.minWinRate', ad: 'En az başarı oranı', tip: 'sayi', adim: 0.01, min: 0, max: 1,
          not: 'Benzer kayıtlarda aranan asgari başarı oranı, 0,60 yüzde 60 demektir.' },
      ],
    },
    {
      baslik: 'Sağlayıcı ve anahtarlar',
      bozar: false,
      onaylar: [
        { yol: 'autoStartLive', ad: 'Program açılınca canlı takibi başlat' },
        { yol: 'autoPrepareOnTfChange', ad: 'Zaman dilimi değişince eksikleri tamamla' },
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
    : [
      { deger: 'histdata', ad: 'HistData' },
      { deger: 'yahoo', ad: 'Yahoo (vekil)' },
      { deger: 'binance', ad: 'Binance (vekil)' },
      { deger: 'okx', ad: 'OKX (vekil)' },
      { deger: 'twelvedata', ad: 'TwelveData' },
      { deger: 'polygon', ad: 'Polygon' },
    ]

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
    if (typeof o.onChange === 'function') {
      o.onChange({}, { path: yol, value: undefined, invalidatesMemory: false, patch: yama })
    }
  }

  /** Bir alan degistiginde yamayi gunceller ve onChange cagirir. */
  function degisti(yol, deger, bozarMi) {
    yolaYaz(yama, yol, deger)
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
 * @param {{onRun?:()=>void, running?:boolean}} [opts]
 */
export function renderBacktest(el, result, opts) {
  if (!el) return
  const o = opts || {}
  bosalt(el)

  const ayak = h('div', 'panel-foot')
  const calistir = h('button', 'btn btn-primary mini', o.running ? 'Test çalışıyor...' : 'Testi Çalıştır')
  calistir.type = 'button'
  calistir.disabled = !!o.running
  calistir.addEventListener('click', () => {
    if (typeof o.onRun === 'function') o.onRun()
  })
  ayak.appendChild(calistir)
  ayak.appendChild(h('span', 'small muted',
    'Her olay yalnızca kendinden önceki hafızayla değerlendirilir, ileriye bakma yoktur.'))
  el.appendChild(ayak)

  const r = result || null
  if (!r || !r.summary) {
    el.appendChild(bosKutu('Henüz test sonucu yok.'))
    return
  }
  const s = r.summary

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

  el.appendChild(bolumBasligi('Özet (' + tam(s.total) + ' olay değerlendirildi)'))

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
