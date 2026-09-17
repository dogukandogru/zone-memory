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
 * Indikatorun urettigi destek/direnc bolgesi (kutu).
 * @typedef {Object} Zone
 * @property {number} id            Seri icinde tekil, olusum sirasina gore artan
 * @property {boolean} isSupport    true destek (BUY LIQUIDITY), false direnc
 * @property {number} top
 * @property {number} bottom
 * @property {number} createdBar    Kutunun ONAYLANDIGI bar (pivot + pivotLen)
 * @property {number} createdTime   createdBar zamani (UNIX saniye)
 * @property {number} pivotBar      Pivotun asil bari (createdBar - pivotLen).
 *                                  Kutunun omru ve cizim uzunlugu BURADAN sayilir.
 * @property {number} pivotTime
 * @property {number} endBar        min(oldugu bar, pivotBar + boxLengthBars)
 * @property {number} endTime
 * @property {number} flow          Guncel akis skoru, 1..10 (dokunus ve
 *                                  birlesmelerle buyur)
 * @property {number} flowAtBirth   Kutu dogdugundaki akis skoru
 * @property {number} mergeCount    Kac yakin pivot bu kutuya katildi
 * @property {number} bbDistAtr     Pivotun Bollinger bandindan disari tasmasi,
 *                                  ATR biriminde (asiriligin derinligi)
 * @property {boolean} broken
 * @property {number} brokenBar     Kirilmadiysa -1
 * @property {number} touchCount
 */

/**
 * Bir bolge OLAYI. Sistemin ogrenme birimi budur. Iki turu vardir ve ikisi de
 * ayni yapiyi tasir; tarihsel nedenle dizinin adi hala `touches`.
 *
 *   kind = 'form'   Kutunun DOGDUGU an. Pivot barindan pivotLen bar sonra
 *                   onaylanir, yani ileriye bakma yoktur.
 *   kind = 'touch'  Fiyat kutuyu tamamen terk ettikten sonra GERI DONUP ilk kez
 *                   dokundugu an.
 *
 * Bir bolge her turden EN FAZLA BIR olay uretir.
 *
 * @typedef {Object} Event
 * @property {number} id
 * @property {number} zoneId
 * @property {'form'|'touch'} kind
 * @property {boolean} isSupport
 * @property {'BUY'|'SELL'} direction   isSupport ? 'BUY' : 'SELL'
 * @property {number} bar
 * @property {number} time
 * @property {number} price             Olay barinin kapanisi
 * @property {number} zoneTop
 * @property {number} zoneBottom
 * @property {number} zoneFlow          Olay anindaki akis skoru, 1..10
 * @property {number} zoneAgeBars       bar - pivotBar
 * @property {number} penetration       Bolgeye ne kadar girildi, 0..1 arasi.
 *                                      Form olayinda her zaman 0.
 * @property {number} entryDistAtr      Kapanisin bolgenin yakin kenarina
 *                                      uzakligi, ATR biriminde. Form olayinda
 *                                      fiyatin pivottan ne kadar kactigini olcer.
 * @property {number} bbDistAtr         Kutunun bant disina tasmasi (Zone'dan)
 * @property {number} volRatio          Olay barinin hacim / hacim ortalamasi orani
 * @property {number} atr               Olay barindaki ATR(atrLen)
 * @property {number} score
 * @property {number} maxScore
 * @property {boolean} qualified        Skor ve seans kapisini gecti mi
 * @property {boolean} strong
 * @property {string} session           'Asia' | 'London' | 'New York' | 'Other'
 * @property {Object<string,boolean>} parts  flow, trend, session, rejection, volume
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
 * Hafiza kaydi: olay + ozellik + sonuc.
 * @typedef {Event & Outcome & {features: Features}} MemoryEvent
 */
