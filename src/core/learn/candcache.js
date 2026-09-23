'use strict'

/**
 * A2 - KOMSU ONBELLEGI (candidate cache).
 *
 * Yuruyen ileri test her olay icin kNN'i bastan hesapliyordu; 1 dakikalik
 * hafizada tek kosu 50 saniyenin uzerinde suruyor. Ileride parametre taramasi
 * (farkli esiklerle onlarca kosu) yapilacak ve esik degistiginde KOMSULAR
 * DEGISMEZ, yalnizca karar degisir:
 *
 *   komsular  <- k, agirliklar, yon, tur, zaman filtresi, komsu dislama
 *   karar     <- minSimilarity, minMatches, minWinRate, minRr, minExpectancy
 *
 * Bu modul birinci kumeyi bir kez hesaplayip iki duz diziye yazar. Sonrasinda
 * `backtest.runBacktestFromCache` esik denemelerini kNN'e hic dokunmadan
 * kosar.
 *
 * ADAY HAVUZU KURALI (tek tanim)
 * ---------------------------------------------------------------------------
 * Bir olay ancak SONUCU BELLI OLDUKTAN sonra baska bir sorguya komsu olabilir:
 * etiketi ufuk dolana kadar bilinmez, dolayisiyla daha erken bir sorgu onu
 * kullanamaz. Olcut olayin BASLADIGI zaman degil, `resolvedTime` alanidir;
 * alan yoksa (eski hafiza dosyalari) ufuk sonu tahmin edilir:
 *   time + horizonBars * tfSaniye
 * Bu kural `cozumZamaniFabrikasi` fonksiyonunda TEK BIR YERDE tanimlidir ve
 * hem backtest.js hem bu modul onu kullanir. Iki yerde yazilsa biri gunun
 * birinde degisir ve onbellek sessizce referans yoldan ayrisirdi.
 *
 * IKILI DOSYA BICIMI (serialize / deserialize)
 * ---------------------------------------------------------------------------
 * Tum sayilar little endian yazilir (hedef platformlar LE; big endian makinede
 * bayt takasi yapilir).
 *
 *   ofset  boyut      alan
 *   0      4          sihirli sayi 0x5A4D4343 ('ZMCC' harflerinin kodu; little
 *                     endian yazildigi icin dosyada baytlar ters sirada durur)
 *   4      2          surum (uint16), CANDCACHE_VERSION
 *   6      2          ayrilmis (uint16), su an 0
 *   8      4          n, sorgu olayi sayisi (uint32)
 *   12     4          k, olay basina aday sayisi (uint32)
 *   16     4          anahtar metninin bayt uzunlugu (uint32)
 *   20     A          anahtar metni (UTF-8), bkz. cacheKey
 *   20+A   D          dolgu: bas kisim 4'un katina tamamlanir (0..3 bayt)
 *   H      n*k*4      aday indeksleri (int32), bos yuva -1
 *   H+n*k*4  n*k*4    benzerlikler (float32)
 *
 * Indeksler, `prepareEvents` ile uretilen ZAMAN SIRALI ve ozellik vektoru olan
 * olay dizisine gore verilir; ham `memory.events` sirasina gore DEGIL.
 *
 * DIKKAT: benzerlikler float32 tutulur (dosya boyu icin). Karar esikleriyle
 * karsilastirma bu yuzden ~1e-7 mertebesinde yuvarlanmis deger uzerinden
 * yapilir. Yuvarlama monoton oldugu icin adaylarin SIRASI degismez.
 */

const { DEFAULT_SIGNAL_CFG, findCandidates, yonBelirle, turBelirle } = require('./signal')
const { agirlikCoz } = require('./similarity')

/** Onbellek bicim surumu. Bicim veya aday havuzu kurali degisirse artirilir. */
// Surum 2: her olay icin HAVUZ SAYACLARI da saklanir (baseN, baseWins).
// Sinyalin gosterdigi oran havuz tabanina dogru kuculutuldugu icin
// (kalibrasyon), onbellekli yol bu sayilari tasimazsa referans yoldan
// sapardi.
const CANDCACHE_VERSION = 2

