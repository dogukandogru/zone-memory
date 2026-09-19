'use strict'

// Y4 - src/core/csv.js testleri.
//
// Bu dosyanin kilitledigi sey tek cumleyle: URETILEN DOSYA, BASKA BIR PROGRAM
// TARAFINDAN OKUNDUGUNDA ICERI GIRENLE AYNI OLMALI. Dokumun tum amaci
// kullanicinin tur tabani, isabet ve net beklenti sayilarini Excel ya da
// pandas ile bagimsiz dogrulayabilmesi; sessizce kayan bir sutun ya da metne
// donmus bir sayi sutunu, dokumu hic olmamasindan daha kotu yapar, cunku
// yanlis sonuc "dogrulanmis" gorunur.
//
// Uc kilit ayrica tek tek sinaniyor:
//   1. KACIS: tirnak, virgul ve satir sonu iceren alanlar ayristirildiginda
//      geri ayni degeri vermeli (asagida kucuk bir RFC 4180 okuyucu var).
//   2. BOS HUCRE: NaN/null/undefined bos kalmali; "NaN" metni pandas'ta
//      sutunun tamamini object dtype'a dusurur.
//   3. BOM: yalnizca dosyanin basinda, bir kez. Gorunmez oldugu icin satir
//      ortasina kacan bir BOM'u kullanici ekranda goremez, yalnizca sayinin
//      neden metin sayildigini anlayamaz.

const test = require('node:test')
const assert = require('node:assert/strict')

const csv = require('../src/core/csv')

/**
 * Kucuk RFC 4180 okuyucu (yalnizca test icin).
 *
 * Uretilen metni kendi kacis kodumuzla degil, BAGIMSIZ bir ayristiriciyla
 * geri okumak icin var: kacis ile okuma ayni hatayi paylasirsa test hicbir
 * sey kanitlamaz.
 *
 * @param {string} text
 * @param {string} [sep]
 * @returns {string[][]}
 */
function csvAyristir (text, sep) {
  const ayrac = sep === undefined ? ',' : sep
  const satirlar = []
  let alanlar = []
  let alan = ''
  let tirnakta = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (tirnakta) {
      if (ch === '"') {
        if (text[i + 1] === '"') { alan += '"'; i += 2; continue }
        tirnakta = false
        i++
        continue
      }
      alan += ch
      i++
      continue
    }
    if (ch === '"') { tirnakta = true; i++; continue }
    if (ch === ayrac) { alanlar.push(alan); alan = ''; i++; continue }
    if (ch === '\r' && text[i + 1] === '\n') {
      alanlar.push(alan); satirlar.push(alanlar); alanlar = []; alan = ''; i += 2
      continue
    }
    if (ch === '\n') {
      alanlar.push(alan); satirlar.push(alanlar); alanlar = []; alan = ''; i++
      continue
    }
    alan += ch
    i++
  }
  // Son satir sonu bos bir kayit uretmemeli.
  if (alan !== '' || alanlar.length > 0) { alanlar.push(alan); satirlar.push(alanlar) }
  return satirlar
}

/** BOM'u atip ham govdeyi dondurur (ayristirma oncesi). */
function bomsuz (metin) {
  return metin.startsWith(csv.BOM) ? metin.slice(csv.BOM.length) : metin
}

test('kacis: tirnak, virgul ve satir sonu iceren alan geri okundugunda AYNI degeri verir', () => {
  const satirlar = [
    { not: 'virgul, icerir' },
    { not: 'tirnak "icerir"' },
    { not: 'iki\nsatir' },
    { not: 'CRLF\r\nvar' },
    { not: 'hepsi: "a", b\nc' },
  ]
  const metin = csv.toCsv(satirlar, [{ key: 'not', header: 'not' }])

  // Kacisin kendisi: virgullu alan tirnakli, icerideki tirnaklar ikilenmis.
  assert.ok(metin.includes('"virgul, icerir"'), 'virgullu alan tirnaklanmali')
  assert.ok(metin.includes('"tirnak ""icerir"""'), 'tirnak ikilenmeli: ' + metin)

  // Asil kilit: bagimsiz okuyucu ayni degerleri geri vermeli.
  const okunan = csvAyristir(bomsuz(metin))
  assert.deepEqual(okunan[0], ['not'])
  assert.equal(okunan.length, satirlar.length + 1, 'satir sonu iceren alan satiri bolmemeli')
  for (let i = 0; i < satirlar.length; i++) {
    assert.deepEqual(okunan[i + 1], [satirlar[i].not], i + '. satir geri okunamadi')
  }
})