```

## 2. Dosya haritasi ve sahiplik

Her satirin sahibi TEK bir ajandir. Baska bir ajanin dosyasina yazma.

```
src/core/tf.js                    A1
src/core/series.js                A1
src/core/paths-core.js            A1
src/core/util/cli.js              A1
src/core/store/binstore.js        A1
src/core/store/memstore.js        A1
src/core/ta.js                    A2
src/core/session.js               A2
src/core/indicator/proZones.js    A3
src/core/learn/outcome.js         A4
src/core/learn/features.js        A4
src/core/learn/similarity.js      A5
src/core/learn/cluster.js         A5
src/core/learn/memory.js          A6
src/core/learn/signal.js          A6
src/core/learn/liveEvents.js      A6
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
  TURETILEN_TF,       // ['5m','15m','1h','4h'] tabandan DOSYAYA turetilenler
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
  growF64(arr, need),              // Float64Array kapasitesini iki katina cikarir
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
- `<ad>.json` : `{version:1, tf, rowLen, shapeLen, retLen, ctxLen, ctxNames:[],
  count, builtToTime, events:[...]}` ve AYAR IZI alanlari:
  `indicatorParams`, `outcomeCfg`, `featureVersion`, `cfgHash`, `builtAt`,
  `buildCommit`, `buildSrcHash`. `events` icinde her kayit `features` HARIC tum
  Event + Outcome alanlari.

  **Ayar izi neden var.** Hafizanin hangi indikator ayari ve hangi etiket
  tanimiyla kuruldugu yazilmazsa, kullanici bir ayari degistirip taramayi
  unuttugunda canli sinyal YENI tanimla uretilen olayi ESKI tanimla
  etiketlenmis gecmisle karsilastirir ve bu hicbir yerde gorunmez.
  `cfgHash = memstore.cfgHash({indicatorParams, outcomeCfg, ctxNames})`
  (anahtarlari sirali JSON'un sha256 ozetinin ilk 12 hanesi). `loadMemory`
  bunlari `meta` alani icinde geri verir, `statMemory` da dondurur.
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

## 9. `src/core/indicator/proZones.js` (A3)

> Bu bolum ilk insadan SONRA degistirildi. Uygulama once MASTER 1 TOUCH
> indikatoruyle (`masterTouch.js`) calisiyordu; o dosya kaldirildi ve yerine
> kullanicinin yeni Pine indikatorunun portu kondu. Eski indikatorle olculmus
> sayilar (README 1. bolumdeki tablo, `presets.js` yorumlari) YENI INDIKATOR
> ICIN GECERLI DEGILDIR ve yeniden olculmesi gerekir.

Kullanicinin Pine v6 indikatorunun ("proje son versiyon 3") JavaScript portu.
Pine kaynagi: `~/Downloads/son pro.txt`.

Ozet mantik:

1. Pivot high / pivot low barinda bir kutu adayi dogar.
2. Aday iki KESIN kapiyi gecmelidir:
   - **hacim**: `vR = volume[pivot] / sma(volume, volumeLen)[pivot]` ve
     `flow = clamp(vR * 3, 1, 10)`; `vR >= minVolRatio && flow >= minFlowToShow`
   - **bollinger**: destekte `pivotLow <= bbLower[pivot]`, direncte
     `pivotHigh >= bbUpper[pivot]`
   Ikisi birlikte kutuyu bir "hacimli asirilik" kurulumu yapar. Sinyalin yonu
   bu yuzden ORTALAMAYA DONUS yonudur: destek kutusu BUY, direnc kutusu SELL.
   Pine'in kutuya yazdigi metin de budur (BUY LIQUIDITY / SELL LIQUIDITY).
3. Kutu geometrisi, `zH = atr[pivot] * zoneAtrMult` olmak uzere:
   - destek : `top = pivotLow + zH * 0.25`, `bottom = pivotLow - zH`
   - direnc : `top = pivotHigh + zH`, `bottom = pivotHigh - zH * 0.25`
4. Ayni yonde ve orta noktasi `atr[bar] * mergeAtrMult` mesafesinden yakin bir
   AKTIF kutu varsa yeni kutu ACILMAZ; mevcut kutu iki pivotu da kapsayacak
   sekilde genisler ve akis skoru `flow * 0.25` kadar artar (tavan 10).
   Birlesme YENI BIR OLAY URETMEZ.
5. Her dokunusta (ayni kutu icin `touchCooldown` bar araligiyla) akis skoru
   0.35 artar, tavan 10.
6. Kirilma: destekte `close < bottom - atr * breakAtrMult`, direncte
   `close > top + atr * breakAtrMult`. **Onay bari yoktur, tek bar yeter.**
   Kirilan kutu takipten duser.
7. Kutu, PIVOT barindan itibaren `maxAgeBars` bar yasar; cizimi `boxLengthBars`
   bar ileri uzar. Aktif liste `maxZones` ile sinirlanir, dolunca en eski kutu
   takipten duser ama `zones` ciktisinda kalir.

Pine'da olmayan, bu portun ekledigi katman **sinyal**tir. Pine yalnizca kutu
ciziyordu, hicbir alis/satis olayi uretmiyordu. Iki olay turu vardir:

- `kind = 'form'`  Kutu dogdugu barda (pivot + pivotLen). Ileriye bakma yok.
- `kind = 'touch'` Kutuya yapilan ILK dokunusta. Bu, kutunun DOGDUGU bara
  denk gelebilir: kutu pivotun etrafinda dogdugu icin fiyat o anda zaten kutunun
  icinde olabilir. Kasitlidir, kullanicinin karari. Onceki bir surumde kutunun
  once tamamen terk edilmesini bekleyen bir kural vardi (`requireArmedTouch`),
  kaldirildi.

```js
const DEFAULT_PARAMS = {
  // Pine: Bolge Ayarlari
  pivotLen: 5, atrLen: 14, zoneAtrMult: 0.35, mergeAtrMult: 0.55,
  maxZones: 24, maxAgeBars: 100, touchCooldown: 12, boxLengthBars: 100,
  // Pine: Volume Ayarlari
  useVolumeFilter: true, volumeLen: 50, minVolRatio: 1.05, minFlowToShow: 6.0,
  // Pine: Bollinger Band
  useBBFilter: true, bbLen: 20, bbMult: 2.0,
  // Pine'da sabit yazilmis kirilma tamponu
  breakAtrMult: 0.15,
  // Sinyal katmani (Pine'da yok)
  signalOnForm: true, signalOnTouch: true,
  minScoreForSignal: 3, strongScoreLevel: 4, strongFlowLevel: 8.0,
  useFlowScore: true, useTrendScore: true, useSessionScore: true,
  useRejectionScore: true, useVolumeScore: true, wickMinRatio: 0.35,
  // Baglam (Pine'da yok, ozellik vektoru ve skor icin)
  useHtfTrend: true, trendTf: '15m', emaFastLen: 50, emaSlowLen: 200,
  sessionTz: 'Europe/Istanbul', hardSessionGate: false,
  useAsia: true, useLondon: true, useNewYork: true, useOther: true,
  mintick: 0.01,
}

module.exports = {
  DEFAULT_PARAMS,
  /**
   * @param {Series} s
   * @param {object} params  DEFAULT_PARAMS uzerine yazilir
   * @param {number} tfSec   Serinin zaman dilimi (saniye)
   * @param {(pct:number, msg:string)=>void} [onProgress]
   * @returns {{zones: Zone[], touches: Event[], context: IndicatorContext, stats: object}}
   */
  runIndicator(s, params, tfSec, onProgress),
}
```

**Skorlama.** Kutu olusumunun kapisi (hacim + bollinger) KESIN oldugu icin o iki
kriter her kutuda dogrudur ve skor bileseni olarak bilgi tasimaz. Bu yuzden skor,
olayin OLDUGU BARDA degisen bes seyi olcer:

| bilesen | kosul | anahtar |
| --- | --- | --- |
| akis | `zoneFlow >= strongFlowLevel` | `flow` |
| trend | ust zaman dilimi trendi yonle uyumlu | `trend` |
| seans | olay bari secili seansta | `session` |
| fitil reddi | olay barinin fitili `wickMinRatio` orandan uzun ve yon dogru | `rejection` |
| hacim | `volume[bar] / volMA[bar] >= minVolRatio` | `volume` |

`maxScore` = acik bilesen sayisi. `needed = min(minScoreForSignal, maxScore)`,
`qualified = score >= needed && (!hardSessionGate || sessionAllowed)`.
Kapali bir olay turu (`signalOnForm` / `signalOnTouch` false) hic olay uretmez.

`IndicatorContext`, ozellik cikarimi ve etiketleme icin yeniden hesaplanmasin
diye geri verilen ara diziler:

```js
/**
 * @typedef {Object} IndicatorContext
 * @property {Float64Array} atr        ATR(atrLen)
 * @property {Float64Array} rsi        RSI(14)
 * @property {Float64Array} sma20
 * @property {Float64Array} sma50
 * @property {Float64Array} bbBasis
 * @property {Float64Array} bbUpper
 * @property {Float64Array} bbLower
 * @property {Float64Array} volRatio     hacim / hacim ortalamasi
 * @property {Float64Array} flowScore    clamp(volRatio * 3, 1, 10)
 * @property {Uint8Array} bullTrend
 * @property {Uint8Array} bearTrend
 * @property {Uint8Array} sessionIdx
 * @property {Uint8Array} localHour
 * @property {Uint8Array} localDow
 */
```

Diger kurallar:

1. `penetration`: destekte `(top - min(low, top)) / (top - bottom)`, direncte
   `(max(high, bottom) - bottom) / (top - bottom)`, 0..1 arasina kirpilir.
   Form olayinda her zaman 0'dir, cunku fiyat kutunun icinde degildir.
2. Bu port TUM olaylari `touches` icinde dondurur; `qualified` bayragi esigi
   gecenleri isaretler. Benzerlik motoru tum olaylari korpus olarak kullanir.
3. HTF trend: `trendTf` grafik zaman diliminden BUYUKSE, seri o zaman dilimine
   yeniden orneklenir, EMA'lar orada hesaplanir ve degerler **HTF bari kapandiktan
   sonra** gecerli olacak sekilde ileri doldurulur (lookahead yok). Kucuk veya
   esitse seri oldugu gibi kullanilir. Trend kutu olusumunu ETKILEMEZ, yalnizca
   skora ve baglama girer.
4. `onProgress` 0..100 arasi yuzde ile en fazla 100 kez cagrilir.
5. Olaylar zamana gore artan sirada doner, `id` degerleri 0'dan baslar ve
   birer artar.

Performans: 6 milyon bar isleyebilmeli. Ic dongude nesne ayirmaktan kacin;
aktif kutu listesi `maxZones` ile sinirli oldugu icin dogrusal tarama yeterlidir.

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
  entryMode: 'zoneEdge', // dokunus olayinda giris: 'zoneEdge' | 'close'
  formTargetRr: 1.0,     // form olayinda hedef, riskin bu kati kadar uzakta
  maxFormRiskAtr: 3.0,   // form olayinda kabul edilen azami risk (ATR)
  tpAtr: 1.0,            // atr modu
  slAtr: 1.0,            // atr modu
}

