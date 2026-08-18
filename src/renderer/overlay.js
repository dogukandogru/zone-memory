/**
 * overlay.js - Grafigin uzerine destek/direnc bolgelerini cizen canvas katmani.
 *
 * Katman `pointer-events: none` ile durur, boylece grafigin kendi kaydirma ve
 * yakinlastirma etkilesimi bozulmaz. Tiklama, kap eleman (#chartWrap) uzerinde
 * yakalanip koordinat hesabiyla bolgeye eslenir.
 *
 * Koordinat cevrimi chart.js'in verdigi `priceToY` ve `timeToX` ile yapilir.
 * Yalnizca gorunur zaman araligindaki bolgeler cizilir.
 *
 * CONTRACTS.md 19. bolum, createZoneOverlay disa acilan API:
 *   setZones(zones), setHighlight(zoneId|null), redraw(), destroy(), onZoneClick(cb)
 */

const SUPPORT_RGB = '38, 166, 154';   // #26a69a
const RESIST_RGB = '239, 83, 80';     // #ef5350

const FILL_ALPHA = 0.12;              // normal bolge dolgusu
const EDGE_ALPHA = 0.60;              // normal bolge siniri
const BROKEN_FILL_ALPHA = 0.06;       // kirilmis bolge dolgusu
const BROKEN_EDGE_ALPHA = 0.30;       // kirilmis bolge siniri (soluk)
const HL_FILL_ALPHA = 0.26;           // vurgulanan bolge dolgusu
const MIN_LABEL_HEIGHT = 14;          // etiket icin gereken en az piksel yukseklik
const DRAG_TOLERANCE = 4;             // bu kadar pikselden fazla kaydiysa tiklama sayilmaz

const LABEL_FONT = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Bolgenin sag kenari icin gecerli zaman: kirildiysa kirilma ani, degilse bitis. */
function zoneRightTime(zone) {
  if (zone.broken && isNum(zone.brokenTime)) return zone.brokenTime;
  if (isNum(zone.endTime)) return zone.endTime;
  return isNum(zone.createdTime) ? zone.createdTime : NaN;
}

/**
 * Bolge katmani olusturur.
 * @param {object} chartView createChartView ciktisi
 * @param {HTMLElement} container Grafigin durdugu, konumu `relative` olan kap
 * @returns {{setZones:Function,setHighlight:Function,redraw:Function,destroy:Function,onZoneClick:Function}}
 */