test('kacis gerekmeyen alan tirnaklanmaz (dosya gereksiz sismesin)', () => {
  const metin = bomsuz(csv.toCsv([{ a: 'duz metin', b: 12.5 }], ['a', 'b']))
  assert.equal(metin, 'a,b\r\nduz metin,12.5\r\n')
})

test('NaN, null, undefined ve sonsuzluk BOS HUCRE olur', () => {
  const satir = { a: NaN, b: null, c: undefined, d: Infinity, e: -Infinity, f: 0 }
  const metin = bomsuz(csv.toCsv([satir], ['a', 'b', 'c', 'd', 'e', 'f']))
  const okunan = csvAyristir(metin)
  // Sifir bos hucre DEGILDIR: eksik olcumle sifir olcum karisirsa net beklenti
  // hesabi sessizce degisir.
  assert.deepEqual(okunan[1], ['', '', '', '', '', '0'])
  assert.equal(metin, 'a,b,c,d,e,f\r\n,,,,,0\r\n')
})

test('BOM yalnizca dosyanin basinda, bir kez bulunur', () => {
  const satirlar = [{ a: 1 }, { a: 2 }, { a: 3 }]
  const metin = csv.toCsv(satirlar, ['a'])
  assert.equal(metin.indexOf(csv.BOM), 0, 'dosya BOM ile baslamali')
  assert.equal(metin.lastIndexOf(csv.BOM), 0, 'BOM yalnizca bir kez olmali')
  assert.equal(metin.split(csv.BOM).length - 1, 1)

  // Kapatilabilir olmali: parcali yazmada ilk parca disinda BOM istenmez.
  const bomsuzMetin = csv.toCsv(satirlar, ['a'], { bom: false })
  assert.ok(!bomsuzMetin.includes(csv.BOM))
  assert.ok(bomsuzMetin.startsWith('a\r\n'))
})

test('sayilar NOKTA ondalikla yazilir, Turkce virgulle DEGIL', () => {
  const satir = { fiyat: 1234.5, oran: 0.125, eksi: -0.75, buyuk: 2412345.678 }
  const metin = bomsuz(csv.toCsv([satir], ['fiyat', 'oran', 'eksi', 'buyuk']))
  const okunan = csvAyristir(metin)
  assert.deepEqual(okunan[1], ['1234.5', '0.125', '-0.75', '2412345.678'])
  // toLocaleString('tr-TR') kullanilsaydi "1.234,5" cikardi: binlik ayraci
  // hem ondalik noktayi bozar hem de sutunu ikiye boler.
  assert.ok(!metin.includes('1.234,5'))
  assert.ok(!metin.includes('2.412.345'))
})

test('bos satir dizisinde yalnizca baslik satiri cikar', () => {
  const metin = csv.toCsv([], [{ key: 'time', header: 'zaman' }, 'close'])
  assert.equal(metin, csv.BOM + 'zaman,close\r\n')
  const okunan = csvAyristir(bomsuz(metin))
  assert.equal(okunan.length, 1, 'yalnizca baslik satiri olmali')

  // null/undefined satir listesi de cokmemeli: cagiran taraf bos sonucu
  // bazen null olarak veriyor.
  assert.equal(csv.toCsv(null, ['a']), csv.BOM + 'a\r\n')
  assert.equal(csv.toCsv(undefined, ['a']), csv.BOM + 'a\r\n')
})

test('sutun sirasi verilen listeye uyar, satirin anahtar sirasina DEGIL', () => {
  // Satirda anahtar sirasi bilerek ters: nesne anahtar sirasina guvenilirse
  // sutunlar surumden surume yer degistirir.
  const satirlar = [{ close: 2400.5, time: 1700000000, high: 2401 }]
  const metin = bomsuz(csv.toCsv(satirlar, ['time', 'high', 'close']))
  const okunan = csvAyristir(metin)
  assert.deepEqual(okunan[0], ['time', 'high', 'close'])
  assert.deepEqual(okunan[1], ['1700000000', '2401', '2400.5'])
})

