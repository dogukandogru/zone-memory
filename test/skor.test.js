'use strict'

// TP SANSI MODELI (core/learn/skor.js): ozellik vektoru, egitim, tahmin.

const test = require('node:test')
const assert = require('node:assert/strict')
const skor = require('../src/core/learn/skor')
const { CTX_NAMES } = require('../src/core/learn/features')
const series = require('../src/core/series')

const T0 = 1700000000
function seri (n) {
  const t = [], o = [], h = [], l = [], c = [], v = []
  for (let i = 0; i < n; i++) { t.push(T0 + i * 300); o.push(100 + i * 0.1); h.push(100.5 + i * 0.1); l.push(99.5 + i * 0.1); c.push(100.2 + i * 0.1); v.push(1) }
  return series.fromArrays({ time: t, open: o, high: h, low: l, close: c, volume: v })
}

test('ozellik vektoru: baglam + kutu geometrisi + seri ozellikleri + komsu orani', () => {
  const s = seri(400)
  const ctx = new Float32Array(CTX_NAMES.length).fill(0.5)
  const e = { features: { ctx }, price: s.close[350], atr: 2, direction: 'BUY', kind: 'form',
    zoneTop: s.close[350] - 1, zoneBottom: s.close[350] - 3, score: 2, maxScore: 4, time: s.time[350] }
  const x = skor.ozellikVektoru(s, e, { komsuOrani: 0.6, tfSec: 300 })
  assert.equal(x.length, skor.OZELLIK_ADLARI.length)
  const ad = (n) => x[skor.OZELLIK_ADLARI.indexOf(n)]
  assert.ok(Math.abs(ad('rsi') - 0.5) < 1e-6, 'baglam degeri aynen')
  // risk: giris - (uzak kenar - 0,25 ATR) = 3 + 0,5 = 3,5 -> / 2 = 1,75
  assert.ok(Math.abs(ad('risk_atr') - 1.75) < 1e-9, 'risk_atr: ' + ad('risk_atr'))
  assert.ok(Math.abs(ad('kutu_genislik_atr') - 1) < 1e-9)
  assert.equal(ad('skor_orani'), 0.5)
  assert.equal(ad('tur_olusum'), 1)
  assert.equal(ad('yon_al'), 1)
  assert.ok(Math.abs(ad('mum_govde') - 0.1) < 1e-9, 'govde (kapanis-acilis)/ATR')
  assert.ok(ad('yon_1saat') > 0 && ad('yon_1gun') > 0, 'yukari trendde AL lehine pozitif')
  assert.ok(ad('gun_konum') > 0.3, 'gunun tepesine yakin')
  assert.equal(ad('komsu_orani'), 0.6)
  // Seri yoksa seri ozellikleri NaN, digerleri durur.
  const y = skor.ozellikVektoru(null, e, { komsuOrani: null })
  assert.ok(Number.isNaN(y[skor.OZELLIK_ADLARI.indexOf('mum_govde')]))
  assert.ok(Number.isNaN(y[skor.OZELLIK_ADLARI.indexOf('komsu_orani')]))
  assert.ok(Math.abs(y[skor.OZELLIK_ADLARI.indexOf('risk_atr')] - 1.75) < 1e-9)
  // SAT: uzak kenar zoneTop.
  const sat = skor.ozellikVektoru(null, Object.assign({}, e, { direction: 'SELL', zoneTop: e.price + 3, zoneBottom: e.price + 1 }), {})
  assert.ok(Math.abs(sat[skor.OZELLIK_ADLARI.indexOf('risk_atr')] - 1.75) < 1e-9)
  assert.equal(sat[skor.OZELLIK_ADLARI.indexOf('yon_al')], 0)
})

