// HistData tick dosyalarinin saat donusumu. Dosya saatleri sabit UTC-5
// SAYILIYORDU; olculdu ki yaz aylarinda depodaki her bar gercek UTC'den
// 1 saat gec etiketleniyordu (2018 ve oncesi ABD, 2019 ve sonrasi AB yaz
// saati kurali).
const test = require('node:test')
const assert = require('node:assert')
const zlib = require('node:zlib')

const histdata = require('../src/core/data/histdata')

const SAAT = 3600

/** Tek bir tick satiri uretir: YYYYMMDD HHMMSSmmm,bid,ask,0 */
function tickSatiri(tarih, saat, bid) {
  const b = bid === undefined ? 2000 : bid
  return tarih + ' ' + saat + '000,' + b.toFixed(2) + ',' + (b + 0.2).toFixed(2) + ',0'
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

/* ------------------------------------------------------------------ */
/* Sira disi (zamanda geriye giden) tick                               */
/* ------------------------------------------------------------------ */

test('geciken tick kovayi silmiyor, mevcut kovaya katiliyor', () => {
  // Olculdu: HistData dosyalarinda ayni dakikanin bir kac satiri sonraki
  // dakikadan SONRA gelebiliyor. Eskiden geciken satir yeni bir kova aciyor,
  // ayni zaman damgasi tampona iki kez giriyor ve sanitize son kaydi tuttugu
  // icin 14:30 barinin hacmi 3 yerine 1 oluyordu.
  const csv = Buffer.from(
    tickSatiri('20260715', '143000', 4000) + '\n' +
    tickSatiri('20260715', '143010', 4001) + '\n' +
    tickSatiri('20260715', '143100', 4002) + '\n' +
    tickSatiri('20260715', '143005', 4005) + '\n'
  )
  const s = histdata._tickCsvden1m(csv, 0, 4102444800)

  assert.equal(s.length, 2, 'iki dakika iki bar')
  // 14:30 dosya saati, Temmuz yaz ofsetiyle 18:30 UTC.
  assert.equal(s.time[0], Date.UTC(2026, 6, 15, 18, 30) / 1000)
  assert.equal(s.volume[0], 3, 'geciken tick hacme katildi')
  assert.equal(s.high[0], 4005, 'geciken tick tepe fiyati yukseltti')
  // Acilis ve kapanis dosyadaki sirayla belirlenir, geciken satir bozmaz.
  assert.equal(s.open[0], 4000)
  assert.equal(s.close[0], 4001)
  assert.equal(s.low[0], 4000)
  assert.equal(s.volume[1], 1)
})

/* ------------------------------------------------------------------ */
/* Artimli indirme: onChunk ve tamamlanmis ayin atlanmasi              */
/* ------------------------------------------------------------------ */

/** Tek girisli, deflate'li ZIP uretir. Okuyucu CRC'ye bakmadigi icin 0 kalir. */
function zipYap(ad, icerik) {
  const adBuf = Buffer.from(ad, 'latin1')
  const veri = zlib.deflateRawSync(icerik)

  const yerel = Buffer.alloc(30)
  yerel.writeUInt32LE(0x04034b50, 0)
  yerel.writeUInt16LE(20, 4) // gereken surum
  yerel.writeUInt16LE(8, 8) // yontem: deflate
  yerel.writeUInt32LE(veri.length, 18)
  yerel.writeUInt32LE(icerik.length, 22)
  yerel.writeUInt16LE(adBuf.length, 26)

  const merkez = Buffer.alloc(46)
  merkez.writeUInt32LE(0x02014b50, 0)
  merkez.writeUInt16LE(20, 4)
  merkez.writeUInt16LE(20, 6)
  merkez.writeUInt16LE(8, 10)
  merkez.writeUInt32LE(veri.length, 20)
  merkez.writeUInt32LE(icerik.length, 24)
  merkez.writeUInt16LE(adBuf.length, 28)
  merkez.writeUInt32LE(0, 42) // yerel baslik ofseti

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(merkez.length + adBuf.length, 12)
  eocd.writeUInt32LE(yerel.length + adBuf.length + veri.length, 16)

  return Buffer.concat([yerel, adBuf, veri, merkez, adBuf, eocd])
}

/** Iki basamakli sayi metni. */
function ik(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * Bir ay icin sahte tick dosyasi: ayin ilk gunu 12:00 ve ayin SON VERI
 * ANINDAN bir dakika once bir tick. Ikinci tick, ay tamamlandiginda depodaki
 * son barin ay kapanisina 1 saatten yakin olmasini saglar.
 */
function ayCsvi(yil, ay) {
  const sonGun = new Date(Date.UTC(yil, ay, 0)).getUTCDate()
  const haftaninGunu = new Date(Date.UTC(yil, ay - 1, sonGun)).getUTCDay()
  // Cuma 17:00 New York haftalik kapanis; diger gunlerde islem gece yarisini asar.
  let gun = sonGun
  let saat = '235900'
  if (haftaninGunu === 5) {
    saat = '165900'
  } else if (haftaninGunu === 6) {
    gun = sonGun - 1
    saat = '165900'
  }
  return Buffer.from(
    tickSatiri(String(yil) + ik(ay) + '01', '120000', 3900) + '\n' +
    tickSatiri(String(yil) + ik(ay) + ik(gun), saat, 3910) + '\n'
  )
}

/** Sahte indirici: istenen aylari kaydeder, istenirse belirli ayda hata firlatir. */
function sahteIndirici(istenen, hataliAy) {
  return async function (parite, yil, ay) {
    istenen.push(yil + '-' + ik(ay))
    if (ay === hataliAy) throw new Error('sahte ag hatasi')
    return zipYap('DAT_ASCII_' + parite + '_T_' + yil + ik(ay) + '.csv', ayCsvi(yil, ay))
  }
}

// Sabit aralik: 2026 Mayis-Temmuz. Ucu de gecmiste kaldigi icin liste
// testin ne zaman kosturuldugundan bagimsizdir.
const MAYIS_BASI = Date.UTC(2026, 4, 1) / 1000
const TEMMUZ_SONU = Date.UTC(2026, 6, 31, 23, 59, 59) / 1000

test('aylariListele: depodaki son bar ayin kapanisina yakinsa o ay yeniden inmiyor', () => {
  // 31 Temmuz 2026 Cuma; spot altin haftasi Cuma 17:00 New York'ta kapanir,
  // yaz ofsetiyle 21:00 UTC. Depo 21:59'da bitiyorsa Temmuz TAMDIR ve 40-50
  // MB'lik zip'i yeniden indirmek bosa istektir.
  const agustosSonu = Date.UTC(2026, 7, 31, 23, 59) / 1000
  assert.deepEqual(
    histdata._aylariListele(Date.UTC(2026, 6, 31, 21, 59) / 1000, agustosSonu),
    [{ yil: 2026, ay: 8 }],
    'tamamlanmis Temmuz listelenmemeli'
  )
  // Ayin ortasinda biten depoda Temmuz'un eksigi var, listelenmeli.
  assert.deepEqual(
    histdata._aylariListele(Date.UTC(2026, 6, 20, 12) / 1000, agustosSonu),
    [{ yil: 2026, ay: 7 }, { yil: 2026, ay: 8 }]
  )
})

test('onChunk: hata oncesindeki aylar teslim edilir, ikinci calistirmada kalan aydan devam eder', async () => {
  // Neden: 210 aylik indirmede barlar ancak en sonda donuyordu, tek ag hatasi
  // saatlerce inen her seyi cope atiyordu.
  const istenen = []
  const parcalar = []
  const onChunk = async function (s) {
    parcalar.push(s)
  }

  await assert.rejects(
    histdata.fetchCandles({
      tfSec: 60,
      from: MAYIS_BASI,
      to: TEMMUZ_SONU,
      onChunk: onChunk,
      _ayZipiniIndir: sahteIndirici(istenen, 7),
    }),
    /2026-07 indirilemedi/
  )

  assert.deepEqual(istenen, ['2026-05', '2026-06', '2026-07'])
  assert.equal(parcalar.length, 2, 'Temmuz patlasa da Mayis ve Haziran teslim edildi')
  assert.equal(parcalar[0].length, 2)
  assert.equal(parcalar[1].length, 2)
  // Parcalar tamponu paylasmamali: ilk parca ikinci ayin verisiyle ezilmemis.
  assert.equal(parcalar[0].time[0], Date.UTC(2026, 4, 1, 16) / 1000)
  assert.equal(parcalar[1].time[0], Date.UTC(2026, 5, 1, 16) / 1000)

  // Ikinci calistirma: depo Haziran'in son barinda bitiyor.
  const haziranSonBar = parcalar[1].time[parcalar[1].length - 1]
  assert.equal(haziranSonBar, Date.UTC(2026, 6, 1, 3, 59) / 1000, 'Haziran 30 23:59 dosya saati')

  const istenen2 = []
  const parcalar2 = []
  const sonuc = await histdata.fetchCandles({
    tfSec: 60,
    from: haziranSonBar,
    to: TEMMUZ_SONU,
    onChunk: async function (s) {
      parcalar2.push(s)
    },
    _ayZipiniIndir: sahteIndirici(istenen2, 0),
  })

  assert.deepEqual(istenen2, ['2026-07'], 'tamamlanan Mayis ve Haziran yeniden istenmedi')
  assert.equal(parcalar2.length, 1)
  assert.equal(parcalar2[0].length, 2)
  assert.equal(sonuc.length, 0, 'onChunk varken donus degeri bos seri')
})

test('onChunk verilmezse eski davranis: tum aylar tek seride donuyor', async () => {
  const istenen = []
  const seri = await histdata.fetchCandles({
    tfSec: 60,
    from: MAYIS_BASI,
    to: TEMMUZ_SONU,
    _ayZipiniIndir: sahteIndirici(istenen, 0),
  })

  assert.deepEqual(istenen, ['2026-05', '2026-06', '2026-07'])
  assert.equal(seri.length, 6, 'ay basina iki bar, hepsi tek seride')
  for (let i = 1; i < seri.length; i++) {
    assert.ok(seri.time[i] > seri.time[i - 1], 'zaman artan olmali')
  }
})

test('birlestirilemeyen sira disi tick ilerleme mesajinda bildiriliyor', async () => {
  // Gecikme birkac dakikayi asarsa hedef kova tamponun son 5 kovasinda
  // kalmaz; boyle satirlar sessizce yutulmak yerine sayilir.
  const satirlar = []
  for (let dk = 0; dk <= 7; dk++) satirlar.push(tickSatiri('20260515', '12' + ik(dk) + '00', 3900 + dk))
  satirlar.push(tickSatiri('20260515', '120000', 3999))
  const csv = Buffer.from(satirlar.join('\n') + '\n')

  const mesajlar = []
  const seri = await histdata.fetchCandles({
    tfSec: 60,
    from: Date.UTC(2026, 4, 1) / 1000,
    to: Date.UTC(2026, 4, 31, 23, 59, 59) / 1000,
    onProgress: function (pct, msg) {
      mesajlar.push(msg)
    },
    _ayZipiniIndir: async function () {
      return zipYap('DAT_ASCII_XAUUSD_T_202605.csv', csv)
    },
  })

  assert.equal(seri.length, 8)
  assert.equal(seri.volume[0], 1, 'cok geciken tick hicbir kovaya katilmadi')
  assert.ok(
    mesajlar.some(function (m) {
      return /1 sira disi tick/.test(m)
    }),
    'sira disi sayaci ilerleme mesajinda gecmeli: ' + mesajlar.join(' | ')
  )
})
