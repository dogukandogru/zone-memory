'use strict'

// Veri yukleyici: saglayicilardan gecmis ceker, ikili depoya yazar, depodan
// okur ve gerekirse ust zaman dilimine yeniden ornekler. Ayrica vekil
// kaynaklarin (GC=F, PAXG, XAUT) fiyatini spot XAUUSD seviyesine tasimak icin
// medyan fark (basis) hesabi burada yapilir.
// CONTRACTS.md bolum 17 ile uyumludur.

const path = require('node:path')
const fsp = require('node:fs/promises')
const { tfSeconds, TURETILEN_TF } = require('../tf')
const series = require('../series')
const binstore = require('../store/binstore')
const { getProvider, bildir } = require('./provider')
const { createMarketCalendar } = require('../session')

const VARSAYILAN_SEMBOL = 'XAUUSD'
const VARSAYILAN_ORTUSME = 200

// Basis ve hacim olcegi icin gereken en az ortak bar sayisi. Bunun altinda
// hesap guvenilmez; duzeltmesiz bar yazmaktansa hic yazmamak dogrudur.
const MIN_ORTAK_BAR = 30
const MIN_HACIM_ORANI = 10

/**
 * BASIS KALITE ESIKLERI (V3)
 *
 * Tek bir medyan fark yeterli degil: ortak bar sayisi az ya da farklar cok
 * dagilmissa hesaplanan basis bir sayi uretir ama o sayi seriyi dogru yere
 * tasimaz. Bu yuzden normalizeProxy ortak bar sayisini VE medyan mutlak
 * sapmayi (MAD) da gozetir.
 *
 * Esikler zaman dilimine gore: 1 dakikalikta ortak bar bol, 15 dakikalikta
 * seyrek. Bilinmeyen zaman diliminde varsayilan kullanilir.
 */
const BASIS_MIN_ORTAK = { 60: 120, 300: 60, 900: 20, 1800: 16, 3600: 12, 14400: 8 }
const BASIS_MIN_ORTAK_VARSAYILAN = 30
/** Ortak barlardaki farkin medyan mutlak sapmasi bu kadar dolari gecmemeli. */
const BASIS_MAX_MAD_USD = 3

/**
 * HACIM KANTIL TABLOSU: kac noktali.
 *
 * 101 nokta (%0, %1, ... %100) yuzdelik basina bir deger demektir; daha
 * yogun bir tablo vekilin gurultusunu kopyalamaya baslar.
 */
const HACIM_KANTIL_NOKTA = 101
/** Kantil eslestirmesi icin her iki tarafta gereken en az hacimli bar. */
const HACIM_KANTIL_MIN_BAR = 200
/** Spot dagilimi kac haftalik pencereden alinir. */
const HACIM_KANTIL_HAFTA = 8
/**
 * Oran hesabinda kullanilan hareketli ortalama uzunlugu.
 *
 * Indikatorun `volumeLen` varsayilaniyla AYNI olmali (proZones.js): kapinin
 * baktigi oran budur. Cagiran taraf ayari degistirdiyse opts ile gecirir.
 */
const VARSAYILAN_VOLUME_LEN = 50

// HistData 2009-03'ten once XAUUSD yayinlamiyor; daha eskisini istemek
// bos indirme turlarindan baska bir sey uretmez.
const HISTDATA_BASLANGIC = Date.UTC(2009, 2, 1) / 1000

/**
 * Depodaki mum dosyasinin adi. CONTRACTS.md bolum 20'deki
 * `XAUUSD_1m.bin` semasiyla ayni.
 * @param {string} tf
 * @param {string} [symbol]
 * @returns {string}
 */
function candleFileName(tf, symbol) {
  return (symbol || VARSAYILAN_SEMBOL) + '_' + tf + '.bin'
}

/** Tam dosya yolu. */
function mumYolu(dataDir, tf, symbol) {
  return path.join(dataDir, candleFileName(tf, symbol))
}

/** Vekil kaynakla doldurulan araliklarin kaydi (XAUUSD_1m.proxy.json). */
function vekilKayitYolu(dataDir, tf, symbol) {
  return path.join(dataDir, (symbol || VARSAYILAN_SEMBOL) + '_' + tf + '.proxy.json')
}

/**
 * Vekil kaynakla yazilan araligi kaydeder. Amac: HistData o ayi yayinladiginda
 * hangi bolgenin spot veriyle DEGISTIRILMESI gerektigi bilinsin. Kayit
 * olmadan vekil donem kalici hale geliyor ve testin en guncel dilimi giderek
 * vekil veriden olusuyordu.
 * @param {string} dataDir
 * @param {string} tf
 * @param {string} symbol
 * @param {{from:number, to:number, provider:string, basis:number,
 *          volScale:number, bars:number}} kayit
 */
async function vekilAraligiKaydet(dataDir, tf, symbol, kayit) {
  const dosya = vekilKayitYolu(dataDir, tf, symbol)
  let govde = { version: 1, ranges: [] }
  try {
    const ham = await fsp.readFile(dosya, 'utf8')
    const cozulen = JSON.parse(ham)
    if (cozulen && Array.isArray(cozulen.ranges)) govde = cozulen
  } catch (err) {
    // Dosya yok veya bozuk: sifirdan yazariz.
  }
  const son = govde.ranges[govde.ranges.length - 1]
  // Kesintisiz devam eden yazimlar tek aralikta birlestirilir.
  if (son && son.provider === kayit.provider && kayit.from - son.to <= 7 * 86400) {
    son.to = Math.max(son.to, kayit.to)
    son.bars += kayit.bars
    son.basis = kayit.basis
    son.volScale = kayit.volScale
    son.writtenAt = Math.floor(Date.now() / 1000)
  } else {
    govde.ranges.push(Object.assign({ writtenAt: Math.floor(Date.now() / 1000) }, kayit))
  }
  const tmp = dosya + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(govde, null, 2), 'utf8')
  await fsp.rename(tmp, dosya)
}

