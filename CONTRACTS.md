# Zone Memory - Modul Sozlesmesi

Bu dosya, projeyi paralel yazan tum ajanlar icin BAGLAYICI arayuz tanimidir.
Burada yazan dosya yollari, export adlari, parametre ve donus tipleri birebir
uygulanir. Bir seyi degistirmek gerekiyorsa degistirme, oldugu gibi uygula ve
sorunu dosyanin basindaki yorumda belirt.

## 0. Genel kurallar

- Dil: JavaScript, CommonJS (`require` / `module.exports`). `package.json` icinde
  `"type": "commonjs"`. Renderer tarafi ise tarayici `<script type="module">`
  kullanir ve ESM `import/export` yazar (asagida ayrica belirtildi).
- Node 20+ / Electron 43 hedefi. Harici npm bagimliligi EKLENMEZ. Tek runtime
  bagimliligi `lightweight-charts` ve o da yalnizca renderer tarafinda,
  `node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js`
  dosyasi `<script src>` ile yuklenerek kullanilir.
- Kod yorumlari ve kullaniciya gorunen tum metinler TURKCEDIR.
- **Em-dash (—) karakteri hicbir yerde kullanilmaz.** Ne kodda, ne yorumda,
  ne arayuz metninde. Gerekirse virgul, iki nokta veya kisa cizgi (-) kullan.
- Turkce arayuz metinlerinde Turkce karakter serbesttir. Kod yorumlarinda da
  serbesttir.
- Hicbir modul `console.log` ile gurultu yapmaz; log gerekiyorsa ilgili
  modulun aldigi `onProgress` / `log` geri cagrisini kullanir.
- Sayisal diziler her yerde `Float64Array` (fiyat/zaman) veya `Float32Array`
  (ozellik vektorleri) olarak tasinir. Isinma (warmup) bolgeleri `NaN` ile
  doldurulur, `0` ile DEGIL.

## 1. Temel tipler

```js
/**
 * Sutunsal mum serisi. Tum diziler ayni uzunlukta ve `length` kadar dolu.
 * time: UNIX saniye (UTC), artan sirali, tekrarsiz.
 * @typedef {Object} Series
 * @property {number} length
 * @property {Float64Array} time
 * @property {Float64Array} open
 * @property {Float64Array} high
 * @property {Float64Array} low
 * @property {Float64Array} close
 * @property {Float64Array} volume
 */

/**
 * Indikatorun urettigi destek/direnc bolgesi.
 * @typedef {Object} Zone
 * @property {number} id            Seri icinde tekil, olusum sirasina gore artan
 * @property {boolean} isSupport    true destek, false direnc
 * @property {number} top
 * @property {number} bottom
 * @property {number} createdBar    Bolgenin ONAYLANDIGI bar (pivot + lookback)
 * @property {number} createdTime   createdBar zamani (UNIX saniye)
 * @property {number} pivotBar      Pivotun asil bari (createdBar - lookback)
 * @property {number} pivotTime
 * @property {number} endBar        createdBar + boxLengthBars
 * @property {number} endTime
 * @property {number} flow          Pivottaki flow gucu
 * @property {boolean} broken
 * @property {number} brokenBar     Kirilmadiysa -1
 * @property {number} touchCount
 */

/**
 * Bir bolgeye ILK dokunus olayi. Sistemin ogrenme birimi budur.
 * @typedef {Object} Touch
 * @property {number} id
 * @property {number} zoneId
 * @property {boolean} isSupport
 * @property {'BUY'|'SELL'} direction   isSupport ? 'BUY' : 'SELL'
 * @property {number} bar
 * @property {number} time
 * @property {number} price             Dokunus barinin kapanisi
 * @property {number} zoneTop
 * @property {number} zoneBottom
 * @property {number} zoneFlow
 * @property {number} zoneAgeBars       bar - createdBar
 * @property {number} penetration       Bolgeye ne kadar girildi, 0..1 arasi
 * @property {number} atr               Dokunus barindaki ATR(atrLen)
 * @property {number} score
 * @property {number} maxScore
 * @property {boolean} qualified        Pine'in gercekten yayinladigi sinyal mi
 * @property {boolean} strong
 * @property {string} session           'Asia' | 'London' | 'New York' | 'Other'
 * @property {Object<string,boolean>} parts  flow, trend, volatility, session,
 *                                           sweep, rejection, mss, fvg
 */

/**
 * Etiketlenmis sonuc.
 * @typedef {Object} Outcome
 * @property {'respect'|'break'|'timeout'} outcome
 * @property {boolean} success        outcome === 'respect'
 * @property {number} mfeAtr          Lehte azami hareket, ATR biriminde
 * @property {number} maeAtr          Aleyhte azami hareket, ATR biriminde
 * @property {number} fwdReturnPct    Ufuk sonundaki yonlu yuzde getiri
 * @property {number} barsToOutcome   Sonuca kac barda ulasildi, -1 ise timeout
 * @property {number} atr
 */

/**
 * Ozellik vektoru.
 * @typedef {Object} Features
 * @property {Float32Array} shape   16 uzunlukta, yumusatilmis min-max sekil
 * @property {Float32Array} ret     32 uzunlukta, z-score log getiriler
 * @property {Float32Array} ctx     CTX_NAMES.length uzunlukta baglam
 */

/**
 * Hafiza kaydi: dokunus + ozellik + sonuc.
 * @typedef {Touch & Outcome & {features: Features}} MemoryEvent
 */
```

## 2. Dosya haritasi ve sahiplik

Her satirin sahibi TEK bir ajandir. Baska bir ajanin dosyasina yazma.

