'use strict'

/**
 * HESAP IMZASI: olaylari ve komsu satirlarini URETEN kodun parmak izi.
 *
 * NEDEN VAR
 * ---------------------------------------------------------------------------
 * Komsu onbellegini (learn/candcache.js) yeniden kullanabilmek icin "ayarlar
 * ayni mi" sorusu yetmez, "hesap ayni mi" sorusu da gerekir. Ayar izi
 * (cfgHash) yalnizca AYARLARI kapsar; bir uygulama guncellemesi indikatoru ya
 * da benzerlik hesabini degistirdiginde iz aynen kalir ve eski satirlar yeni
 * olaylara ait olmayan sayilar tasimaya devam eder.
 *
 * NEDEN TUM KAYNAGIN DAMGASI DEGIL
 * ---------------------------------------------------------------------------
 * Yapi damgasi (build-info.json srcHash) src'nin TAMAMINI kapsar, yani
 * arayuzde bir yazim duzeltmesi bile degisir. Onbellek ona baglanirsa hesabi
 * hic etkilemeyen bir guncelleme musteriyi bes dakikalik yeniden taramaya
 * mahkum eder. Kullanicinin bildirdigi sorun tam olarak buydu:
 * "musteri guncelleme yukledigunde 1m 5m secince grafigin yuklenmesi uzun
 * suruyor".
 *
 * NEDEN ELLE DOSYA LISTESI DEGIL
 * ---------------------------------------------------------------------------
 * Elle tutulan liste gunun birinde eksik kalir ve imza SESSIZCE yanlis olur:
 * en kotu hata cesidi. Bunun yerine giris modullerinden baslanip `require`
 * zincirinin tamami dolasilir. Hesaba giren her dosya tanimi geregi bu
 * zincirdedir. (src/core icinde hesaplanmis tek bir `require` var, o da veri
 * saglayici secimindedir ve bu zincire girmez.)
 *
 * SINIR: zincir yalnizca src/core icinde dolasilir. Node'un kendi modulleri ve
 * src/main dosyalari imzaya girmez; hesap cekirdegi core icindedir.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/**
 * Zincirin baslangic modulleri, core koküne gore.
 *
 * Bunlar "hesabi yapan" giris noktalari: hafiza kurma, indikator, ozellik
 * cikarma, etiketleme, benzerlik, komsu onbellegi ve hazir ayarlar. Zincir
 * buradan otomatik genisler.
 */
const COMPUTE_ENTRIES = [
  'indicator/proZones.js',
  'learn/memory.js',
  'learn/candcache.js',
  'learn/signal.js',
  'learn/similarity.js',
  'learn/features.js',
  'learn/outcome.js',
  'learn/presets.js',
]

/**
 * Hesap zincirini dolasip imzayi uretir.
 *
 * @param {{root?:string, entries?:string[],
 *          readFile?:(yol:string)=>string}} [opts]
 *   root     : core kökü (varsayilan: bu dosyanin ust klasoru)
 *   entries  : giris modulleri (varsayilan: COMPUTE_ENTRIES)
 *   readFile : dosya okuyucu (test icin degistirilebilir)
 * @returns {{hash:string, files:string[]}} hash bos ise imza uretilemedi
 */
function codeSignature (opts) {
  const o = opts || {}
  const kok = o.root ? path.resolve(o.root) : path.resolve(path.join(__dirname, '..'))
  const girisler = Array.isArray(o.entries) && o.entries.length ? o.entries : COMPUTE_ENTRIES
  const oku = typeof o.readFile === 'function'
    ? o.readFile
    : function (yol) { return fs.readFileSync(yol, 'utf8') }

  const gorulen = new Set()
  const sira = girisler.map(function (r) { return path.join(kok, r) })
  const parcalar = []

  while (sira.length > 0) {
    const dosya = sira.pop()
    const ad = path.relative(kok, dosya)
    if (gorulen.has(ad)) continue
    gorulen.add(ad)
    let icerik
    try {
      icerik = oku(dosya)
    } catch (err) {
      // Bir dosya okunamiyorsa imza URETILEMEZ. Bos imza "koruma yapma"
      // demektir; eksik zincirden yanlis bir imza uretmekten iyidir.
      return { hash: '', files: [] }
    }
    // HAM ICERIK ozetlenir, yorumlar da dahil. Yorumlari ayiklamak imzayi
    // gereksiz degisimlerden korurdu ama dogru ayiklama gercek bir ayristirici
    // ister; kaba bir ayiklama gunun birinde GERCEK kodu siler ve o zaman kod
    // degisikligi imzada hic gorunmez. Fazladan yeniden tarama, sessizce eski
    // satir kullanmaktan iyidir.
    parcalar.push(ad + ':' +
      crypto.createHash('sha256').update(String(icerik)).digest('hex'))

    // Yalnizca GORECELI require'lar izlenir; core disina cikilmaz.
    const desen = /require\(\s*'(\.[^']+)'\s*\)/g
    let esleme = desen.exec(icerik)
    while (esleme) {
      let hedef = path.resolve(path.dirname(dosya), esleme[1])
      if (!path.extname(hedef)) hedef += '.js'
      if (hedef.indexOf(kok + path.sep) === 0) sira.push(hedef)
      esleme = desen.exec(icerik)
    }
  }

  // Dolasma sirasi degisse bile imza ayni kalsin.
  parcalar.sort()
  const hash = crypto.createHash('sha256').update(parcalar.join('\n')).digest('hex').slice(0, 16)
  return { hash: hash, files: parcalar.map(function (p) { return p.split(':')[0] }) }
}

module.exports = { COMPUTE_ENTRIES, codeSignature }
