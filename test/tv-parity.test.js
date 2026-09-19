'use strict'

// A4 - TRADINGVIEW SADAKAT TESTI
//
// Butun hafiza, butun istatistik ve butun olcum, portun (proZones.js) Pine
// ile AYNI kutulari urettigi VARSAYIMINA dayanir. O varsayim depoda hicbir
// yerde sinanmiyordu: test/ altinda tek bir TradingView verisi yoktu ve
// indicator.test.js yalnizca sentetik seri kullaniyordu. Birlestirme
// kuralindaki bir fark bu yuzden uzun sure fark edilmeden kalmisti.
//
// Bu test, TradingView'de calistirilan `docs/pine/son_pro_export.pine`
// ciktisiyla portu BAR BAR karsilastirir.
//
// FIXTURE OLMADAN CALISMAZ ve bu bilerek boyledir: veri kullanicinin kendi
// TradingView hesabindan, kendi brokerinin hacmiyle gelmek zorunda. Hacim
// brokere gore degisir ve kutu kapisi hacme bagli oldugu icin baska bir
// kaynaktan alinan "referans" yanlis bir guven verirdi. Dosya yoksa test
// kendini atlar ve nasil uretilecegini yazar.
//
// Uretme adimlari: docs/pine/son_pro_export.pine dosyasinin basindaki
// aciklama.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const series = require('../src/core/series')
const { runIndicator } = require('../src/core/indicator/proZones')

const FIXTURE_DIR = path.join(__dirname, 'fixtures')

/** Hangi zaman dilimleri icin fixture ariyoruz. */
const HEDEFLER = [
  { tf: '15m', tfSec: 900, dosya: 'tv_xauusd_15m.csv.gz' },
  { tf: '1h', tfSec: 3600, dosya: 'tv_xauusd_1h.csv.gz' },
  { tf: '5m', tfSec: 300, dosya: 'tv_xauusd_5m.csv.gz' },
]

/**
 * TradingView'in isinma penceresi bizimkiyle ayni degildir: grafige yalnizca
 * belli sayida bar yuklenir ve `ta.atr`, `ta.sma`, `ta.stdev` serinin en
 * basinda birbirinden farkli degerler verir. Ilk barlar bu yuzden
 * karsilastirmaya GIRMEZ.
 */
const ISINMA_BAR = 1000

/** Toplamlarda kabul edilen bagil fark. */
const TOLERANS = 1e-6

/** Fixture dosyasini okur; yoksa null. */
function fixtureOku(dosya) {
  const tam = path.join(FIXTURE_DIR, dosya)
  if (!fs.existsSync(tam)) return null
  const ham = tam.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(tam)).toString('utf8')
    : fs.readFileSync(tam, 'utf8')
  return ham
}

/** Bir CSV hucresini sayiya cevirir; bos ya da "NaN" ise NaN. */
function sayi(h) {
  if (h === undefined || h === null) return NaN
  const s = String(h).trim().replace(/^"|"$/g, '')
  if (s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'na') return NaN
  // TradingView bazi yerel ayarlarda ondalik ayraci olarak virgul verir.
  const d = s.indexOf(',') >= 0 && s.indexOf('.') < 0 ? s.replace(',', '.') : s
  const n = Number(d)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Zaman hucresini UNIX saniyeye cevirir.
 * TradingView "Export chart data" ya UNIX saniye ya da ISO metin verir.
 */
function zaman(h) {
  const s = String(h === undefined ? '' : h).trim().replace(/^"|"$/g, '')
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s)
    return s.length > 10 ? Math.floor(n / 1000) : n
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? Math.floor(t / 1000) : NaN
}

/**
 * CSV'yi ayristirir.
 * @returns {{bars:object, tv:Array<object>}|null}
 */
