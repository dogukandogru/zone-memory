'use strict'

/**
 * CSV URETIMI (Y4 cekirdegi)
 *
 * NEDEN: Sistemin iddialari (tur tabani, isabet, net beklenti, kalibrasyon)
 * simdiye kadar yalnizca arayuzden okunabiliyordu ve arayuz testin son 100
 * islemini gosteriyordu. Brut sonuc ve maliyet diske hic yazilmadigi icin
 * kullanici sayilari Excel ya da pandas ile BAGIMSIZ dogrulayamiyordu. Bu
 * modul o dokumun kacis ve bicimlendirme kismidir; dosyaya yazma isi
 * cagiranindir.
 *
 * TASARIM KARARLARI (hepsinin hedefi ayni: hucre Excel/pandas'ta SAYI olarak
 * acilsin, metin olarak degil):
 *
 *   AYRAC VIRGUL, ONDALIK NOKTA. Turkce yerel ayarda tam tersi beklenir ama
 *   hedef bu degil: dosya pandas.read_csv ile ve yabanci yerel ayarli Excel
 *   ile acilacak. Sayilar String(n) ile yazilir, toLocaleString ile DEGIL;
 *   toLocaleString tr-TR altinda 1234.5 sayisini "1.234,5" yapar ve hem
 *   binlik nokta hem ondalik virgul sutunun tamamini metne cevirir.
 *
 *   NAN/NULL/UNDEFINED BOS HUCRE. pandas bos hucreyi NaN okur, "NaN" metnini
 *   ise object dtype'a dusurur. Sonsuzluk da bos birakilir: canli olcumde
 *   Infinity yalnizca sifira bolmeden cikar, yani veri degil hatadir ve tek
 *   bir "Infinity" hucresi o sutunun tamamini metin yapar.
 *
 *   UTF-8 BOM YALNIZCA DOSYANIN BASINDA. BOM olmadan Excel dosyayi Windows
 *   kod sayfasiyla acar ve Turkce basliklar bozulur. Ama BOM gorunmez bir
 *   karakterdir: parca parca yazarken her parcaya konursa satir ortalarinda
 *   birikir ve o alanlar artik sayi olarak ayristirilamaz.
 *
 * SATIR SONU CRLF'dir (RFC 4180). Hem Excel hem pandas ikisini de okur, ama
 * standardin yazdigi budur ve her satir kendi sonuyla biter: boylece parcalar
 * uc uca eklendiginde satirlar birbirine yapismaz.
 */

/** Excel'in UTF-8 anlamasi icin gereken bayt sirasi imi. */
const BOM = '\uFEFF'

/** RFC 4180 satir sonu. */
const CRLF = '\r\n'

/**
 * Varsayilan parca buyuklugu (satir). csvChunks tamponu bu kadar satirda bir
 * bosaltir: cok kucuk secilirse her parca icin ayri bir yazma cagrisi dogar,
 * cok buyuk secilirse parcanin amaci kalmaz.
 */
const PARCA_SATIR = 4096

/**
 * Date'in gecerli araligi (+-8.64e15 ms). Bunun disindaki saniye degerleri
 * toISOString'de RangeError atar; olcum dosyalarinda bozuk zaman damgasi
 * gorulebildigi icin atmak yerine bos hucre veriyoruz.
 */
const ISO_MAX_SN = 8640000000000

/**
 * UNIX saniyeyi ISO 8601 (UTC) metnine cevirir.
 *
 * Kuyruktaki ".000" kirpilir: depodaki mum zamanlari tam saniyedir ve takvim
 * dosyasi da (calendar.js) saniye hassasiyetli ISO kullanir, iki dosya elle
 * karsilastirildiginda ayni bicimde gorunmeleri gerekir.
 *
 * @param {number} sec UNIX saniye
 * @returns {string} Gecersiz degerlerde bos dize
 */
function isoUtc (sec) {
  // Number() null, bos dize ve false degerlerini 0'a, yani 1970-01-01'e
  // dusuruyor. Eksik bir zaman damgasinin dokumde gecerli bir tarih gibi
  // gorunmesi bos hucreden cok daha kotudur: kullanici onu gercek bir islem
  // sanip sayilari ona gore dogrular. Bu yuzden tur acikca suzuluyor.
  const tur = typeof sec
  let s
  if (tur === 'number' || tur === 'bigint') s = Number(sec)
  else if (tur === 'string' && sec.trim() !== '') s = Number(sec)
  else return ''
  if (!Number.isFinite(s) || s > ISO_MAX_SN || s < -ISO_MAX_SN) return ''
  const iso = new Date(s * 1000).toISOString()
  return iso.endsWith('.000Z') ? iso.slice(0, -5) + 'Z' : iso
}

/**
 * Bir degeri hucre metnine cevirir (kacis YOK, yalnizca bicimlendirme).
 * @param {*} value
 * @returns {string}
 */