/** Vekil aralik kaydini okur (yoksa bos liste). */
async function vekilAraliklariOku(dataDir, tf, symbol) {
  try {
    const ham = await fsp.readFile(vekilKayitYolu(dataDir, tf, symbol), 'utf8')
    const govde = JSON.parse(ham)
    return govde && Array.isArray(govde.ranges) ? govde.ranges : []
  } catch (err) {
    return []
  }
}

/**
 * Seriyi [from, to] zaman araligina kirpar (ikisi de dahil).
 * Kirpma gerekmiyorsa ayni nesne geri verilir.
 * @param {import('../series').Series} s
 * @param {number} [from]
 * @param {number} [to]
 * @returns {import('../series').Series}
 */
function zamanaGoreDilimle(s, from, to) {
  if (!s || s.length === 0) return series.emptySeries()
  let i0 = 0
  if (Number.isFinite(from)) {
    const k = series.firstIndexAtOrAfter(s, from)
    if (k < 0) return series.emptySeries()
    i0 = k
  }
  let i1 = s.length
  if (Number.isFinite(to)) {
    const k = series.lastIndexAtOrBefore(s, to)
    if (k < 0) return series.emptySeries()
    i1 = k + 1
  }
  if (i1 <= i0) return series.emptySeries()
  if (i0 === 0 && i1 === s.length) return s
  return series.sliceSeries(s, i0, i1)
}

/**
 * Eksik araliklari saptar, saglayicidan ceker ve binstore'a ekler.
 *
 * Depoda veri varsa iki bosluk taranir: `from` mevcut ilk bardan eskiyse
 * bastaki bosluk, `to` mevcut son bardan yeniyse sondaki bosluk. Sondaki
 * bosluk mevcut SON BARDAN baslar; boylece yarim kalmis son bar tazelenir
 * (appendSeries ayni zaman damgasinda yeni veriyi kazandirir).
 *
 * @param {{dataDir:string, tf:string, providerId:string, apiKey?:string,
 *          from?:number, to?:number, symbol?:string,
 *          onProgress?:(pct:number,msg:string)=>void}} opts
 * @returns {Promise<{provider:string, tf:string, path:string, fetched:number,
 *                    added:number, total:number, firstTime:number, lastTime:number,
 *                    ranges:Array<{from:number,to:number,label:string,bars:number}>}>}
 */
