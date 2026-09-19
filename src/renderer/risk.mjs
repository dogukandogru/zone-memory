/**
 * risk.mjs - Pozisyon boyutu hesabi (Y1 cekirdegi).
 *
 * NEDEN VAR: sinyal ayrintisi SL'yi yalnizca fiyat olarak gosteriyordu, oysa
 * SL mesafesi turler arasinda UC KAT degisiyor: kutu olusumunda ortalama
 * 2,02-2,10 ATR, bolge dokunusunda 0,68-0,75 ATR. 2026'da 5 dakikalik medyan
 * ATR 5,97 dolar; 10.000 dolarlik hesapta %1 risk, olusumda yaklasik 0,07 lot,
 * dokunusta yaklasik 0,22 lot demek. Sabit lotla acan kullanici olusum
 * sinyalinde ucu ucuna uc kat fazla risk aliyordu. Burasi o mesafeyi dolara ve
 * lota cevirir.
 *
 * TASARIM KURALI (bozmayin): sistem su an HICBIR zaman diliminde pozitif net
 * beklenti uretmiyor. Bu yuzden hesap YALNIZCA riski sinirlar. Kelly, basari
 * oranina gore lot buyutme ya da "guvenli sinyalde daha fazla bas" turu hicbir
 * carpani YOKTUR: olculmemis bir edimi lotla buyutmek zarari buyutmekten baska
 * bir sey yapmaz.
 *
 * BIRIMLER (kafa karisikligi en pahali hata burada):
 *   fiyat / SL / TP1  : dolar/ons (XAUUSD kotasyonu)
 *   contractSize      : ons/lot (standart XAUUSD lotu 100 ons)
 *   lot               : lot
 *   riskUsd, kazanc   : dolar
 *   riskPct           : yuzde (1 = %1), oran DEGIL
 *
 * Saf modul: DOM, IPC, zaman ya da rastgelelik kullanmaz, yalnizca girdisine
 * bakar. Boylece tarayici olmadan `node --test` ile dogrulanabilir.
 */

/** XAUUSD standart lotu: 1 lot = 100 ons. */
const VARSAYILAN_KONTRAT = 100

/** Cogu brokerde en kucuk lot adimi. */
const VARSAYILAN_ADIM = 0.01

/**
 * Bir sayinin ondalik basamak sayisi.
 *
 * lotStep degeri ayarlardan ya da broker bilgisinden gelir; 0.01 olabilecegi
 * gibi 1e-7 gibi us gosterimiyle de yazilmis olabilir. Tam sayi aritmetigine
 * gecebilmek icin once kac basamakla calisacagimizi bilmemiz gerekir.
 * @param {number} sayi
 * @returns {number} ondalik basamak sayisi
 */
function ondalikBasamak (sayi) {
  const metin = String(sayi)
  const usIndeksi = metin.indexOf('e')
  if (usIndeksi >= 0) {
    const taban = metin.slice(0, usIndeksi)
    const us = Number(metin.slice(usIndeksi + 1))
    const nokta = taban.indexOf('.')
    const tabanBasamak = nokta >= 0 ? taban.length - nokta - 1 : 0
    return Math.max(0, tabanBasamak - (Number.isFinite(us) ? us : 0))
  }
  const nokta = metin.indexOf('.')
  return nokta >= 0 ? metin.length - nokta - 1 : 0
}

/**
 * Degeri adimin ALT katina yuvarlar (asagi dogru), kayan nokta hatasina
 * takilmadan.
 *
 * Neden duz `Math.floor(deger / adim) * adim` degil: ikisi de bozuk.
 * (a) 0.1 + 0.2 = 0.30000000000000004 ornegindeki gibi, tam 0.30 olmasi
 *     gereken bir bolum 29.999999999999996 cikip bir adim ASAGI dusuyor,
 *     yani kullanici hak ettigi lotun bir adim altinda islem aciyor.
 * (b) Carpim tarafinda da 0.07 yerine 0.07000000000000001 gibi degerler
 *     uretiliyor ve bu sayi ekranda ya da brokere giden emirde cirkin
 *     goruniyor.
 * Cozum: adimi tam sayiya cevirip bolmeyi tam sayi uzerinde yapmak, sonucu da
 * (adet * adimTam) / olcek seklinde tek bolmeyle uretmek. Tek bolme, ondaligin
 * en yakin cift duyarlikli karsiligini verir.
 *
 * Esik payi (epsilon) bilerek konuldu: girdinin kendisi zaten kayan noktali
 * bir hesabin sonucu oldugu icin, adim sinirinin bir tik altina dusen degerler
 * sinira yukari cekilir. Pay goreceli tutulur, boylece buyuk lotlarda da
 * anlamli kalir.
 * @param {number} deger
 * @param {number} adim
 * @returns {number} adimin tam kati olan deger (negatif girdide 0)
 */
