/**
 * overlay.js - Destek/direnc bolgelerini grafige cizen katman.
 *
 * ----------------------------------------------------------------------------
 * NEDEN AYRI CANVAS DEGIL DE CIZIM EKLENTISI (primitive)
 * ----------------------------------------------------------------------------
 * Ilk surum grafigin ustune mutlak konumlu bir <canvas> koyuyor ve
 * `subscribeVisibleLogicalRangeChange` olayinda yeniden ciziyordu. Iki hatasi
 * vardi ve ikisi de kullanicinin gordugu "kutular kayiyor / sabit kaliyor"
 * belirtisini uretiyordu:
 *
 *  1. O olay YALNIZCA zaman ekseni degisince tetiklenir. Fiyat eksenini
 *     suruklemek, dikey kaydirmak veya otomatik olcekleme (yeni mum girince
 *     fiyat araligi degisir) olay uretmez. Bu yuzden kutular dikeyde eski
 *     yerinde kalir; yatayda kaydirinca olay gelir ve kutular birden yerine
 *     oturur, yani "scroll edince duzeliyor" gorunur.
 *  2. Olay geldiginde bile cizim `requestAnimationFrame` ile bir SONRAKI kareye
 *     erteleniyordu. Grafik zaten o karede boyandigi icin katman surekli bir
 *     kare geriden gelir ve akici kaydirmada kutular mumlarin arkasindan
 *     surunur gibi gorunur.
 *
 * Cozum: lightweight-charts'in `series.attachPrimitive()` arayuzunu kullanmak.
 * Eklenti, grafigin KENDI cizim gecisinin icinde cagrilir. Boylece:
 *   - Kutular her karede mumlarla ayni anda ve ayni donusumle cizilir,
 *     yatay/dikey/yakinlastirma fark etmez, gecikme sifirdir.
 *   - Cizim uzayi dogrudan PANE'dir; fiyat ve zaman olceklerinin genisligini
 *     elle olcup kirpmak gerekmez.
 *   - Kirpma isini grafik yapar.
 *
 * Isabet testi (tiklama) icin `chart.subscribeClick` kullanilir; verdigi
 * `param.point` de pane koordinatlarindadir, yani cizim uzayiyla ayni.
 *
 * CONTRACTS.md 19. bolum, createZoneOverlay disa acilan API korunmustur:
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
 * @param {HTMLElement} container Grafigin durdugu kap (yalnizca imza uyumu icin)
 * @returns {{setZones:Function,setHighlight:Function,redraw:Function,destroy:Function,onZoneClick:Function}}
 */