async function syncHistory(opts) {
  const o = opts || {}
  if (!o.dataDir) throw new Error('syncHistory: dataDir parametresi gerekli')
  const tf = o.tf || '1m'
  const tfSec = tfSeconds(tf)
  const saglayici = getProvider(o.providerId)
  const anahtar = o.apiKey ? String(o.apiKey).trim() : ''
  if (saglayici.needsKey && !anahtar) {
    throw new Error(
      saglayici.name + ' icin API anahtari gerekli. Ayarlar sekmesinden anahtari girin.'
    )
  }

  const dosya = mumYolu(o.dataDir, tf, o.symbol)
  const simdi = Math.floor(Date.now() / 1000)
  // Acik (kapanmamis) bar depoya YAZILMAZ: yarim OHLCV kalici olur, cunku
  // sonraki cekimler ayni zaman damgasini atlar. Ust sinir son KAPANMIS bar.
  const sonKapanmis = Math.floor(simdi / tfSec) * tfSec - 1
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : sonKapanmis
  if (to > sonKapanmis) to = sonKapanmis

  const durum = await binstore.statSeries(dosya)
  const varOlan = durum && durum.count > 0 ? durum : null
  let from = Number.isFinite(o.from)
    ? Math.floor(o.from)
    : varOlan
      ? varOlan.lastTime
      : to - 30 * 86400

  // "Vekil" yalnizca PAXG / XAUT / GC=F demek degil: depodaki seri BASKA bir
  // kaynakla kurulduysa yeni kaynak spot olsa bile hacim olcegi ve fiyat
  // seviyesi farkli olabilir (ornek: HistData tick hacmi ile Polygon islem
  // sayisi). Bu yuzden duzeltme yolu, saglayicinin kendisi vekil OLMASA BILE
  // kaynak degistiginde de calisir.
  // Son yazan kaynak `.proxy.json` kaydindan okunur (depo dosyasi kaynak
  // bilgisi tutmaz). Kayit yoksa kaynak degisimi bilinemez ve yalnizca
  // saglayicinin kendi vekil bayragina bakilir.
  const oncekiKayitlar = await vekilAraliklariOku(o.dataDir, tf, o.symbol)
  const sonKayit = oncekiKayitlar.length > 0 ? oncekiKayitlar[oncekiKayitlar.length - 1] : null
  const kaynakDegisti = !!(sonKayit && sonKayit.provider && sonKayit.provider !== saglayici.id)
  const vekil = !!saglayici.isProxy || kaynakDegisti
  // Gecmise dogru indirme YALNIZCA kullanici acikca `from` verdiyse yapilir.
  // Aksi halde her senkron 1970'ten depo basina kadar bos tur atiyordu (bir
  // tiklamada 471 bos HistData istegi olculdu). Vekil kaynakta gecmise dogru
  // indirme hic yapilmaz: eski bolge icin ortak bar yoktur, yani duzeltme
  // hesaplanamaz.
  const fromVerildi = Number.isFinite(o.from)
  if (fromVerildi && saglayici.id === 'histdata' && from < HISTDATA_BASLANGIC) {
    from = HISTDATA_BASLANGIC
  }

  /** @type {Array<{from:number,to:number,label:string,bars:number}>} */
  const araliklar = []
  if (!varOlan) {
    if (from < to) araliklar.push({ from: from, to: to, label: 'tum aralik', bars: 0 })
  } else {
    if (fromVerildi && !vekil && from < varOlan.firstTime) {
      araliklar.push({ from: from, to: varOlan.firstTime, label: 'gecmise dogru', bars: 0 })
    }
    if (varOlan.lastTime < to) {
      araliklar.push({ from: varOlan.lastTime, to: to, label: 'guncelleme', bars: 0 })
    }
  }

  if (araliklar.length === 0) {
    bildir(o.onProgress, 100, 'Depo zaten guncel, indirilecek yeni veri yok')
    return {
      provider: saglayici.id,
      tf: tf,
      path: dosya,
      fetched: 0,
      added: 0,
      total: varOlan ? varOlan.count : 0,
      firstTime: varOlan ? varOlan.firstTime : 0,
      lastTime: varOlan ? varOlan.lastTime : 0,
      ranges: [],
    }
  }

  const pay = 100 / araliklar.length
  let toplamCekilen = 0
  let toplamEklenen = 0
  let uygulananBasis = null
  let sonVolScale = 1

  // Vekil kaynak (GC=F, PAXG, XAUT) spot XAUUSD DEGILDIR; seviye farki
  // yuzlerce dolar olabilir. Duzeltmeden eklemek seride sahte bir sicrama
  // yaratir ve indikatoru bozar. Bu yuzden vekil kaynakta:
  //   1. Depodaki son barin BIRAZ ONCESINDEN baslayarak cekeriz, boylece
  //      ortak zaman damgasi olusur.
  //   2. normalizeProxy basis ve hacim olcegini uygular, piyasanin kapali
  //      oldugu saatlerdeki barlari eler.
  //   3. Duzeltme hesaplanamazsa EKLEME YAPILMAZ: sessizce bozuk veri
  //      yazmaktansa acik bir hata vermek dogrudur.
  const ortakSaniye = Math.max(tfSec * 400, 3 * 86400)

  for (let i = 0; i < araliklar.length; i++) {
    const r = araliklar[i]
    const taban = i * pay
    bildir(o.onProgress, taban, saglayici.name + ': ' + r.label + ' indiriliyor')

    // Vekil kaynakta guncelleme aralligini ortak bolge kadar geriye tasiriz.
    const guncelleme = r.label === 'guncelleme'
    const cekBaslangic = (vekil && guncelleme && varOlan)
      ? Math.max(r.from - ortakSaniye, varOlan.firstTime)
      : r.from

    let yeni = await saglayici.fetchCandles({
      tfSec: tfSec,
      from: cekBaslangic,
      to: r.to,
      apiKey: anahtar,
      symbol: o.symbol,
      onProgress: function (pct, msg) {
        bildir(o.onProgress, taban + (pct * pay) / 100, msg)
      },
    })

    if (vekil && guncelleme && varOlan && yeni && yeni.length > 0) {
      const spot = o.storedSeries && o.storedSeries.length > 0
        ? o.storedSeries
        : await binstore.readSeries(dosya)
      if (!spot || spot.length === 0) {
        throw new Error(
          'Fiyat kaydirmasi icin depodaki seri okunamadi. ' +
          saglayici.name + ' vekil bir kaynak oldugu icin duzeltme olmadan eklenemez.'
        )
      }
      const duzeltme = normalizeProxy(spot, yeni, {
        tfSec: tfSec,
        // Daha once vekil yazilmis araliklar spot referansindan cikarilir,
        // yoksa vekil kendi dagilimini hedef olarak gorur.
        proxyRanges: await vekilAraliklariOku(o.dataDir, tf, o.symbol),
      })
      if (!duzeltme.ok) {
        throw new Error(
          saglayici.name + ' verisi duzeltilemedi: ' + duzeltme.reason + '. ' +
          'Bu vekil kaynak spot XAUUSD degildir ve duzeltmesiz eklenirse seride ' +
          'sahte bir sicrama olusur. Once bosluğu gercek spot kaynakla ' +
          '(HistData, Polygon, Twelve Data) kapatin.'
        )
      }
      uygulananBasis = duzeltme.basis
      sonVolScale = duzeltme.volScale
      yeni = duzeltme.series
      bildir(o.onProgress, taban + pay * 0.9,
        'Vekil fiyat spot seviyesine ' + duzeltme.basis.toFixed(2) + ' birim kaydirildi')
      if (duzeltme.volScale !== 1) {
        bildir(o.onProgress, taban + pay * 0.92,
          'Hacim olcegi ' + duzeltme.volScale.toFixed(2) + ' katsayisiyla esitlendi')
      }
      if (duzeltme.dropped > 0) {
        bildir(o.onProgress, taban + pay * 0.95,
          'Piyasanin kapali oldugu ' + duzeltme.dropped + ' bar elendi')
      }

      // Depoda zaten olan barlari atarak yalnizca yeni kismi birakiriz.
      const ilkYeni = series.firstIndexAtOrAfter(yeni, varOlan.lastTime + 1)
      yeni = ilkYeni < 0 ? series.emptySeries() : series.sliceSeries(yeni, ilkYeni, yeni.length)
    }

    r.bars = yeni ? yeni.length : 0
    toplamCekilen += r.bars
    if (r.bars > 0) {
      const sonuc = await binstore.appendSeries(dosya, yeni)
      toplamEklenen += sonuc.added
      if (vekil && sonuc.added > 0) {
        await vekilAraligiKaydet(o.dataDir, tf, o.symbol, {
          from: yeni.time[0],
          to: yeni.time[yeni.length - 1],
          provider: saglayici.id,
          basis: uygulananBasis,
          volScale: sonVolScale,
          bars: sonuc.added,
        })
      }
    }
  }

  const son = await binstore.statSeries(dosya)
  bildir(
    o.onProgress,
    100,
    'Tamamlandi: ' + toplamEklenen + ' yeni bar eklendi, toplam ' + (son ? son.count : 0)
  )

  return {
    provider: saglayici.id,
    tf: tf,
    path: dosya,
    fetched: toplamCekilen,
    added: toplamEklenen,
    total: son ? son.count : 0,
    firstTime: son ? son.firstTime : 0,
    lastTime: son ? son.lastTime : 0,
    ranges: araliklar,
    basis: uygulananBasis,
    isProxy: vekil,
  }
}