```
src/core/tf.js                    A1
src/core/series.js                A1
src/core/store/binstore.js        A1
src/core/store/memstore.js        A1
src/core/ta.js                    A2
src/core/session.js               A2
src/core/indicator/masterTouch.js A3
src/core/learn/outcome.js         A4
src/core/learn/features.js        A4
src/core/learn/similarity.js      A5
src/core/learn/cluster.js         A5
src/core/learn/memory.js          A6
src/core/learn/signal.js          A6
src/core/learn/backtest.js        A7
src/core/data/provider.js         A8
src/core/data/yahoo.js            A8
src/core/data/twelvedata.js       A8
src/core/data/polygon.js          A8
src/core/data/binance.js          A8
src/core/data/okx.js              A8
src/core/data/histdata.js         A8
src/core/data/loader.js           A8
src/main/main.js                  A9
src/main/preload.js               A9
src/main/paths.js                 A9
src/main/settings.js              A9
src/main/ipc.js                   A9
src/main/engine.js                A9
src/main/worker/engine.worker.js  A9
src/main/live.js                  A9
src/renderer/index.html           A10
src/renderer/styles.css           A10
src/renderer/app.js               A10
src/renderer/chart.js             A10
src/renderer/overlay.js           A10
src/renderer/panels.js            A10
src/renderer/tradingview.html     A10
scripts/import-legacy.mjs         A11
scripts/fetch-history.mjs         A11
README.md                         A11
test/*.test.js                    A12
```

## 3. `src/core/tf.js` (A1)

```js
const TF_SECONDS = { '1m':60, '5m':300, '15m':900, '30m':1800, '1h':3600, '4h':14400, '1d':86400 }
module.exports = {
  TF_SECONDS,
  TF_LIST,            // ['1m','5m','15m','30m','1h','4h','1d']
  tfSeconds(tf),      // number, bilinmeyen tf icin throw
  tfLabel(tf),        // '15m' -> '15 dakika'
  tfFromSeconds(sec), // 900 -> '15m', eslesme yoksa null
}
```

## 4. `src/core/series.js` (A1)

```js
module.exports = {
  createSeries(n),                 // Series, tum diziler n uzunlukta
  emptySeries(),                   // length 0
  sliceSeries(s, from, to),        // [from, to) yeni Series, kopyalamadan subarray kullan
  concatSeries(a, b),              // zaman sirali birlestirme, cakisanlarda b kazanir
  fromArrays({time,open,high,low,close,volume}), // normal dizilerden Series
  toBars(s, from, to),             // [{time,open,high,low,close,volume}] chart icin
  indexAtTime(s, t),               // ikili arama, tam eslesme yoksa -1
  lastIndexAtOrBefore(s, t),       // <= t olan en buyuk indeks, yoksa -1
  firstIndexAtOrAfter(s, t),
  resample(s, toTfSec),            // Series, epoch katlarina hizali kovalar
  sanitize(s),                     // zaman sirali, tekrarsiz, NaN'siz Series dondur
}
```

`resample` kurallari: kova baslangici `Math.floor(time / toTfSec) * toTfSec`.
open = kovanin ilk open, high = max, low = min, close = son close, volume = toplam.
Bos kovalar URETILMEZ (piyasa kapali saatler gercek bosluktur).

## 5. `src/core/store/binstore.js` (A1)

Ikili dosya formati (little endian):

```
offset 0   : 8 bayt  ascii magic  'ZMEM0001'
offset 8   : uint32  surum = 1
offset 12  : uint32  rezerve = 0
offset 16  : float64 count
offset 24  : count * float64  time
...        : count * float64  open, high, low, close, volume (bu sirayla)
```

```js
module.exports = {
  MAGIC,                              // 'ZMEM0001'
  async writeSeries(filePath, series),// once .tmp yaz sonra rename (atomik)
  async readSeries(filePath),         // Series | null (dosya yoksa null)
  async appendSeries(filePath, series),// {added, total} zamana gore tekillestirir
  async statSeries(filePath),         // {count, firstTime, lastTime} | null
}
```

`appendSeries` mevcut veriyi okur, `concatSeries` ile birlestirir, `sanitize`
eder ve yeniden yazar. Ayni zaman damgasi varsa YENI veri kazanir.

## 6. `src/core/store/memstore.js` (A1)

Hafiza kayitlari iki dosyada tutulur:
- `<ad>.json` : `{version:1, tf, rowLen, shapeLen, retLen, ctxLen, ctxNames:[], count, events:[...]}`
  `events` icinde her kayit `features` HARIC tum Touch + Outcome alanlari.
- `<ad>.vec`  : `count * rowLen` adet float32. Satir duzeni: `[shape(16), ret(32), ctx(ctxLen)]`.

```js
module.exports = {
  async saveMemory(basePath, {tf, ctxNames, events}), // events[i].features zorunlu
  async loadMemory(basePath),   // {tf, ctxNames, events} | null, features geri kurulur
  async statMemory(basePath),   // {count, tf, firstTime, lastTime} | null
  async deleteMemory(basePath),
}
```

## 7. `src/core/ta.js` (A2)

Tumu `Float64Array` alir, `Float64Array` dondurur. Isinma bolgesi `NaN`.
Pine Script davranisiyla birebir uyumlu olmalidir (referans: bu projedeki
`../indicator2/backend/app/services/indicator/master_touch.py` icindeki
`_pine_ema`, `_pine_rma`, `_pine_atr`, `_pivot_high`, `_pivot_low`).