test('sutunlar dize dizisi ya da {key, header} nesnesi olarak verilebilir', () => {
  const satirlar = [{ time: 1700000000, net: -1.25 }]
  const dizeyle = bomsuz(csv.toCsv(satirlar, ['time', 'net']))
  const nesneyle = bomsuz(csv.toCsv(satirlar, [
    { key: 'time' },
    { key: 'net', header: 'net beklenti (R)' },
  ]))
  assert.equal(dizeyle, 'time,net\r\n1700000000,-1.25\r\n')
  // header verilmezse anahtarin kendisi baslik olur.
  assert.equal(nesneyle, 'time,net beklenti (R)\r\n1700000000,-1.25\r\n')
})

test('satirda olmayan anahtar sutunlari KAYDIRMAZ, bos hucre birakir', () => {
  const satirlar = [
    { a: 1, b: 2, c: 3 },
    { a: 4, c: 6 },
    {},
  ]
  const okunan = csvAyristir(bomsuz(csv.toCsv(satirlar, ['a', 'b', 'c'])))
  assert.deepEqual(okunan[1], ['1', '2', '3'])
  assert.deepEqual(okunan[2], ['4', '', '6'], 'eksik alan yerinde bos kalmali')
  assert.deepEqual(okunan[3], ['', '', ''])
})

test('baslikta virgul ya da tirnak varsa baslik da kacisli yazilir', () => {
  const metin = bomsuz(csv.toCsv([], [
    { key: 'a', header: 'isabet, %' },
    { key: 'b', header: 'esik "R"' },
  ]))
  assert.equal(metin, '"isabet, %","esik ""R"""\r\n')
  assert.deepEqual(csvAyristir(metin)[0], ['isabet, %', 'esik "R"'])
})

test('satir sonu CRLF ve her satir kendi sonuyla biter', () => {
  const metin = bomsuz(csv.toCsv([{ a: 1 }, { a: 2 }], ['a']))
  assert.equal(metin, 'a\r\n1\r\n2\r\n')
  // Tek basina LF kalmamali (yalnizca CRLF'in parcasi olarak).
  const lfSayisi = metin.split('\n').length - 1
  const crlfSayisi = metin.split('\r\n').length - 1
  assert.equal(lfSayisi, crlfSayisi, 'ciplak LF olmamali')
})

test('format: deger metne cevrilmeden once sutuna ozel bicimden gecer', () => {
  const satirlar = [{ oran: 0.1 + 0.2, sayac: 3 }]
  const metin = bomsuz(csv.toCsv(satirlar, [
    // Kayan nokta gurultusu (0.30000000000000004) hucrede gorunmesin diye.
    { key: 'oran', header: 'oran', format: (v) => Number(v.toFixed(4)) },
    { key: 'sayac', header: 'sayac' },
  ]))
  assert.equal(metin, 'oran,sayac\r\n0.3,3\r\n')
})

test('format NaN dondururse hucre yine bos kalir', () => {
  const metin = bomsuz(csv.toCsv([{ a: 5 }], [
    { key: 'a', header: 'a', format: () => NaN },
  ]))
  assert.equal(metin, 'a\r\n\r\n')
})

test('ayrac degistirilebilir ve kacis YENI ayraca gore yapilir', () => {
  // Turkce yerel ayarli Excel virgulu ayrac saymaz; varsayilani degistirmeden
  // cagiranin noktali virgule gecebilmesi gerekiyor.
  const metin = bomsuz(csv.toCsv(
    [{ a: 'x;y', b: 'p,q' }],
    ['a', 'b'],
    { separator: ';' },
  ))
  // Noktali virgullu alan tirnakli, virgullu alan artik tirnaksiz.
  assert.equal(metin, 'a;b\r\n"x;y";p,q\r\n')
  assert.deepEqual(csvAyristir(metin, ';')[1], ['x;y', 'p,q'])
})