/**
 * Vekil seriyi depodaki spot seriyle AYNI olcege getirir: fiyat kaydirmasi
 * (basis), hacim olcegi ve piyasa saati suzgeci tek yerde uygulanir.
 *
 * Neden tek fonksiyon: canli dongu ile Veri Cek yolu bu adimlari ayri ayri
 * uyguluyordu ve canli yol basis hesaplanamadiginda HAM barlari depoya
 * yaziyordu. Bir kez ham bar girince basis 0 cikip duzeltme kalici olarak
 * kapaniyordu. Artik duzeltme hesaplanamazsa {ok:false} doner ve cagiran
 * taraf hicbir sey yazmaz.
 *
 * @param {import('../series').Series} spot Depodaki gercek seri
 * @param {import('../series').Series} proxy Vekil kaynaktan gelen ham seri
 * @param {{overlapBars?:number, tfSec?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, series?:import('../series').Series,
 *            basis?:number, volScale?:number, volMode?:string, dropped?:number,
 *            overlap?:number, mad?:number}}
 */
function normalizeProxy(spot, proxy, opts) {
  const o = opts || {}
  if (!proxy || proxy.length === 0) return { ok: false, reason: 'vekil kaynaktan bar gelmedi' }
  if (!spot || spot.length === 0) return { ok: false, reason: 'depoda karsilastirilacak seri yok' }

  // BASIS VE KALITESI. Tek bir medyan fark yeterli degil: ortak bar sayisi az
  // ya da farklar cok dagilmissa hesap bir sayi uretir ama seriyi dogru yere
  // tasimaz. Bu yuzden ortak bar sayisi ve medyan mutlak sapma da olculur.
  const olcum = basisOlcumu(spot, proxy, o.overlapBars || 400)
  if (olcum === null) {
    return { ok: false, reason: 'ortak zaman damgasi yok, fiyat kaydirmasi hesaplanamadi' }
  }
  const tfSec = Number.isFinite(o.tfSec) ? o.tfSec : 0
  const gerekenOrtak = BASIS_MIN_ORTAK[tfSec] || BASIS_MIN_ORTAK_VARSAYILAN
  if (olcum.n < gerekenOrtak) {
    return {
      ok: false,
      overlap: olcum.n,
      mad: olcum.mad,
      reason: 'yeterli ortak bar yok (' + olcum.n + ' < ' + gerekenOrtak + ')',
    }
  }
  if (olcum.mad > BASIS_MAX_MAD_USD) {
    return {
      ok: false,
      overlap: olcum.n,
      mad: olcum.mad,
      reason: 'fiyat farki cok dagilmis (medyan mutlak sapma ' +
        olcum.mad.toFixed(2) + ' dolar, ust sinir ' + BASIS_MAX_MAD_USD + ')',
    }
  }
  const basis = olcum.basis
  let out = applyBasis(proxy, basis)

  // HACIM: once kantil eslestirmesi denenir (dagilimi duzeltir), yeterli veri
  // yoksa eski medyan oran yoluna dusulur (yalnizca olcegi duzeltir).
  let volMode = 'oran-eslestirme'
  const esleme = hacimOranEslemesi(spot, out, {
    volumeLen: o.volumeLen,
    proxyRanges: o.proxyRanges,
  })
  let olcek
  if (esleme) {
    out.volume.set(esleme.volumes)
    olcek = esleme.medianScale
  } else {
    volMode = 'oran'
    olcek = hacimOlcegi(spot, out)
    if (olcek === null) {
      return { ok: false, reason: 'ortak barlarda hacim yok, hacim olcegi hesaplanamadi' }
    }
    if (olcek !== 1) {
      for (let k = 0; k < out.length; k++) out.volume[k] *= olcek
    }
  }

  const oncekiAdet = out.length
  out = piyasaSaatleriyleSuz(out)
  return {
    ok: true,
    series: out,
    basis: basis,
    volScale: olcek,
    volMode: volMode,
    overlap: olcum.n,
    mad: olcum.mad,
    dropped: oncekiAdet - out.length,
  }
}


/**
 * Bir sayi dizisinden KANTIL TABLOSU uretir (artan sirali, esit araliklarla).
 *
 * @param {number[]|Float64Array} degerler Sifirdan buyuk hacimler
 * @param {number} nokta Tablo uzunlugu
 * @returns {Float64Array|null} Yeterli veri yoksa null
 */
function kantilTablosu(degerler, nokta) {
  const arr = Float64Array.from(degerler)
  if (arr.length === 0) return null
  arr.sort()
  const n = nokta > 1 ? nokta : 2
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const pos = (arr.length - 1) * (i / (n - 1))
    const lo = Math.floor(pos)
    const hi = lo + 1
    out[i] = hi >= arr.length ? arr[arr.length - 1] : arr[lo] + (pos - lo) * (arr[hi] - arr[lo])
  }
  return out
}