module.exports = {
  DEFAULT_OUTCOME_CFG,
  labelTouch(s, event, atrAtEvent, cfg),   // Outcome | null
  zoneLevels(event, atr, cfg),             // {entry, target, invalid, sign, entryMode, riskAtr, rewardAtr} | null
}
```

**Iki olay turu, iki giris modeli.** `event.kind` seviyeleri belirler:

| | `kind = 'touch'` | `kind = 'form'` |
| --- | --- | --- |
| giris | bolgenin YAKIN kenari, limit emir | onay barinin KAPANISI |
| gecersizlik | bolgenin UZAK kenari -/+ `breakBufferAtr * atr` | ayni |
| hedef | yakin kenardan `targetAtr * atr` | giristen `formTargetRr * risk` |
| odul | her zaman `targetAtr` | her zaman `formTargetRr` risk birimi |

Dokunus olayinda giris kenardadir cunku dokunus tanimi geregi fiyat o kenari
gecmistir, yani limit emir dolar. Form olayinda fiyat kutunun icinde DEGILDIR,
oraya donmeyebilir; bu yuzden giris kapanistir ve risk kurulumdan kuruluma
degisir. Hedef sabit bir ATR mesafesi olsaydi risk/odul 0.3 ile 2.0 arasinda
savrulur ve "gecmiste bu yapi %70 tuttu" cumlesi karsilastirilamaz seylerin
ortalamasi olurdu. `formTargetRr` bunu tek eksene indirger: tum form olaylari
ayni risk/odul oranini tasir, aralarindaki tek fark isabet oranidir.

`formTargetRr = 0` verilirse form olayinda da sabit `targetAtr` mesafesi
kullanilir.

**Form olayinda iki eleme.** `zoneLevels` su iki durumda `null` doner ve olay
hafizaya HIC girmez (`noLabel` olarak sayilir):
1. Giris zaten gecersizlik tarafindaysa (pivot onaylanana kadar fiyat kutunun
   obur tarafina gecmis).
2. Risk `maxFormRiskAtr` esigini asiyorsa (sivri bir fitil dibinden sonra fiyat
   cok uzaga kacmis). Boyle bir kurulum gercekte islenmez; hafizaya girerse hem
   kendi istatistigini bozar hem plan hedeflerini sisirir. `0` sinirı kapatir.

Ayrica dokunus olayina ozgu kural: giris kenardan limit emirle OLAY BARI icinde
dolar, o bar gecersizligi de gorduyse bar ici sirayi bilemedigimiz icin ANINDA
kirilma yazilir. Form olayinda boyle bir kural yoktur, emir bar kapaninca dolar.

**Bolge modu (varsayilan).** Destege yapilan dokunus icin:
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
  'scoreRatio', 'pFlow', 'pTrend', 'pSession', 'pRejection', 'pVolume',
  'isSupport', 'trendState', 'isForm', 'bbDistAtr', 'volRatio', 'entryDistAtr',
]

module.exports = {
  SHAPE_LEN, RET_LEN, WINDOW_BARS, CTX_NAMES,
  /**
   * @param {Series} s
   * @param {Event} event
   * @param {IndicatorContext} ctx
   * @returns {Features|null}   Pencere yetmiyorsa null
   */
  buildFeatures(s, event, ctx),
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
  `clamp(zoneFlow,0,10)/10`, `penetration`, `score/maxScore`,
  `parts.flow?1:0`, `parts.trend?1:0`, `parts.session?1:0`,
  `parts.rejection?1:0`, `parts.volume?1:0`,
  `isSupport?1:0`, `bullTrend?1:(bearTrend?-1:0)`,
  `kind==='form'?1:0`, `clamp(bbDistAtr,0,3)/3`, `clamp(volRatio,0,3)/3`,
  `clamp(entryDistAtr,0,5)/5`.
- `zoneFlow` 10'a bolunur cunku Pine'daki akis skoru 1..10 araligindadir.
- Tum ctx degerleri sonlu olmali; NaN cikarsa 0 yaz.

**Baglam vektoru indikatore baglidir.** `pFlow / pTrend / pSession / pRejection /
pVolume`, `proZones` cikisindaki `parts` anahtarlarinin birebir karsiligidir.
`CTX_NAMES` degisirse eski hafiza dosyalari kendi iclerinde tutarli kalir ama
yeni olaylarla KARSILASTIRILAMAZ. Motor bunu yakalar: `engine.worker.js`
`getMemory`, yuklenen `ctxNames` uzunlugu guncelden farkliysa anlasilir bir hata
firlatip yeniden tarama ister.

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
   * @param {{k:number, direction:string, kind:string, excludeWithinSec:number,
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

`kind`: yalnizca ayni turdeki olaylar aday olur. Kutunun DOGDUGU an ile fiyatin
ona GERI DONDUGU an iki farkli kurulumdur; girisleri, riskleri ve tipik
sonuclari ayridir. Karistirilirsa "gecmiste bu yapi %78 tuttu" cumlesi baska bir
kurulumun istatistigini tasir. Kayitta `kind` yoksa `'touch'` kabul edilir.

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
   * Tarih boyunca indikatoru calistirir, uretilen olaylari (kutu olusumu ve
   * bolgeye ilk geri donus) etiketler, ozellik vektorlerini cikarir ve hafiza
   * kaydini uretir.
   * @param {Series} s
   * @param {{tf:string, params:object, outcomeCfg:object}} cfg
   * @param {(pct:number,msg:string)=>void} [onProgress]
   * @returns {{tf, ctxNames, events: MemoryEvent[], zones: Zone[], stats: object}}
   */
  buildMemory(s, cfg, onProgress),
  /** Var olan hafizaya yeni barlardan gelen olaylari ekler (artimli tarama). */
  extendMemory(s, memory, cfg, onProgress),
  /**
   * Hafiza ozeti: toplam, basarili, basarisiz; yon, OLAY TURU (byKind),
   * seans dagilimi ve yillara gore kirilim.
   */
  summarize(memory),
}
```

