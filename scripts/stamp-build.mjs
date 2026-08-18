// Paketleme oncesi yapi damgasi yazar.
//
// Neden gerekli: surum numarasi her pakette ayni (0.1.0) oldugu icin
// "hangi yapiyi calistiriyorum" sorusunun cevabi yoktu. Bir hata bildirildiginde
// eski bir paketten mi geldigi anlasilamiyor ve bos yere aranmis oluyor.
// Bu damga arayuzde ve pencere basliginda gorunur.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Kisa git commit kimligi, depo yoksa bos. */
function gitKimligi() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: kok })
      .toString().trim()
  } catch (err) {
    return ''
  }
}

const damga = {
  builtAt: new Date().toISOString(),
  commit: gitKimligi(),
}

const hedef = path.join(kok, 'src', 'build-info.json')
fs.writeFileSync(hedef, JSON.stringify(damga, null, 2) + '\n', 'utf8')
process.stderr.write('Yapi damgasi: ' + damga.builtAt + ' ' + damga.commit + '\n')