/** Artan sirali tabloda bir degerin [0, 1] arasindaki yuzdeligi. */
function kantilYeri(tablo, deger) {
  const n = tablo.length
  if (deger <= tablo[0]) return 0
  if (deger >= tablo[n - 1]) return 1
  let lo = 0
  let hi = n - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (tablo[mid] <= deger) lo = mid
    else hi = mid
  }
  const aralik = tablo[hi] - tablo[lo]
  const kesir = aralik > 0 ? (deger - tablo[lo]) / aralik : 0
  return (lo + kesir) / (n - 1)
}

/** Artan sirali tabloda [0, 1] yuzdeligine karsilik gelen deger. */
function kantilDegeri(tablo, p) {
  const n = tablo.length
  const q = p < 0 ? 0 : (p > 1 ? 1 : p)
  const pos = (n - 1) * q
  const lo = Math.floor(pos)
  const hi = lo + 1
  if (hi >= n) return tablo[n - 1]
  return tablo[lo] + (pos - lo) * (tablo[hi] - tablo[lo])
}

/**
 * VEKIL HACMINI SPOT SERIYLE AYNI "HACIM ORANI" DAGILIMINA TASIR.
 *
 * Neden tek bir olcek yetmiyor: kutu kapisi `vR = hacim / SMA(hacim, volumeLen)`,
 * yani bir ORANDIR. Butun hacimleri ayni sayiyla carpmak bu orani HIC
 * degistirmez. Gercek veriyle olculdu (14 gunluk PAXGUSDT 1 dakikalik,
 * 19 Eylul 2026): ham PAXG'de vR >= 2 olan bar orani %12,27, medyan oranla
 * olceklendikten sonra yine %12,27; ayni donemin spot referansi %3,13.
 * Yani "gecmiste bu yapi %X tuttu" cumlesi, kutulari UC KAT sik doguran
 * baska bir surecle uretilmis olaylara uygulaniyordu.
 *
 * Ham hacmin dagilimini eslestirmek de yetmiyor (olculdu: %12,27 -> %7,67),
 * cunku vR bir barin KENDI yerel ortalamasina oranidir; kripto hacmi daha
 * "patlamali" ve bu yapi monoton bir donusumle kaybolmaz.
 *
 * Bu yuzden eslestirme dogrudan ORAN uzerinde yapilir:
 *   1. Spot referans penceresinde vR dagilimi cikarilir
 *   2. Vekilin kendi vR dagilimi cikarilir
 *   3. Her vekil bari, kendi dagilimindaki yuzdeligiyle AYNI yuzdelikteki
 *      spot vR degerine tasinir
 *   4. Oran, spot medyan hacmiyle carpilip hacme geri cevrilir
 * Olculdu: %12,27 -> %3,66 (piyasa saati suzgecinden sonra %2,27), spot
 * referansi %3,13.
 *
 * @param {import('../series').Series} spot Depodaki gercek seri
 * @param {import('../series').Series} proxy Vekil seri (basis uygulanmis)
 * @param {{volumeLen?:number, proxyRanges?:Array<{from:number,to:number}>}} [opts]
 * @returns {{volumes:Float64Array, spotN:number, proxyN:number,
 *            medianScale:number}|null} Yeterli veri yoksa null
 */
function hacimOranEslemesi(spot, proxy, opts) {
  if (!spot || spot.length === 0 || !proxy || proxy.length === 0) return null
  const o = opts || {}
  const len = Number.isFinite(o.volumeLen) && o.volumeLen > 1 ? Math.floor(o.volumeLen) : VARSAYILAN_VOLUME_LEN

  // SPOT REFERANS PENCERESI: vekil doneminin HEMEN ONCESINDEKI son haftalar.
  // Butun gecmis alinamaz, cunku altinin hacmi yillar icinde buyudu; ayrica
  // daha once vekil kaynakla yazilmis araliklar disarida birakilir, yoksa
  // vekil kendi dagilimini hedef olarak gorur.
  const pencereSn = HACIM_KANTIL_HAFTA * 7 * 86400
  const vekilBas = proxy.time[0]
  const disArali = Array.isArray(o.proxyRanges) ? o.proxyRanges : []
  const vekilDonemi = (t) => {
    for (let i = 0; i < disArali.length; i++) {
      const r = disArali[i]
      if (r && t >= r.from && t <= r.to) return true
    }
    return false
  }

  let son = spot.length - 1
  while (son >= 0 && spot.time[son] >= vekilBas) son--
  if (son < len) return null
  let bas = son
  while (bas > 0 && spot.time[bas - 1] >= vekilBas - pencereSn) bas--

  const spotVr = []
  const spotHacim = []
  let toplam = 0
  for (let i = bas; i <= son; i++) {
    const v = spot.volume[i]
    toplam += v
    if (i - bas >= len) toplam -= spot.volume[i - len]
    if (v > 0 && !vekilDonemi(spot.time[i])) spotHacim.push(v)
    if (i - bas + 1 < len) continue
    const ort = toplam / len
    if (ort > 0 && !vekilDonemi(spot.time[i])) spotVr.push(v / ort)
  }

  const proxyVr = []
  toplam = 0
  for (let i = 0; i < proxy.length; i++) {
    toplam += proxy.volume[i]
    if (i >= len) toplam -= proxy.volume[i - len]
    if (i + 1 < len) continue
    const ort = toplam / len
    if (ort > 0) proxyVr.push(proxy.volume[i] / ort)
  }

  if (spotVr.length < HACIM_KANTIL_MIN_BAR || proxyVr.length < HACIM_KANTIL_MIN_BAR) return null
  if (spotHacim.length < HACIM_KANTIL_MIN_BAR) return null

  const spotQ = kantilTablosu(spotVr, HACIM_KANTIL_NOKTA)
  const proxyQ = kantilTablosu(proxyVr, HACIM_KANTIL_NOKTA)
  if (!spotQ || !proxyQ) return null

  // Oranlari hacme cevirirken kullanilan seviye: spot medyan hacmi.
  spotHacim.sort((a, b) => a - b)
  const seviye = spotHacim[spotHacim.length >> 1]
  if (!(seviye > 0)) return null

  const volumes = new Float64Array(proxy.length)
  let k = 0
  for (let i = 0; i < proxy.length; i++) {
    if (i + 1 < len) {
      // Ilk barlarda oran hesaplanamaz; notr seviye yazilir. Bu barlar zaten
      // indikatorun kendi isinma penceresine denk gelir.
      volumes[i] = seviye
      continue
    }
    volumes[i] = kantilDegeri(spotQ, kantilYeri(proxyQ, proxyVr[k])) * seviye
    k++
  }

  const ortaS = spotQ[(HACIM_KANTIL_NOKTA - 1) >> 1]
  const ortaP = proxyQ[(HACIM_KANTIL_NOKTA - 1) >> 1]
  return {
    volumes: volumes,
    spotN: spotVr.length,
    proxyN: proxyVr.length,
    // Bilgi amacli: arayuzde gosterilen "hacim olcegi" karsiligi.
    medianScale: ortaP > 0 ? (ortaS / ortaP) * (seviye / (ortaP > 0 ? 1 : 1)) : 1,
  }
}