```js
module.exports = {
  sma(src, len),
  ema(src, len),        // out[len-1] = SMA(len), sonra alpha = 2/(len+1)
  rma(src, len),        // out[len-1] = SMA(len), sonra alpha = 1/len
  trueRange(high, low, close),
  atr(high, low, close, len),   // rma(trueRange, len)
  rsi(src, len),        // Pine ta.rsi: rma(up,len) / rma(down,len)
  rollingMax(src, len), // [i-len+1 .. i], monotonik kuyruk ile O(n)
  rollingMin(src, len),
  rollingMean(src, len),
  stdev(src, len),
  pivotHigh(high, left, right),  // deger c+right indeksine yazilir, digerleri NaN
  pivotLow(low, left, right),
  shift(src, n),        // n bar geriye kaydir, basi NaN
  clamp(x, lo, hi),
}
```

`pivotHigh` kurali: `c` merkez olmak uzere `high[c] > max(high[c-left..c-1])` VE
`high[c] > max(high[c+1..c+right])` ise `out[c+right] = high[c]`. Esitlikte pivot
YOKTUR (kesin buyukluk). `pivotLow` simetrigidir.

## 8. `src/core/session.js` (A2)

Seans hesabi Europe/Istanbul saatine gore yapilir. 6 milyon bar icin her bar
`Intl.DateTimeFormat` cagirmak cok yavastir; bu yuzden GUN bazinda onbellek
kullan: bir UTC gunu icin ofset bir kez hesaplanir ve o gunun tum barlarina
uygulanir. (Turkiye 2016'dan beri sabit UTC+3, oncesinde yaz saati uygulaniyordu,
bu yuzden sabit ofset varsayimi YAPILAMAZ.)

```js
module.exports = {
  SESSIONS,                       // ['Asia','London','New York','Other']
  sessionIndexArray(timeArr, tz), // Uint8Array, SESSIONS icindeki indeks
  localHourArray(timeArr, tz),    // Uint8Array 0..23
  localDowArray(timeArr, tz),     // Uint8Array 0..6, 0 = Pazar
  sessionName(hour),              // 0-8 Asia, 8-13 London, 13-21 New York, else Other
}
```

## 9. `src/core/indicator/masterTouch.js` (A3)

Kullanicinin TradingView Pine indikatorunun ("XAUUSD MASTER son", MASTER 1 TOUCH)
JavaScript portu. **Referans uygulama** olarak
`/Users/dogukandogru/dev/indicator2/backend/app/services/indicator/master_touch.py`
dosyasini oku ve mantigi birebir tasi; Pine kaynagi
`/Users/dogukandogru/dev/indicator/indicator.pine` dosyasindadir.

```js
const DEFAULT_PARAMS = {
  minScoreForSignal: 5, strongScoreLevel: 6,
  lookback: 10, boxWidthAtr: 1.0, maxZoneHistory: 50,
  breakConfirmBars: 5, boxLengthBars: 120, mergeNearAtr: 0.8,
  flowLen: 10, minFlowStrength: 1.5, flowBonusMult: 1.25,
  useFootprintScore: false, hardFootprintGate: false, allowNoFootprintData: true,
  useHtfTrend: true, trendTf: '15m', emaFastLen: 50, emaSlowLen: 200,
  useVolatility: true, atrLen: 14, atrBaseLen: 50,
  minAtrRatio: 0.70, maxAtrRatio: 2.50,
  useLiquiditySweep: true, sweepLookback: 20,
  useRejection: true, wickMinRatio: 0.35,
  useMss: true, mssLen: 5,
  useFvg: false, fvgLookback: 8,
  sessionTz: 'Europe/Istanbul', useSessionScore: true, hardSessionGate: true,
  useAsia: false, useLondon: true, useNewYork: true, useOther: false,
  mintick: 0.01,
}

module.exports = {
  DEFAULT_PARAMS,
  /**
   * @param {Series} s
   * @param {object} params  DEFAULT_PARAMS uzerine yazilir
   * @param {number} tfSec   Serinin zaman dilimi (saniye)
   * @param {(pct:number, msg:string)=>void} [onProgress]
   * @returns {{zones: Zone[], touches: Touch[], context: IndicatorContext, stats: object}}
   */
  runIndicator(s, params, tfSec, onProgress),
}
```

`IndicatorContext`, ozellik cikarimi ve etiketleme icin yeniden hesaplanmasin
diye geri verilen ara diziler:

```js
/**
 * @typedef {Object} IndicatorContext
 * @property {Float64Array} atr        ATR(atrLen)
 * @property {Float64Array} atr200
 * @property {Float64Array} rsi        RSI(14)
 * @property {Float64Array} sma20
 * @property {Float64Array} sma50
 * @property {Float64Array} flowStrength
 * @property {Uint8Array} bullTrend
 * @property {Uint8Array} bearTrend
 * @property {Uint8Array} sessionIdx
 * @property {Uint8Array} localHour
 * @property {Uint8Array} localDow
 */
```

Kritik davranislar (Python portundan aynen):
1. Bolge olusumu: pivot barinda `flowStrength >= minFlowStrength` ve yon dogru
   ise (destek icin `dir > 0`, direnc icin `dir < 0`). Genislik `atr200[pivot] * boxWidthAtr`.
   Destek: `top = pivotLow`, `bottom = pivotLow - genislik`. Direnc: `bottom = pivotHigh`,
   `top = pivotHigh + genislik`.
2. `mergeNearAtr > 0` ise, AKTIF bolge listesinde ayni yonde ve orta noktasi
   `atr200[pivot] * mergeNearAtr` mesafesinden yakin bolge varsa YENI BOLGE ACILMAZ.
