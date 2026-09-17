// Depodaki serinin saglik raporunu basar: ic bosluklar, aylik kapsama,
// hafta sonu ve sifir hacimli barlar, hacim rejimi kirilmalari.
//
// Kullanim:
//   node scripts/data-doctor.mjs                 # 1m
//   node scripts/data-doctor.mjs --tf 15m
//   node scripts/data-doctor.mjs --from 2023-01 --to 2023-12
//   node scripts/data-doctor.mjs --json

import path from 'node:path'
import { createRequire } from 'node:module'
import { dataDir as varsayilanDataDir, DEFAULT_SYMBOL } from './userdata-path.mjs'

const require = createRequire(import.meta.url)
const binstore = require('../src/core/store/binstore.js')
const { tfSeconds } = require('../src/core/tf.js')
const loader = require('../src/core/data/loader.js')
const { veriDoktoru } = require('../src/core/data/doctor.js')
const { argumanlariAyristir, sayiBicim } = require('../src/core/util/cli.js')

/** UNIX saniyeyi okunur UTC metnine cevirir. */
function zamanYaz(t) {
  if (!Number.isFinite(t)) return '-'
  return new Date(t * 1000).toISOString().replace('.000Z', 'Z')
}

/** 'YYYY-MM' veya tam tarihten ay anahtarini alir. */
function ayAnahtari(deger) {
  if (!deger || deger === true) return null
  const m = String(deger).match(/^(\d{4})-(\d{2})/)
  return m ? m[1] + '-' + m[2] : null
}

const arg = argumanlariAyristir(process.argv.slice(2))
if (arg.help || arg.h) {
  process.stdout.write([
    'Depodaki serinin saglik raporu.',
    '',
    '  --tf <zaman>      Zaman dilimi (varsayilan 1m)',
    '  --data-dir <yol>  Veri klasoru',
    '  --symbol <ad>     Sembol (varsayilan ' + DEFAULT_SYMBOL + ')',
    '  --from <YYYY-MM>  Aylik tabloyu bu aydan baslat',
    '  --to <YYYY-MM>    Aylik tabloyu bu ayda bitir',
    '  --min-gap <dk>    Bosluk esigi (varsayilan 30 dakika)',
    '  --json            Ham JSON yaz',
    '',
  ].join('\n'))
  process.exit(0)
}

const dataDir = arg['data-dir'] && arg['data-dir'] !== true ? String(arg['data-dir']) : varsayilanDataDir()
const symbol = arg.symbol && arg.symbol !== true ? String(arg.symbol) : DEFAULT_SYMBOL
const tf = arg.tf && arg.tf !== true ? String(arg.tf) : '1m'
const enAz = Number.isFinite(Number(arg['min-gap'])) ? Number(arg['min-gap']) : 30

const dosya = path.join(dataDir, loader.candleFileName(tf, symbol))
const s = await binstore.readSeries(dosya)
if (!s || s.length === 0) {
  process.stderr.write('Depo bos veya bulunamadi: ' + dosya + '\n')
  process.exit(1)
}

const rapor = veriDoktoru(s, tfSeconds(tf), { minGapMinutes: enAz })

if (arg.json) {
  process.stdout.write(JSON.stringify(rapor, null, 2) + '\n')
  process.exit(0)
}

process.stdout.write('Dosya            : ' + dosya + '\n')
process.stdout.write('Bar sayisi       : ' + sayiBicim(rapor.bars) + '\n')
process.stdout.write('Aralik           : ' + zamanYaz(rapor.firstTime) + ' - ' + zamanYaz(rapor.lastTime) + '\n')
process.stdout.write('Eksik bar (acik) : ' + sayiBicim(rapor.gapBars) + '\n')
process.stdout.write('Bosluk (>= ' + enAz + ' dk): ' + rapor.gaps.length + '\n')
process.stdout.write('Piyasa kapali bar: ' + sayiBicim(rapor.weekendBars) + '\n')
process.stdout.write('Sifir hacimli bar: ' + sayiBicim(rapor.zeroVolumeBars) + '\n')
process.stdout.write('Tekrar / sirasiz : ' + rapor.duplicateTimes + ' / ' + rapor.outOfOrder + '\n')

const basAy = ayAnahtari(arg.from)
const bitAy = ayAnahtari(arg.to)
const aylik = rapor.monthly.filter((m) => (!basAy || m.month >= basAy) && (!bitAy || m.month <= bitAy))

// En kotu kapsamali 12 ay (veya istenen aralik).
const gosterilecek = (basAy || bitAy)
  ? aylik
  : aylik.slice().sort((a, b) => a.coverage - b.coverage).slice(0, 12).sort((a, b) => (a.month < b.month ? -1 : 1))

process.stdout.write('\nAy       bar      beklenen  kapsama  medyan hacim  sifir hacim\n')
for (const m of gosterilecek) {
  process.stdout.write(
    m.month + '  ' + String(sayiBicim(m.bars)).padStart(8) + '  ' + String(sayiBicim(m.expected)).padStart(8) +
    '  ' + ('%' + (m.coverage * 100).toFixed(1)).padStart(7) + '  ' + String(m.medianVolume).padStart(12) +
    '  ' + String(m.zeroVolume).padStart(11) + '\n')
}

if (rapor.gaps.length > 0) {
  const enBuyuk = rapor.gaps.slice().sort((a, b) => b.missingBars - a.missingBars).slice(0, 10)
  process.stdout.write('\nEn buyuk 10 bosluk:\n')
  for (const g of enBuyuk) {
    process.stdout.write('  ' + zamanYaz(g.from) + ' -> ' + zamanYaz(g.to) +
      '  ' + sayiBicim(g.missingBars) + ' bar (' + g.minutes + ' dk)\n')
  }
}

if (rapor.volumeBreaks.length > 0) {
  process.stdout.write('\nHacim rejimi kirilmalari (medyan, ' + rapor.volumeBreaks.length + ' adet):\n')
  for (const k of rapor.volumeBreaks.slice(0, 10)) {
    process.stdout.write('  ' + k.month + ': ' + k.from + ' -> ' + k.to + ' (' + k.ratio.toFixed(1) + ' kat)\n')
  }
}