export function createZoneOverlay(chartView, container) {
  if (!chartView) throw new Error('createZoneOverlay: chartView gerekli');
  if (!container) throw new Error('createZoneOverlay: kap elemani gerekli');

  const canvas = document.createElement('canvas');
  canvas.className = 'zone-overlay';
  // Sinif styles.css'te tanimli; yine de temel konumlandirmayi burada da veriyoruz
  // ki katman stil dosyasi olmadan da dogru yerde dursun.
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '3';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  /** @type {Array<object>} */
  let zones = [];
  /** @type {number|null} */
  let highlightId = null;
  /** @type {Array<Function>} */
  const clickHandlers = [];
  /** Cizilen dikdortgenler, tiklama testi icin. */
  let hitRects = [];

  let destroyed = false;
  let rafId = 0;
  let warmupDraws = 0;   // olcekler olculene kadar yapilan yeniden cizim sayisi
  let cssW = 0;
  let cssH = 0;
  let backingW = 0;
  let backingH = 0;

  // ---------------------------------------------------------------------
  // Cizim
  // ---------------------------------------------------------------------
  function syncCanvasSize() {
    const dpr = window.devicePixelRatio || 1;
    cssW = Math.max(1, container.clientWidth);
    cssH = Math.max(1, container.clientHeight);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (bw !== backingW || bh !== backingH) {
      canvas.width = bw;
      canvas.height = bh;
      backingW = bw;
      backingH = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawZoneBox(r, strong) {
    const rgb = r.isSupport ? SUPPORT_RGB : RESIST_RGB;
    const broken = r.broken;

    let fillA = broken ? BROKEN_FILL_ALPHA : FILL_ALPHA;
    let edgeA = broken ? BROKEN_EDGE_ALPHA : EDGE_ALPHA;
    if (strong) {
      fillA = HL_FILL_ALPHA;
      edgeA = 0.95;
    }

    const w = Math.max(1, r.x2 - r.x1);
    const h = Math.max(1, r.y2 - r.y1);

    ctx.fillStyle = 'rgba(' + rgb + ',' + fillA + ')';
    ctx.fillRect(r.x1, r.y1, w, h);

    ctx.strokeStyle = 'rgba(' + rgb + ',' + edgeA + ')';
    ctx.lineWidth = strong ? 2 : 1;
    ctx.setLineDash(broken ? [4, 3] : []);
    // Yarim piksel kaydirma keskin cizgi verir.
    ctx.strokeRect(r.x1 + 0.5, r.y1 + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
    ctx.setLineDash([]);

    // Etiket yalnizca kutu yeterince yuksekse cizilir.
    if (h > MIN_LABEL_HEIGHT) {
      const label = (r.isSupport ? 'DES' : 'DIR') + (isNum(r.flow) ? ' ' + r.flow.toFixed(2) : '');
      ctx.font = LABEL_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(label).width;
      const lx = Math.max(r.x1, 0) + 3;
      const ly = r.y1 + 2;
      ctx.fillStyle = 'rgba(19, 23, 34, 0.72)';
      ctx.fillRect(lx - 2, ly - 1, tw + 5, 12);
      ctx.fillStyle = 'rgba(' + rgb + ',' + (broken && !strong ? 0.55 : 0.95) + ')';
      ctx.fillText(label, lx, ly);
    }
  }

  function draw() {
    rafId = 0;
    if (destroyed) return;

    syncCanvasSize();
    ctx.clearRect(0, 0, cssW, cssH);
    hitRects = [];
    if (zones.length === 0) return;

    // Cizim alani: fiyat ve zaman olcekleri disarida kalir.
    let paneW = cssW;
    let paneH = cssH;
    if (typeof chartView.getPaneSize === 'function') {
      const p = chartView.getPaneSize();
      if (p && isNum(p.width) && isNum(p.height)) {
        paneW = p.width;
        paneH = p.height;
        // Grafik ilk boyamasini bitirmeden olcek genislikleri 0 gelir; bu
        // durumda bir sonraki karede yeniden cizeriz ki kutular fiyat
        // olceginin uzerine tasmasin.
        if (p.measured === false && warmupDraws < 5) {
          warmupDraws++;
          requestAnimationFrame(redraw);
        } else if (p.measured) {
          warmupDraws = 0;
        }
      }
    }

    let vFrom = -Infinity;
    let vTo = Infinity;
    if (typeof chartView.getVisibleTimeRange === 'function') {
      const vr = chartView.getVisibleTimeRange();
      if (vr && isNum(vr.from) && isNum(vr.to)) {
        vFrom = vr.from;
        vTo = vr.to;
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, paneW, paneH);
    ctx.clip();

    let highlighted = null;

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      if (!z) continue;

      const startT = +z.createdTime;
      let endT = zoneRightTime(z);
      if (!isNum(startT) || !isNum(endT)) continue;
      if (endT < startT) endT = startT;

      // Gorunur araligin disindaki bolgeler hic cizilmez.
      if (endT < vFrom || startT > vTo) continue;

      // Sag kenar: bitis zamani ile gorunur son arasindaki kucuk olan.
      const rightT = Math.min(endT, vTo);

      const rawX1 = chartView.timeToX(startT);
      const rawX2 = chartView.timeToX(rightT);
      const top = isNum(+z.top) ? +z.top : NaN;
      const bottom = isNum(+z.bottom) ? +z.bottom : NaN;
      const rawY1 = chartView.priceToY(top);
      const rawY2 = chartView.priceToY(bottom);
      if (!isNum(rawX1) || !isNum(rawX2) || !isNum(rawY1) || !isNum(rawY2)) continue;

      let x1 = Math.min(rawX1, rawX2);
      let x2 = Math.max(rawX1, rawX2);
      let y1 = Math.min(rawY1, rawY2);
      let y2 = Math.max(rawY1, rawY2);

      if (x2 < 0 || x1 > paneW || y2 < 0 || y1 > paneH) continue;

      // Ekran disina tasan kisimlari kirp, en az 2 piksel genislik birak.
      x1 = Math.max(x1, -1);
      x2 = Math.min(x2, paneW);
      if (x2 - x1 < 2) x2 = x1 + 2;
      y1 = Math.max(y1, -1);
      y2 = Math.min(y2, paneH);

      const rect = {
        zone: z,
        id: z.id,
        isSupport: !!z.isSupport,
        broken: !!z.broken,
        flow: isNum(+z.flow) ? +z.flow : NaN,
        x1, x2, y1, y2,
        h: y2 - y1,
      };
      hitRects.push(rect);

      if (highlightId != null && z.id === highlightId) {
        highlighted = rect;   // en uste cizilsin diye sona birakilir
      } else {
        drawZoneBox(rect, false);
      }
    }

    if (highlighted) drawZoneBox(highlighted, true);

    ctx.restore();
  }

  function redraw() {
    if (destroyed || rafId !== 0) return;
    rafId = requestAnimationFrame(draw);
  }

  // ---------------------------------------------------------------------
  // Tiklama
  // ---------------------------------------------------------------------
  let downX = 0;
  let downY = 0;
  let downOk = false;

  function onMouseDown(e) {
    if (e.button !== 0) { downOk = false; return; }
    downX = e.clientX;
    downY = e.clientY;
    downOk = true;
  }

  function onMouseUp(e) {
    if (!downOk || e.button !== 0) return;
    downOk = false;
    if (clickHandlers.length === 0 || hitRects.length === 0) return;
    // Suruklemeyi tiklama sayma.
    if (Math.abs(e.clientX - downX) > DRAG_TOLERANCE || Math.abs(e.clientY - downY) > DRAG_TOLERANCE) return;

    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Ust uste binen bolgelerde en dar olani secilir.
    let best = null;
    for (let i = 0; i < hitRects.length; i++) {
      const r = hitRects[i];
      if (x < r.x1 || x > r.x2 || y < r.y1 || y > r.y2) continue;
      if (best === null || r.h < best.h) best = r;
    }
    if (!best) return;

    for (let i = 0; i < clickHandlers.length; i++) {
      try { clickHandlers[i](best.zone); } catch (_e) { /* dinleyici hatasi yayilmasin */ }
    }
  }

  container.addEventListener('mousedown', onMouseDown, true);
  container.addEventListener('mouseup', onMouseUp, true);

  // ---------------------------------------------------------------------
  // Yeniden cizim tetikleyicileri
  // ---------------------------------------------------------------------
  const unsubscribeRange = typeof chartView.onVisibleRangeChange === 'function'
    ? chartView.onVisibleRangeChange(() => redraw())
    : () => {};

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => redraw());
    ro.observe(container);
  } else {
    window.addEventListener('resize', redraw);
  }

  // Retina ekranindan normale tasima gibi durumlarda olcek degisir.
  let dprQuery = null;
  const onDprChange = () => { backingW = 0; backingH = 0; redraw(); };
  if (typeof window.matchMedia === 'function') {
    dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    if (typeof dprQuery.addEventListener === 'function') dprQuery.addEventListener('change', onDprChange);
    else dprQuery = null;
  }

  // ---------------------------------------------------------------------
  // Disa acilan API
  // ---------------------------------------------------------------------
  /** @param {Array<object>} next Zone dizisi */
  function setZones(next) {
    zones = Array.isArray(next) ? next : [];
    redraw();
  }

  /** @param {number|null} zoneId */
  function setHighlight(zoneId) {
    highlightId = zoneId == null ? null : zoneId;
    redraw();
  }

  /**
   * @param {(zone:object)=>void} cb
   * @returns {()=>void} Dinleyiciyi kaldiran fonksiyon
   */
  function onZoneClick(cb) {
    if (typeof cb !== 'function') return () => {};
    clickHandlers.push(cb);
    return () => {
      const i = clickHandlers.indexOf(cb);
      if (i >= 0) clickHandlers.splice(i, 1);
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; }
    container.removeEventListener('mousedown', onMouseDown, true);
    container.removeEventListener('mouseup', onMouseUp, true);
    try { unsubscribeRange(); } catch (_e) { /* yoksay */ }
    if (ro) ro.disconnect(); else window.removeEventListener('resize', redraw);
    if (dprQuery) dprQuery.removeEventListener('change', onDprChange);
    clickHandlers.length = 0;
    zones = [];
    hitRects = [];
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  redraw();

  return { setZones, setHighlight, redraw, destroy, onZoneClick, canvas };
}
