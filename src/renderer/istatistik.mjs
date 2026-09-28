/**
 * Arayuz tarafinda kucuk istatistik yardimcilari (saf ESM).
 *
 * Neden ayri dosya: cekirdekteki `learn/stats.js` CommonJS'tir ve renderer
 * ESM oldugu icin dogrudan yuklenemez. Burada YALNIZCA arayuzun gosterim
 * icin ihtiyac duydugu kadari var; formul degisirse iki dosya birlikte
 * degismeli.
 */

/**
 * Wilson %95 guven araligi.
 *
 * Neden gerekli: uygulamanin ana ciktisi "gecmiste bu yapi %X tuttu"
 * cumlesi, ama 5 eslesmeli %60 ile 25 eslesmeli %60 ekranda AYNI gorunuyordu
 * ve belirsizlik hicbir yerde yazmiyordu. Wilson araligi kucuk orneklemde
 * normal yaklasiklikten daha dogrudur ve 0 ile 1 sinirlarini asmaz.
 *
 * @param {number} k Basarili sayisi
 * @param {number} n Toplam
 * @returns {{lo:number, hi:number}|null} n <= 0 ise null
 */
export function wilsonAraligi(k, n) {
  const toplam = Number(n)
  const basari = Number(k)
  if (!Number.isFinite(toplam) || toplam <= 0) return null
  if (!Number.isFinite(basari) || basari < 0) return null
  const z = 1.959963984540054
  const p = basari / toplam
  const z2 = z * z
  const merkez = p + z2 / (2 * toplam)
  const yayilim = z * Math.sqrt((p * (1 - p) + z2 / (4 * toplam)) / toplam)
  const bolen = 1 + z2 / toplam
  const lo = (merkez - yayilim) / bolen
  const hi = (merkez + yayilim) / bolen
  return { lo: lo < 0 ? 0 : lo, hi: hi > 1 ? 1 : hi }
}

/**
 * Bir sinyalin guven araligi: sinyal tasiyorsa oradan, yoksa hesaplanir.
 *
 * Eski kayitlarda (S1 oncesi) `winRateLo` / `winRateHi` yoktur; o durumda
 * basari sayisi `winRate * matchCount` ile turetilir.
 *
 * @param {{winRate?:number, matchCount?:number, winRateLo?:number, winRateHi?:number}} signal
 * @returns {{lo:number, hi:number}|null}
 */
export function sinyalAraligi(signal) {
  if (!signal) return null
  const lo = Number(signal.winRateLo)
  const hi = Number(signal.winRateHi)
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo && (lo > 0 || hi > 0)) {
    return { lo: lo, hi: hi }
  }
  const n = Number(signal.matchCount)
  const oran = Number(signal.winRate)
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(oran)) return null
  return wilsonAraligi(Math.round(oran * n), n)
}

/**
 * Sinyalin "kac kayittan kaci" bicimi: 9/15.
 * @param {{winRate?:number, matchCount?:number}} signal
 * @returns {{k:number, n:number}|null}
 */
export function sinyalSayilari(signal) {
  if (!signal) return null
  const n = Number(signal.matchCount)
  const oran = Number(signal.winRate)
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(oran)) return null
  // Kalibre edilmis oran gosterildiginde `winRateRaw` ham orandir; sayim ham
  // orandan turetilmeli, yoksa "9/15" ile gosterilen yuzde tutmaz.
  const hamOran = Number(signal.winRateRaw)
  const kullanilan = Number.isFinite(hamOran) ? hamOran : oran
  return { k: Math.round(kullanilan * n), n: Math.round(n) }
}

/**
 * BASABAS ISABET ORANI: bu plan kac isabetle sifir kar eder.
 *
 * Neden sabit %50 yetmiyor: renkler risk/odulu hesaba katmadigi icin
 * basabasi %31 olan bir dokunus kurulumu kirmizi, basabasi %50 olan bir
 * olusum yesil gorunebiliyordu. Kullanici en guvenilir GORUNEN sinyale en
 * cok guvenip en kotu sonucu alabilirdi.
 *
 * @param {number} rr Risk/odul orani
 * @returns {number} 0..1
 */
export function basabasOran(rr) {
  const r = Number(rr)
  if (!Number.isFinite(r) || r <= 0) return 0.5
  return 1 / (1 + r)
}

/**
 * Aralik ile basabas karsilastirmasindan renk sinifi.
 *
 * Aralik basabasi ICERIYORSA notr gri: "bu kurulumun karli oldugu
 * soylenemez" demektir ve yesil/kirmizi gostermek yaniltici olurdu.
 *
 * @param {{lo:number, hi:number}|null} aralik
 * @param {number} basabas
 * @returns {'up'|'down'|'muted'}
 */
export function aralikSinifi(aralik, basabas) {
  if (!aralik) return 'muted'
  if (aralik.lo > basabas) return 'up'
  if (aralik.hi < basabas) return 'down'
  return 'muted'
}