/** Sihirli sayi: 'ZMCC' (Zone Memory Candidate Cache). */
const MAGIC = 0x5a4d4343

/** Bas kisim, anahtar metni ve dolgu haric. */
const HEADER_FIXED = 20

/**
 * Varsayilan ambargo, saniye. backtest.js'in DEFAULT_BACKTEST_CFG'si bu sabiti
 * kullanir; deger iki yerde yazilirsa onbellek ile referans yol farkli havuz
 * kurar.
 */
const DEFAULT_EMBARGO_SEC = 86400

/** Sonuc ufku bilinmiyorsa varsayilan bar sayisi (outcome.js ile ayni). */
const DEFAULT_HORIZON_BARS = 48

/** Zaman dilimi cozulemezse varsayilan bar suresi, saniye. */
const DEFAULT_TF_SEC = 900

// Hedef platformlar little endian; degilse bayt takasi yapilir.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/** Sonlu sayi degilse varsayilana duser. */
function sayi (v, varsayilan) {
  const x = Number(v)
  return Number.isFinite(x) ? x : varsayilan
}

/**
 * Hafizayi test ve onbellek icin hazirlar.
 *
 * Iki dizi doner:
 *   sorted  zamana gore artan TUM olaylar (taban oran sayimlari icin)
 *   events  bunlardan yalnizca ozellik vektoru olanlar; hem sorgu hem aday
 *           olabilecek olaylar bunlardir ve onbellek indeksleri BU diziye
 *           gore verilir
 * Cagiranin dizisini bozmamak icin kopya alinir. Siralama kararli oldugu icin
 * ayni zamanli olaylar ham sirada kalir, dolayisiyla iki cagri her zaman ayni
 * diziyi uretir.
 *
 * @param {{events?:Array<Object>}} memory
 * @returns {{sorted:Array<Object>, events:Array<Object>}}
 */
function prepareEvents (memory) {
  const ham = memory && Array.isArray(memory.events) ? memory.events : []
  const sorted = ham.slice()
  sorted.sort(function (a, b) {
    return a.time - b.time
  })
  const events = []
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] && sorted[i].features) events.push(sorted[i])
  }
  return { sorted: sorted, events: events }
}

/**
 * ADAY HAVUZU KURALI: bir olayin sonucunun BELLI OLDUGU zamani veren fonksiyon.
 *
 * @param {{tf?:string}} memory
 * @param {Object} [signalCfg] `outcomeCfg.horizonBars` buradan okunur
 * @returns {(ev:Object) => number}
 */
function cozumZamaniFabrikasi (memory, signalCfg) {
  let tfSec = DEFAULT_TF_SEC
  try {
    tfSec = require('../tf').tfSeconds(memory && memory.tf ? memory.tf : '15m')
  } catch (err) {
    tfSec = DEFAULT_TF_SEC
  }
  // `|| DEFAULT_HORIZON_BARS`: 0 da gecersiz sayilir, cunku sifir barlik ufuk
  // diye bir sey yok. Kural backtest.js'ten oldugu gibi tasindi.
  const ufukBar = Math.max(1, Math.floor(Number(
    (signalCfg && signalCfg.outcomeCfg && signalCfg.outcomeCfg.horizonBars) || DEFAULT_HORIZON_BARS
  )))
  return function cozumZamani (ev) {
    const r = Number(ev && ev.resolvedTime)
    if (Number.isFinite(r) && r > 0) return r
    return Number(ev.time) + ufukBar * tfSec
  }
}

/**
 * Bir olayin ait oldugu kova: tur + yon. Onbellek kurulurken tarama bu
 * kovalara bolunur, boylece kNN her sorguda yalnizca AYNI TUR VE YONDEKI
 * kayitlari dolasir (kendi filtreleri yine calisir, sonuc degismez).
 *
 * Yon ve tur tanimi signal.js'ten gelir. Burada yeniden yazilsa, ornegin
 * `direction` alani olmayip yalnizca `isSupport` tasiyan bir sorgu yanlis
 * kovaya bakar ve hicbir komsu bulamazdi.
 * @param {Object} ev
 * @returns {string}
 */