function adimaYuvarla (deger, adim) {
  if (!Number.isFinite(deger) || !Number.isFinite(adim) || adim <= 0) return 0
  // 12 basamaktan otesi cift duyarlikta guvenilir tam sayi uretmez.
  const basamak = Math.min(ondalikBasamak(adim), 12)
  const olcek = Math.pow(10, basamak)
  const adimTam = Math.round(adim * olcek)
  if (!(adimTam > 0)) return 0

  const oran = (deger * olcek) / adimTam
  if (!Number.isFinite(oran) || oran <= 0) return 0
  const pay = Math.max(1e-9, oran * 1e-12)
  const adet = Math.floor(oran + pay)
  if (!(adet > 0)) return 0
  return (adet * adimTam) / olcek
}

/** Sayi mi ve sonlu mu. */
function sonlu (deger) {
  return typeof deger === 'number' && Number.isFinite(deger)
}

/** Gecersiz girdide donen, sekli bozulmamis sonuc. Cagiran taraf alan yoklamaz. */
function gecersizSonuc (sebep) {
  return {
    gecersiz: true,
    sebep,
    yon: null,
    lot: 0,
    riskUsd: 0,
    tp1KazancUsd: null,
    gerceklesenRiskPct: 0,
    yetersiz: false,
    enKucukLotRiskPct: 0,
  }
}

/**
 * Plandaki SL mesafesini hesabin buyuklugune gore lota cevirir.
 *
 * Yon SL'nin girise gore konumundan anlasilir: SL girisin altindaysa ALIS,
 * ustundeyse SATIS. Mesafe her iki yonde de mutlak deger olarak alinir.
 *
 * @param {object} girdi
 * @param {number} girdi.entry Giris fiyati, dolar/ons.
 * @param {number} girdi.sl Zarar durdur fiyati, dolar/ons. entry'ye esit olamaz.
 * @param {number} [girdi.tp1] Ilk hedef, dolar/ons. Yoksa tp1KazancUsd null doner.
 * @param {number} girdi.balance Hesap bakiyesi, dolar. Pozitif olmali.
 * @param {number} [girdi.riskPct=1] Islem basina goze alinan bakiye yuzdesi
 *   (1 = %1). Oran degil, yuzde.
 * @param {number} [girdi.contractSize=100] Bir lottaki ons sayisi, ons/lot.
 * @param {number} [girdi.lotStep=0.01] Broker lot adimi, lot.
 * @param {number} [girdi.minLot=lotStep] Brokerin kabul ettigi en kucuk lot.
 * @param {number} [girdi.costUsd=0] Gidis-donus islem maliyeti (spread +
 *   komisyon), dolar/ons. Olculdu: tipik XAUUSD spreadi bugun 0,30 dolar
 *   civari. Maliyet hem riske hem hedefe islenir, cunku her iki uctan da
 *   odenir.
 * @returns {{
 *   gecersiz: boolean,
 *   sebep: string|null,
 *   yon: ('AL'|'SAT'|null),
 *   lot: number,
 *   riskUsd: number,
 *   tp1KazancUsd: number|null,
 *   gerceklesenRiskPct: number,
 *   yetersiz: boolean,
 *   enKucukLotRiskPct: number
 * }} lot: adima yuvarlanmis pozisyon buyuklugu (lot); riskUsd: SL vurursa
 *   kaybedilecek dolar (maliyet dahil); tp1KazancUsd: TP1 vurursa kalan net
 *   dolar (maliyet dusulmus, plan tersse eksi olabilir); gerceklesenRiskPct:
 *   yuvarlama sonrasi gercekte alinan bakiye yuzdesi; yetersiz: en kucuk lot
 *   bile bu riskPct'ye sigmiyor; enKucukLotRiskPct: en kucuk lotla acilirsa
 *   bakiyenin yuzde kaci riske girer.
 */