3. Aktif bolge listesi `maxZoneHistory` ile sinirlanir, en eskiden atilir.
   Ancak fonksiyon TUM olusmus bolgeleri `zones` dizisinde dondurur (grafik icin).
4. Kirilma: destekte `close < bottom`, direncte `close > top` olan ardisik bar
   sayaci `breakConfirmBars`'a ulasinca bolge kirilir. Ardisik olmayan barda sayac sifirlanir.
5. Dokunus: `zoneAlive && !broken && bar >= createdBar && low <= top && high >= bottom`.
   `wasTouching` durumu ile YENI dokunus ayirt edilir. **Bolge basina yalnizca
   ILK dokunus** olay uretir (`touchCount === 0` kontrolu).
6. Skor bilesenleri ve `neededScore = min(minScoreForSignal, maxScore)` kurali
   Python portuyla ayni. `qualified = score >= needed && sessionGateOk && footprintGateOk`.
7. `penetration`: destekte `(top - min(low, top)) / (top - bottom)`, direncte
   `(max(high, bottom) - bottom) / (top - bottom)`, 0..1 arasina kirpilir.
8. Bu port TUM ilk dokunuslari `touches` icinde dondurur. `qualified` bayragi
   Pine'in yayinladigi sinyali isaretler. Bu ayrim onemlidir: esik cok az sinyal
   urettigi icin benzerlik motoru tum dokunuslari korpus olarak kullanir.
9. HTF trend: `trendTf` grafik zaman diliminden BUYUKSE, seri o zaman dilimine
   yeniden orneklenir, EMA'lar orada hesaplanir ve degerler **HTF bari kapandiktan
   sonra** gecerli olacak sekilde ileri doldurulur (lookahead yok). Kucuk veya
   esitse seri oldugu gibi kullanilir.
10. `onProgress` 0..100 arasi yuzde ile en fazla 100 kez cagrilir.

Performans: 6 milyon bar isleyebilmeli. Ic dongude nesne ayirmaktan kacin,
tipli dizi kullan, aktif bolge listesini duz dizilerde tut.

## 10. `src/core/learn/outcome.js` (A4)

> Bu bolum ilk insadan SONRA guncellendi. Ilk surumdeki tek mod (giris +- N ATR)
> bolgeden bagimsiz oldugu icin "bolge calisti mi" sorusunu olcmuyordu ve gercek
> veride yazi-tura uretiyordu (15m %48.0, 5m %50.4). Ayrica sinyal plani stop'u
> MAE yuzdeliginden turetiyordu ve 30 ATR gibi anlamsiz degerler cikiyordu.

```js
const DEFAULT_OUTCOME_CFG = {
  mode: 'zone',          // 'zone' (varsayilan) | 'atr' (eski)
  horizonBars: 48,
  targetAtr: 1.0,        // bolge modu: yakin kenardan hedef uzakligi
  breakBufferAtr: 0.25,  // bolge modu: uzak kenardan tasma toleransi
  minTargetAtr: 0.25,    // hedef en az bu kadar uzakta olur
  tpAtr: 1.0,            // atr modu
  slAtr: 1.0,            // atr modu
}

module.exports = {
  DEFAULT_OUTCOME_CFG,
  labelTouch(s, touch, atrAtTouch, cfg),   // Outcome | null
  zoneLevels(touch, atr, cfg),             // {entry, target, invalid, sign, riskAtr, rewardAtr} | null
}
```

**Bolge modu (varsayilan).** Destek icin:
`gecersizlik = zoneBottom - breakBufferAtr * atr`,
`hedef = max(zoneTop + targetAtr * atr, giris + minTargetAtr * atr)`.
Direnc simetriktir. Gecersizlik once vurulursa `'break'` (bolge kirildi),
hedef once vurulursa `'respect'` (bolge tuttu), ikisi de olmazsa `'timeout'`.
Ayni barda ikisi de saglanirsa MUHAFAZAKAR davranilir: `'break'`.

Bu tanimin degeri: ogrenilen etiket ile islem plani ayni seydir. Sinyalin
stop'u tam olarak bu gecersizlik seviyesidir (`signal.js` `useZoneStop`),
yani "bolge kirildi" ile "stop vuruldu" ayni olaydir.

**Outcome alanlari:** `outcome, success, mfeAtr, maeAtr, mfeExitAtr, maeExitAtr,
fwdReturnPct, barsToOutcome, atr, mode, targetPrice, invalidPrice, riskAtr, rewardAtr`.

`mfeAtr` / `maeAtr` ufkun TAMAMINI olcer (ozellik olarak degerli).
`mfeExitAtr` / `maeExitAtr` yalnizca SONUCA kadar olan kismi olcer; plan
hedefleri ve yuruyen ileri testin kazanc kurali bunlari kullanir, cunku stop
vurulduktan sonraki hareket gercekte yakalanamaz.

## 11. `src/core/learn/features.js` (A4)

```js
const SHAPE_LEN = 16
const RET_LEN = 32
const WINDOW_BARS = 32   // Sekil ve getiri penceresi
const CTX_NAMES = [
  'rsi', 'atrPct', 'distSma20Atr', 'distSma50Atr',
  'hourSin', 'hourCos', 'dowSin', 'dowCos',
  'zoneWidthAtr', 'zoneAge', 'zoneFlow', 'penetration',
  'scoreRatio', 'pFlow', 'pTrend', 'pVolatility', 'pSession',
  'pSweep', 'pRejection', 'pMss', 'isSupport', 'trendState',
]

module.exports = {
  SHAPE_LEN, RET_LEN, WINDOW_BARS, CTX_NAMES,
  /**
   * @param {Series} s
   * @param {Touch} touch
   * @param {IndicatorContext} ctx
   * @returns {Features|null}   Pencere yetmiyorsa null
   */
  buildFeatures(s, touch, ctx),
  rowLength(),   // SHAPE_LEN + RET_LEN + CTX_NAMES.length
  packRow(features, out, offset),   // Float32Array'e yaz
  unpackRow(buf, offset),           // Features geri kur
}
```