function hucreMetni (value) {
  if (value === null || value === undefined) return ''
  const tur = typeof value
  // Sayi: String() yerel ayardan bagimsizdir, her zaman nokta ondalik verir.
  if (tur === 'number') return Number.isFinite(value) ? String(value) : ''
  if (tur === 'string') return value
  if (tur === 'boolean') return value ? 'true' : 'false'
  if (tur === 'bigint') return value.toString()
  // Date nesnesi yerel saate gore degil UTC ISO olarak yazilir; aksi halde
  // ayni dosya farkli makinelerde farkli saat gosterir.
  if (value instanceof Date) return isoUtc(value.getTime() / 1000)
  return String(value)
}

/**
 * Kacis gerekip gerekmedigini tek gecisle soyler.
 *
 * Dort ayri indexOf yerine tek dongu: 6 milyon barlik bir dokumde hucre sayisi
 * on milyonlari buluyor, alan basina dort tarama yerine bir tarama yapiliyor.
 *
 * @param {string} text
 * @param {number} sepCode Ayracin karakter kodu
 * @returns {boolean}
 */
function kacisGerekli (text, sepCode) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // 34 = cift tirnak, 13 = CR, 10 = LF
    if (c === 34 || c === 13 || c === 10 || c === sepCode) return true
  }
  return false
}

/**
 * Tek bir alani RFC 4180'e gore kacisli metne cevirir.
 *
 * @param {*} value
 * @param {number} [sepCode] Ayracin karakter kodu (varsayilan virgul)
 * @returns {string}
 */
function csvField (value, sepCode) {
  const kod = sepCode === undefined ? 44 : sepCode
  const metin = hucreMetni(value)
  if (metin === '') return ''
  if (!kacisGerekli(metin, kod)) return metin
  // RFC 4180: alan cift tirnaga alinir, icerideki her cift tirnak ikilenir.
  return '"' + metin.replace(/"/g, '""') + '"'
}

/**
 * Sutun listesini normalize eder.
 *
 * Iki bicim kabul edilir: dize dizisi (`['time','close']`) ve nesne dizisi
 * (`[{key:'time', header:'zaman'}]`). Nesne biciminde istege bagli bir
 * `format(value, row)` alani vardir: hucre metne cevrilmeden once degeri
 * degistirir (ornegin yuvarlama, ya da ayni anahtardan turetilmis bir sutun).
 *
 * Sutunlar ZORUNLUDUR, ilk satirin anahtarlarindan tahmin edilmez: dokumun
 * amaci bagimsiz dogrulama ve sutun sirasi ile basliklarinin satirdan satira
 * ya da surumden surume degismemesi gerekir.
 *
 * @param {Array<string|{key:string, header?:string, format?:Function}>} columns
 * @returns {Array<{key:string, header:string, format:Function|null}>}
 */
function sutunlariCoz (columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('csv: sutun listesi zorunlu (dize dizisi ya da {key, header} dizisi)')
  }
  const cikti = new Array(columns.length)
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i]
    if (typeof c === 'string') {
      cikti[i] = { key: c, header: c, format: null }
      continue
    }
    if (!c || typeof c !== 'object' || c.key === undefined || c.key === null) {
      throw new Error('csv: ' + i + '. sutunda key yok')
    }
    cikti[i] = {
      key: String(c.key),
      header: c.header === undefined || c.header === null ? String(c.key) : String(c.header),
      format: typeof c.format === 'function' ? c.format : null,
    }
  }
  return cikti
}

/**
 * Secenekleri cozer ve dogrular.
 * @param {{bom?:boolean, header?:boolean, separator?:string, eol?:string,
 *          chunkRows?:number}} [options]
 */
function secenekleriCoz (options) {
  const o = options || {}
  const sep = o.separator === undefined ? ',' : String(o.separator)
  if (sep.length !== 1) throw new Error('csv: ayrac tek karakter olmali')
  const kod = sep.charCodeAt(0)
  // Tirnak ve satir sonu ayrac olursa kacis kurali kendi kendini yer.
  if (kod === 34 || kod === 13 || kod === 10) {
    throw new Error('csv: ayrac tirnak ya da satir sonu olamaz')
  }
  const parcaSatir = Math.max(1, Math.floor(Number(o.chunkRows) || PARCA_SATIR))
  return {
    bom: o.bom !== false,
    header: o.header !== false,
    sep: sep,
    sepCode: kod,
    eol: o.eol === undefined ? CRLF : String(o.eol),
    parcaSatir: parcaSatir,
  }
}

/**
 * Tek bir satiri kacisli CSV satirina cevirir.
 * @returns {string} Satir sonu YOK
 */
function satiriYaz (row, cols, sep, sepCode) {
  let cikti = ''
  for (let i = 0; i < cols.length; i++) {
    if (i > 0) cikti += sep
    const c = cols[i]
    // Satirda anahtar yoksa deger undefined kalir ve bos hucre olur: eksik
    // alan yuzunden sutunlarin kaymasi, dokumu sessizce ise yaramaz yapar.
    let v = row === null || row === undefined ? undefined : row[c.key]
    if (c.format !== null) v = c.format(v, row)
    cikti += csvField(v, sepCode)
  }
  return cikti
}

