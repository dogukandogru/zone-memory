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

import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dataDir, ensureDataDir, DEFAULT_SYMBOL } from './userdata-path.mjs'

// Cekirdek moduller CommonJS oldugu icin createRequire ile yuklenir.
const require = createRequire(import.meta.url)
const binstore = require('../src/core/store/binstore.js')
const seriler = require('../src/core/series.js')
const { tfSeconds, tfLabel } = require('../src/core/tf.js')

/** Kaynak zaman diliminden turetilecek varsayilan zaman dilimleri. */
const VARSAYILAN_TURETILEN = ['5m', '15m', '1h', '4h']

/** Ilerleme kac satirda bir bildirilsin. */
const ILERLEME_ADIMI = 250000

/** Satir sayisi bilinmiyorsa baslangic tampon kapasitesi. */
const BASLANGIC_KAPASITE = 1 << 20

/* ------------------------------------------------------------------ */
/* Kucuk yardimcilar                                                    */
/* ------------------------------------------------------------------ */

/** Basit argüman ayristirici: --ad deger, --ad=deger ve --bayrak destekler. */
function argumanlariAyristir(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const govde = arg.slice(2)
    const esit = govde.indexOf('=')
    if (esit >= 0) {
      out[govde.slice(0, esit)] = govde.slice(esit + 1)
      continue
    }
    const sonraki = argv[i + 1]
    if (sonraki !== undefined && !sonraki.startsWith('--')) {
      out[govde] = sonraki
      i++
    } else {
      out[govde] = true
    }
  }
  return out
}

/** 6086450 -> '6.086.450' */
function sayiBicim(n) {
  const s = String(Math.trunc(n))
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.'
    out += s[i]
  }
  return out
}

/** UNIX saniyeyi '2009-03-15 22:00' seklinde yazar. */
function zamanBicim(sn) {
  if (!Number.isFinite(sn)) return '-'
  return new Date(sn * 1000).toISOString().replace('T', ' ').slice(0, 16)
}

/** Saniyeyi '12,3 sn' seklinde yazar. */
function sureBicim(ms) {
  return (ms / 1000).toFixed(1).replace('.', ',') + ' sn'
}

/** stderr'e tek satir yazar (stdout yalnizca ozet icindir). */
function bildir(metin) {
  process.stderr.write(metin + '\n')
}

/** Float64Array kapasitesini en az `gerekli` olacak sekilde iki katina cikarir. */
function buyut(dizi, gerekli) {
  let kapasite = dizi.length * 2
  if (kapasite < gerekli) kapasite = gerekli
  const yeni = new Float64Array(kapasite)
  yeni.set(dizi)
  return yeni
}

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
  '  --help                Bu yardimi goster\n'

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

  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error('--limit degeri pozitif bir tam sayi olmali.')
  }

  // Kaynak zaman dilimi taninmali; turetme adimlari buna gore secilir.
  const kaynakSaniye = tfSeconds(tf)

  const hedefYol =
    typeof args.out === 'string'
      ? path.resolve(args.out)
      : path.join(dataDir(), sembol + '_' + tf + '.bin')

  let turetilecek = VARSAYILAN_TURETILEN
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

  ensureDataDir(path.dirname(hedefYol))

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
  cikti += '\nDosyalar: ' + path.dirname(hedefYol) + '\n'
  process.stdout.write(cikti)
}

main().catch(function (err) {
  process.stderr.write('\nHata: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