`stats` icinde en az: `bars, zonesCreated, zonesMerged, totalEvents, formEvents,
touchEvents, formStored, touchStored, firstTouches, qualified, labeled,
respected, broken, timeout, scoreHist`.

**Artimli taramada tekrar anahtari.** `extendMemory` seriyi bastan degil, son
olayin epeyce oncesinden yeniden tarar ve yeniden taramada kimlikler sifirdan
numaralanir. Tekrar kontrolu bu yuzden `kind + zoneId + time` uclusuyle yapilir;
asil koruma ise "hafizadaki son olay zamanindan SONRAKI olaylar" filtresidir.

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
   * Bir bolge olayini hafizayla karsilastirip sinyal uretir. Karsilastirma
   * YALNIZCA ayni turdeki (`event.kind`) gecmis olaylarla yapilir.
   * Esikleri gecemezse yine bir nesne doner ama `fired: false` olur; boylece
   * arayuz "neden sinyal olmadi" bilgisini gosterebilir.
   * @returns {Signal}
   */
  evaluateTouch(event, features, memory, prototypes, cfg, beforeTime),
}

/**
 * @typedef {Object} Signal
 * @property {string} id
 * @property {boolean} fired
 * @property {'form'|'touch'} kind
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

### `src/core/learn/liveEvents.js` (A6)

Canli dongunun "bu tikte yeni olan olaylar" secimi. Saf modul, dosya ve ag
bilmez.

```js
module.exports = {
  /**
   * Olayin kayan pencereden ETKILENMEYEN kimligi:
   * `kind + '|' + time + '|' + zoneTop.toFixed(5) + '|' + zoneBottom.toFixed(5)`
   * zoneId KULLANILMAZ: proZones her calismada kutulari sifirdan numaralandirir
   * ve canli kuyruk her barda kaydigi icin ayni bolge her tikte baska bir
   * zoneId alir.
   */
  eventKey(event),
  /**
   * `since` degerinden SONRAKI, `seen` icinde OLMAYAN tum olaylari zaman
   * sirasiyla dondurur. Ayni barda birden fazla olay varsa HEPSI doner
   * (olculdu: 15m'de 5378 olayin 60'i ayni barda baska bir olayla birlikte).
   * `seen` Set veya dizi olabilir ve DEGISTIRILMEZ.
   */
  selectNewEvents(touches, since, seen),
}
```

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
profitFactor, maxDrawdownAtr, avgRr, baselineWinRate, byKind`
(baseline = etiketlenmis TUM olaylarin ham basari orani; sistemin katma degerini
gosterir).