Hesaplama kurallari:
- `shape`: dokunus bariyla biten son `WINDOW_BARS` kapanis. Once 5'lik hareketli
  ortalama ile yumusatilir (baslangicta pencere kisaltilir), sonra `SHAPE_LEN`
  kovaya bolunup her kovanin ortalamasi alinir, sonra min-max ile 0..1'e
  normalize edilir. Duz seride (max == min) tum degerler 0.5 olur.
  (Bu ayar onceki projede olculdu: ham 32 barlik vektore gore sinyal basina
  yaklasik 3 kat daha fazla anlamli eslesme uretti.)
- `ret`: son `RET_LEN + 1` kapanisin log getirileri, z-score normalize.
  Standart sapma 1e-12'den kucukse hepsi 0.
- `ctx`: sirasiyla
  `rsi/100`, `min(atr/price*100, 1)`, `clamp((price-sma20)/atr,-5,5)/5`,
  `clamp((price-sma50)/atr,-5,5)/5`, `sin(2pi*h/24)`, `cos(2pi*h/24)`,
  `sin(2pi*dow/7)`, `cos(2pi*dow/7)`,
  `clamp((zoneTop-zoneBottom)/atr,0,5)/5`, `min(zoneAgeBars/120,1)`,
  `clamp(zoneFlow,0,5)/5`, `penetration`, `score/maxScore`,
  `parts.flow?1:0`, `parts.trend?1:0`, `parts.volatility?1:0`, `parts.session?1:0`,
  `parts.sweep?1:0`, `parts.rejection?1:0`, `parts.mss?1:0`,
  `isSupport?1:0`, `bullTrend?1:(bearTrend?-1:0)`.
- Tum ctx degerleri sonlu olmali; NaN cikarsa 0 yaz.

## 12. `src/core/learn/similarity.js` (A5)

```js
const DEFAULT_WEIGHTS = { shape: 0.60, ctx: 0.25, dtw: 0.15 }

module.exports = {
  DEFAULT_WEIGHTS,
  pearson(a, b),          // -1..1, sabit seride 0
  cosine(a, b),           // -1..1
  euclidean(a, b),
  dtwDistance(a, b, band),// Sakoe-Chiba bantli, band varsayilan 5,
                          // sonuc (n+m)'ye bolunerek normalize edilir
  /**
   * @returns {{shapeSim:number, ctxSim:number, dtwSim:number, score:number}}
   * shapeSim = (pearson(shape)+1)/2, ctxSim = (cosine(ctx)+1)/2,
   * dtwSim = 1/(1+dtw(ret)), score = agirlikli toplam. Hepsi 0..1.
   */
  similarity(qa, qb, weights),
  /**
   * @param {Features} query
   * @param {{events:MemoryEvent[]}} memory
   * @param {{k:number, direction:string, excludeWithinSec:number,
   *          beforeTime:number|null, weights:object}} opts
   * @returns {Array<{event:MemoryEvent, shapeSim, ctxSim, dtwSim, similarity}>}
   *          Benzerlige gore azalan sirali, en fazla k adet.
   */
  knn(query, memory, opts),
}
```

`excludeWithinSec`: sorgu zamanina bu kadar yakin kayitlar elenir (komsu
dislama; ayni kurulumun kendisiyle eslesmesini onler). `beforeTime` verilirse
yalnizca o zamandan ONCEKI kayitlar aday olur (yuruyen ileri test icin sart).

Performans: 20 bin kayitta 1 sorgu 50 ms altinda kalmali. Once ucuz `shapeSim`
ile on eleme yap (en iyi `k*8` aday), sonra yalnizca onlarda DTW hesapla.

## 13. `src/core/learn/cluster.js` (A5)

```js
module.exports = {
  mulberry32(seed),   // deterministik PRNG, Math.random KULLANILMAZ
  /**
   * k-means++ baslatmali, deterministik k-means.
   * @returns {{centroids: Float32Array[], assignments: Int32Array, inertia: number}}
   */
  kmeans(vectors, k, opts),   // opts: {iters=50, seed=42}
  /**
   * Yalnizca basarili (success) kayitlarin sekil vektorlerinden ortak yapilari
   * cikarir. Kucuk kumeler (minSize altinda) elenir.
   * @returns {Array<{id, size, winRate, avgMfeAtr, avgMaeAtr, centroid:Float32Array,
   *                  label:string, memberIds:number[]}>}
   */
  buildPrototypes(memory, opts),  // opts: {k=8, minSize=15, seed=42, onlySuccess=true}
  /** Bir sekil vektorunun en yakin prototipini bulur. */
  matchPrototype(shape, prototypes),  // {prototype, similarity} | null
}
```

`label`: sekil vektorunden turetilen okunabilir Turkce ad, ornegin
`'Dusen kama, sert donus'` yerine daha basit ve mekanik bir sema kullan:
egim (yukselen/dusen/yatay), oynaklik (sikisik/genis) ve son hareket
(v-donus/duz/kirilma) uclusunden uretilmis ad, ornegin `'Dusen + sikisik + V donus'`.

## 14. `src/core/learn/memory.js` (A6)