/**
 * Orneklem buyuklugu rozeti.
 * @param {number} matchCount
 * @returns {{metin:string, sinif:string}|null} Yeterliyse null
 */
export function ornekRozeti(matchCount) {
  const n = Number(matchCount)
  if (!Number.isFinite(n)) return null
  if (n < 10) return { metin: 'çok az örnek', sinif: 'down' }
  if (n < 30) return { metin: 'az örnek', sinif: 'warn' }
  return null
}

/**
 * Sinyalin tek satirlik ozeti (arayuz kopyasi).
 *
 * Cekirdekteki `learn/signalText.js` ile AYNI bicimi uretir; o dosya
 * CommonJS oldugu icin renderer'dan yuklenemiyor. Isci sinyale
 * `summaryText` alanini ekler ve arayuz oncelikle onu kullanir; bu fonksiyon
 * yalnizca o alani tasimayan ESKI kayitlar icindir. Bicim degisirse iki
 * dosya birlikte degismeli.
 *
 * @param {Object} signal
 * @returns {string}
 */
export function sinyalOzetiMetni(signal) {
  if (!signal) return ''
  const parcalar = []
  // BENZERLIK KIPI: bkz. core/learn/signalText.js sinyalOzeti, ayni bicim.
  // Guven metni: core/learn/guven.js guvenMetni ile AYNI ("TP şansı %56 (6/10)").
  // Ayrim `similarCount` ile yapilir; `confidence` iki bicimde de var ama
  // olcegi farkli (eski 0..1, yeni 0..100).
  const benzer = Number(signal.similarCount)
  if (Number.isFinite(benzer)) {
    const guven = guvenMetni(signal)
    if (guven) parcalar.push(guven)
    parcalar.push(Math.round(benzer) + ' benzer kurulum')
    return parcalar.join(', ')
  }
  const sayimlar = sinyalSayilari(signal)
  if (sayimlar) parcalar.push(sayimlar.k + '/' + sayimlar.n + ' tuttu')
  const aralik = sinyalAraligi(signal)
  if (aralik) {
    parcalar.push('%95 aralık %' + Math.round(aralik.lo * 100) + '-' + Math.round(aralik.hi * 100))
  }
  const taban = Number(signal.baseRate)
  if (Number.isFinite(taban)) parcalar.push('tür tabanı %' + Math.round(taban * 100))
  return parcalar.join(', ')
}

/**
 * Grafik isaretinin kisa metni: "OL %82".
 *
 * SAYI, O KIPTE HESAPLANAN SEYDIR. Varsayilan kipte tutma orani hic
 * hesaplanmiyor, dolayisiyla isaretin yaninda GUVEN yuzdesi yazar: bu
 * kurulumun kendi turundeki kurulumlarin yuzde kacindan daha cok gecmis
 * ornegi oldugu. Bir donem burada "9/15 tuttu" yaziyordu; o alanlar
 * kaldirilinca isaretlerde HIC sayi kalmadi ama grafigin efsanesi hala
 * "yanindaki sayi: gecmiste kac kayittan kaci tuttu" diyordu.
 *
 * Eski kayitlar (kaldirilan R:R bicimi) icin eski gosterim korunur, yoksa
 * kullanici yeniden tarayana kadar isaretler bos kalirdi.
 *
 * @param {Object} signal
 * @returns {string}
 */
export function isaretMetni(signal) {
  if (!signal) return ''
  const onek = signal.kind === 'form' ? 'OL' : 'DK'
  // Ayrim `similarCount` ile: `confidence` eski bicimde 0..1, yenide 0..100.
  if (Number.isFinite(Number(signal.similarCount))) {
    const guven = Number(signal.confidence)
    return Number.isFinite(guven) ? onek + ' %' + Math.round(guven) : onek
  }
  const sayimlar = sinyalSayilari(signal)
  if (sayimlar) return onek + ' ' + sayimlar.k + '/' + sayimlar.n
  const oran = Number(signal.winRate)
  if (Number.isFinite(oran)) return onek + ' %' + Math.round(oran * 100)
  return onek
}

/**
 * Guven metni: "TP şansı %56 (6/10)". core/learn/guven.js guvenMetni ile
 * ayni bicim; renderer core'a erisemedigi icin burada yinelenir.
 * @param {{confidence?:number, confidenceTp?:number, confidenceN?:number}} s
 * @returns {string} confidence yoksa bos dize
 */
export function guvenMetni(s) {
  const g = Number(s && s.confidence)
  if (!Number.isFinite(g)) return ''
  const n = Number(s && s.confidenceN)
  const tp = Number(s && s.confidenceTp)
  let metin = 'TP şansı %' + Math.round(g)
  if (Number.isFinite(n) && n > 0 && Number.isFinite(tp)) {
    metin += ' (' + Math.round(tp) + '/' + Math.round(n) + ')'
  }
  return metin
}