`byKind`, iki sinyal turunun ayri kirilimidir:
`[{kind, total, fired, wins, losses, winRate, expectancyAtr, totalPnlAtr}]`.
Toplam rakam, turlerden birinin digerini tasidigi durumlari gizler; hangi
sinyalin gercekten calistigina bu tabloya bakilarak karar verilir.
`Trade` kayitlari da `kind` alani tasir.

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
  Dosya saatleri sabit UTC-5 DEGILDIR: yaz saati uygulanir ve kural 2019'da
  degismistir (2018 ve oncesi ABD, 2019 ve sonrasi Avrupa yaz saati tarihleri).
  Donusum `dosyaOfsetiSn(yil, ay, gun)` icindedir; olculdu, sabit UTC-5
  varsayimi yilin yaklasik %63'undeki barlari 1 saat ileri kaydiriyordu.
  Zip acmak icin Node `zlib.inflateRawSync` ile
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
  `memoryPath(tf)`, `settingsPath()`, `liveLogPath(tf)` (= `memoryPath(tf)` +
  `.live.jsonl`, canli sinyal gunlugu). Klasorleri olusturur. Yol birlestirme,
  ortam degiskeni onceligi ve klasor olusturma `src/core/paths-core.js`
  icindedir; `paths.js` yalnizca Electron'un `userData` degerini varsayilan
  kok olarak verir, betikler (`scripts/*.mjs`) ayni cekirdegi kullanir.
