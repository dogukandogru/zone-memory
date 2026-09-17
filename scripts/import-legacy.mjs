// Eski projedeki (indicator2) TimescaleDB'den mumlari yeni ikili depoya aktarir.
//
// Calisan Docker konteynerinde psql calistirilir ve COPY ... TO STDOUT ciktisi
// AKIS halinde ayristirilir. 6 milyondan fazla satir geldigi icin cikti asla
// tek parca string olarak biriktirilmez: her parca satir satir islenir ve
// degerler buyuyen Float64Array tamponlarina yazilir (kapasite dolunca iki
// katina cikar).
//
// Kullanim:
//   node scripts/import-legacy.mjs
//   node scripts/import-legacy.mjs --tf 1m --container indicator2-db-1
//   node scripts/import-legacy.mjs --out /yol/XAUUSD_1m.bin --limit 100000
//   node scripts/import-legacy.mjs --no-resample
//
// Varsayilan hedef:
//   macOS   ~/Library/Application Support/Zone Memory/data/XAUUSD_1m.bin
//   Windows %APPDATA%/Zone Memory/data/XAUUSD_1m.bin
//
// UZERINE YAZMA KORUMASI: hedef dosyalardan biri zaten varsa betik hic is
// yapmadan durur. --force verilirse her hedef once '<ad>.bak-<damga>' olarak
// yedeklenir. --limit verilip --out verilmezse (deneme aktarimi) hedef gecici
// klasordur, yani gercek depoya asla dokunulmaz.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dataDir, ensureDataDir, DEFAULT_SYMBOL } from './userdata-path.mjs'

// Cekirdek moduller CommonJS oldugu icin createRequire ile yuklenir.
const require = createRequire(import.meta.url)
const binstore = require('../src/core/store/binstore.js')
const seriler = require('../src/core/series.js')
const { tfSeconds, tfLabel, TURETILEN_TF } = require('../src/core/tf.js')
const yollar = require('../src/core/paths-core.js')
const {
  argumanlariAyristir,
  sayiBicim,
  zamanBicim,
  sureBicim,
  damga,
  bildir,
} = require('../src/core/util/cli.js')

/** Deneme aktariminin yazildigi gecici klasorun adi. */
const DENEME_KLASORU = 'zone-memory-deneme'

/** Ilerleme kac satirda bir bildirilsin. */
const ILERLEME_ADIMI = 250000

/** Satir sayisi bilinmiyorsa baslangic tampon kapasitesi. */
const BASLANGIC_KAPASITE = 1 << 20

/* ------------------------------------------------------------------ */
/* Kucuk yardimcilar                                                    */
/* ------------------------------------------------------------------ */
/* Arguman ayristirma ve bicimleme src/core/util/cli.js icindedir.      */

/** Float64Array kapasitesini en az `gerekli` olacak sekilde buyutur. */
const buyut = seriler.growF64

/* ------------------------------------------------------------------ */
/* Docker / psql                                                        */
/* ------------------------------------------------------------------ */

/**
 * Bir komutu calistirir ve ciktisini toplar. Buyuk cikti beklenen yerlerde
 * KULLANILMAZ; yalnizca kucuk kontrol komutlari icindir.
 * @param {string} komut
 * @param {string[]} args
 * @returns {Promise<{kod:number, cikti:string, hata:string, calismadi:boolean}>}
 */
function komutCalistir(komut, args) {
  return new Promise(function (resolve) {
    let cikti = ''
    let hata = ''
    let cocuk
    try {
      cocuk = spawn(komut, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ kod: -1, cikti: '', hata: String(err && err.message), calismadi: true })
      return
    }
    cocuk.stdout.on('data', function (p) {
      cikti += p.toString('utf8')
    })
    cocuk.stderr.on('data', function (p) {
      hata += p.toString('utf8')
    })
    cocuk.on('error', function (err) {
      resolve({
        kod: -1,
        cikti: cikti,
        hata: String(err && err.message),
        calismadi: err && err.code === 'ENOENT',
      })
    })
    cocuk.on('close', function (kod) {
      resolve({ kod: kod === null ? -1 : kod, cikti: cikti, hata: hata, calismadi: false })
    })
  })
}