```js
module.exports = {
  /**
   * Tarih boyunca indikatoru calistirir, ilk dokunuslari etiketler,
   * ozellik vektorlerini cikarir ve hafiza kaydini uretir.
   * @param {Series} s
   * @param {{tf:string, params:object, outcomeCfg:object}} cfg
   * @param {(pct:number,msg:string)=>void} [onProgress]
   * @returns {{tf, ctxNames, events: MemoryEvent[], zones: Zone[], stats: object}}
   */
  buildMemory(s, cfg, onProgress),
  /** Var olan hafizaya yeni barlardan gelen olaylari ekler (artimli tarama). */
  extendMemory(s, memory, cfg, onProgress),
  /** Hafiza ozeti: toplam, basarili, basarisiz, yon ve seans dagilimi, yillara gore. */
  summarize(memory),
}
```

`stats` icinde en az: `bars, zonesCreated, zonesMergedAway, firstTouches,
qualified, labeled, respected, broken, timeout, scoreHist`.

## 15. `src/core/learn/signal.js` (A6)

```js
const DEFAULT_SIGNAL_CFG = {
  k: 25, minSimilarity: 0.80, minMatches: 5, minWinRate: 0.60,
  excludeWithinSec: 86400 * 3, weights: { shape: 0.60, ctx: 0.25, dtw: 0.15 },
  tp1Pct: 40, tp2Pct: 70, slPct: 75,
}

module.exports = {
  DEFAULT_SIGNAL_CFG,
  /**
   * Bir dokunusu hafizayla karsilastirip sinyal uretir.
   * Esikleri gecemezse yine bir nesne doner ama `fired: false` olur; boylece
   * arayuz "neden sinyal olmadi" bilgisini gosterebilir.
   * @returns {Signal}
   */
  evaluateTouch(touch, features, memory, prototypes, cfg, beforeTime),
}

/**
 * @typedef {Object} Signal
 * @property {string} id
 * @property {boolean} fired
 * @property {number} time
 * @property {number} bar
 * @property {'BUY'|'SELL'} direction
 * @property {number} price
 * @property {number} zoneTop
 * @property {number} zoneBottom
 * @property {number} matchCount        Esik ustu benzer kayit sayisi
 * @property {number} avgSimilarity
 * @property {number} bestSimilarity
 * @property {number} winRate           0..1
 * @property {number} confidence        0..1
 * @property {number} expectedMfeAtr
 * @property {number} expectedMaeAtr
 * @property {number} entry
 * @property {number} tp1
 * @property {number} tp2
 * @property {number} sl
 * @property {number} rr
 * @property {number|null} prototypeId
 * @property {number} prototypeSim
 * @property {string} prototypeLabel
 * @property {Array<{id,time,similarity,success,mfeAtr,maeAtr,price}>} topMatches
 * @property {string[]} reasons         Turkce aciklamalar, sinyal neden olustu/olusmadi
 */
```

Plan hesabi:
- Yalnizca `similarity >= minSimilarity` olan eslesmeler kullanilir.
- `winRate` = bu eslesmelerdeki `success` orani.
- `tp1` = eslesmelerin `mfeAtr` degerlerinin `tp1Pct`. yuzdeligi (ATR carpani),
  `tp2` = `tp2Pct`. yuzdeligi, `sl` = `maeAtr` degerlerinin `slPct`. yuzdeligi.
  Fiyata cevrim: `entry + yon * carpan * atr`. SL icin ters yon.
- `sl` carpani en az 0.3 ATR olacak sekilde tabanlanir.
- `rr = (tp1 - entry) / (entry - sl)` mutlak degerle.
- `confidence = 0.4 * min(matchCount/20, 1) + 0.35 * |winRate - 0.5| * 2 + 0.25 * ((avgSimilarity - minSimilarity) / (1 - minSimilarity))`,
  0..1 arasina kirpilir.
- `fired = matchCount >= minMatches && winRate >= minWinRate`.
- `reasons` her zaman doldurulur, ornegin `'12 benzer kayit bulundu, ortalama benzerlik 0.87'`,
  `'Yeterli benzer kayit yok (3 < 5)'`.

## 16. `src/core/learn/backtest.js` (A7)

```js
module.exports = {
  /**
   * Yuruyen ileri test. Her olay yalnizca KENDINDEN ONCEKI hafizayla
   * degerlendirilir; ileriye bakma kesinlikle yasak.
   * @param {{events:MemoryEvent[]}} memory
   * @param {{signalCfg:object, warmupEvents:number, embargoSec:number}} cfg
   * @returns {{trades:Trade[], summary:Summary, byYear:Array, equity:Array<{time,value}>}}
   */
  runBacktest(memory, prototypes, cfg, onProgress),
}
```

`Summary` icinde: `total, fired, wins, losses, winRate, expectancyAtr,
profitFactor, maxDrawdownAtr, avgRr, baselineWinRate` (baseline = tum ilk
dokunuslarin ham basari orani; sistemin katma degerini gosterir).

`equity`: her islemde `success ? +tp1Atr : -slAtr` birikimli toplami.

Performans: 20 bin olayda tam yuruyen ileri test 60 saniyeyi gecmemeli.
Gerekiyorsa hafizayi zaman sirali tutup artimli aday havuzu kullan.

## 17. `src/core/data/*` (A8)

```js
// provider.js
/**
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} name
 * @property {boolean} needsKey
 * @property {string[]} caps           ['history'] ve/veya ['live']
 * @property {boolean} isProxy         Fiyat XAUUSD spot degil mi (GC=F, PAXG gibi)
 * @property {string} note             Turkce kisa aciklama
 * @property {(opts:{tfSec:number, from:number, to:number, apiKey?:string,
 *            onProgress?:Function}) => Promise<Series>} fetchCandles
 */
module.exports = { PROVIDERS, getProvider(id), listProviders() }
```