- `settings.js`: `load()`, `save(patch)`, `replace(tam)`, `get(key)`,
  `set(key, val)`, `applySetPayload(p)`, `varsayilanlaraDon()`, `DEFAULTS`,
  `SINIRLAR`. DEFAULTS icinde: `symbol:'XAUUSD'`, `timeframe:'5m'`,
  `indicatorParams`, `outcomeCfg`, `signalCfg`,
  `providers:{history:'histdata', live:'binance'}`,
  `apiKeys:{twelvedata:'', polygon:''}`, `livePollSeconds:20`,
  `autoStartLive:true`, `autoPrepareOnTfChange:true`, `theme:'dark'`.

  **`settings:set` yuk sozlesmesi.** Uc bicim de kabul edilir ve tek yerde
  (`applySetPayload`) cozulur: `{key:'apiKeys.polygon', value:'...'}`,
  `{patch:{...}}` veya dogrudan yamanin kendisi (`{timeframe:'1h'}`). Renderer
  `{patch}` bicimini kullanir. DEFAULTS icinde `key`, `patch` veya `value`
  adinda ust duzey alan YOKTUR, ciplak yamayi tanimak bu yuzden guvenlidir.

  **Sinir denetimi.** `save` ve `replace`, yazmadan once `SINIRLAR` tablosuna
  gore sayisal alanlari kirpar; sayi olmayan degerde onceki deger korunur,
  bilinmeyen `timeframe` yazilmaz. Arayuzdeki min/max yalnizca ipucudur,
  baglayici olan bu tablodur.

  **Sifirlama.** `settings:reset` -> `varsayilanlaraDon()`: tum ayarlar
  varsayilana doner ama `apiKeys`, `providers` ve `timeframe` KORUNUR.