/**
 * HACIM KAPISININ NE SIKLIKLA ACILDIGINI olcer.
 *
 * Indikatorun kutu kapisi `vR = hacim / SMA(hacim, volumeLen) >= esik`
 * kosuludur. Bu oran, veri kaynagi degisince sessizce kayar: olculdu, ham
 * PAXG 1 dakikalikta kapi %12,27 oraninda aciliyor, ayni donemin spot
 * referansinda %3,13. Kapi ne kadar sik acilirsa o kadar cok kutu dogar ve
 * "gecmiste bu yapi %X tuttu" cumlesi baska bir surecle uretilmis olaylara
 * uygulanir.
 *
 * Bu fonksiyon canli akista rejim kaymasini yakalamak icin kullanilir.
 *
 * @param {import('../series').Series} s
 * @param {{volumeLen?:number, esik?:number, fromIndex?:number, toIndex?:number}} [opts]
 * @returns {{rate:number, n:number}} Olculecek bar yoksa rate 0, n 0
 */
function hacimKapiOrani(s, opts) {
  if (!s || s.length === 0) return { rate: 0, n: 0 }
  const o = opts || {}
  const len = Number.isFinite(o.volumeLen) && o.volumeLen > 1
    ? Math.floor(o.volumeLen)
    : VARSAYILAN_VOLUME_LEN
  const esik = Number.isFinite(o.esik) ? o.esik : 2
  let bas = Number.isFinite(o.fromIndex) ? Math.max(0, Math.floor(o.fromIndex)) : 0
  const son = Number.isFinite(o.toIndex) ? Math.min(s.length, Math.floor(o.toIndex)) : s.length
  // Ortalama penceresi icin geriye dogru pay birakilir, yoksa ilk barlar
  // olcum disi kalir ve kisa pencerelerde sonuc anlamsizlasir.
  const olcumBas = bas
  bas = Math.max(0, bas - len)

  let toplam = 0
  let gecen = 0
  let olculen = 0
  for (let i = bas; i < son; i++) {
    toplam += s.volume[i]
    if (i - bas >= len) toplam -= s.volume[i - len]
    if (i - bas + 1 < len) continue
    if (i < olcumBas) continue
    const ort = toplam / len
    if (!(ort > 0)) continue
    olculen++
    if (s.volume[i] / ort >= esik) gecen++
  }
  return { rate: olculen > 0 ? gecen / olculen : 0, n: olculen }
}

/**
 * Iki serinin ORTAK zaman damgalarindaki hacim oranlarinin medyanini dondurur
 * (spot hacmi / vekil hacmi). Vekil kaynagin hacmini depodaki olcege tasimak
 * icin kullanilir.
 *
 * Medyan kullanilir cunku tek tek barlardaki uc degerler ortalamayi bozar.
 * Yeterli ortak bar yoksa NULL doner: "olcek 1" ile "olcek bilinmiyor" ayni
 * sey degildir, ikincisinde bar yazilmamalidir.
 *
 * @param {import('../series').Series} spot
 * @param {import('../series').Series} proxy
 * @returns {number|null}
 */
function hacimOlcegi(spot, proxy) {
  if (!spot || spot.length === 0 || !proxy || proxy.length === 0) return null
  const oranlar = []
  let i = 0
  let j = 0
  while (i < spot.length && j < proxy.length) {
    const a = spot.time[i]
    const b = proxy.time[j]
    if (a === b) {
      const sv = spot.volume[i]
      const pv = proxy.volume[j]
      if (sv > 0 && pv > 0) oranlar.push(sv / pv)
      i++
      j++
    } else if (a < b) i++
    else j++
  }
  if (oranlar.length < MIN_HACIM_ORANI) return null
  oranlar.sort((x, y) => x - y)
  const m = oranlar[Math.floor(oranlar.length / 2)]
  return Number.isFinite(m) && m > 0 ? m : null
}

