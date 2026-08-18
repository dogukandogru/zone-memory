/**
 * chart.js - Ana mum grafigi gorunumu.
 *
 * lightweight-charts SURUM 4.2.3 API'si kullanilir (v5 API'si degil):
 *   LightweightCharts.createChart(el, opts)
 *   chart.addCandlestickSeries(opts)
 *   series.setMarkers([...]) / series.createPriceLine({...})
 *   chart.timeScale().subscribeVisibleLogicalRangeChange(cb)
 *
 * Kutuphane index.html icinde <script src> ile yuklenir ve global
 * `LightweightCharts` nesnesini verir; burada import EDILMEZ.
 *
 * Tum zaman degerleri UNIX SANIYEDIR (UTC). Ekranda gosterilen tarih ve
 * saatler Europe/Istanbul saatine cevrilir.
 *
 * CONTRACTS.md 19. bolum, createChartView disa acilan API:
 *   chart, candleSeries, setBars, updateBar, setMarkers, setPriceLines,
 *   clearPriceLines, fitContent, scrollToTime, onVisibleRangeChange,
 *   priceToY, timeToX, resize, destroy
 * Sozlesme disinda kalan ekler (overlay.js ve app.js icin kolaylik):
 *   volumeSeries, getPaneSize, getVisibleTimeRange, onCrosshairMove,
 *   onMarkerClick, barCount, lastBarTime, xToTime, isDestroyed
 */

const TZ = 'Europe/Istanbul';

const COLOR = {
  bg: '#131722',
  grid: '#1e222d',
  border: '#2a2e39',
  text: '#d1d4dc',
  dim: '#787b86',
  accent: '#2962ff',
  up: '#26a69a',
  down: '#ef5350',
};

// Tarih bicimlendiricileri bir kez kurulur, her bar icin yeniden yaratilmaz.
const fmtHm = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtDayMon = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ, day: '2-digit', month: '2-digit',
});
const fmtMonYear = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ, month: 'short', year: '2-digit',
});
const fmtYear = new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, year: 'numeric' });
const fmtFull = new Intl.DateTimeFormat('tr-TR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Bir UNIX saniye degerini Istanbul saatine gore tam metne cevirir. */
function formatFullTime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return String(sec == null ? '' : sec);
  return fmtFull.format(new Date(sec * 1000));
}

/** Zaman ekseni etiketleri. tickMarkType: 0 Yil, 1 Ay, 2 Gun, 3 Saat, 4 Saniye. */
function tickMarkFormatter(time, tickMarkType) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '';
  const d = new Date(time * 1000);
  switch (tickMarkType) {
    case 0: return fmtYear.format(d);
    case 1: return fmtMonYear.format(d);
    // Turkce yazimda gun.ay ayraci noktadir, ICU bazi surumlerde egik cizgi verir.
    case 2: return fmtDayMon.format(d).replace(/\//g, '.');
    default: return fmtHm.format(d);
  }
}

/** Sayi sonlu mu (NaN ve sonsuz eler). */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Girdi normalize eder: hem `toBars` cikti dizisini hem de sutunsal Series
 * nesnesini kabul eder. Gecersiz ve sira disi barlar atilir.
 * @returns {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>}
 */
function normalizeBars(input) {
  const out = [];
  if (!input) return out;

  // Sutunsal Series geldiyse duz nesnelere cevir.
  if (!Array.isArray(input) && input.time && typeof input.length === 'number') {
    const n = input.length | 0;
    const t = input.time, o = input.open, h = input.high, l = input.low, c = input.close, v = input.volume;
    let prev = -Infinity;
    for (let i = 0; i < n; i++) {
      const tt = t[i];
      if (!isNum(tt) || tt <= prev) continue;
      if (!isNum(o[i]) || !isNum(h[i]) || !isNum(l[i]) || !isNum(c[i])) continue;
      prev = tt;
      out.push({ time: tt, open: o[i], high: h[i], low: l[i], close: c[i], volume: v && isNum(v[i]) ? v[i] : 0 });
    }
    return out;
  }

  if (!Array.isArray(input)) return out;
  let prev = -Infinity;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (!b) continue;
    const tt = +b.time;
    if (!isNum(tt) || tt <= prev) continue;
    if (!isNum(+b.open) || !isNum(+b.high) || !isNum(+b.low) || !isNum(+b.close)) continue;
    prev = tt;
    out.push({
      time: tt, open: +b.open, high: +b.high, low: +b.low, close: +b.close,
      volume: isNum(+b.volume) ? +b.volume : 0,
    });
  }
  return out;
}