- `engine.js`: `worker_threads` ile tek isci baslatir, `call(cmd, payload, onProgress)`
  Promise dondurur, id ile eslestirir. Isci cokerse yeniden baslatir.
- `worker/engine.worker.js`: komut yonlendirici. Komutlar:
  `data:status`, `data:doctor`, `data:import`, `data:sync`, `data:candles`,
  `engine:scan`, `engine:zones`, `engine:touches`, `engine:signals`,
  `engine:backtest`, `engine:backtest-last`, `engine:prototypes`,
  `engine:memory-summary`, `engine:memory-delete`, `engine:live-tick`,
  `engine:live-log`.
  Uzun islerde `{type:'progress', id, pct, msg}` mesaji gonderir.

  **Ayar birlestirme (tek nokta).** `engine:scan`, `engine:backtest` ve
  `engine:live-tick` esikleri `core/learn/presets.js` icindeki
  `resolveCfg(tf, cfgPatch, memMeta)` ile cozer. Sira: cekirdek varsayilani,
  zaman dilimine ait hazir ayar, kullanicinin YAMASI. Plan geometrisi (TP1, SL)
  hafizanin etiketlendigi `outcomeCfg`den gelir, yani "bolge tuttu" ile "TP1
  vuruldu" ayni olaydir. Yuk bicimi: `{tf, params, cfgPatch}` (tarama ve canli)
  ve `{tf, cfg:{warmupEvents, cfgPatch}}` (test). Test yukunde esikler UST
  DUZEYDE gelirse isci anlasilir bir hata firlatir; eskiden sessizce yok
  sayiliyor ve hazir ayar olculuyordu.

  `engine:backtest` sonucu `<ad>_memory.backtest.json` dosyasina yazilir
  (`usedCfg`, `memory`, `cfgHash`, `cfgMatch`, `summary`, `byYear`, `equity`).
  `engine:backtest-last` bunu geri verir ve hafizanin izi degistiyse
  `stillValid:false` doner. `engine:scan` test sinyallerini ve bu ozeti
  YALNIZCA ayar izi degistiyse siler.

  **`engine:live-tick` birden fazla olay dondurur.** Yuk:
  `{tf, series, isProxy, providerId, basis, volScale, basisWarned, fetchedAt,
  sinceTime, seenKeys, params, cfgPatch, tailBars}`. Sonuc `events` dizisi
  tasir: `[{key, touch, signal, ageBars}]`. Onceden yalnizca SON olay aliniyor
  ve `sinceTime` onun zamanina cekildigi icin ayni bardaki diger olaylar
  kalici olarak kayboluyordu; aday secimi artik
  `core/learn/liveEvents.selectNewEvents` ile yapilir. Tekil `signal` ve
  `touch` alanlari GERIYE UYUM icin dizinin sonuncusuyla doldurulur.
  `ageBars = (fetchedAt - (time + tfSec)) / tfSec`; 1'den buyukse sinyale
  `stale: true` konur ve `reasons` dizisine gecikme notu eklenir.

  **Canli sinyal gunlugu: `<ad>_memory.live.jsonl` (JSON Lines).** Her canli
  olay, tetiklenmemis olsa bile, bir satir olarak EKLENIR (dosya hic
  yeniden yazilmaz). Iki satir tipi vardir:

  ```
  {type:'event',   key, tf, time, fetchedAt, ageBars, providerId, isProxy,
                   basis, volScale, cfgHash, touch, signal}
  {type:'outcome', key, outcome, win, realizedR, pnlAtr, barsToOutcome}
  ```

  `signal` yalnizca ozet tasir: `fired, direction, kind, winRate, matchCount,
  confidence, expectancy, entry, tp1, sl, rr, atr, stale`. Sonuc satiri, olayin
  ufku dolunca (`time + horizonBars * tfSec <= son kapanmis bar`) yazilir:
  olay bari `series.lastIndexAtOrBefore` ile bulunur, etiket
  `learn/outcome.labelTouch` ile, kazanc `learn/backtest.tradeResult` ile
  hesaplanir (ayri bir kopya YOKTUR). Etiketleme tanimi hafizanin
  `outcomeCfg`sidir (`presets.resolveCfg` -> `planOutcomeCfg`).
  `engine:scan` ve `engine:memory-delete` bu dosyaya DOKUNMAZ: canli olcu
  taramadan bagimsiz birikir.

  `engine:live-log` (yuk: `{tf, limit}`) dosyayi okuyup ozet dondurur:
  `{tf, found, count, fired, labeled, wins, winRate, netAtr, expectancyAtr,
  stale, firstTime, lastTime, records}`. `winRate` ve `netAtr` YALNIZCA
  tetiklenmis ve etiketlenmis kayitlar uzerinden olculur (test ozetiyle ayni
  taban). Dosya yoksa `found:false` ve sifirli ozet doner.

  Kaldirilan komut: `engine:evaluate` (renderer'dan hic cagrilmiyordu ve
  ambargosuz, farkli ayarla sinyal uretiyordu).
