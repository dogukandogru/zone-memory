'use strict'

// Veri doktoru: depodaki serinin saglik raporunu cikarir.
//
// Neden gerekli: kod ic bosluklari hic gormuyordu. Olculdu ki 2023-02-20 ile
// 2023-07-28 arasinda sistematik bir "bir saat var, bir saat yok" deseni var
// (yaklasik 479 tam saat eksik). Bu donemde pivot, ATR, hacim ortalamasi ve
// 48 barlik sonuc ufku gercekte cok daha uzun bir zamana yayiliyor, yani o
// olaylar hafizaya ve teste farkli ozelliklerle giriyor. Canli modda
// bilgisayar uyudugunda da ayni sekilde kalici bosluk olusuyor.
//
// Rapor kural tabanli piyasa takvimini kullanir (session.createMarketCalendar),
// boylece hafta sonu ve gunluk ara bosluk sayilmaz.

const { createMarketCalendar } = require('../session')

const DAKIKA = 60

/** UNIX saniyeden 'YYYY-MM' anahtari. */
function ayAnahtari(t) {
  const d = new Date(t * 1000)
  const ay = d.getUTCMonth() + 1
  return d.getUTCFullYear() + '-' + (ay < 10 ? '0' + ay : String(ay))
}

/** Dizinin medyani (dizi degistirilir). */
function medyan(dizi) {
  if (dizi.length === 0) return 0
  dizi.sort((a, b) => a - b)
  const m = dizi.length >> 1
  return dizi.length % 2 === 1 ? dizi[m] : (dizi[m - 1] + dizi[m]) / 2
}

/**
 * Seriyi tarar ve saglik raporu dondurur.
 *
 * @param {import('../series').Series} s
 * @param {number} tfSec Bar suresi (saniye)
 * @param {{minGapMinutes?:number, volumeBreakRatio?:number}} [opts]
 * @returns {{bars:number, firstTime:number, lastTime:number,
 *            gaps:Array<{from:number,to:number,missingBars:number,minutes:number}>,
 *            gapBars:number, monthly:Array<{month:string,bars:number,expected:number,
 *            coverage:number,medianVolume:number,zeroVolume:number}>,
 *            weekendBars:number, zeroVolumeBars:number, duplicateTimes:number,
 *            outOfOrder:number, volumeBreaks:Array<{month:string,from:number,to:number,ratio:number}>}}
 */
function veriDoktoru(s, tfSec, opts) {
  const o = opts || {}
  const enAzBosluk = Number.isFinite(o.minGapMinutes) ? o.minGapMinutes : 30
  const kirilmaOrani = Number.isFinite(o.volumeBreakRatio) ? o.volumeBreakRatio : 2
  const bosluklar = []
  const aylar = new Map()
  const piyasaAcikMi = createMarketCalendar()

  const n = s ? s.length : 0
  if (n === 0) {
    return {
      bars: 0, firstTime: 0, lastTime: 0, gaps: [], gapBars: 0, monthly: [],
      weekendBars: 0, zeroVolumeBars: 0, duplicateTimes: 0, outOfOrder: 0, volumeBreaks: [],
    }
  }

  let haftaSonu = 0
  let sifirHacim = 0
  let tekrar = 0
  let sirasiz = 0
  let bosBar = 0

  for (let i = 0; i < n; i++) {
    const t = s.time[i]
    if (i > 0) {
      const onceki = s.time[i - 1]
      if (t === onceki) tekrar++
      else if (t < onceki) sirasiz++
      else if (t - onceki > tfSec) {
        // Aradaki barlardan kacinin piyasa acikken olmasi gerekirdi.
        let eksik = 0
        for (let a = onceki + tfSec; a < t; a += tfSec) {
          if (piyasaAcikMi(a)) eksik++
        }
        if (eksik > 0) {
          bosBar += eksik
          const dakika = (eksik * tfSec) / DAKIKA
          if (dakika >= enAzBosluk) {
            bosluklar.push({ from: onceki, to: t, missingBars: eksik, minutes: dakika })
          }
        }
      }
    }
    if (!piyasaAcikMi(t)) haftaSonu++
    if (!(s.volume[i] > 0)) sifirHacim++

    const anahtar = ayAnahtari(t)
    let kayit = aylar.get(anahtar)
    if (!kayit) {
      kayit = { month: anahtar, bars: 0, expected: 0, hacimler: [], zeroVolume: 0 }
      aylar.set(anahtar, kayit)
    }
    kayit.bars++
    if (!(s.volume[i] > 0)) kayit.zeroVolume++
    // Medyan icin ornekleme: her ayda en fazla 5000 deger yeterlidir.
    if (kayit.hacimler.length < 5000) kayit.hacimler.push(s.volume[i])
  }

  // Beklenen bar sayisi: piyasanin acik oldugu her kova.
  const bas = Math.floor(s.time[0] / tfSec) * tfSec
  const bit = s.time[n - 1]
  for (let t = bas; t <= bit; t += tfSec) {
    if (!piyasaAcikMi(t)) continue
    const anahtar = ayAnahtari(t)
    const kayit = aylar.get(anahtar)
    if (kayit) kayit.expected++
  }

  const aylik = Array.from(aylar.values()).map((k) => ({
    month: k.month,
    bars: k.bars,
    expected: k.expected,
    coverage: k.expected > 0 ? k.bars / k.expected : 1,
    medianVolume: medyan(k.hacimler),
    zeroVolume: k.zeroVolume,
  })).sort((a, b) => (a.month < b.month ? -1 : 1))

  // Hacim rejimi kirilmalari: ardisik aylarin medyan hacmi kat degistirirse.
  const kirilmalar = []
  for (let i = 1; i < aylik.length; i++) {
    const a = aylik[i - 1].medianVolume
    const b = aylik[i].medianVolume
    if (!(a > 0) || !(b > 0)) continue
    const oran = b > a ? b / a : a / b
    if (oran >= kirilmaOrani) {
      kirilmalar.push({ month: aylik[i].month, from: a, to: b, ratio: oran })
    }
  }

  return {
    bars: n,
    firstTime: s.time[0],
    lastTime: s.time[n - 1],
    gaps: bosluklar,
    gapBars: bosBar,
    monthly: aylik,
    weekendBars: haftaSonu,
    zeroVolumeBars: sifirHacim,
    duplicateTimes: tekrar,
    outOfOrder: sirasiz,
    volumeBreaks: kirilmalar,
  }
}

module.exports = {
  veriDoktoru: veriDoktoru,
}
