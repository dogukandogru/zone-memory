'use strict'

// Veri yukleyici: saglayicilardan gecmis ceker, ikili depoya yazar, depodan
// okur ve gerekirse ust zaman dilimine yeniden ornekler. Ayrica vekil
// kaynaklarin (GC=F, PAXG, XAUT) fiyatini spot XAUUSD seviyesine tasimak icin
// medyan fark (basis) hesabi burada yapilir.
// CONTRACTS.md bolum 17 ile uyumludur.

const path = require('node:path')
const { tfSeconds } = require('../tf')
const series = require('../series')
const binstore = require('../store/binstore')
const { getProvider, bildir } = require('./provider')

const VARSAYILAN_SEMBOL = 'XAUUSD'
const VARSAYILAN_ORTUSME = 200

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
  let to = Number.isFinite(o.to) ? Math.floor(o.to) : simdi
  if (to > simdi) to = simdi

  const durum = await binstore.statSeries(dosya)
  const varOlan = durum && durum.count > 0 ? durum : null
  let from = Number.isFinite(o.from)
    ? Math.floor(o.from)
    : varOlan
      ? varOlan.lastTime
      : to - 30 * 86400

  /** @type {Array<{from:number,to:number,label:string,bars:number}>} */
  const araliklar = []
  if (!varOlan) {
    if (from < to) araliklar.push({ from: from, to: to, label: 'tum aralik', bars: 0 })
  } else {
    if (from < varOlan.firstTime) {
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

  // Vekil kaynak (GC=F, PAXG, XAUT) spot XAUUSD DEGILDIR; seviye farki
  // yuzlerce dolar olabilir. Duzeltmeden eklemek seride sahte bir sicrama
  // yaratir ve indikatoru bozar. Bu yuzden vekil kaynakta:
  //   1. Depodaki son barin BIRAZ ONCESINDEN baslayarak cekeriz, boylece
  //      ortak zaman damgasi olusur.
  //   2. Ortak bolgeden medyan fark (basis) hesaplanir.
  //   3. Fark tum yeni seriye uygulanir.
  //   4. Depoda zaten olan barlar atilir, yalnizca yeni kisim eklenir.
  // Ortak bolge bulunamazsa EKLEME YAPILMAZ: sessizce bozuk veri yazmaktansa
  // acik bir hata vermek dogrudur.
  const vekil = !!saglayici.isProxy
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
      const fark = computeBasis(spot, yeni, 400)
      if (!Number.isFinite(fark) || fark === 0) {
        throw new Error(
          saglayici.name + ' ile depodaki seri arasinda ortak zaman bulunamadi, ' +
          'fiyat kaydirmasi hesaplanamadi. Bu vekil kaynak spot XAUUSD degildir ve ' +
          'duzeltmesiz eklenirse seride sahte bir sicrama olusur. ' +
          'Once bosluğu gercek spot kaynakla (HistData, Polygon, Twelve Data) kapatin.'
        )
      }
      uygulananBasis = fark
      yeni = applyBasis(yeni, fark)

      // Hacim olcegini de esitleriz. Kaynaklarin hacim birimi farklidir:
      // HistData dakikadaki TICK SAYISINI verir (~95), Binance ise PAXG
      // cinsinden islem hacmini (~7). Indikatorun flow bileseni hacme bagli
      // oldugu icin, olcek degisiminin oldugu yerde yaklasik 10 barlik bir
      // bozulma olusur (hareketli ortalama hala eski buyuk degerleri tasir).
      // Ortak bolgedeki medyan orana gore olcekleyip bunu ortadan kaldiririz.
      const hacimOran = hacimOlcegi(spot, yeni)
      if (Number.isFinite(hacimOran) && hacimOran > 0 && hacimOran !== 1) {
        for (let k = 0; k < yeni.length; k++) yeni.volume[k] *= hacimOran
        bildir(o.onProgress, taban + pay * 0.92,
          'Hacim olcegi ' + hacimOran.toFixed(2) + ' katsayisiyla esitlendi')
      }
      bildir(o.onProgress, taban + pay * 0.9,
        'Vekil fiyat spot seviyesine ' + fark.toFixed(2) + ' birim kaydirildi')

      // Depoda zaten olan barlari atarak yalnizca yeni kismi birakiriz.
      yeni = series.sliceSeries(yeni, series.firstIndexAtOrAfter(yeni, varOlan.lastTime + 1), yeni.length)

      // Spot piyasanin kapali oldugu saatlerdeki barlari (hafta sonu, gunluk
      // ara) eleriz; kripto vekilleri 7/24 islem gorur, spot altin gormez.
      const oncekiAdet = yeni.length
      yeni = piyasaSaatleriyleSuz(spot, yeni, 8)
      if (yeni.length < oncekiAdet) {
        bildir(o.onProgress, taban + pay * 0.95,
          'Piyasanin kapali oldugu ' + (oncekiAdet - yeni.length) + ' bar elendi')
      }
    }

    r.bars = yeni ? yeni.length : 0
    toplamCekilen += r.bars
    if (r.bars > 0) {
      const sonuc = await binstore.appendSeries(dosya, yeni)
      toplamEklenen += sonuc.added
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
 * Iki serinin ORTAK zaman damgalarindaki hacim oranlarinin medyanini dondurur
 * (spot hacmi / vekil hacmi). Vekil kaynagin hacmini depodaki olcege tasimak
 * icin kullanilir.
 *
 * Medyan kullanilir cunku tek tek barlardaki uc degerler ortalamayi bozar.
 * Ortak nokta yoksa veya hacimler sifirsa 1 doner (olcekleme yapilmaz).
 *
 * @param {import('../series').Series} spot
 * @param {import('../series').Series} proxy
 * @returns {number}
 */
function hacimOlcegi(spot, proxy) {
  if (!spot || spot.length === 0 || !proxy || proxy.length === 0) return 1
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
  if (oranlar.length < 10) return 1
  oranlar.sort((x, y) => x - y)
  const m = oranlar[Math.floor(oranlar.length / 2)]
  return Number.isFinite(m) && m > 0 ? m : 1
}

/**
 * Vekil kaynagin, spot piyasanin KAPALI oldugu saatlerde urettigi barlari eler.
 *
 * Neden gerekli: PAXG ve XAUT kripto borsalarinda 7/24 islem gorur, spot XAUUSD
 * ise hafta sonu ve gunluk aradan kapalidir. Duzeltmeden eklenirse seriye
 * gecmiste hic olmayan barlar girer; bu, indikatorun pivot ve ATR pencerelerini
 * kaydirdigi icin hafizadaki gecmisle tutarsiz sonuc uretir.
 *
 * Takvim sabit kodlanmaz, VERIDEN cikarilir: depodaki serinin son haftalarinda
 * hangi (haftanin gunu, UTC saati) kovalarinda bar VARSA yalnizca o kovalar
 * kabul edilir. Boylece yaz saati kaymalari ve tatil duzenleri kendiliginden
 * dogru ele alinir.
 *
 * @param {import('../series').Series} spot Depodaki gercek seri
 * @param {import('../series').Series} proxy Vekil kaynaktan gelen seri
 * @param {number} [haftaSayisi] Takvimi cikarmak icin bakilacak hafta (varsayilan 8)
 * @returns {import('../series').Series}
 */
function piyasaSaatleriyleSuz(spot, proxy, haftaSayisi) {
  if (!spot || spot.length === 0 || !proxy || proxy.length === 0) return proxy
  const hafta = Number.isFinite(haftaSayisi) && haftaSayisi > 0 ? haftaSayisi : 8

  // Son N haftanin (gun, saat) kovalari.
  const sonZaman = spot.time[spot.length - 1]
  const baslangic = sonZaman - hafta * 7 * 86400
  const kovalar = new Uint8Array(7 * 24)
  let bakilan = 0
  for (let i = spot.length - 1; i >= 0; i--) {
    const t = spot.time[i]
    if (t < baslangic) break
    const d = new Date(t * 1000)
    kovalar[d.getUTCDay() * 24 + d.getUTCHours()] = 1
    bakilan++
  }
  // Yeterli ornek yoksa suzme yapma (yanlislikla her seyi elemeyelim).
  if (bakilan < 200) return proxy

  const tut = new Uint8Array(proxy.length)
  let kalan = 0
  for (let i = 0; i < proxy.length; i++) {
    const d = new Date(proxy.time[i] * 1000)
    if (kovalar[d.getUTCDay() * 24 + d.getUTCHours()] === 1) {
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
 * medyani dondurulur. Ortak nokta yoksa 0 doner.
 *
 * Medyan kullanilir cunku tek tek barlarda olusan gecici sapmalar ortalamayi
 * bozar; medyan bunlara dayaniklidir.
 *
 * @param {import('../series').Series} spotSeries
 * @param {import('../series').Series} proxySeries
 * @param {number} [overlapBars] Son kac ortak bar kullanilsin (varsayilan 200)
 * @returns {number}
 */
function computeBasis(spotSeries, proxySeries, overlapBars) {
  const a = spotSeries
  const b = proxySeries
  if (!a || !b || a.length === 0 || b.length === 0) return 0

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
  if (sayac === 0) return 0

  const m = sayac < pencere ? sayac : pencere
  const dizi = halka.slice(0, m)
  dizi.sort()
  return m % 2 === 1 ? dizi[(m - 1) >> 1] : (dizi[m / 2 - 1] + dizi[m / 2]) / 2
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
  piyasaSaatleriyleSuz: piyasaSaatleriyleSuz,
  hacimOlcegi: hacimOlcegi,
  applyBasis: applyBasis,
  loadSeries: loadSeries,
  // Betikler ve ana surec icin ek yardimci (sozlesme disinda, eklemedir):
  candleFileName: candleFileName,
}