/**
 * Docker'in kurulu ve konteynerin calisir durumda oldugunu dogrular.
 * Sorun varsa anlamli Turkce hata firlatir.
 * @param {string} konteyner
 */
async function konteyneriDogrula(konteyner) {
  const sonuc = await komutCalistir('docker', [
    'inspect',
    '-f',
    '{{.State.Running}}',
    konteyner,
  ])
  if (sonuc.calismadi) {
    throw new Error(
      'Docker komutu bulunamadi. Docker Desktop kurulu ve calisiyor olmali. ' +
        'Kurulu degilse eski verileri aktaramazsiniz; bunun yerine ' +
        'npm run fetch-history ile gecmisi internetten indirebilirsiniz.'
    )
  }
  if (sonuc.kod !== 0) {
    const ipucu = /No such object|no such container/i.test(sonuc.hata)
      ? '"' + konteyner + '" adinda bir konteyner yok. Once eski projeyi ayaga kaldirin: ' +
        'cd ../indicator2 && docker compose up -d db'
      : sonuc.hata.trim() || 'docker inspect basarisiz oldu'
    throw new Error('Docker konteyneri bulunamadi. ' + ipucu)
  }
  if (sonuc.cikti.trim() !== 'true') {
    throw new Error(
      '"' + konteyner + '" konteyneri kurulu ama calismiyor. Baslatmak icin: ' +
        'docker start ' + konteyner
    )
  }
}

/**
 * Aktarilacak satir sayisini onceden ogrenir. Boylece tampon tek seferde
 * dogru boyutta ayrilir. Basarisiz olursa 0 doner (tampon buyuyerek ilerler).
 * @param {{konteyner:string, kullanici:string, veritabani:string, tf:string, limit:number}} o
 * @returns {Promise<number>}
 */