function kovaAdi (ev) {
  return turBelirle(ev) + '|' + yonBelirle(ev)
}

/**
 * Bir olay hic aday olabilir mi. Sonucu hesaplanmamis, dolmamis (nofill) veya
 * ozellik vektoru olmayan kayitlar kNN tarafindan zaten elenir; havuza hic
 * koymamak yalnizca tarama maliyetini dusurur.
 * @param {Object} ev
 * @returns {boolean}
 */
function adayOlabilir (ev) {
  if (!ev) return false
  if (ev.outcome === undefined || ev.outcome === null) return false
  if (ev.outcome === 'nofill') return false
  if (!ev.features || !ev.features.shape) return false
  return ev.direction === 'BUY' || ev.direction === 'SELL'
}

/**
 * Komsu onbellegini kurar: her olay icin kNN BIR KEZ kosar.
 *
 * Aday havuzu kurali backtest.js ile aynidir (bkz. dosya basi). Isinma
 * (warmupEvents / warmupPerBucket) BILEREK dikkate alinmaz: onbellek isinma
 * ayarindan bagimsizdir, boylece isinma degistirilince yeniden kurulmasi
 * gerekmez.
 *
 * `outcome === 'nofill'` olaylari icin aday hesaplanmaz (satir bos kalir),
 * cunku test o olaylari hic degerlendirmez.
 *
 * @param {{events:Array<Object>, tf?:string, ctxNames?:string[]}} memory
 * @param {{embargoSec?:number, signalCfg?:Object}} [cfg] Testin ayarlari
 * @param {(pct:number, msg:string)=>void} [onProgress]
 * @returns {{version:number, key:string, n:number, k:number,
 *            idx:Int32Array, sim:Float32Array}}
 */