test('sutun listesi zorunludur, bozuk sutun sessizce gecmez', () => {
  assert.throws(() => csv.toCsv([{ a: 1 }]), /sutun listesi zorunlu/)
  assert.throws(() => csv.toCsv([{ a: 1 }], []), /sutun listesi zorunlu/)
  assert.throws(() => csv.toCsv([{ a: 1 }], [{ header: 'baslik' }]), /key yok/)
  assert.throws(() => csv.toCsv([{ a: 1 }], ['a'], { separator: ',,' }), /tek karakter/)
  assert.throws(() => csv.toCsv([{ a: 1 }], ['a'], { separator: '"' }), /tirnak ya da satir sonu/)
})

test('isoUtc: tam saniyede .000 kuyrugu yazilmaz, gecersiz zaman bos doner', () => {
  // calendar.js ile ayni bicim: 2024-07-05T12:30:00Z
  assert.equal(csv.isoUtc(1700000000), '2023-11-14T22:13:20Z')
  assert.equal(csv.isoUtc(0), '1970-01-01T00:00:00Z')
  assert.equal(csv.isoUtc(NaN), '')
  assert.equal(csv.isoUtc(Infinity), '')
  // Number(null), Number('') ve Number(false) sifira, yani 1970-01-01'e duser.
  // Eksik zaman damgasi bos kalmali, uydurma bir tarih olmamali: dokumde
  // 1970 yazan bir satiri kullanici gercek bir islem sanir.
  assert.equal(csv.isoUtc(null), '')
  assert.equal(csv.isoUtc(undefined), '')
  assert.equal(csv.isoUtc(''), '')
  assert.equal(csv.isoUtc('   '), '')
  assert.equal(csv.isoUtc(false), '')
  assert.equal(csv.isoUtc({}), '')
  // Dizeye donmus saniye (JSON'dan gelen kayit) yine de okunur.
  assert.equal(csv.isoUtc('1700000000'), '2023-11-14T22:13:20Z')
  // Date araligini asan deger RangeError atmamali, bos donmeli.
  assert.equal(csv.isoUtc(1e15), '')
})

test('zamanSutunlari: ham saniye ve ISO karsiligi YAN YANA uretilir', () => {
  const cols = [...csv.zamanSutunlari('time'), 'close']
  const metin = bomsuz(csv.toCsv([{ time: 1700000000, close: 1980.25 }], cols))
  const okunan = csvAyristir(metin)
  assert.deepEqual(okunan[0], ['time', 'timeUtc', 'close'])
  // Ham saniye makine icin, ISO insan icin: ikisi de ayni alandan turer, bu
  // yuzden birbirinden kayamaz.
  assert.deepEqual(okunan[1], ['1700000000', '2023-11-14T22:13:20Z', '1980.25'])
})

test('zamanSutunlari: anahtar adi degisince baslik oneki de degisir', () => {
  const cols = csv.zamanSutunlari('entryTime')
  assert.deepEqual(cols.map((c) => c.header), ['entryTime', 'entryTimeUtc'])
  const okunan = csvAyristir(bomsuz(csv.toCsv([{ entryTime: 0 }], cols)))
  assert.deepEqual(okunan[1], ['0', '1970-01-01T00:00:00Z'])
  // Zaman alani eksik ya da bozuksa ISO sutunu da bos kalir.
  // Zaman alani eksik ya da null ise ISO sutunu da bos kalir, 1970 yazmaz.
  const bosOkunan = csvAyristir(bomsuz(csv.toCsv([{}, { entryTime: null }], cols)))
  assert.deepEqual(bosOkunan[1], ['', ''])
  assert.deepEqual(bosOkunan[2], ['', ''])
})

test('Date nesnesi yerel saatle degil UTC ISO olarak yazilir', () => {
  const d = new Date('2024-07-05T12:30:00Z')
  const okunan = csvAyristir(bomsuz(csv.toCsv([{ d: d }], ['d'])))
  assert.deepEqual(okunan[1], ['2024-07-05T12:30:00Z'])
  // Gecersiz Date bos hucre.
  const bozuk = csvAyristir(bomsuz(csv.toCsv([{ d: new Date('olmaz') }, { d: 1 }], ['d'])))
  assert.deepEqual(bozuk[1], [''])
  // Bos satir yutulmamali: sonraki satir hala yerinde olmali.
  assert.deepEqual(bozuk[2], ['1'])
})