/**
 * Vekil kaynagin, spot piyasanin KAPALI oldugu saatlerde urettigi barlari eler.
 *
 * Neden gerekli: PAXG ve XAUT kripto borsalarinda 7/24 islem gorur, spot XAUUSD
 * ise hafta sonu ve gunluk aradan kapalidir. Duzeltmeden eklenirse seriye
 * gecmiste hic olmayan barlar girer; bu, indikatorun pivot ve ATR pencerelerini
 * kaydirdigi icin hafizadaki gecmisle tutarsiz sonuc uretir.
 *
 * Takvim ONCEDEN depodaki son 8 haftadan cikariliyordu. Depoya bir kez kirli
 * (Cumartesi) bar girdiginde o saat "acik" sayiliyor ve suzgec kendi kendini
 * bozuyordu; olculdu: 7/24 vekil haftasinda veriden cikarilan takvim kapali
 * saatten 480 bar tutup acik saatten 180 bar atiyordu. Artik kural tabanli
 * New York takvimi kullanilir (session.js createMarketCalendar).
 *
 * @param {import('../series').Series} proxy Vekil kaynaktan gelen seri
 * @returns {import('../series').Series}
 */
function piyasaSaatleriyleSuz(proxy) {
  if (!proxy || proxy.length === 0) return proxy
  const piyasaAcikMi = createMarketCalendar()

  const tut = new Uint8Array(proxy.length)
  let kalan = 0
  for (let i = 0; i < proxy.length; i++) {
    if (piyasaAcikMi(proxy.time[i])) {
      tut[i] = 1
      kalan++
    }
  }
  if (kalan === proxy.length) return proxy

  const out = series.createSeries(kalan)
  let k = 0
  for (let i = 0; i < proxy.length; i++) {
    if (tut[i] !== 1) continue
    out.time[k] = proxy.time[i]
    out.open[k] = proxy.open[i]
    out.high[k] = proxy.high[i]
    out.low[k] = proxy.low[i]
    out.close[k] = proxy.close[i]
    out.volume[k] = proxy.volume[i]
    k++
  }
  return out
}

/**
 * Vekil kaynak fiyatini spot seviyesine tasimak icin medyan fark hesaplar.
 * Iki serinin ORTAK zaman damgalarindaki kapanis farklarinin (spot - vekil)
 * medyani dondurulur. Yeterli ortak bar yoksa NULL doner.
 *
 * NOT: Depoya bir kez HAM vekil bar yazildiysa ortak bolgedeki fark gercekten
 * 0 cikar ve bu durum "ortak yok" ile ayirt edilemez. Tek korunma, ham barin
 * hic yazilmamasidir (normalizeProxy) ve kirlenmis depo icin tek seferlik
 * onarimdir (scripts/repair-proxy.mjs).
 *
 * Medyan kullanilir cunku tek tek barlarda olusan gecici sapmalar ortalamayi
 * bozar; medyan bunlara dayaniklidir.
 *
 * @param {import('../series').Series} spotSeries
 * @param {import('../series').Series} proxySeries
 * @param {number} [overlapBars] Son kac ortak bar kullanilsin (varsayilan 200)
 * @returns {number|null}
 */
function computeBasis(spotSeries, proxySeries, overlapBars) {
  const olcum = basisOlcumu(spotSeries, proxySeries, overlapBars)
  return olcum === null ? null : olcum.basis
}

/**
 * computeBasis ile AYNI hesabi yapar ama kaliteyi de dondurur.
 *
 * Neden ayri: "basis hesaplandi" ile "basis guvenilir" ayni sey degil.
 * Ortak bar sayisi az ya da farklar dagilmissa medyan yine bir sayi uretir,
 * ama o sayi seriyi dogru yere tasimaz. normalizeProxy bu iki olcute gore
 * bar yazmayi reddeder.
 *
 * @param {import('../series').Series} spotSeries
 * @param {import('../series').Series} proxySeries
 * @param {number} [overlapBars]
 * @returns {{basis:number, n:number, mad:number}|null}
 */
function basisOlcumu(spotSeries, proxySeries, overlapBars) {
  const a = spotSeries
  const b = proxySeries
  if (!a || !b || a.length === 0 || b.length === 0) return null

  let pencere = Number.isFinite(overlapBars) ? Math.floor(overlapBars) : VARSAYILAN_ORTUSME
  if (pencere <= 0) pencere = VARSAYILAN_ORTUSME

  // Halka tampon: son `pencere` ortak farki tutar, siralari onemli degil.
  const halka = new Float64Array(pencere)
  let sayac = 0

  const at = a.time
  const bt = b.time
  const ac = a.close
  const bc = b.close
  let i = 0
  let j = 0
  const na = a.length
  const nb = b.length
  while (i < na && j < nb) {
    const ta = at[i]
    const tb = bt[j]
    if (ta < tb) {
      i++
    } else if (tb < ta) {
      j++
    } else {
      const d = ac[i] - bc[j]
      if (Number.isFinite(d)) {
        halka[sayac % pencere] = d
        sayac++
      }
      i++
      j++
    }
  }
  if (sayac < MIN_ORTAK_BAR) return null

  const m = sayac < pencere ? sayac : pencere
  const dizi = halka.slice(0, m)
  dizi.sort()
  const medyan = m % 2 === 1 ? dizi[(m - 1) >> 1] : (dizi[m / 2 - 1] + dizi[m / 2]) / 2

  // MEDYAN MUTLAK SAPMA: farklarin medyandan ne kadar uzaklastigi. Ortalamaya
  // gore secilmedi, cunku tek bir uc deger standart sapmayi sisirir.
  const sapma = new Float64Array(m)
  for (let k = 0; k < m; k++) sapma[k] = Math.abs(dizi[k] - medyan)
  sapma.sort()
  const mad = m % 2 === 1 ? sapma[(m - 1) >> 1] : (sapma[m / 2 - 1] + sapma[m / 2]) / 2

  return { basis: medyan, n: sayac, mad: mad }
}