function buildCandidates (memory, cfg, onProgress) {
  const conf = cfg || {}
  const signalCfg = Object.assign({}, DEFAULT_SIGNAL_CFG, conf.signalCfg || {})
  signalCfg.weights = agirlikCoz(signalCfg)

  let embargoSec = sayi(conf.embargoSec, DEFAULT_EMBARGO_SEC)
  if (embargoSec < 0) embargoSec = 0

  const k = Math.max(1, Math.round(sayi(signalCfg.k, 25)))
  const events = prepareEvents(memory).events
  const n = events.length
  const idx = new Int32Array(n * k).fill(-1)
  const sim = new Float32Array(n * k)
  // Havuz sayaclari: kNN'in secim yaptigi aday havuzunun buyuklugu ve o
  // havuzdaki basari sayisi. Kalibrasyon bunlari kullanir.
  const baseN = new Int32Array(n)
  const baseWins = new Int32Array(n)
  const cache = {
    version: CANDCACHE_VERSION,
    key: cacheKey(memory, conf),
    n: n,
    k: k,
    idx: idx,
    sim: sim,
    baseN: baseN,
    baseWins: baseWins,
  }
  if (n === 0) return cache

  const cozumZamani = cozumZamaniFabrikasi(memory, signalCfg)

  // TUR + YON BAZLI HAVUZLAR
  // Tek havuz kullanildiginda kNN her sorguda tum gecmisi dolasip yonu ve turu
  // uymayan kayitlari eliyordu. Havuzu bastan bolmek taramayi dortte bire
  // indirir. Sonuc DEGISMEZ: kNN'in kendi yon/tur filtreleri yerinde durur ve
  // on eleme yigininin boyu (k * 8) ya iki durumda da ayni, ya da havuz
  // yiginin sigasindan kucuk oldugu icin tum uygun adaylar zaten sigar.
  const kovalar = new Map()
  for (const ad of ['form|BUY', 'form|SELL', 'touch|BUY', 'touch|SELL']) {
    const havuz = []
    kovalar.set(ad, {
      events: havuz,
      memory: { tf: memory.tf, ctxNames: memory.ctxNames, events: havuz },
    })
  }

  // Aday kovalarda duruyor ama onbellege GLOBAL sira numarasi yazilir. kNN
  // olay nesnesini dondurdugu icin nesne kimliginden indekse cevrilir; olay
  // nesnelerine alan EKLENMEZ, cagiranin verisi oldugu gibi kalir.
  const globalIndeks = new Map()
  for (let i = 0; i < n; i++) globalIndeks.set(events[i], i)

  // Tek imlec: ambargo siniri olaylar zaman sirali oldugu icin monoton artar,
  // bu yuzden her olay bir kez okunup KENDI kovasina yazilir.
  let imlec = 0
  const step = Math.max(1, Math.floor(n / 100))
  if (typeof onProgress === 'function') onProgress(0, 'Komşu önbelleği kuruluyor')

  for (let i = 0; i < n; i++) {
    const ev = events[i]
    const beforeTime = ev.time - embargoSec
    while (imlec < n && cozumZamani(events[imlec]) < beforeTime) {
      const aday = events[imlec]
      if (adayOlabilir(aday)) {
        const kova = kovalar.get(kovaAdi(aday))
        if (kova) kova.events.push(aday)
      }
      imlec++
    }

    // Dolmamis emirler test tarafinda hic degerlendirilmez.
    if (ev.outcome !== 'nofill') {
      const kova = kovalar.get(kovaAdi(ev))
      const adaylar = kova
        ? findCandidates(ev, ev.features, kova.memory, signalCfg, beforeTime)
        : []
      // Havuzun taban orani (findCandidates sayilamaz alan olarak takar).
      baseN[i] = Number.isFinite(adaylar.baseN) ? adaylar.baseN : 0
      baseWins[i] = Number.isFinite(adaylar.baseRate) && adaylar.baseRate !== null
        ? Math.round(adaylar.baseRate * baseN[i])
        : 0

      const off = i * k
      const m = adaylar.length < k ? adaylar.length : k
      let yazilan = 0
      for (let j = 0; j < m; j++) {
        const g = globalIndeks.get(adaylar[j].event)
        if (g === undefined) continue
        idx[off + yazilan] = g
        sim[off + yazilan] = adaylar[j].similarity
        yazilan++
      }
    }

    if (typeof onProgress === 'function' && i % step === 0) {
      onProgress(Math.round(((i + 1) / n) * 100), 'Komşu önbelleği: ' + (i + 1) + '/' + n)
    }
  }

  if (typeof onProgress === 'function') onProgress(100, 'Komşu önbelleği hazır: ' + n + ' olay')
  return cache
}

/**
 * Onbellek kimligi. Bu degerlerden biri degistiginde eski onbellek gecersizdir.
 *
 * Icerik: hafiza kayit sayisi, hafizanin uretildigi son bar zamani, baglam
 * vektoru uzunlugu, k, benzerlik agirliklari, komsu dislama penceresi ve bicim
 * surumu.
 *
 * SINIR: ambargo (embargoSec) ve sonuc ufku (horizonBars) anahtara GIRMEZ,
 * cunku sozlesmede sayilan alanlar bunlar degil. Ikisi de aday havuzunu
 * etkiledigi icin, bu iki ayardan biri degistirilirse onbellek ELLE
 * gecersizlenmelidir.
 *
 * @param {{events?:Array, ctxNames?:string[], builtToTime?:number,
 *          meta?:{builtToTime?:number}}} memory
 * @param {{signalCfg?:Object}} [cfg]
 * @returns {string}
 */