Saglayicilar:
- `yahoo`: `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d`
  Anahtarsiz, gercek hacim var, `isProxy: true` (COMEX vadeli, spot ile fark var).
  Desteklenen araliklar Yahoo sinirlarina gore secilir (1m icin en fazla 7 gun geriye).
  `User-Agent` basligi gonder, yoksa engellenir.
- `binance`: `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT` anahtarsiz,
  gercek zamanli, `isProxy: true`.
- `okx`: `https://www.okx.com/api/v5/market/candles?instId=XAUT-USDT` anahtarsiz,
  `isProxy: true`. Not: 1m barlarin cogunda hacim sifir, flow bileseni icin zayif.
- `twelvedata`: `https://api.twelvedata.com/time_series?symbol=XAU/USD` anahtar
  gerekir, spot dogru fiyat, ama forex serilerinde HACIM GELMEZ (volume 0).
- `polygon`: `https://api.polygon.io/v2/aggs/ticker/C:XAUUSD/range/...` anahtar
  gerekir, spot dogru fiyat ve tick sayisi hacmi. Onerilen ucretli secenek.
- `histdata`: aylik tick zip indirir ve 1m muma cevirir. Referans:
  `/Users/dogukandogru/dev/indicator2/backend/app/services/histdata.py`.
  Zaman dilimi sabit UTC-5. Zip acmak icin Node `zlib.inflateRawSync` ile
  minimal ZIP okuyucu yaz (harici bagimlilik yok). Hacim = dakikadaki tick sayisi.
  Icinde bulunulan ay yayinlanmaz.

```js
// loader.js
module.exports = {
  /** Eksik araliklari saptar ve saglayicidan cekip binstore'a ekler. */
  async syncHistory({dataDir, tf, providerId, apiKey, from, to, onProgress}),
  /** Vekil kaynak fiyatini spot seviyesine tasimak icin medyan fark hesaplar. */
  computeBasis(spotSeries, proxySeries, overlapBars),
  applyBasis(series, offset),
  /** Depodan seri okur, gerekirse ust zaman dilimine yeniden ornekler. */
  async loadSeries({dataDir, tf, from, to}),
}
```

## 18. `src/main/*` (A9)

- `paths.js`: `dataDir()` = `app.getPath('userData')/data`, `candlePath(tf)`,
  `memoryPath(tf)`, `settingsPath()`. Klasorleri olusturur.
- `settings.js`: `load()`, `save(obj)`, `get(key)`, `set(key, val)`, `DEFAULTS`.
  DEFAULTS icinde: `symbol:'XAUUSD'`, `timeframe:'15m'`, `indicatorParams`,
  `outcomeCfg`, `signalCfg`, `providers:{history:'histdata', live:'yahoo'}`,
  `apiKeys:{twelvedata:'', polygon:''}`, `livePollSeconds:20`, `theme:'dark'`.
- `engine.js`: `worker_threads` ile tek isci baslatir, `call(cmd, payload, onProgress)`
  Promise dondurur, id ile eslestirir. Isci cokerse yeniden baslatir.
- `worker/engine.worker.js`: komut yonlendirici. Komutlar:
  `data:status`, `data:import`, `data:sync`, `data:candles`,
  `engine:scan`, `engine:zones`, `engine:touches`, `engine:signals`,
  `engine:evaluate`, `engine:backtest`, `engine:prototypes`, `engine:memory-summary`.
  Uzun islerde `{type:'progress', id, pct, msg}` mesaji gonderir.
- `ipc.js`: `ipcMain.handle('api:call', (e, {cmd, payload}) => ...)`.
  Ilerleme ve canli olaylar `webContents.send('api:event', {type, data})` ile gider.
- `live.js`: secili saglayicidan `livePollSeconds` araliginda son barlari ceker,
  depoya ekler, yeni KAPANMIS bar olustuysa indikatoru son pencerede calistirir,
  yeni ilk dokunus varsa `evaluateTouch` cagirir ve sinyali renderer'a yollar.
  Vekil kaynak kullaniliyorsa `computeBasis` ile fiyat kaydirmasi uygular ve
  bunu sinyalin `reasons` alanina not dusuer.
- `preload.js`:
  ```js
  contextBridge.exposeInMainWorld('api', {
    call(cmd, payload),          // Promise
    on(type, handler),           // 'progress' | 'live:candle' | 'live:signal' | 'log'
    off(type, handler),
  })
  ```
- `main.js`: 1500x950 pencere, `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: false` (preload icin gerekli degilse true birak). `--dev` ile devtools.
  macOS'ta pencere kapaninca uygulama kapanmaz, Windows'ta kapanir.

## 19. `src/renderer/*` (A10)

ESM modulleri, `<script type="module" src="app.js">`. lightweight-charts
standalone dosyasi ayri bir `<script>` ile ONCE yuklenir ve global
`LightweightCharts` nesnesini verir. **Surum 4.2.3 API'si kullanilir:**
`LightweightCharts.createChart(el, opts)`, `chart.addCandlestickSeries(opts)`,
`series.setMarkers([...])`, `series.createPriceLine({...})`,
`chart.timeScale().subscribeVisibleLogicalRangeChange(cb)`.
(v5'teki `chart.addSeries(CandlestickSeries, ...)` API'si KULLANILMAZ.)