test('csvChunks: parcalar birlestirilince toCsv ile BIREBIR ayni cikar', () => {
  const satirlar = []
  for (let i = 0; i < 2500; i++) satirlar.push({ i: i, not: i % 7 === 0 ? 'a,b' : 'x' })
  const cols = ['i', 'not']

  const parcalar = [...csv.csvChunks(satirlar, cols, { chunkRows: 1000 })]
  assert.equal(parcalar.join(''), csv.toCsv(satirlar, cols))

  // 1 baslik parcasi + ceil(2500/1000) = 3 govde parcasi.
  assert.equal(parcalar.length, 4)
  // BOM ve baslik yalnizca ilk parcada: her parcaya konsa dosyanin ortasinda
  // gorunmez karakter ve tekrar eden baslik olurdu.
  assert.ok(parcalar[0].startsWith(csv.BOM))
  for (let i = 1; i < parcalar.length; i++) {
    assert.ok(!parcalar[i].includes(csv.BOM), i + '. parcada BOM olmamali')
    assert.ok(!parcalar[i].includes('i,not'), i + '. parcada baslik olmamali')
  }
  // Her parca satir sonuyla biter, yani uc uca eklenince satirlar yapismaz.
  for (const parca of parcalar) assert.ok(parca.endsWith('\r\n'))
})

test('csvChunks satirlari SIRAYLA ve TEK TEK tuketir (bellek icin)', () => {
  // Jeneratörden beslenmek, milyonlarca satiri once diziye toplamadan
  // yazabilmenin sarti: dizi yerine gezilebilir de kabul edilmeli.
  let uretilen = 0
  function * uret (n) {
    for (let i = 0; i < n; i++) { uretilen++; yield { i: i } }
  }
  const parcalar = [...csv.csvChunks(uret(5), ['i'], { chunkRows: 2 })]
  assert.equal(uretilen, 5)
  const okunan = csvAyristir(bomsuz(parcalar.join('')))
  assert.equal(okunan.length, 6)
  assert.deepEqual(okunan.slice(1).map((s) => s[0]), ['0', '1', '2', '3', '4'])
})

test('6 sutunlu 20 bin satirlik dokum tam olarak geri okunur', () => {
  // Gercek dokume yakin bir bicim uzerinde ucdan uca kilit: sayilar, metinler,
  // eksik olcumler ve kacis gerektiren etiketler bir arada.
  const satirlar = new Array(20000)
  for (let i = 0; i < satirlar.length; i++) {
    satirlar[i] = {
      time: 1700000000 + i * 60,
      yon: i % 2 === 0 ? 'long' : 'short',
      giris: 2400 + i * 0.01,
      sonucR: i % 5 === 0 ? NaN : (i % 3) - 1 + 0.25,
      maliyetR: 0.08,
      etiket: i % 11 === 0 ? 'seans "Asia", veri ±30 dk' : 'normal',
    }
  }
  const cols = [
    ...csv.zamanSutunlari('time'),
    'yon', 'giris', 'sonucR', 'maliyetR', 'etiket',
  ]
  const metin = csv.toCsv(satirlar, cols)
  const okunan = csvAyristir(bomsuz(metin))

  assert.equal(okunan.length, satirlar.length + 1)
  assert.equal(okunan[0].length, 7)
  for (let i = 0; i < satirlar.length; i += 997) {
    const s = satirlar[i]
    const r = okunan[i + 1]
    assert.equal(r.length, 7, i + '. satirda sutun sayisi kaymis')
    assert.equal(r[0], String(s.time))
    assert.equal(r[1], csv.isoUtc(s.time))
    assert.equal(r[2], s.yon)
    assert.equal(Number(r[3]), s.giris)
    assert.equal(r[4], Number.isNaN(s.sonucR) ? '' : String(s.sonucR))
    assert.equal(r[6], s.etiket)
  }
})