/**
 * Grafik gorunumu olusturur.
 * @param {HTMLElement} container Konumu `relative` olan kap (ornek: #chartWrap)
 * @returns {object} Yukarida listelenen API
 */
export function createChartView(container) {
  if (!container) throw new Error('createChartView: kap elemani gerekli');
  const LW = globalThis.LightweightCharts;
  if (!LW || typeof LW.createChart !== 'function') {
    throw new Error('lightweight-charts yuklenmedi: index.html icindeki <script src> yolunu kontrol edin');
  }

  const crosshairMode = LW.CrosshairMode ? LW.CrosshairMode.Normal : 0;
  const dashed = LW.LineStyle ? LW.LineStyle.Dashed : 2;

  const chart = LW.createChart(container, {
    width: Math.max(1, container.clientWidth),
    height: Math.max(1, container.clientHeight),
    layout: {
      background: { type: 'solid', color: COLOR.bg },
      textColor: COLOR.text,
      fontSize: 11,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    },
    grid: {
      vertLines: { color: COLOR.grid },
      horzLines: { color: COLOR.grid },
    },
    crosshair: {
      mode: crosshairMode,
      vertLine: { color: '#4c525e', width: 1, style: dashed, labelBackgroundColor: '#363c4e' },
      horzLine: { color: '#4c525e', width: 1, style: dashed, labelBackgroundColor: '#363c4e' },
    },
    rightPriceScale: {
      visible: true,
      borderColor: COLOR.border,
      scaleMargins: { top: 0.08, bottom: 0.22 },
      entireTextOnly: true,
    },
    leftPriceScale: { visible: false },
    timeScale: {
      borderColor: COLOR.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 6,
      barSpacing: 8,
      minBarSpacing: 0.4,
      tickMarkFormatter,
    },
    localization: {
      locale: 'tr-TR',
      dateFormat: 'dd.MM.yyyy',
      timeFormatter: formatFullTime,
      priceFormatter: (p) => (isNum(p) ? p.toFixed(2) : ''),
    },
    watermark: { visible: false },
    handleScale: { axisPressedMouseMove: { time: true, price: true } },
    kineticScroll: { mouse: false, touch: true },
    autoSize: false,
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: COLOR.up,
    downColor: COLOR.down,
    borderUpColor: COLOR.up,
    borderDownColor: COLOR.down,
    wickUpColor: COLOR.up,
    wickDownColor: COLOR.down,
    borderVisible: true,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    priceLineVisible: true,
    priceLineColor: COLOR.dim,
    priceLineStyle: dashed,
    lastValueVisible: true,
  });

  // Hacim, kendi ust uste binen olceginde alt seride cizilir.
  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    color: 'rgba(38, 166, 154, 0.35)',
    priceLineVisible: false,
    lastValueVisible: false,
  });
  try {
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  } catch (_e) { /* eski surumde olcek ayari yoksa gormezden gel */ }

  // ---------------------------------------------------------------------
  // Zaman <-> mantiksal indeks cevrimi.
  // timeToCoordinate yalnizca veride var olan zamanlar icin calisir; bolge
  // kutulari son barin otesine uzayabildigi icin mantiksal indeks uzerinden
  // dogrusal cevrim yapilir.
  // ---------------------------------------------------------------------
  let times = new Float64Array(0);   // bar zamanlari, artan sirali
  let count = 0;
  let stepSec = 60;                  // barlar arasi tipik mesafe
  let destroyed = false;

  function ensureCapacity(n) {
    if (n <= times.length) return;
    let cap = times.length > 0 ? times.length : 1024;
    while (cap < n) cap *= 2;
    const next = new Float64Array(cap);
    next.set(times.subarray(0, count));
    times = next;
  }

  function recomputeStep() {
    if (count < 2) return;
    // Son 200 barin en kucuk farki tipik bar araligini verir (bosluklara dayanikli).
    const from = Math.max(1, count - 200);
    let best = Infinity;
    for (let i = from; i < count; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0 && d < best) best = d;
    }
    if (Number.isFinite(best) && best > 0) stepSec = best;
  }

  /** Zamandan kesirli mantiksal indeks. Veri disina dogrusal uzatilir. */
  function timeToLogical(t) {
    if (count === 0 || !isNum(t)) return null;
    if (t <= times[0]) return (t - times[0]) / stepSec;
    const last = count - 1;
    if (t >= times[last]) return last + (t - times[last]) / stepSec;
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    const span = times[hi] - times[lo];
    return span > 0 ? lo + (t - times[lo]) / span : lo;
  }

  /** Kesirli mantiksal indeksten zamana. */
  function logicalToTime(l) {
    if (count === 0 || !isNum(l)) return null;
    const last = count - 1;
    if (l <= 0) return times[0] + l * stepSec;
    if (l >= last) return times[last] + (l - last) * stepSec;
    const i = Math.floor(l);
    const f = l - i;
    return times[i] + f * (times[i + 1] - times[i]);
  }

  // ---------------------------------------------------------------------
  // Gorunur aralik yayinlama
  // ---------------------------------------------------------------------
  const rangeListeners = [];
  const crosshairListeners = [];

  function getVisibleTimeRange() {
    if (destroyed || count === 0) return null;
    let lr = null;
    try { lr = chart.timeScale().getVisibleLogicalRange(); } catch (_e) { return null; }
    if (!lr) return null;
    const from = logicalToTime(lr.from);
    const to = logicalToTime(lr.to);
    if (from == null || to == null) return null;
    return { from, to };
  }

  function emitRange() {
    if (rangeListeners.length === 0) return;
    const r = getVisibleTimeRange();
    for (let i = 0; i < rangeListeners.length; i++) {
      try { rangeListeners[i](r); } catch (_e) { /* dinleyici hatasi grafigi bozmasin */ }
    }
  }

  function onLogicalRangeChange() { emitRange(); }
  chart.timeScale().subscribeVisibleLogicalRangeChange(onLogicalRangeChange);

  // Isaret (marker) tiklamasi: setMarkers ile verilen isaretlerde `id` alani
  // varsa lightweight-charts tiklanan isaretin kimligini `hoveredObjectId`
  // olarak bildirir.
  const markerClickListeners = [];

  function onChartClick(param) {
    if (markerClickListeners.length === 0) return;
    if (!param || param.hoveredObjectId === undefined || param.hoveredObjectId === null) return;
    const bilgi = { id: param.hoveredObjectId, time: param.time != null ? param.time : null, point: param.point || null };
    for (let i = 0; i < markerClickListeners.length; i++) {
      try { markerClickListeners[i](bilgi); } catch (_e) { /* yoksay */ }
    }
  }
  chart.subscribeClick(onChartClick);

  function onCrosshair(param) {
    if (crosshairListeners.length === 0) return;
    let bar = null;
    if (param && param.time != null && param.seriesData && typeof param.seriesData.get === 'function') {
      const d = param.seriesData.get(candleSeries);
      if (d) bar = { time: param.time, open: d.open, high: d.high, low: d.low, close: d.close };
    }
    for (let i = 0; i < crosshairListeners.length; i++) {
      try { crosshairListeners[i](bar, param); } catch (_e) { /* yoksay */ }
    }
  }
  chart.subscribeCrosshairMove(onCrosshair);

  // ---------------------------------------------------------------------
  // Boyutlandirma
  // ---------------------------------------------------------------------
  function resize() {
    if (destroyed) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    try { chart.resize(w, h); } catch (_e) { return; }
    emitRange();
  }

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => resize());
    ro.observe(container);
  } else {
    window.addEventListener('resize', resize);
  }

  // ---------------------------------------------------------------------
  // Fiyat cizgileri
  // ---------------------------------------------------------------------
  let priceLines = [];

  function clearPriceLines() {
    for (let i = 0; i < priceLines.length; i++) {
      try { candleSeries.removePriceLine(priceLines[i]); } catch (_e) { /* zaten silinmis */ }
    }
    priceLines = [];
  }

  /**
   * Fiyat cizgilerini tazeler, oncekileri siler.
   * `style`/`lineStyle` ve `width`/`lineWidth` adlarinin ikisi de kabul edilir.
   * @param {Array<{price:number,color?:string,title?:string,style?:number,
   *   lineStyle?:number,width?:number,lineWidth?:number}>} lines
   */
  function setPriceLines(lines) {
    clearPriceLines();
    if (!Array.isArray(lines)) return;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln || !isNum(+ln.price)) continue;
      const w = ln.width != null ? ln.width : ln.lineWidth;
      const st = ln.style != null ? ln.style : ln.lineStyle;
      try {
        priceLines.push(candleSeries.createPriceLine({
          price: +ln.price,
          color: ln.color || COLOR.accent,
          lineWidth: isNum(+w) && +w > 0 ? +w : 1,
          lineStyle: isNum(+st) ? +st : dashed,
          axisLabelVisible: true,
          title: ln.title || '',
        }));
      } catch (_e) { /* gecersiz cizgi atlanir */ }
    }
  }

  // ---------------------------------------------------------------------
  // Veri
  // ---------------------------------------------------------------------
  function setBars(bars) {
    if (destroyed) return;
    const data = normalizeBars(bars);
    const n = data.length;

    ensureCapacity(n);
    count = n;
    const candles = new Array(n);
    const vols = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = data[i];
      times[i] = b.time;
      candles[i] = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
      vols[i] = {
        time: b.time,
        value: b.volume,
        color: b.close >= b.open ? 'rgba(38, 166, 154, 0.32)' : 'rgba(239, 83, 80, 0.32)',
      };
    }
    recomputeStep();

    candleSeries.setData(candles);
    volumeSeries.setData(vols);
    emitRange();
  }

  function updateBar(bar) {
    if (destroyed || !bar) return;
    const t = +bar.time;
    if (!isNum(t) || !isNum(+bar.close)) return;

    const point = { time: t, open: +bar.open, high: +bar.high, low: +bar.low, close: +bar.close };
    if (!isNum(point.open) || !isNum(point.high) || !isNum(point.low)) return;

    if (count === 0 || t > times[count - 1]) {
      ensureCapacity(count + 1);
      times[count++] = t;
      recomputeStep();
    } else if (t === times[count - 1]) {
      // ayni bar guncelleniyor
    } else {
      // Gecmise donuk guncelleme: lightweight-charts kabul etmez, sessizce atla.
      return;
    }

    candleSeries.update(point);
    const vol = isNum(+bar.volume) ? +bar.volume : 0;
    volumeSeries.update({
      time: t,
      value: vol,
      color: point.close >= point.open ? 'rgba(38, 166, 154, 0.32)' : 'rgba(239, 83, 80, 0.32)',
    });
    emitRange();
  }

  function setMarkers(markers) {
    if (destroyed) return;
    try { candleSeries.setMarkers(Array.isArray(markers) ? markers : []); } catch (_e) { /* yoksay */ }
  }

  // ---------------------------------------------------------------------
  // Koordinat cevrimi (overlay.js kullanir)
  // ---------------------------------------------------------------------
  function priceToY(price) {
    if (destroyed || !isNum(+price)) return null;
    const y = candleSeries.priceToCoordinate(+price);
    return isNum(y) ? y : null;
  }

  function timeToX(time) {
    if (destroyed) return null;
    const l = timeToLogical(+time);
    if (l == null) return null;
    const x = chart.timeScale().logicalToCoordinate(l);
    return isNum(x) ? x : null;
  }

  function xToTime(x) {
    if (destroyed || !isNum(+x)) return null;
    const l = chart.timeScale().coordinateToLogical(+x);
    return isNum(l) ? logicalToTime(l) : null;
  }

  /**
   * Cizim alani: fiyat ve zaman olcekleri disarida birakilmis kutu.
   * Not: olcek genislikleri ilk boyama tamamlanana kadar 0 gelebilir; bu
   * durumda kap boyutu dondurulur ve `measured` false olur.
   */
  function getPaneSize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    let sw = 0, th = 0, tw = 0;
    try { sw = chart.priceScale('right').width() || 0; } catch (_e) { sw = 0; }
    try {
      const ts = chart.timeScale();
      th = ts.height() || 0;
      tw = ts.width() || 0;
    } catch (_e) { th = 0; tw = 0; }
    // Iki olcumden kucuk olani gercek cizim alanidir.
    const byScale = sw > 0 ? w - sw : w;
    const width = Math.max(1, Math.min(tw > 0 ? tw : w, byScale));
    return {
      width,
      height: Math.max(1, h - th),
      fullWidth: w,
      fullHeight: h,
      measured: sw > 0 && th > 0,
    };
  }

  // ---------------------------------------------------------------------
  // Gezinme
  // ---------------------------------------------------------------------
  function fitContent() {
    if (destroyed) return;
    chart.timeScale().fitContent();
    emitRange();
  }

  function scrollToTime(time) {
    if (destroyed || count === 0) return;
    const l = timeToLogical(+time);
    if (l == null) return;
    const ts = chart.timeScale();
    const cur = ts.getVisibleLogicalRange();
    const span = cur && isNum(cur.to - cur.from) && cur.to - cur.from > 4 ? cur.to - cur.from : 200;
    ts.setVisibleLogicalRange({ from: l - span / 2, to: l + span / 2 });
    emitRange();
  }

  /**
   * Gorunur zaman araligi dinleyicisi.
   * @param {(range:{from:number,to:number}|null)=>void} cb
   * @returns {()=>void} Aboneligi biten fonksiyon
   */
  function onVisibleRangeChange(cb) {
    if (typeof cb !== 'function') return () => {};
    rangeListeners.push(cb);
    try { cb(getVisibleTimeRange()); } catch (_e) { /* yoksay */ }
    return () => {
      const i = rangeListeners.indexOf(cb);
      if (i >= 0) rangeListeners.splice(i, 1);
    };
  }

  /**
   * Nisangah hareketi dinleyicisi (efsane kutusu icin).
   * @param {(bar:object|null, param:object)=>void} cb
   */
  function onCrosshairMove(cb) {
    if (typeof cb !== 'function') return () => {};
    crosshairListeners.push(cb);
    return () => {
      const i = crosshairListeners.indexOf(cb);
      if (i >= 0) crosshairListeners.splice(i, 1);
    };
  }

  /**
   * Sinyal isaretine tiklama dinleyicisi.
   * @param {(bilgi:{id:*,time:number|null,point:object|null})=>void} cb
   * @returns {()=>void}
   */
  function onMarkerClick(cb) {
    if (typeof cb !== 'function') return () => {};
    markerClickListeners.push(cb);
    return () => {
      const i = markerClickListeners.indexOf(cb);
      if (i >= 0) markerClickListeners.splice(i, 1);
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
    rangeListeners.length = 0;
    crosshairListeners.length = 0;
    markerClickListeners.length = 0;
    try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onLogicalRangeChange); } catch (_e) { /* yoksay */ }
    try { chart.unsubscribeCrosshairMove(onCrosshair); } catch (_e) { /* yoksay */ }
    try { chart.unsubscribeClick(onChartClick); } catch (_e) { /* yoksay */ }
    priceLines = [];
    try { chart.remove(); } catch (_e) { /* yoksay */ }
    times = new Float64Array(0);
    count = 0;
  }

  return {
    chart,
    candleSeries,
    volumeSeries,
    setBars,
    updateBar,
    setMarkers,
    setPriceLines,
    clearPriceLines,
    fitContent,
    scrollToTime,
    onVisibleRangeChange,
    onCrosshairMove,
    onMarkerClick,
    priceToY,
    timeToX,
    xToTime,
    getPaneSize,
    getVisibleTimeRange,
    resize,
    destroy,
    barCount: () => count,
    lastBarTime: () => (count > 0 ? times[count - 1] : null),
    isDestroyed: () => destroyed,
  };
}

export { formatFullTime, COLOR as CHART_COLORS };
