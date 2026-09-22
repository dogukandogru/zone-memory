'use strict'

/**
 * ILK ACILISTA PAKETE GOMULU VERIYI KURAR.
 *
 * NEDEN
 * Uygulama veri olmadan hicbir ise yaramaz: mum deposu olmadan ne tarama
 * yapilabilir ne sinyal uretilebilir. Musteriye teslimde bu, "once Veri Cek
 * de saatlerce bekle, sonra Gecmisi Tara de bir daha bekle" demekti ve
 * kurulumu teslim eden kisinin 470 MB'lik klasoru elle dogru yere
 * kopyalamasini gerektiriyordu. Yanlis klasore kopyalandiginda uygulama
 * "kayit yok" diyor, sebebi de gorunmuyordu.
 *
 * Artik hazir veri paketin icinde geliyor ve ilk acilista yerine kopyalaniyor.
 * Musterinin tek yapmasi gereken kurulum dosyasini calistirmak.
 *
 * MUTLAK KURAL: VAR OLAN VERININ USTUNE YAZILMAZ.
 * Hedef klasorde tek bir `.bin` bile varsa kopyalama HIC yapilmaz. Aksi
 * halde bir guncelleme kurulumu, musterinin aylardir biriktirdigi canli
 * barlari ve taradigi hafizayi sessizce eski bir anlik goruntuyle
 * degistirebilirdi. Bu, geri alinamaz bir veri kaybi olurdu.
 */

const fs = require('fs')
const path = require('path')

const paths = require('./paths')
const logfile = require('./logfile')

/** Paketlenmis uygulamada gomulu verinin durdugu klasor. */
function gomuluKlasor() {
  // `process.resourcesPath` yalnizca paketlenmis calistirmada anlamlidir.
  // Gelistirmede depo icindeki build/bundled-data denenir, boylece akis
  // paketlemeden once de sinanabilir.
  const adaylar = []
  if (process.resourcesPath) adaylar.push(path.join(process.resourcesPath, 'bundled-data'))
  adaylar.push(path.join(__dirname, '..', '..', 'build', 'bundled-data'))
  for (const aday of adaylar) {
    try {
      if (fs.existsSync(aday) && fs.statSync(aday).isDirectory()) return aday
    } catch (err) {
      // Erisilemiyorsa sonraki adaya gec.
    }
  }
  return null
}

/** Hedef klasorde kullanilabilir veri var mi (tek bir .bin yeter). */
function veriVarMi(klasor) {
  try {
    const liste = fs.readdirSync(klasor)
    for (const ad of liste) {
      if (ad.endsWith('.bin')) return true
    }
    return false
  } catch (err) {
    // Klasor okunamiyorsa "var" kabul ederiz: emin olmadan yazmayiz.
    return true
  }
}

/** Bayt sayisini okunur metne cevirir. */
function boyutMetni(bayt) {
  if (bayt >= 1073741824) return (bayt / 1073741824).toFixed(2) + ' GB'
  if (bayt >= 1048576) return (bayt / 1048576).toFixed(0) + ' MB'
  return (bayt / 1024).toFixed(0) + ' KB'
}

/**
 * Gomulu veriyi hedefe kopyalar.
 *
 * Once `.yukleniyor` uzantisiyla yazilir, sonra adi degistirilir: kopyalama
 * yarida kesilirse (elektrik, kullanicinin uygulamayi kapatmasi) yarim bir
 * `.bin` dosyasi kalmaz. Yarim `.bin`, depo okuyucusunda "bozuk dosya"
 * hatasina yol acardi ve kullanici sebebini anlamazdi.
 *
 * @returns {{kopyalandi:number, bayt:number, atlanan:number}}
 */
function kopyala(kaynak, hedef) {
  const sonuc = { kopyalandi: 0, bayt: 0, atlanan: 0 }
  const liste = fs.readdirSync(kaynak)
  for (const ad of liste) {
    const kYol = path.join(kaynak, ad)
    let st = null
    try {
      st = fs.statSync(kYol)
    } catch (err) {
      sonuc.atlanan++
      continue
    }
    if (!st.isFile()) { sonuc.atlanan++; continue }

    const hYol = path.join(hedef, ad)
    const gecici = hYol + '.yukleniyor'
    try {
      fs.copyFileSync(kYol, gecici)
      fs.renameSync(gecici, hYol)
      sonuc.kopyalandi++
      sonuc.bayt += st.size
    } catch (err) {
      try { fs.unlinkSync(gecici) } catch (e2) { /* zaten yok */ }
      sonuc.atlanan++
      logfile.write({
        level: 'hata',
        source: 'firstrun',
        message: 'Gomulu veri kopyalanamadi: ' + ad + ', ' +
          (err && err.message ? err.message : String(err)),
      })
    }
  }
  return sonuc
}

/**
 * Gerekiyorsa gomulu veriyi kurar.
 *
 * Uygulama acilisini BLOKLAR, bilerek: isci bassa veri klasorunu yariya
 * kadar dolmus halde okur ve "bozuk depo" hatasi verirdi. 470 MB'lik kopya
 * SSD'de birkac saniye surer ve yalnizca ilk acilista olur.
 *
 * @param {string} [kaynakDir] Yalnizca test icin: gomulu klasoru zorlar.
 * @returns {{durum:string, kopyalandi?:number, bayt?:number}}
 */
function kur(kaynakDir) {
  // Test, depo icindeki gercek build/bundled-data klasorunu bulup yuzlerce
  // megabayti gecici klasore kopyalayabiliyordu. Kaynak disaridan verilebilir.
  const kaynak = kaynakDir === undefined ? gomuluKlasor() : kaynakDir
  if (!kaynak || !fs.existsSync(kaynak)) return { durum: 'gomulu-veri-yok' }

  let hedef = null
  try {
    hedef = paths.dataDir()
    fs.mkdirSync(hedef, { recursive: true })
  } catch (err) {
    logfile.write({
      level: 'hata',
      source: 'firstrun',
      message: 'Veri klasoru olusturulamadi: ' +
        (err && err.message ? err.message : String(err)),
    })
    return { durum: 'klasor-acilamadi' }
  }

  // VAR OLAN VERIYE DOKUNULMAZ.
  if (veriVarMi(hedef)) return { durum: 'veri-zaten-var' }

  logfile.write({
    level: 'bilgi',
    source: 'firstrun',
    message: 'Ilk acilis: pakete gomulu veri kuruluyor.',
  })
  const basla = Date.now()
  const sonuc = kopyala(kaynak, hedef)
  const sn = ((Date.now() - basla) / 1000).toFixed(1)

  logfile.write({
    level: 'bilgi',
    source: 'firstrun',
    message: 'Gomulu veri kuruldu: ' + sonuc.kopyalandi + ' dosya, ' +
      boyutMetni(sonuc.bayt) + ', ' + sn + ' sn' +
      (sonuc.atlanan > 0 ? ', ' + sonuc.atlanan + ' dosya atlandi' : ''),
  })

  return { durum: 'kuruldu', kopyalandi: sonuc.kopyalandi, bayt: sonuc.bayt }
}

module.exports = {
  kur,
  // Test icin.
  _gomuluKlasor: gomuluKlasor,
  _veriVarMi: veriVarMi,
  _kopyala: kopyala,
}