function cacheKey (memory, cfg) {
  const mem = memory || {}
  const conf = cfg || {}
  const signalCfg = Object.assign({}, DEFAULT_SIGNAL_CFG, conf.signalCfg || {})
  // Anahtar COZULMUS agirliklardan uretilir: on ayar degistiginde eski
  // onbellek sessizce kullanilirsa olcum yanlis cikar.
  const w = agirlikCoz(signalCfg)

  const adet = Array.isArray(mem.events) ? mem.events.length : 0
  // `builtToTime` ust duzeyde ya da memstore'un `meta` alaninda olabilir.
  const builtTo = Math.round(sayi(
    mem.builtToTime, sayi(mem.meta && mem.meta.builtToTime, 0)
  ))
  const ctxLen = Array.isArray(mem.ctxNames) ? mem.ctxNames.length : 0
  const k = Math.max(1, Math.round(sayi(signalCfg.k, 25)))
  const dis = Math.max(0, Math.round(sayi(signalCfg.excludeWithinSec, 0)))
  const agirlik = sayi(w.shape, 0).toFixed(4) + ',' + sayi(w.ctx, 0).toFixed(4) +
    ',' + sayi(w.dtw, 0).toFixed(4)
  // Ambargo ve ufuk da ADAY HAVUZUNU belirler (bir olayin komsu olabilmesi
  // icin sonucunun cozulmus olmasi gerekir). Anahtarda olmazlarsa bu ayarlar
  // degistiginde eski onbellek sessizce kullanilir ve olcum yanlis cikar.
  const ambargo = Math.max(0, Math.round(sayi(conf.embargoSec, DEFAULT_EMBARGO_SEC)))
  const ufuk = Math.max(1, Math.round(sayi(
    conf.outcomeCfg && conf.outcomeCfg.horizonBars,
    sayi(signalCfg.outcomeCfg && signalCfg.outcomeCfg.horizonBars, 48)
  )))

  return 'v' + CANDCACHE_VERSION + '|n' + adet + '|t' + builtTo + '|c' + ctxLen +
    '|k' + k + '|w' + agirlik + '|x' + dis + '|e' + ambargo + '|h' + ufuk
}

/** Float32/Int32 dizisinin bayt gorunumu (BE makinede takasli kopya). */
function baytGorunumu (arr) {
  const view = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
  if (LITTLE_ENDIAN) return view
  const kopya = Buffer.from(view)
  kopya.swap32()
  return kopya
}

/**
 * Onbellegi tek bir Buffer'a yazar. Bicim dosyanin basinda belgelenmistir.
 * @param {{version?:number, key?:string, n:number, k:number,
 *          idx:Int32Array, sim:Float32Array}} cache
 * @returns {Buffer}
 */
function serialize (cache) {
  if (!cache || !cache.idx || !cache.sim) throw new Error('candcache: onbellek nesnesi eksik')
  const n = Math.max(0, Math.round(sayi(cache.n, 0)))
  const k = Math.max(0, Math.round(sayi(cache.k, 0)))
  const hucre = n * k
  if (cache.idx.length !== hucre || cache.sim.length !== hucre) {
    throw new Error('candcache: dizi boylari n * k ile uyusmuyor')
  }

  const anahtar = Buffer.from(String(cache.key === undefined || cache.key === null ? '' : cache.key), 'utf8')
  const dolgu = (4 - ((HEADER_FIXED + anahtar.length) % 4)) % 4
  const basBoyut = HEADER_FIXED + anahtar.length + dolgu
  const buf = Buffer.alloc(basBoyut + hucre * 8 + n * 8)

  buf.writeUInt32LE(MAGIC, 0)
  buf.writeUInt16LE(Math.round(sayi(cache.version, CANDCACHE_VERSION)), 4)
  buf.writeUInt16LE(0, 6)
  buf.writeUInt32LE(n, 8)
  buf.writeUInt32LE(k, 12)
  buf.writeUInt32LE(anahtar.length, 16)
  anahtar.copy(buf, HEADER_FIXED)
  // Dolgu baytlari Buffer.alloc sayesinde zaten sifirdir.

  if (hucre > 0) {
    baytGorunumu(cache.idx).copy(buf, basBoyut)
    baytGorunumu(cache.sim).copy(buf, basBoyut + hucre * 4)
  }
  // Havuz sayaclari (surum 2): olay basina iki Int32.
  if (n > 0) {
    const bn = cache.baseN instanceof Int32Array ? cache.baseN : new Int32Array(n)
    const bw = cache.baseWins instanceof Int32Array ? cache.baseWins : new Int32Array(n)
    baytGorunumu(bn).copy(buf, basBoyut + hucre * 8)
    baytGorunumu(bw).copy(buf, basBoyut + hucre * 8 + n * 4)
  }
  return buf
}