export function pozisyonBoyutu (girdi) {
  const g = girdi || {}

  const entry = Number(g.entry)
  const sl = Number(g.sl)
  const balance = Number(g.balance)
  const riskPct = g.riskPct === undefined ? 1 : Number(g.riskPct)
  const contractSize = g.contractSize === undefined ? VARSAYILAN_KONTRAT : Number(g.contractSize)
  const lotStep = g.lotStep === undefined ? VARSAYILAN_ADIM : Number(g.lotStep)
  const costUsd = g.costUsd === undefined ? 0 : Number(g.costUsd)
  const minLotGirdi = g.minLot === undefined ? lotStep : Number(g.minLot)

  // Girdi dogrulamasi tek tek yapilir, cunku kullaniciya "neden hesaplayamadim"
  // diye yazacak olan panelin sebebe ihtiyaci var. Hepsi tek bir "gecersiz"
  // altinda toplanirsa ekranda anlamsiz bir bos kutu kalir.
  if (!sonlu(entry) || entry <= 0) return gecersizSonuc('Giriş fiyatı geçersiz.')
  if (!sonlu(sl) || sl <= 0) return gecersizSonuc('SL fiyatı geçersiz.')
  if (entry === sl) return gecersizSonuc('SL girişe eşit, mesafe yok.')
  if (!sonlu(balance) || balance <= 0) return gecersizSonuc('Hesap bakiyesi geçersiz.')
  if (!sonlu(riskPct) || riskPct <= 0) return gecersizSonuc('Risk yüzdesi geçersiz.')
  if (!sonlu(contractSize) || contractSize <= 0) return gecersizSonuc('Kontrat büyüklüğü geçersiz.')
  if (!sonlu(lotStep) || lotStep <= 0) return gecersizSonuc('Lot adımı geçersiz.')
  if (!sonlu(costUsd) || costUsd < 0) return gecersizSonuc('İşlem maliyeti geçersiz.')

  const yon = sl < entry ? 'AL' : 'SAT'

  // Ons basina risk: SL mesafesi + maliyet. Maliyeti riske katmak gerekir,
  // cunku SL vurdugunda spread de odenmistir; katmayan hesap her islemde
  // riski oldugundan az gosterir.
  const onsBasiRisk = Math.abs(entry - sl) + costUsd
  if (!(onsBasiRisk > 0)) return gecersizSonuc('SL mesafesi hesaplanamadı.')

  // Bir lotun tasidigi dolar riski. Bolen burada sifir olamaz: yukaridaki
  // dogrulamalar ikisini de pozitif garanti etti.
  const lotBasiRisk = onsBasiRisk * contractSize
  const riskButcesi = balance * (riskPct / 100)

  // Brokerin en kucuk lotu: minLot verilmemisse ya da adimdan kucukse, adim
  // zaten alt sinirdir. Boylece minLot 0 gelse bile "0 lot islem" gibi
  // anlamsiz bir sonuc uretmeyiz.
  const enKucukLot = Math.max(sonlu(minLotGirdi) && minLotGirdi > 0 ? minLotGirdi : 0, lotStep)
  const enKucukLotRiskPct = (enKucukLot * lotBasiRisk) / balance * 100

  const hamLot = riskButcesi / lotBasiRisk
  // ASAGI yuvarlanir, cunku yukari yuvarlamak riski butcenin ustune cikarir.
  const lot = adimaYuvarla(hamLot, lotStep)

  if (lot < enKucukLot) {
    // Hesap bu plan icin kucuk. Lot buyutmek yerine durumu soyluyoruz: en
    // kucuk lotla girmek bakiyenin yuzde kacini riske atardi.
    return {
      gecersiz: false,
      sebep: null,
      yon,
      lot: 0,
      riskUsd: 0,
      tp1KazancUsd: null,
      gerceklesenRiskPct: 0,
      yetersiz: true,
      enKucukLotRiskPct,
    }
  }

  const riskUsd = lot * lotBasiRisk
  const gerceklesenRiskPct = (riskUsd / balance) * 100

  // TP1 istege bagli. Yon bilindigi icin mutlak deger kullanilmaz: hedef yanlis
  // tarafa konmussa sonuc EKSI cikar ve plan bozuklugu ekranda gorunur, mutlak
  // deger bunu sahte bir kazanca cevirirdi.
  let tp1KazancUsd = null
  const tp1 = Number(g.tp1)
  if (sonlu(tp1) && tp1 > 0) {
    const onsBasiKazanc = (yon === 'AL' ? tp1 - entry : entry - tp1) - costUsd
    tp1KazancUsd = lot * contractSize * onsBasiKazanc
  }

  return {
    gecersiz: false,
    sebep: null,
    yon,
    lot,
    riskUsd,
    tp1KazancUsd,
    gerceklesenRiskPct,
    yetersiz: false,
    enKucukLotRiskPct,
  }
}