Duzen:
- Ust serit: sembol (XAUUSD sabit), zaman dilimi butonlari (1m 5m 15m 30m 1h 4h),
  saglayici secimi, "Canli" ac/kapa, "Geçmişi Tara" butonu, ilerleme cubugu.
- Sol/orta: grafik. Uzerinde canvas overlay ile bolge kutulari.
- Sag panel sekmeleri: `Sinyaller`, `Bölgeler`, `Hafıza`, `Ayarlar`, `Test`.
- Alt serit: veri durumu (kac mum, ilk/son tarih), motor durumu, saat.
- Ayri sekme: `TradingView` (iframe ile gomulu TradingView grafigi,
  `https://s.tradingview.com/widgetembed/?symbol=OANDA%3AXAUUSD&interval=15&theme=dark`).
  Bu sekmede kendi cizimlerimiz GORUNMEZ, kullaniciya bu not gosterilir.

`overlay.js` gorevi: grafigin uzerine mutlak konumlu bir `<canvas>` koyar,
`series.priceToCoordinate()` ve `chart.timeScale().timeToCoordinate()` ile
bolgeleri dikdortgen olarak cizer. Yalnizca gorunur araliktaki bolgeler cizilir.
`subscribeVisibleLogicalRangeChange` ve `ResizeObserver` ile yeniden cizim yapar.
Destek yesil, direnc kirmizi, kirilan bolge soluk ve kesik cerceveli.
Bolgeye tiklaninca o bolgenin dokunus gecmisi sag panelde acilir.

Sinyal isaretleri: `series.setMarkers` ile BUY icin altta yukari ok (`arrowUp`),
SELL icin ustte asagi ok. Etikette basari orani yazar, ornegin `%78`.
Bir sinyale tiklaninca sag panelde detay acilir: giris/TP1/TP2/SL fiyat cizgileri
grafige dusler ve benzer gecmis ornekler mini grafik (sparkline canvas) olarak listelenir.

`Test` sekmesi: yuruyen ileri test sonuclari, ozet tablo, yillara gore kirilim
ve sermaye egrisi (basit canvas cizimi).

Tema: TradingView koyu temasi. Arka plan `#131722`, izgara `#1e222d`,
yukselen mum `#26a69a`, dusen mum `#ef5350`, metin `#d1d4dc`.

## 20. `scripts/*` ve `README.md` (A11)

- `scripts/import-legacy.mjs`: calisan `indicator2-db-1` Docker konteynerindeki
  TimescaleDB'den mumlari yeni ikili depoya aktarir. Komut:
  `docker exec indicator2-db-1 psql -U xauusd -d xauusd -At -F',' -c "COPY (SELECT extract(epoch from ts)::bigint, open, high, low, close, volume FROM candles WHERE timeframe='1m' ORDER BY ts) TO STDOUT WITH CSV"`
  Ciktiyi akis halinde ayristirip `binstore.writeSeries` ile yazar. Bellekte
  tumunu string olarak tutma, satir satir isle ve buyuyen tampon kullan.
  Hedef: `~/Library/Application Support/Zone Memory/data/XAUUSD_1m.bin` (macOS),
  Windows'ta `%APPDATA%/Zone Memory/data`. Yol hesabi Electron olmadan
  yapilacagi icin `scripts/userdata-path.mjs` benzeri kucuk bir yardimci yaz
  veya `--out` parametresi al.
- `scripts/fetch-history.mjs`: saglayici uzerinden gecmis indirir (Electron'suz).
- `README.md`: Turkce. Kurulum (macOS ve Windows), calistirma, ilk veri kurulumu,
  saglayici secimi ve anahtarlar, sistemin nasil calistigi, bilinen sinirlar.

## 21. `test/*.test.js` (A12)

`node --test` ile calisir, harici bagimlilik yok. En az su testler:
- `ta.test.js`: ema/rma/atr/rsi degerleri Python portuyla ayni mi (elle
  hesaplanmis kucuk ornekler), pivotHigh/pivotLow konumlandirmasi.
- `series.test.js`: resample kova hizalamasi, indexAtTime ikili aramasi,
  concatSeries tekillestirme.
- `binstore.test.js`: yaz/oku gidis donus, append tekillestirme.
- `indicator.test.js`: sentetik seride bolge olusumu, yakin bolge birlestirme,
  kirilma sayaci, ILK dokunus kurali (ikinci dokunus olay uretmemeli),
  HTF trendinde ileriye bakma olmadigi.
- `outcome.test.js`: TP once, SL once, ayni barda ikisi (SL kazanir), timeout.
- `similarity.test.js`: pearson/cosine/dtw bilinen degerler, knn siralamasi,
  `beforeTime` filtresinin ileriye bakmayi engelledigi.
- `signal.test.js`: esik altinda `fired:false`, plan fiyatlarinin yonu dogru.
- `backtest.test.js`: yuruyen ileri testte gelecekteki kayitlarin kullanilmadigi.

## 22. Kullanilabilir referans dosyalar (salt okunur)

- `/Users/dogukandogru/dev/indicator/indicator.pine` - Pine v6 kaynagi
- `/Users/dogukandogru/dev/indicator2/backend/app/services/indicator/master_touch.py` - Python portu
- `/Users/dogukandogru/dev/indicator2/backend/app/services/features.py`
- `/Users/dogukandogru/dev/indicator2/backend/app/services/similarity.py`
- `/Users/dogukandogru/dev/indicator2/backend/app/services/outcomes.py`
- `/Users/dogukandogru/dev/indicator2/backend/app/services/histdata.py`
- `/Users/dogukandogru/dev/indicator2/backend/tests/test_master_touch.py`

Bu dosyalari OKU ama DEGISTIRME.
