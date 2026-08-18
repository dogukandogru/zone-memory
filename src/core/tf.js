'use strict'

// Zaman dilimi yardimcilari.
// CONTRACTS.md bolum 3 ile birebir uyumludur.

/** Zaman dilimi kodundan saniye karsiligi. */
const TF_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

/** Arayuzde gosterilecek sira. */
const TF_LIST = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']

/** Turkce etiketler. */
const TF_LABELS = {
  '1m': '1 dakika',
  '5m': '5 dakika',
  '15m': '15 dakika',
  '30m': '30 dakika',
  '1h': '1 saat',
  '4h': '4 saat',
  '1d': '1 gün',
}

// Saniye -> kod ters haritasi, tfFromSeconds icin bir kez kurulur.
const SECONDS_TO_TF = Object.create(null)
for (let i = 0; i < TF_LIST.length; i++) {
  SECONDS_TO_TF[TF_SECONDS[TF_LIST[i]]] = TF_LIST[i]
}

/**
 * Zaman dilimi kodunun saniye karsiligini dondurur.
 * @param {string} tf
 * @returns {number}
 */
function tfSeconds(tf) {
  const sec = TF_SECONDS[tf]
  if (sec === undefined) throw new Error('Bilinmeyen zaman dilimi: ' + String(tf))
  return sec
}

/**
 * Zaman dilimi kodunun Turkce etiketini dondurur.
 * Bilinmeyen kodlarda kodun kendisi geri verilir.
 * @param {string} tf
 * @returns {string}
 */
function tfLabel(tf) {
  const label = TF_LABELS[tf]
  return label === undefined ? String(tf) : label
}

/**
 * Saniyeden zaman dilimi kodu bulur.
 * @param {number} sec
 * @returns {string|null} Eslesme yoksa null
 */
function tfFromSeconds(sec) {
  const tf = SECONDS_TO_TF[sec]
  return tf === undefined ? null : tf
}

module.exports = {
  TF_SECONDS,
  TF_LIST,
  tfSeconds,
  tfLabel,
  tfFromSeconds,
}