/**
 * open/high/low/close degerlerine sabit bir fark ekler ve YENI seri dondurur.
 * Girdi serisi degistirilmez.
 * @param {import('../series').Series} s
 * @param {number} offset
 * @returns {import('../series').Series}
 */
function applyBasis(s, offset) {
  if (!s || s.length === 0) return series.emptySeries()
  const off = Number.isFinite(offset) ? offset : 0
  const n = s.length
  const out = series.createSeries(n)
  out.time.set(s.time.subarray(0, n))
  out.volume.set(s.volume.subarray(0, n))
  if (off === 0) {
    out.open.set(s.open.subarray(0, n))
    out.high.set(s.high.subarray(0, n))
    out.low.set(s.low.subarray(0, n))
    out.close.set(s.close.subarray(0, n))
    return out
  }
  const so = s.open
  const sh = s.high
  const sl = s.low
  const sc = s.close
  const oo = out.open
  const oh = out.high
  const ol = out.low
  const oc = out.close
  for (let i = 0; i < n; i++) {
    oo[i] = so[i] + off
    oh[i] = sh[i] + off
    ol[i] = sl[i] + off
    oc[i] = sc[i] + off
  }
  return out
}

/**
 * Turetilmis zaman dilimi dosyalarini 1 dakikalik seriden yeniden uretir.
 * Taban seri degistiginde (indirme, onarim, goc) cagrilmalidir; aksi halde
 * 5m/15m/1h/4h dosyalari 1m ile senkronsuz kalir ve yukleyici eski dosyayi
 * tercih ettigi icin hafiza yanlis seriyle kurulur.
 *
 * @param {string} dataDir
 * @param {string} [symbol]
 * @param {string[]} [tfs] varsayilan TURETILEN_TF
 * @returns {Promise<Array<{tf:string, count:number, lastTime:number}>>}
 */
async function rebuildDerived(dataDir, symbol, tfs) {
  const liste = Array.isArray(tfs) && tfs.length ? tfs : TURETILEN_TF
  const taban = await binstore.readSeries(mumYolu(dataDir, '1m', symbol))
  if (!taban || taban.length === 0) return []
  const sonuc = []
  for (const tf of liste) {
    const s = series.resample(taban, tfSeconds(tf))
    await binstore.writeSeries(mumYolu(dataDir, tf, symbol), s)
    sonuc.push({ tf: tf, count: s.length, lastTime: s.length ? s.time[s.length - 1] : 0 })
  }
  return sonuc
}

/**
 * Depodan seri okur. Istenen zaman diliminin dosyasi yoksa 1 dakikalik
 * dosyadan yeniden ornekler. `from` / `to` verilirse sonuc o araliga kirpilir.
 *
 * Yeniden ornekleme gerektiginde once 1 dakikalik veri kova sinirina hizali
 * olarak kirpilir, sonra ornekleme yapilir; boylece 6 milyon barin tamami
 * gereksiz yere islenmez.
 *
 * @param {{dataDir:string, tf:string, from?:number, to?:number, symbol?:string}} opts
 * @returns {Promise<import('../series').Series>}
 */
async function loadSeries(opts) {
  const o = opts || {}
  if (!o.dataDir) throw new Error('loadSeries: dataDir parametresi gerekli')
  const tf = o.tf || '1m'
  const tfSec = tfSeconds(tf)
  const from = Number.isFinite(o.from) ? Math.floor(o.from) : undefined
  const to = Number.isFinite(o.to) ? Math.floor(o.to) : undefined

  const dogrudan = await binstore.readSeries(mumYolu(o.dataDir, tf, o.symbol))
  if (dogrudan && dogrudan.length > 0) return zamanaGoreDilimle(dogrudan, from, to)

  if (tfSec === 60) return series.emptySeries()

  const bir = await binstore.readSeries(mumYolu(o.dataDir, '1m', o.symbol))
  if (!bir || bir.length === 0) return series.emptySeries()

  // Kova basina hizali alt sinir, aksi halde ilk kova eksik veriyle olusur.
  const hamBas = from === undefined ? undefined : Math.floor(from / tfSec) * tfSec
  const kaynak = zamanaGoreDilimle(bir, hamBas, to)
  if (kaynak.length === 0) return series.emptySeries()

  const orneklenmis = series.resample(kaynak, tfSec)
  return zamanaGoreDilimle(orneklenmis, from, to)
}

module.exports = {
  syncHistory: syncHistory,
  computeBasis: computeBasis,
  // Basis kalitesi (ortak bar sayisi ve medyan mutlak sapma) ile birlikte.
  basisOlcumu: basisOlcumu,
  normalizeProxy: normalizeProxy,
  // Vekil hacmini spot seriyle ayni oran dagilimina tasiyan eslestirme (V3).
  hacimOranEslemesi: hacimOranEslemesi,
  // Hacim kapisinin ne siklikla acildigi (rejim kaymasi olcumu).
  hacimKapiOrani: hacimKapiOrani,
  piyasaSaatleriyleSuz: piyasaSaatleriyleSuz,
  hacimOlcegi: hacimOlcegi,
  applyBasis: applyBasis,
  loadSeries: loadSeries,
  rebuildDerived: rebuildDerived,
  MIN_ORTAK_BAR: MIN_ORTAK_BAR,
  vekilAraligiKaydet: vekilAraligiKaydet,
  vekilAraliklariOku: vekilAraliklariOku,
  vekilKayitYolu: vekilKayitYolu,
  // Betikler ve ana surec icin ek yardimci (sozlesme disinda, eklemedir):
  candleFileName: candleFileName,
}