async function satirSayisiniOgren(o) {
  const sql =
    "SELECT count(*) FROM candles WHERE timeframe='" + o.tf.replace(/'/g, "''") + "'"
  const sonuc = await komutCalistir('docker', [
    'exec',
    o.konteyner,
    'psql',
    '-U',
    o.kullanici,
    '-d',
    o.veritabani,
    '-At',
    '-c',
    sql,
  ])
  if (sonuc.kod !== 0) return 0
  const n = Number(sonuc.cikti.trim())
  if (!Number.isFinite(n) || n <= 0) return 0
  if (o.limit > 0 && o.limit < n) return o.limit
  return n
}

/* ------------------------------------------------------------------ */
/* Akis halinde CSV ayristirma                                          */
/* ------------------------------------------------------------------ */

/**
 * psql'i calistirir, COPY ciktisini satir satir okur ve seriyi kurar.
 * @param {{konteyner:string, kullanici:string, veritabani:string, tf:string,
 *          limit:number, kapasite:number}} o
 * @returns {Promise<{seri:object, okunan:number, atlanan:number}>}
 */
function mumlariAktar(o) {
  const secim =
    'SELECT extract(epoch from ts)::bigint, open, high, low, close, volume ' +
    "FROM candles WHERE timeframe='" + o.tf.replace(/'/g, "''") + "' ORDER BY ts" +
    (o.limit > 0 ? ' LIMIT ' + o.limit : '')
  const sql = 'COPY (' + secim + ') TO STDOUT WITH CSV'

  const args = [
    'exec',
    o.konteyner,
    'psql',
    '-U',
    o.kullanici,
    '-d',
    o.veritabani,
    '-At',
    '-F',
    ',',
    '-c',
    sql,
  ]

  return new Promise(function (resolve, reject) {
    const baslangic = Date.now()
    let kapasite = o.kapasite > 0 ? o.kapasite : BASLANGIC_KAPASITE

    let zaman = new Float64Array(kapasite)
    let acilis = new Float64Array(kapasite)
    let yuksek = new Float64Array(kapasite)
    let dusuk = new Float64Array(kapasite)
    let kapanis = new Float64Array(kapasite)
    let hacim = new Float64Array(kapasite)

    let n = 0
    let okunan = 0
    let atlanan = 0
    let sonZaman = -Infinity
    let sonrakiIlerleme = ILERLEME_ADIMI
    let kuyruk = ''
    let hataMetni = ''

    // Tek satiri ayristirip tamponlara yazar.
    function satirIsle(metin, bas, son) {
      okunan++
      let p = bas
      let v1 = metin.indexOf(',', p)
      if (v1 < 0 || v1 > son) {
        atlanan++
        return
      }
      const t = Number(metin.slice(p, v1))
      p = v1 + 1
      v1 = metin.indexOf(',', p)
      if (v1 < 0 || v1 > son) {
        atlanan++
        return
      }
      const a = Number(metin.slice(p, v1))
      p = v1 + 1
      v1 = metin.indexOf(',', p)
      if (v1 < 0 || v1 > son) {
        atlanan++
        return
      }
      const y = Number(metin.slice(p, v1))
      p = v1 + 1
      v1 = metin.indexOf(',', p)
      if (v1 < 0 || v1 > son) {
        atlanan++
        return
      }
      const d = Number(metin.slice(p, v1))
      p = v1 + 1
      v1 = metin.indexOf(',', p)
      if (v1 < 0 || v1 > son) {
        atlanan++
        return
      }
      const k = Number(metin.slice(p, v1))
      p = v1 + 1
      let hamHacim = Number(metin.slice(p, son))

      if (
        !Number.isFinite(t) ||
        !Number.isFinite(a) ||
        !Number.isFinite(y) ||
        !Number.isFinite(d) ||
        !Number.isFinite(k) ||
        t <= sonZaman
      ) {
        // Bozuk satir veya tekrar eden zaman damgasi atlanir.
        atlanan++
        return
      }
      if (!Number.isFinite(hamHacim)) hamHacim = 0

      if (n === zaman.length) {
        const gerekli = n + 1
        zaman = buyut(zaman, gerekli)
        acilis = buyut(acilis, gerekli)
        yuksek = buyut(yuksek, gerekli)
        dusuk = buyut(dusuk, gerekli)
        kapanis = buyut(kapanis, gerekli)
        hacim = buyut(hacim, gerekli)
      }

      zaman[n] = t
      acilis[n] = a
      yuksek[n] = y
      dusuk[n] = d
      kapanis[n] = k
      hacim[n] = hamHacim
      n++
      sonZaman = t

      if (n >= sonrakiIlerleme) {
        sonrakiIlerleme += ILERLEME_ADIMI
        const gecen = Date.now() - baslangic
        const hiz = gecen > 0 ? Math.round(n / (gecen / 1000)) : 0
        bildir(
          '  ' + sayiBicim(n) + ' satir islendi (' + sureBicim(gecen) + ', ' +
            sayiBicim(hiz) + ' satir/sn)'
        )
      }
    }

    let cocuk
    try {
      cocuk = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new Error('Docker calistirilamadi: ' + String(err && err.message)))
      return
    }

    cocuk.stdout.on('data', function (parca) {
      // Veri saf ASCII sayilardan olustugu icin latin1 cozumu guvenli ve hizli.
      const metin = kuyruk + parca.toString('latin1')
      let bas = 0
      for (;;) {
        const nl = metin.indexOf('\n', bas)
        if (nl < 0) break
        let son = nl
        if (son > bas && metin.charCodeAt(son - 1) === 13) son--
        if (son > bas) satirIsle(metin, bas, son)
        bas = nl + 1
      }
      kuyruk = bas < metin.length ? metin.slice(bas) : ''
    })

    cocuk.stderr.on('data', function (parca) {
      if (hataMetni.length < 4000) hataMetni += parca.toString('utf8')
    })

    cocuk.on('error', function (err) {
      if (err && err.code === 'ENOENT') {
        reject(new Error('Docker komutu bulunamadi. Docker Desktop kurulu olmali.'))
      } else {
        reject(new Error('Docker calistirilamadi: ' + String(err && err.message)))
      }
    })

    cocuk.on('close', function (kod) {
      if (kuyruk.trim().length > 0) satirIsle(kuyruk, 0, kuyruk.length)
      kuyruk = ''
      if (kod !== 0) {
        const detay = hataMetni.trim()
        reject(
          new Error(
            'psql basarisiz oldu (cikis kodu ' + kod + ').' +
              (detay ? ' Sunucu mesaji: ' + detay : '')
          )
        )
        return
      }
      resolve({
        seri: {
          length: n,
          time: zaman,
          open: acilis,
          high: yuksek,
          low: dusuk,
          close: kapanis,
          volume: hacim,
        },
        okunan: okunan,
        atlanan: atlanan,
      })
    })
  })
}

/* ------------------------------------------------------------------ */
/* Cikti yollari                                                        */
/* ------------------------------------------------------------------ */

/**
 * Kaynak dosya yolundan turetilen zaman dilimi icin yol uretir.
 * '.../XAUUSD_1m.bin' + '15m' -> '.../XAUUSD_15m.bin'
 * @param {string} kaynakYol
 * @param {string} tf
 * @returns {string}
 */
function turetilmisYol(kaynakYol, tf) {
  const klasor = path.dirname(kaynakYol)
  const ad = path.basename(kaynakYol)
  const eslesme = /^(.*)_[^_]+\.bin$/.exec(ad)
  const onek = eslesme ? eslesme[1] : DEFAULT_SYMBOL
  return path.join(klasor, onek + '_' + tf + '.bin')
}

/**
 * Deneme aktariminin (yalnizca --limit, --out yok) yazilacagi gecici hedef.
 * Gercek depo hicbir kosulda deneme ile ezilmemeli.
 * @param {string} sembol
 * @param {string} tf
 * @returns {string}
 */
function denemeYolu(sembol, tf) {
  return path.join(os.tmpdir(), DENEME_KLASORU, sembol + '_' + tf + '.bin')
}

/** Dosya var mi (klasorler sayilmaz). */
function dosyaVar(yol) {
  try {
    return fs.statSync(yol).isFile()
  } catch (err) {
    return false
  }
}

/**
 * Uzerine yazilacak dosyalari '<ad>.bak-<damga>' olarak kopyalar.
 * @param {string[]} yollarListesi
 * @param {string} damgaMetni
 * @returns {string[]} Olusturulan yedek yollari
 */
function yedekAl(yollarListesi, damgaMetni) {
  const yedekler = []
  for (let i = 0; i < yollarListesi.length; i++) {
    const kaynak = yollarListesi[i]
    const yedek = yollar.yedekYolu(kaynak, damgaMetni)
    bildir('Yedekleniyor: ' + path.basename(kaynak) + ' -> ' + path.basename(yedek))
    fs.copyFileSync(kaynak, yedek)
    yedekler.push(yedek)
  }
  return yedekler
}

/**
 * Aktarim sonrasi eski hafiza dosyalarini yedek klasorune TASIR.
 *
 * Aktarilan mumlar eskisiyle birebir ayni olmayabilir; hafizadaki bolgeler
 * bar INDEKSI ile saklandigi icin eski kayitlar artik olmayan barlara isaret
 * eder. Silmek yerine tasinir, kullanici isterse geri koyabilir.
 *
 * @param {string} klasor Veri klasoru
 * @param {string} sembol
 * @param {string} damgaMetni
 * @returns {{klasor:string, dosyalar:string[]}}
 */
function eskiHafizalariTasi(klasor, sembol, damgaMetni) {
  let girdiler = []
  try {
    girdiler = fs.readdirSync(klasor, { withFileTypes: true })
  } catch (err) {
    return { klasor: '', dosyalar: [] }
  }
  const hedefKlasor = yollar.eskiHafizaKlasoru(klasor, damgaMetni)
  const tasinan = []
  for (let i = 0; i < girdiler.length; i++) {
    const girdi = girdiler[i]
    if (!girdi.isFile()) continue
    if (!yollar.isMemoryFile(girdi.name, sembol)) continue
    if (tasinan.length === 0) fs.mkdirSync(hedefKlasor, { recursive: true })
    fs.renameSync(path.join(klasor, girdi.name), path.join(hedefKlasor, girdi.name))
    tasinan.push(girdi.name)
  }
  return { klasor: tasinan.length > 0 ? hedefKlasor : '', dosyalar: tasinan }
}

/* ------------------------------------------------------------------ */
/* Ana akis                                                             */
/* ------------------------------------------------------------------ */

const YARDIM =
  'Eski TimescaleDB verisini Zone Memory ikili deposuna aktarir.\n' +
  '\n' +
  'Kullanim: node scripts/import-legacy.mjs [secenekler]\n' +
  '\n' +
  '  --tf <zaman>          Kaynak zaman dilimi (varsayilan 1m)\n' +
  '  --container <ad>      Docker konteyneri (varsayilan indicator2-db-1)\n' +
  '  --user <ad>           Veritabani kullanicisi (varsayilan xauusd)\n' +
  '  --db <ad>             Veritabani adi (varsayilan xauusd)\n' +
  '  --out <yol>           Hedef .bin dosyasi (varsayilan uygulama veri klasoru)\n' +
  '  --symbol <ad>         Dosya adi oneki (varsayilan XAUUSD)\n' +
  '  --limit <n>           Yalnizca ilk n satiri aktar (deneme icin)\n' +
  '  --tfs 5m,15m,1h,4h    Turetilecek zaman dilimleri\n' +
  '  --no-resample         Ust zaman dilimlerini uretme\n' +
  '  --force               Mevcut dosyalarin uzerine yaz (once yedeklenir)\n' +
  '  --help                Bu yardimi goster\n' +
  '\n' +
  'Uzerine yazma korumasi:\n' +
  '  Hedef .bin dosyalarindan biri zaten varsa betik HICBIR IS YAPMADAN durur.\n' +
  '  Uzerine yazmak icin --force ekleyin; o zaman her hedef once\n' +
  '  "<ad>.bak-YYYYMMDD-HHMMSS" adiyla yedeklenir.\n' +
  '\n' +
  'Deneme aktarimi:\n' +
  '  --limit verilip --out verilmezse hedef gecici klasordur\n' +
  '  (' + path.join(os.tmpdir(), DENEME_KLASORU) + '),\n' +
  '  yani gercek depo deneme yuzunden asla ezilmez. Gercek depoya yazmak icin\n' +
  '  --out ile hedefi acikca verin.\n' +
  '\n' +
  'Hafiza dosyalari:\n' +
  '  Gercek veri klasorune aktarim bitince mevcut "<sembol>_<tf>_memory*"\n' +
  '  dosyalari "_eski_hafiza_yedek/<damga>/" altina TASINIR: aktarilan\n' +
  '  mumlarla eski hafizanin bar indeksleri uyusmaz, hafizalar yeniden\n' +
  '  taranmalidir.\n'

async function main() {
  const args = argumanlariAyristir(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(YARDIM)
    return
  }

  const tf = typeof args.tf === 'string' ? args.tf : '1m'
  const konteyner = typeof args.container === 'string' ? args.container : 'indicator2-db-1'
  const kullanici = typeof args.user === 'string' ? args.user : 'xauusd'
  const veritabani = typeof args.db === 'string' ? args.db : 'xauusd'
  const sembol = typeof args.symbol === 'string' ? args.symbol : DEFAULT_SYMBOL
  const limit = typeof args.limit === 'string' ? Math.trunc(Number(args.limit)) : 0
  const yenidenOrnekle = args.resample !== 'false' && args['no-resample'] !== true
  const zorla = args.force === true || args.force === 'true'

  if (args.limit === true) {
    // Degersiz --limit "deneme yapiyorum" sanisi yaratir ama TAM aktarim olur.
    throw new Error('--limit bir sayi ister. Ornek: --limit 200000')
  }
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error('--limit degeri pozitif bir tam sayi olmali.')
  }

  // Kaynak zaman dilimi taninmali; turetme adimlari buna gore secilir.
  const kaynakSaniye = tfSeconds(tf)

  // Hedef secimi: --out her seyin onunde. --out yoksa ve --limit varsa bu bir
  // DENEME aktarimidir; gecici klasore yazilir, gercek depoya dokunulmaz.
  const denemeModu = typeof args.out !== 'string' && limit > 0
  let hedefYol
  if (typeof args.out === 'string') {
    hedefYol = path.resolve(args.out)
  } else if (denemeModu) {
    hedefYol = denemeYolu(sembol, tf)
  } else {
    hedefYol = path.join(dataDir(), sembol + '_' + tf + '.bin')
  }
  const hedefKlasor = path.dirname(hedefYol)

  let turetilecek = TURETILEN_TF
  if (typeof args.tfs === 'string') {
    turetilecek = args.tfs
      .split(',')
      .map(function (x) {
        return x.trim()
      })
      .filter(function (x) {
        return x.length > 0
      })
  }
  // Kaynaktan kucuk veya esit zaman dilimleri turetilemez.
  turetilecek = turetilecek.filter(function (x) {
    return tfSeconds(x) > kaynakSaniye
  })

  if (denemeModu) {
    bildir('--limit verildi: DENEME aktarimi, gecici klasore yazilacak.')
    bildir('  Hedef : ' + hedefKlasor)
    bildir('  Gercek depoya yazmak icin --out ile hedefi acikca verin.')
  }

  // Yazilacak butun dosyalar. Uzerine yazma kontrolu veritabanina hic
  // dokunmadan, en basta yapilir: saatlerce suren bir aktarimdan sonra
  // "dosya zaten var" demek anlamsiz olurdu.
  const hedefler = [hedefYol]
  if (yenidenOrnekle) {
    for (let i = 0; i < turetilecek.length; i++) {
      hedefler.push(turetilmisYol(hedefYol, turetilecek[i]))
    }
  }
  const mevcutHedefler = hedefler.filter(dosyaVar)

  if (mevcutHedefler.length > 0 && !zorla) {
    const liste = mevcutHedefler
      .map(function (y) {
        return '  ' + y
      })
      .join('\n')
    throw new Error(
      'Hedef dosyalar zaten var, aktarim DURDURULDU:\n' + liste + '\n' +
        'Bu dosyalarin uzerine yazmak depodaki mumlari kalici olarak degistirir; ' +
        'aktarimdan sonra eklenen barlar kaybolur ve mevcut hafizalar artik ' +
        'olmayan barlara isaret eder.\n' +
        'Yine de devam etmek icin --force ekleyin (her dosya once ' +
        '"<ad>.bak-YYYYMMDD-HHMMSS" olarak yedeklenir), ya da --out ile bos bir ' +
        'klasor secin.'
    )
  }
  if (mevcutHedefler.length > 0) {
    bildir(
      '--force verildi: ' + mevcutHedefler.length +
        ' mevcut dosyanin uzerine yazilacak, once yedekleri alinacak.'
    )
  }

  bildir('Kaynak konteyner: ' + konteyner + ' (veritabani ' + veritabani + ')')
  await konteyneriDogrula(konteyner)

  bildir('Satir sayisi ogreniliyor...')
  const beklenen = await satirSayisiniOgren({
    konteyner: konteyner,
    kullanici: kullanici,
    veritabani: veritabani,
    tf: tf,
    limit: limit,
  })
  if (beklenen > 0) {
    bildir(sayiBicim(beklenen) + ' adet ' + tfLabel(tf) + ' mumu aktarilacak.')
  } else {
    bildir('Satir sayisi ogrenilemedi, tampon gerektikce buyutulecek.')
  }

  const baslangic = Date.now()
  const sonuc = await mumlariAktar({
    konteyner: konteyner,
    kullanici: kullanici,
    veritabani: veritabani,
    tf: tf,
    limit: limit,
    kapasite: beklenen,
  })

  if (sonuc.seri.length === 0) {
    throw new Error(
      'Veritabanindan hic mum gelmedi. "' + tf + '" zaman dilimi candles tablosunda ' +
        'olmayabilir. Kontrol: docker exec ' + konteyner + ' psql -U ' + kullanici +
        ' -d ' + veritabani + ' -c "SELECT timeframe, count(*) FROM candles GROUP BY 1"'
    )
  }
  if (sonuc.atlanan > 0) {
    bildir(sayiBicim(sonuc.atlanan) + ' satir bozuk veya tekrarli oldugu icin atlandi.')
  }

  ensureDataDir(hedefKlasor)

  // Tum yedekler ve tasima klasoru ayni damgayi paylasir; boylece tek bir
  // aktarimin biraktigi dosyalar bir arada durur.
  const damgaMetni = damga()
  if (mevcutHedefler.length > 0) yedekAl(mevcutHedefler, damgaMetni)

  const ozet = []
  bildir('Yaziliyor: ' + hedefYol)
  await binstore.writeSeries(hedefYol, sonuc.seri)
  ozet.push({
    tf: tf,
    adet: sonuc.seri.length,
    ilk: sonuc.seri.time[0],
    son: sonuc.seri.time[sonuc.seri.length - 1],
    yol: hedefYol,
  })

  if (yenidenOrnekle) {
    for (let i = 0; i < turetilecek.length; i++) {
      const hedefTf = turetilecek[i]
      const yol = turetilmisYol(hedefYol, hedefTf)
      bildir(tfLabel(hedefTf) + ' uretiliyor: ' + yol)
      const ust = seriler.resample(sonuc.seri, tfSeconds(hedefTf))
      if (ust.length === 0) continue
      await binstore.writeSeries(yol, ust)
      ozet.push({
        tf: hedefTf,
        adet: ust.length,
        ilk: ust.time[0],
        son: ust.time[ust.length - 1],
        yol: yol,
      })
    }
  }

  // Gercek veri klasorune yazildiysa eski hafizalar gecersizdir: bolgeler bar
  // INDEKSI ile saklanir, aktarilan mumlarla indeksler uyusmaz. Silinmez,
  // tarihli bir yedek klasorune tasinir.
  const gercekDepo = path.resolve(hedefKlasor) === path.resolve(dataDir())
  const tasima = gercekDepo
    ? eskiHafizalariTasi(hedefKlasor, sembol, damgaMetni)
    : { klasor: '', dosyalar: [] }
  if (tasima.dosyalar.length > 0) {
    bildir('')
    bildir(tasima.dosyalar.length + ' eski hafiza dosyasi tasindi: ' + tasima.klasor)
  }

  const gecen = Date.now() - baslangic
  let cikti = '\nAktarim tamamlandi (' + sureBicim(gecen) + ')\n\n'
  cikti += 'Zaman'.padEnd(8) + 'Mum'.padStart(12) + '  ' + 'Ilk'.padEnd(18) + 'Son\n'
  cikti += '-'.repeat(58) + '\n'
  for (let i = 0; i < ozet.length; i++) {
    const o = ozet[i]
    cikti +=
      o.tf.padEnd(8) +
      sayiBicim(o.adet).padStart(12) +
      '  ' +
      zamanBicim(o.ilk).padEnd(18) +
      zamanBicim(o.son) +
      '\n'
  }
  cikti += '\nDosyalar: ' + hedefKlasor + '\n'
  if (mevcutHedefler.length > 0) {
    cikti +=
      'Yedekler: ' + mevcutHedefler.length + ' dosya ".bak-' + damgaMetni +
      '" olarak saklandi.\n'
  }
  if (tasima.dosyalar.length > 0) {
    cikti += 'Eski hafizalar: ' + tasima.klasor + '\n'
    cikti +=
      'Aktarilan mumlarla eski hafizanin bar indeksleri uyusmaz. ' +
      'Uygulamayi acip HAFIZALARI YENIDEN TARAYIN.\n'
  }
  if (denemeModu) {
    cikti += 'Bu bir deneme aktarimidir, gercek depo degismedi.\n'
  }
  process.stdout.write(cikti)
}

main().catch(function (err) {
  process.stderr.write('\nHata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
