'use strict'

/**
 * Komut satiri betiklerinin ortak yardimcilari.
 *
 * `scripts/*.mjs` dosyalari ESM oldugu icin bu modulu `createRequire` ile
 * yukler. Buradaki her sey SAF fonksiyondur (tek istisna `bildir`), boylece
 * testten dogrudan cagrilabilir.
 */

/**
 * Basit argüman ayristirici: --ad deger, --ad=deger ve --bayrak destekler.
 * Bayraklar `true`, degerler dize olarak doner; adsiz argumanlar `_` dizisine
 * girer.
 * @param {string[]} argv
 * @returns {Object<string, string|boolean|string[]>}
 */
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

/**
 * 6086450 -> '6.086.450'
 * @param {number} n
 * @returns {string}
 */
function sayiBicim(n) {
  const s = String(Math.trunc(n))
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.'
    out += s[i]
  }
  return out
}

/**
 * UNIX saniyeyi '2009-03-15 22:00' seklinde yazar.
 * @param {number} sn
 * @returns {string}
 */
function zamanBicim(sn) {
  if (!Number.isFinite(sn)) return '-'
  return new Date(sn * 1000).toISOString().replace('T', ' ').slice(0, 16)
}

/**
 * Milisaniyeyi '12,3 sn' seklinde yazar.
 * @param {number} ms
 * @returns {string}
 */
function sureBicim(ms) {
  return (ms / 1000).toFixed(1).replace('.', ',') + ' sn'
}

/** Iki haneye tamamlar: 7 -> '07' */
function iki(n) {
  return n < 10 ? '0' + n : String(n)
}

/**
 * Yedek klasor ve dosya adlarinda kullanilan YEREL saat damgasi:
 * 'YYYYMMDD-HHMMSS'. Kullanici dosyayi kendi saatiyle bulabilsin diye UTC
 * degil yerel saat kullanilir.
 * @param {Date} [tarih] Verilmezse su an
 * @returns {string}
 */
function damga(tarih) {
  const t = tarih instanceof Date ? tarih : new Date()
  return (
    String(t.getFullYear()) +
    iki(t.getMonth() + 1) +
    iki(t.getDate()) +
    '-' +
    iki(t.getHours()) +
    iki(t.getMinutes()) +
    iki(t.getSeconds())
  )
}

/**
 * stderr'e tek satir yazar (stdout yalnizca ozet icindir).
 * @param {string} metin
 */
function bildir(metin) {
  process.stderr.write(metin + '\n')
}

module.exports = {
  argumanlariAyristir,
  sayiBicim,
  zamanBicim,
  sureBicim,
  damga,
  bildir,
}