/**
 * `serialize` ile yazilmis Buffer'i geri okur. Bozuk veya baska surumden
 * gelen veride ACIK HATA firlatir; sessizce bos onbellek dondurmek, testin
 * neden bir anda referans yoldan sapip yavasladigini gizlerdi.
 * @param {Buffer|Uint8Array} buf
 * @returns {{version:number, key:string, n:number, k:number,
 *            idx:Int32Array, sim:Float32Array}}
 */
function deserialize (buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(
    buf && buf.buffer ? buf.buffer : buf, buf && buf.byteOffset ? buf.byteOffset : 0,
    buf && buf.byteLength ? buf.byteLength : undefined
  )
  if (b.length < HEADER_FIXED) throw new Error('candcache: dosya baslik icin bile kisa')
  if (b.readUInt32LE(0) !== MAGIC) throw new Error('candcache: sihirli sayi uyusmuyor')
  const version = b.readUInt16LE(4)
  if (version !== CANDCACHE_VERSION) {
    throw new Error('candcache: bicim surumu uyusmuyor (' + version + ' != ' + CANDCACHE_VERSION + ')')
  }
  const n = b.readUInt32LE(8)
  const k = b.readUInt32LE(12)
  const anahtarLen = b.readUInt32LE(16)
  const dolgu = (4 - ((HEADER_FIXED + anahtarLen) % 4)) % 4
  const basBoyut = HEADER_FIXED + anahtarLen + dolgu
  const hucre = n * k
  // Bolum baslangiclari: once hucre dizileri (idx, sim), sonra havuz sayaclari.
  const simBas = basBoyut + hucre * 4
  const havuzBas = basBoyut + hucre * 8
  const beklenen = havuzBas + n * 8
  if (b.length < beklenen) {
    throw new Error('candcache: dosya beklenenden kisa (' + b.length + ' < ' + beklenen + ')')
  }

  const key = anahtarLen > 0 ? b.toString('utf8', HEADER_FIXED, HEADER_FIXED + anahtarLen) : ''
  const idx = new Int32Array(hucre)
  const sim = new Float32Array(hucre)
  if (hucre > 0) {
    // Hizalama sorunu olmasin diye taze dizilere KOPYALANIR; Buffer havuzdan
    // gelmisse byteOffset 4'un kati olmayabilir.
    const idxBayt = Buffer.from(idx.buffer, idx.byteOffset, hucre * 4)
    idxBayt.set(b.subarray(basBoyut, simBas))
    const simBayt = Buffer.from(sim.buffer, sim.byteOffset, hucre * 4)
    simBayt.set(b.subarray(simBas, havuzBas))
    if (!LITTLE_ENDIAN) {
      idxBayt.swap32()
      simBayt.swap32()
    }
  }

  const baseN = new Int32Array(n)
  const baseWins = new Int32Array(n)
  if (n > 0) {
    const bnBayt = Buffer.from(baseN.buffer, baseN.byteOffset, n * 4)
    bnBayt.set(b.subarray(havuzBas, havuzBas + n * 4))
    const bwBayt = Buffer.from(baseWins.buffer, baseWins.byteOffset, n * 4)
    bwBayt.set(b.subarray(havuzBas + n * 4, beklenen))
    if (!LITTLE_ENDIAN) {
      bnBayt.swap32()
      bwBayt.swap32()
    }
  }

  return {
    version: version, key: key, n: n, k: k, idx: idx, sim: sim,
    baseN: baseN, baseWins: baseWins,
  }
}

module.exports = {
  CANDCACHE_VERSION,
  DEFAULT_EMBARGO_SEC,
  buildCandidates,
  cacheKey,
  serialize,
  deserialize,
  prepareEvents,
  cozumZamaniFabrikasi,
}
