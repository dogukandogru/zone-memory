// HistData tick dosyalarinin saat donusumu. Dosya saatleri sabit UTC-5
// SAYILIYORDU; olculdu ki yaz aylarinda depodaki her bar gercek UTC'den
// 1 saat gec etiketleniyordu (2018 ve oncesi ABD, 2019 ve sonrasi AB yaz
// saati kurali).
const test = require('node:test')
const assert = require('node:assert')

const histdata = require('../src/core/data/histdata')

const SAAT = 3600

/** Tek bir tick satiri uretir: YYYYMMDD HHMMSSmmm,bid,ask,0 */
function tickSatiri(tarih, saat) {
  return tarih + ' ' + saat + '000,2000.00,2000.20,0'
}

/** Verilen gun ve dosya saati icin uretilen barin UTC zamanini dondurur. */
function barZamani(tarih, saat) {
  const csv = Buffer.from(tickSatiri(tarih, saat) + '\n' + tickSatiri(tarih, saat) + '\n')
  const s = histdata._tickCsvden1m(csv, 0, 4102444800)
  assert.ok(s.length > 0, 'bar uretilmedi')
  return s.time[0]
}

test('dosyaOfsetiSn: 2019 ve sonrasi Avrupa yaz saati kurali', () => {
  // 2026: AB yazi 29 Mart - 25 Ekim.
  assert.equal(histdata._dosyaOfsetiSn(2026, 7, 15), 4 * SAAT, 'Temmuz yaz saati')
  assert.equal(histdata._dosyaOfsetiSn(2026, 1, 15), 5 * SAAT, 'Ocak kis saati')
  assert.equal(histdata._dosyaOfsetiSn(2026, 3, 17), 5 * SAAT, 'AB yazindan once')
  assert.equal(histdata._dosyaOfsetiSn(2026, 3, 30), 4 * SAAT, 'AB yazi basladi')
  assert.equal(histdata._dosyaOfsetiSn(2026, 10, 24), 4 * SAAT, 'AB yazi surerken')
  assert.equal(histdata._dosyaOfsetiSn(2026, 10, 26), 5 * SAAT, 'AB yazi bitti')
})

test('dosyaOfsetiSn: 2018 ve oncesi ABD yaz saati kurali', () => {
  // 2018: ABD yazi 11 Mart - 4 Kasim.
  assert.equal(histdata._dosyaOfsetiSn(2018, 3, 20), 4 * SAAT, 'ABD yazi basladi')
  assert.equal(histdata._dosyaOfsetiSn(2018, 3, 5), 5 * SAAT, 'ABD yazindan once')
  assert.equal(histdata._dosyaOfsetiSn(2018, 10, 20), 4 * SAAT, 'Ekim ABD yazi surer')
  assert.equal(histdata._dosyaOfsetiSn(2018, 11, 10), 5 * SAAT, 'ABD yazi bitti')
  assert.equal(histdata._dosyaOfsetiSn(2015, 7, 15), 4 * SAAT)
})

test('tick dosyasindaki 12:00 dogru UTC bara dusuyor', () => {
  // Yaz: 12:00 dosya saati -> 16:00 UTC. Kis: 17:00 UTC.
  assert.equal(barZamani('20260715', '120000'), Date.UTC(2026, 6, 15, 16) / 1000)
  assert.equal(barZamani('20260115', '120000'), Date.UTC(2026, 0, 15, 17) / 1000)
  assert.equal(barZamani('20260317', '120000'), Date.UTC(2026, 2, 17, 17) / 1000)
  assert.equal(barZamani('20180320', '120000'), Date.UTC(2018, 2, 20, 16) / 1000)
})