function csvAyristir(metin) {
  const satirlar = metin.split(/\r?\n/).filter((x) => x.trim() !== '')
  if (satirlar.length < 2) return null

  // Ayrac: noktali virgul de cikabiliyor.
  const ayrac = satirlar[0].indexOf(';') >= 0 && satirlar[0].indexOf(',') < 0 ? ';' : ','
  const basliklar = satirlar[0].split(ayrac).map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase())

  const dizin = (...adlar) => {
    for (const ad of adlar) {
      const i = basliklar.indexOf(ad)
      if (i >= 0) return i
    }
    return -1
  }

  const iT = dizin('time', 'unix time', 'date', 'datetime')
  const iO = dizin('open')
  const iH = dizin('high')
  const iL = dizin('low')
  const iC = dizin('close')
  const iV = dizin('volume')
  const iAktif = dizin('zaktif')
  const iTopTop = dizin('ztoptop')
  const iBotTop = dizin('zbottop')
  const iScoreTop = dizin('zscoretop')
  if (iT < 0 || iO < 0 || iH < 0 || iL < 0 || iC < 0 || iV < 0) return null
  if (iAktif < 0) return null

  const t = []; const o = []; const h = []; const l = []; const c = []; const v = []
  const tv = []
  for (let i = 1; i < satirlar.length; i++) {
    const hucre = satirlar[i].split(ayrac)
    const zt = zaman(hucre[iT])
    const co = sayi(hucre[iC])
    if (!Number.isFinite(zt) || !Number.isFinite(co)) continue
    t.push(zt)
    o.push(sayi(hucre[iO]))
    h.push(sayi(hucre[iH]))
    l.push(sayi(hucre[iL]))
    c.push(co)
    const hac = sayi(hucre[iV])
    v.push(Number.isFinite(hac) ? hac : 0)
    tv.push({
      aktif: sayi(hucre[iAktif]),
      topTop: iTopTop >= 0 ? sayi(hucre[iTopTop]) : NaN,
      botTop: iBotTop >= 0 ? sayi(hucre[iBotTop]) : NaN,
      scoreTop: iScoreTop >= 0 ? sayi(hucre[iScoreTop]) : NaN,
    })
  }
  if (t.length === 0) return null
  return { bars: series.fromArrays({ time: t, open: o, high: h, low: l, close: c, volume: v }), tv: tv }
}

/** Bagil fark toleransi. */
function yakinMi(a, b) {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return true
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const olcek = Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) / olcek <= TOLERANS
}

// ---------------------------------------------------------------------------
// AYRISTIRICININ KENDI TESTI
// ---------------------------------------------------------------------------
// Fixture gelene kadar yukaridaki uc test ATLANIR. O halde ayristiricinin ve
// iz kancasinin dogru calistigi hic sinanmamis olurdu ve fixture geldigi gun
// "hata mi Pine'da mi ayristiricida" sorusuyla baslardik. Bu test, portun
// KENDI ciktisindan bir CSV uretip ayni yoldan geri okur: karsilastirma
// zincirinin (CSV -> seri -> runIndicator -> iz -> karsilastirma) saglam
// oldugunu kilitler. Pine sadakati hakkinda hicbir sey soylemez.

/** Tohumlu sozde rastgele (test tekrarlanabilir olsun). */
function rastgele(tohum) {
  let x = tohum >>> 0
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    return x / 4294967296
  }
}

/**
 * Sentetik OHLCV serisi.
 *
 * Kutu kapisi UC kosulu birlikte ister: bar bir pivot olacak, hacmi kendi
 * ortalamasinin ustunde olacak ve pivot noktasi Bollinger bandinin disinda
 * kalacak. Duz bir rastgele yuruyuste bu uclu neredeyse hic bir araya
 * gelmez (olculdu: 1900 barda 1 kutu). Bu yuzden seri indicator.test.js'teki
 * gibi KURULUR: kapanislar sabit, yalnizca dip/tepe fitilleri ve o barin
 * hacmi degisir. Sabit kapanis Bollinger sapmasini sifira indirir, yani
 * bant kapanisin kendisidir ve her fitil bandin disinda kalir.
 */