/**
 * CSV'yi PARCA PARCA uretir (jenerator).
 *
 * NEDEN (olculdu, 7 sutunlu islem dokumu, 1 milyon satir):
 *   toCsv      933 ms, tepe heap +216 MB, tek dizede 66,3 milyon karakter
 *   csvChunks  813 ms, tepe heap  +40 MB, diske 63,3 MB
 * Ikisi ayni dosyayi uretir, fark bellektedir: toCsv butun dosyayi TEK bir
 * dize olarak tutmak zorunda. V8'de bir dizenin ust siniri 536,9 milyon
 * karakter, yani bu bicimde yaklasik 8 milyon satir; depo 6 milyon barlik 1
 * dakikalik seri tutuyor ve tavan hemen ustunde. Bu yuzden buyuk dokumler bu
 * jenerator ile diske akitilir: parcalar arasinda bellekte duran sey yalnizca
 * `chunkRows` kadar satirdir.
 *
 * BOM ve baslik YALNIZCA ILK PARCADA verilir; her parcaya konsa dosyanin
 * ortasinda gorunmez karakterler ve tekrar eden basliklar olusurdu.
 *
 * @param {Iterable<Object>} rows Dizi ya da herhangi bir gezilebilir
 * @param {Array<string|{key:string, header?:string, format?:Function}>} columns
 * @param {{bom?:boolean, header?:boolean, separator?:string, eol?:string,
 *          chunkRows?:number}} [options]
 * @yields {string}
 */
function * csvChunks (rows, columns, options) {
  const cols = sutunlariCoz(columns)
  const ops = secenekleriCoz(options)

  let bas = ops.bom ? BOM : ''
  if (ops.header) {
    // Baslik da kacistan gecer: icinde virgul olan bir baslik sutunlari kaydirir.
    for (let i = 0; i < cols.length; i++) {
      if (i > 0) bas += ops.sep
      bas += csvField(cols[i].header, ops.sepCode)
    }
    bas += ops.eol
  }
  if (bas !== '') yield bas

  if (rows === null || rows === undefined) return

  // Satirlar tek tek uretilip tamponda toplanir, join ile birlestirilir:
  // dize uzerinde tekrarli `+=` yerine join, ara dizeleri biriktirmedigi icin
  // buyuk dokumde tepe bellegi dusuk tutar.
  const tampon = []
  for (const row of rows) {
    tampon.push(satiriYaz(row, cols, ops.sep, ops.sepCode))
    if (tampon.length >= ops.parcaSatir) {
      yield tampon.join(ops.eol) + ops.eol
      tampon.length = 0
    }
  }
  if (tampon.length > 0) yield tampon.join(ops.eol) + ops.eol
}

/**
 * Satirlari tek bir CSV metnine cevirir.
 *
 * Kucuk ve orta boy raporlar icindir (test ozeti, bolge listesi, kalibrasyon
 * kovalari). Milyonlarca satirlik dokumler icin csvChunks kullanilmalidir,
 * bkz. oradaki dize siniri notu.
 *
 * @param {Iterable<Object>} rows
 * @param {Array<string|{key:string, header?:string, format?:Function}>} columns
 * @param {{bom?:boolean, header?:boolean, separator?:string, eol?:string,
 *          chunkRows?:number}} [options]
 * @returns {string}
 */
function toCsv (rows, columns, options) {
  const parcalar = []
  for (const parca of csvChunks(rows, columns, options)) parcalar.push(parca)
  return parcalar.join('')
}

/**
 * Bir zaman anahtari icin iki sutun uretir: ham UNIX saniye ve yanindaki
 * ISO 8601 (UTC) karsiligi.
 *
 * NEDEN IKISI BIRDEN: ham saniye makine icin (sirala, cikar, esle), ISO metni
 * insan icin. Excel'de UNIX saniyeyi tarihe cevirmek elle formul ister;
 * yalnizca ISO yazilsa da iki satir arasindaki fark saniye cinsinden
 * hesaplanamaz hale gelir.
 *
 * Kullanimi ZORUNLU DEGILDIR, yalnizca sutun listesini kisaltir:
 *   const cols = [...zamanSutunlari('time'), 'close']
 *
 * @param {string} [key] Satirdaki anahtar (varsayilan 'time')
 * @param {string} [header] Baslik onu (varsayilan anahtarin kendisi)
 * @returns {Array<{key:string, header:string, format?:Function}>}
 */
function zamanSutunlari (key, header) {
  const k = key === undefined || key === null ? 'time' : String(key)
  const h = header === undefined || header === null ? k : String(header)
  return [
    { key: k, header: h },
    // Ikinci sutun AYNI anahtari okur, yalnizca bicimi farklidir: satirda
    // ayrica bir timeUtc alani tutmak, iki alanin birbirinden kaymasi riskini
    // getirirdi.
    { key: k, header: h + 'Utc', format: isoUtc },
  ]
}

module.exports = {
  BOM,
  CRLF,
  isoUtc,
  csvField,
  csvChunks,
  toCsv,
  zamanSutunlari,
}