test('agac: dogrusal olmayan deseni ogrenir, JSON gidip gelince ayni tahmin, az veride lojistik', () => {
  const d = skor.OZELLIK_ADLARI.length
  const j = skor.OZELLIK_ADLARI.indexOf('risk_atr'), k = skor.OZELLIK_ADLARI.indexOf('penetration')
  const X = [], y = []
  let tohum = 11
  const rnd = () => { tohum = (tohum * 1103515245 + 12345) % 2147483648; return tohum / 2147483648 }
  for (let i = 0; i < 4000; i++) {
    const x = new Float64Array(d).fill(NaN)
    const r = rnd() * 3, pn = rnd()
    x[j] = r; x[k] = pn; x[0] = rnd()
    // Dogrusal olmayan: orta riskte VE dusuk penetrasyonda TP yuksek.
    const p = (r > 1 && r < 2 && pn < 0.5) ? 0.75 : 0.35
    X.push(x); y.push(rnd() < p ? 1 : 0)
  }
  const m = skor.egit(X, y)
  assert.equal(m.tur, 'agac', '4000 satirda agac')
  assert.ok(m.auc > 0.65, 'agac deseni ogrenmeli: ' + m.auc)
  const lojistik = skor.egit(X, y, { zorlaLojistik: true })
  assert.ok(m.auc > lojistik.auc + 0.05, 'agac lojistigi gecmeli: ' + m.auc + ' / ' + lojistik.auc)
  const kopya = JSON.parse(JSON.stringify(m))
  for (let i = 0; i < 20; i++) assert.ok(Math.abs(skor.tahmin(kopya, X[i]) - skor.tahmin(m, X[i])) < 1e-12, 'JSON gidip gelince ayni')
  const iyi = new Float64Array(d).fill(NaN); iyi[j] = 1.5; iyi[k] = 0.2
  const kotu = new Float64Array(d).fill(NaN); kotu[j] = 0.3; kotu[k] = 0.9
  assert.ok(skor.tahmin(m, iyi) > 0.6 && skor.tahmin(m, kotu) < 0.45, 'iyi ' + skor.tahmin(m, iyi) + ' kotu ' + skor.tahmin(m, kotu))
  const etk = skor.etkiler(m)
  assert.ok(['risk_atr', 'penetration'].includes(etk[0].ad), 'en etkili risk ya da penetrasyon: ' + etk[0].ad)
  assert.equal(skor.egit(X.slice(0, 1000), y.slice(0, 1000)).tur, 'lojistik', '2000 altinda lojistik')
})

test('egitim: ayirt edici ozellikte ogrenir, AUC yukselir, NaN ortalamaya duser', () => {
  const d = skor.OZELLIK_ADLARI.length
  const j = skor.OZELLIK_ADLARI.indexOf('risk_atr')
  const X = [], y = []
  let tohum = 7
  const rnd = () => { tohum = (tohum * 1103515245 + 12345) % 2147483648; return tohum / 2147483648 }
  for (let i = 0; i < 1000; i++) {
    const x = new Float64Array(d).fill(NaN)
    const r = rnd() * 3
    x[j] = r
    x[0] = rnd()            // gurultu ozelligi
    X.push(x)
    y.push(rnd() < (r < 0.5 ? 0.2 : 0.55) ? 1 : 0)
  }
  const m = skor.egit(X, y, { iter: 200 })
  assert.ok(m && m.n === 1000 && m.tur === 'lojistik')
  assert.ok(m.auc > 0.58, 'egitim AUC yukselmeli: ' + m.auc)
  assert.ok(m.w[j] > 0, 'risk_atr katsayisi pozitif (buyuk risk = daha cok TP)')
  const dusuk = new Float64Array(d).fill(NaN); dusuk[j] = 0.2
  const yuksek = new Float64Array(d).fill(NaN); yuksek[j] = 2.5
  assert.ok(skor.tahmin(m, yuksek) > skor.tahmin(m, dusuk), 'tahmin ozellikle artmali')
  // Tumu NaN: standart sifir, tahmin tabana yakin.
  const bos = new Float64Array(d).fill(NaN)
  assert.ok(Math.abs(skor.tahmin(m, bos) - m.taban) < 0.15, 'bilinmeyen girdi tabana yakin: ' + skor.tahmin(m, bos))
  assert.equal(skor.egit(X.slice(0, 50), y.slice(0, 50)), null, 'az satirla model yok')
  assert.ok(Number.isNaN(skor.tahmin(null, bos)))
  assert.equal(skor.etkiler(m)[0].ad, 'risk_atr', 'en etkili ozellik risk_atr')
})

test('auc: mukemmel siralama 1, ters 0, rastgele 0,5 civari, baglar ortalama', () => {
  assert.equal(skor.auc([1, 2, 3, 4], [0, 0, 1, 1]), 1)
  assert.equal(skor.auc([4, 3, 2, 1], [0, 0, 1, 1]), 0)
  assert.equal(skor.auc([1, 1, 1, 1], [0, 1, 0, 1]), 0.5)
})