- `ipc.js`: `ipcMain.handle('api:call', (e, {cmd, payload}) => ...)`.
  Ilerleme ve canli olaylar `webContents.send('api:event', {type, data})` ile gider.
- `live.js`: secili saglayicidan `livePollSeconds` araliginda son barlari ceker,
  depoya ekler, yeni KAPANMIS bar olustuysa indikatoru son pencerede calistirir,
  yeni olaylar varsa `evaluateTouch` cagirir ve sinyalleri renderer'a yollar.
  Donen `events` dizisindeki HER sinyal icin ayri bir `live:signal` olayi
  yayinlanir; degerlendirilen olay anahtarlari bir Set'te tutulur ve bir
  sonraki tike `seenKeys` olarak gonderilir (tekrar degerlendirme olmaz).
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
Bolgeye tiklaninca o bolgenin olay gecmisi sag panelde acilir.

Sinyal isaretleri: `series.setMarkers` ile BUY icin altta yukari ok (`arrowUp`),
SELL icin ustte asagi ok. Etikette olay turu oneki ve basari orani yazar:
`O %78` kutu olusumu, `D %78` bolgeye geri donus. Sinyal listesinde ayni ayrim
`OLUSUM` / `DOKUNUS` rozetiyle gosterilir ve suzgecte ayri secenekleri vardir.
Bir sinyale tiklaninca sag panelde detay acilir: giris/TP1/TP2/SL fiyat cizgileri
grafige dusler ve benzer gecmis ornekler mini grafik (sparkline canvas) olarak listelenir.

`Test` sekmesi: yuruyen ileri test sonuclari, ozet tablo, yillara gore kirilim
ve sermaye egrisi (basit canvas cizimi). Panelin ALTINA `renderLiveLog` ile
"Canlı sinyal günlüğü" bolumu cizilir: kayit sayisi, tetiklenen, etiketlenen,
canli isabet orani ve net ATR; ayrica "Testte olculen" degerler ve aradaki
fark (drift). Veri yoksa `'Henüz canlı sinyal kaydı yok.'` yazar. Ozet
`engine:live-log` ile zaman dilimi yuklenirken alinir (`durum.canliGunluk`).

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
  yapilacagi icin `scripts/userdata-path.mjs` kullanilir (govdesi
  `src/core/paths-core.js` icindedir) veya `--out` parametresi alinir.

  **Uzerine yazma korumasi (zorunlu).** Hedef `.bin` dosyalarindan biri zaten
  varsa betik veritabanina HIC dokunmadan durur ve cikis kodu 1 verir.
  `--force` verilirse her hedef once `<ad>.bak-YYYYMMDD-HHMMSS` olarak
  kopyalanir. `--limit` verilip `--out` verilmezse hedef
  `os.tmpdir()/zone-memory-deneme/` olur: deneme aktarimi gercek depoyu asla
  ezmez. Gercek veri klasorune aktarim bitince mevcut
  `<sembol>_<tf>_memory*` dosyalari `<dataDir>/_eski_hafiza_yedek/<damga>/`
  altina TASINIR ve hafizalarin yeniden taranmasi gerektigi bildirilir
  (aktarilan mumlarla eski hafizanin bar indeksleri uyusmaz).
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
- `indicator.test.js`: sentetik seride kutu olusumu, hacim ve bollinger
  kapilarinin gercekten elemesi, yakin pivotun birlestigi, tek barda kirilma,
  kutu omru, form olayinin onay barinda uretildigi, temas olayinin ilk dokunusta
  (gerekirse kutunun dogdugu barda) uretildigi, bolge basina her turden EN FAZLA
  BIR olay, olaylarin zaman sirasi, HTF trendinde ileriye bakma olmadigi.
- `outcome.test.js`: TP once, SL once, ayni barda ikisi (SL kazanir), timeout;
  form olayinda girisin kapanis oldugu, hedefin riskin kati oldugu
  (`formTargetRr`), asiri riskin `maxFormRiskAtr` ile elendigi.
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