function sentetikSeri(n, tohum) {
  const r = rastgele(tohum)
  const TABAN = 2000
  const t = []; const o = []; const h = []; const l = []; const c = []; const v = []
  for (let i = 0; i < n; i++) {
    t.push(1600000000 + i * 900)
    l.push(TABAN)
    o.push(TABAN + 0.05)
    c.push(TABAN + 0.15)
    h.push(TABAN + 0.30)
    v.push(100)
  }
  // Her 40 barda bir, hacimli bir dip ya da tepe. Konum ve derinlik tohumdan.
  for (let i = 60; i < n - 20; i += 40) {
    const yer = i + Math.floor(r() * 8)
    const derinlik = 2 + r() * 6
    const dipMi = r() < 0.5
    if (dipMi) l[yer] = Math.round((l[yer] - derinlik) * 100) / 100
    else h[yer] = Math.round((h[yer] + derinlik) * 100) / 100
    v[yer] = 8000 + Math.floor(r() * 12000)
    // Kutunun bir kismi kirilsin, bir kismi tutsun: ikisi de olmadan
    // karsilastirma zincirinin yarisi hic calismaz.
    if (r() < 0.45) {
      const kay = (dipMi ? -1 : 1) * (derinlik + 3)
      for (let j = yer + 6; j < Math.min(n, yer + 14); j++) {
        l[j] += kay; o[j] += kay; c[j] += kay; h[j] += kay
      }
    }
  }
  return series.fromArrays({ time: t, open: o, high: h, low: l, close: c, volume: v })
}

test('ayristirici ve iz kancasi: portun kendi ciktisi geri okunabiliyor', () => {
  const n = ISINMA_BAR + 900
  const s = sentetikSeri(n, 20260919)

  const iz = new Array(n)
  const r = runIndicator(s, {}, 900, null, (i, live) => {
    let topT = 0; let botT = 0; let skorT = 0
    for (let j = 0; j < live.length; j++) {
      topT += live[j].top
      botT += live[j].bottom
      skorT += live[j].flow
    }
    iz[i] = { aktif: live.length, topTop: topT, botTop: botT, scoreTop: skorT }
  })

  // Kutu dogmayan bir seride bu testin hicbir anlami olmaz.
  assert.ok(r.zones.length >= 5, 'sentetik seride en az bes kutu dogmali: ' + r.zones.length)
  let aktifGorulen = 0
  for (let i = ISINMA_BAR; i < n; i++) if (iz[i] && iz[i].aktif > 0) aktifGorulen++
  assert.ok(aktifGorulen > 50, 'izde aktif kutu gorulen bar sayisi: ' + aktifGorulen)

  // Portun ciktisindan TradingView bicimli bir CSV kur.
  const satirlar = ['time,open,high,low,close,volume,zAktif,zTopTop,zBotTop,zScoreTop']
  for (let i = 0; i < n; i++) {
    const a = iz[i] || { aktif: 0, topTop: 0, botTop: 0, scoreTop: 0 }
    satirlar.push([
      s.time[i], s.open[i], s.high[i], s.low[i], s.close[i], s.volume[i],
      a.aktif, a.topTop, a.botTop, a.scoreTop,
    ].join(','))
  }

  const veri = csvAyristir(satirlar.join('\n'))
  assert.ok(veri, 'kendi uretimimiz CSV ayristirilamadi')
  assert.strictEqual(veri.bars.length, n)

  // Ayristirilan seriyle yeniden calistirinca iz BIREBIR ayni cikmali.
  const iz2 = new Array(n)
  runIndicator(veri.bars, {}, 900, null, (i, live) => {
    let topT = 0; let botT = 0; let skorT = 0
    for (let j = 0; j < live.length; j++) {
      topT += live[j].top
      botT += live[j].bottom
      skorT += live[j].flow
    }
    iz2[i] = { aktif: live.length, topTop: topT, botTop: botT, scoreTop: skorT }
  })

  for (let i = ISINMA_BAR; i < n; i++) {
    assert.strictEqual(iz2[i].aktif, veri.tv[i].aktif, 'bar ' + i + ' aktif kutu sayisi')
    assert.ok(yakinMi(iz2[i].topTop, veri.tv[i].topTop), 'bar ' + i + ' topTop')
    assert.ok(yakinMi(iz2[i].scoreTop, veri.tv[i].scoreTop), 'bar ' + i + ' scoreTop')
  }
})