export function createZoneOverlay(chartView, container) {
  if (!chartView) throw new Error('createZoneOverlay: chartView gerekli');

  /** @type {Array<object>} */
  let zones = [];
  /** @type {number|null} */
  let highlightId = null;
  /** @type {Array<Function>} */
  const clickHandlers = [];
  /** Son cizimde olusan dikdortgenler, tiklama testi icin (pane koordinati). */
  let hitRects = [];

  let destroyed = false;
  /** Eklenti baglandiginda grafigin verdigi "yeniden ciz" istegi. */
  let requestUpdate = null;

  // ---------------------------------------------------------------------
  // Cizim
  // ---------------------------------------------------------------------

  /**
   * Gorunur bolgeleri pane koordinatlarina cevirir.
   * Her cizimde yeniden hesaplanir, cunku donusum her karede degisebilir.
   * @param {number} paneW
   * @param {number} paneH
   */
  function hesaplaDikdortgenler(paneW, paneH) {
    const out = [];
    if (zones.length === 0) return out;

    let vFrom = -Infinity;
    let vTo = Infinity;
    if (typeof chartView.getVisibleTimeRange === 'function') {
      const vr = chartView.getVisibleTimeRange();
      if (vr && isNum(vr.from) && isNum(vr.to)) {
        vFrom = vr.from;
        vTo = vr.to;
      }
    }

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

      out.push({
        zone: z,
        id: z.id,
        isSupport: !!z.isSupport,
        broken: !!z.broken,
        flow: isNum(+z.flow) ? +z.flow : NaN,
        strong: highlightId != null && z.id === highlightId,
        x1, x2, y1, y2,
        h: y2 - y1,
      });
    }
    return out;
  }

  /** Bir bolgenin dolgusunu ve sinirini cizer. */
  function cizKutu(ctx, r) {
    const rgb = r.isSupport ? SUPPORT_RGB : RESIST_RGB;
    const broken = r.broken;

    let fillA = broken ? BROKEN_FILL_ALPHA : FILL_ALPHA;
    let edgeA = broken ? BROKEN_EDGE_ALPHA : EDGE_ALPHA;
    if (r.strong) {
      fillA = HL_FILL_ALPHA;
      edgeA = 0.95;
    }

    const w = Math.max(1, r.x2 - r.x1);
    const h = Math.max(1, r.y2 - r.y1);

    ctx.fillStyle = 'rgba(' + rgb + ',' + fillA + ')';
    ctx.fillRect(r.x1, r.y1, w, h);

    ctx.strokeStyle = 'rgba(' + rgb + ',' + edgeA + ')';
    ctx.lineWidth = r.strong ? 2 : 1;
    ctx.setLineDash(broken ? [4, 3] : []);
    // Yarim piksel kaydirma keskin cizgi verir.
    ctx.strokeRect(r.x1 + 0.5, r.y1 + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
    ctx.setLineDash([]);
  }

  /** Bolge etiketini cizer (mumlarin USTUNDE, okunabilir kalsin diye). */
  function cizEtiket(ctx, r) {
    const h = Math.max(1, r.y2 - r.y1);
    if (h <= MIN_LABEL_HEIGHT) return;

    const rgb = r.isSupport ? SUPPORT_RGB : RESIST_RGB;
    const label = (r.isSupport ? 'DES' : 'DIR') + (isNum(r.flow) ? ' ' + r.flow.toFixed(2) : '');
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width;
    const lx = Math.max(r.x1, 0) + 3;
    const ly = r.y1 + 2;
    ctx.fillStyle = 'rgba(19, 23, 34, 0.72)';
    ctx.fillRect(lx - 2, ly - 1, tw + 5, 12);
    ctx.fillStyle = 'rgba(' + rgb + ',' + (r.broken && !r.strong ? 0.55 : 0.95) + ')';
    ctx.fillText(label, lx, ly);
  }

  /**
   * Dolgu ve sinir katmani: mumlarin ARKASINDA cizilir, boylece mumlar
   * okunakli kalir (TradingView'in bolge gorunumu de boyledir).
   */
  const dolguGorunumu = {
    zOrder: () => 'bottom',
    renderer: () => ({
      draw: (target) => {
        target.useMediaCoordinateSpace((scope) => {
          const ctx = scope.context;
          const w = scope.mediaSize.width;
          const h = scope.mediaSize.height;
          // Isabet testi icin kullanilan dikdortgenler burada tazelenir.
          hitRects = hesaplaDikdortgenler(w, h);
          let vurgulu = null;
          for (let i = 0; i < hitRects.length; i++) {
            const r = hitRects[i];
            if (r.strong) { vurgulu = r; continue; }  // vurgulu en uste
            cizKutu(ctx, r);
          }
          if (vurgulu) cizKutu(ctx, vurgulu);
        });
      },
    }),
  };

  /** Etiket katmani: mumlarin USTUNDE, yoksa etiket mumun altinda kayboluyor. */
  const etiketGorunumu = {
    zOrder: () => 'top',
    renderer: () => ({
      draw: (target) => {
        target.useMediaCoordinateSpace((scope) => {
          const ctx = scope.context;
          for (let i = 0; i < hitRects.length; i++) cizEtiket(ctx, hitRects[i]);
        });
      },
    }),
  };

  const primitive = {
    attached: (param) => {
      requestUpdate = param && typeof param.requestUpdate === 'function' ? param.requestUpdate : null;
    },
    detached: () => { requestUpdate = null; },
    updateAllViews: () => {},
    paneViews: () => [dolguGorunumu, etiketGorunumu],
  };

  const bagli = typeof chartView.attachPrimitive === 'function' && chartView.attachPrimitive(primitive);
  if (!bagli) {
    throw new Error(
      'Bölge katmanı bağlanamadı: grafik kütüphanesi attachPrimitive desteklemiyor. ' +
      'lightweight-charts 4.1 veya üzeri gerekir.'
    );
  }

  // ---------------------------------------------------------------------
  // Tiklama
  // ---------------------------------------------------------------------
  const unsubscribeClick = typeof chartView.onChartClick === 'function'
    ? chartView.onChartClick((param) => {
      if (destroyed || clickHandlers.length === 0 || hitRects.length === 0) return;
      const p = param && param.point;
      if (!p || !isNum(p.x) || !isNum(p.y)) return;

      // Ust uste binen bolgelerde en dar olani secilir.
      let best = null;
      for (let i = 0; i < hitRects.length; i++) {
        const r = hitRects[i];
        if (p.x < r.x1 || p.x > r.x2 || p.y < r.y1 || p.y > r.y2) continue;
        if (best === null || r.h < best.h) best = r;
      }
      if (!best) return;

      for (let i = 0; i < clickHandlers.length; i++) {
        try { clickHandlers[i](best.zone); } catch (_e) { /* dinleyici hatasi yayilmasin */ }
      }
    })
    : () => {};

  // ---------------------------------------------------------------------
  // Disa acilan API
  // ---------------------------------------------------------------------

  /**
   * Yeniden cizim ister. Kaydirma ve yakinlastirmada BUNA GEREK YOKTUR,
   * grafik zaten her karede eklentiyi cagirir. Yalnizca veri degistiginde
   * (bolge listesi, vurgu) cagrilir.
   */
  function redraw() {
    if (destroyed) return;
    if (requestUpdate) requestUpdate();
  }

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
    try { unsubscribeClick(); } catch (_e) { /* yoksay */ }
    if (typeof chartView.detachPrimitive === 'function') chartView.detachPrimitive(primitive);
    clickHandlers.length = 0;
    zones = [];
    hitRects = [];
    requestUpdate = null;
  }

  // `container` artik cizim icin kullanilmiyor (grafik kendi pane'ine ciziyor),
  // imza uyumlulugu ve ileride gerekebilecek DOM islemleri icin duruyor.
  void container;

  return { setZones, setHighlight, redraw, destroy, onZoneClick, canvas: null };
}