test('iz kancasi verilmediginde davranis degismez', () => {
  const s = sentetikSeri(1500, 7)
  const a = runIndicator(s, {}, 900)
  const b = runIndicator(s, {}, 900, null, () => {})
  assert.strictEqual(a.zones.length, b.zones.length)
  assert.strictEqual(a.touches.length, b.touches.length)
  assert.deepStrictEqual(a.zones.map((z) => z.id), b.zones.map((z) => z.id))
  assert.deepStrictEqual(a.touches.map((t) => t.bar), b.touches.map((t) => t.bar))
})

const NASIL =
  'TradingView fixture yok. Uretmek icin docs/pine/son_pro_export.pine ' +
  'dosyasinin basindaki adimlari izleyip ciktilari ' +
  'test/fixtures/ altina koyun.'

for (const hedef of HEDEFLER) {
  test('TradingView sadakati (' + hedef.tf + ')', (t) => {
    const metin = fixtureOku(hedef.dosya)
    if (metin === null) {
      t.skip(NASIL + ' Beklenen dosya: test/fixtures/' + hedef.dosya)
      return
    }

    const veri = csvAyristir(metin)
    assert.ok(veri, hedef.dosya + ' ayristirilamadi: beklenen sutunlar ' +
      'time, open, high, low, close, volume ve zAktif (son_pro_export.pine ciktisi)')

    const n = veri.bars.length
    assert.ok(n > ISINMA_BAR + 200,
      'fixture cok kisa (' + n + ' bar), en az ' + (ISINMA_BAR + 200) + ' bar gerekir')

    // Bar SONU izi: Pine'in ayni bardaki data_window ciktisiyla ayni an.
    const iz = new Array(n)
    runIndicator(veri.bars, {}, hedef.tfSec, null, (i, live) => {
      let topT = 0; let botT = 0; let skorT = 0
      for (let j = 0; j < live.length; j++) {
        topT += live[j].top
        botT += live[j].bottom
        skorT += live[j].flow
      }
      iz[i] = { aktif: live.length, topTop: topT, botTop: botT, scoreTop: skorT }
    })

    let ilkFark = null
    let farkliBar = 0
    for (let i = ISINMA_BAR; i < n; i++) {
      const a = iz[i]
      const b = veri.tv[i]
      if (!a || !b) continue
      const ayni =
        a.aktif === b.aktif &&
        yakinMi(a.topTop, b.topTop) &&
        yakinMi(a.botTop, b.botTop) &&
        yakinMi(a.scoreTop, b.scoreTop)
      if (ayni) continue
      farkliBar++
      if (ilkFark === null) {
        ilkFark = 'bar ' + i + ' (' + new Date(veri.bars.time[i] * 1000).toISOString() + '): ' +
          'aktif port=' + a.aktif + ' tv=' + b.aktif + ', ' +
          'topTop port=' + a.topTop.toFixed(4) + ' tv=' + Number(b.topTop).toFixed(4) + ', ' +
          'scoreTop port=' + a.scoreTop.toFixed(4) + ' tv=' + Number(b.scoreTop).toFixed(4)
      }
    }

    assert.strictEqual(farkliBar, 0,
      farkliBar + ' barda fark var (toplam ' + (n - ISINMA_BAR) + ' bar). Ilk fark: ' + ilkFark)
  })
}
