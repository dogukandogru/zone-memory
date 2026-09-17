# Degisiklikler

Bu dosya, 2026-09 incelemesinden sonra yapilan islerin genel kaydidir.
Amac: orijinal fikrin uzerine NE eklendigini ve hangi hatalarin duzeltildigini
tek bakista gormek. Ayrintili plan ve madde kodlari (K1, O2, V1 gibi) yol
haritasi sayfasindadir; her maddenin durumu orada tutulur.

## Orijinal fikir (degismedi)

XAUUSD'de "proje son versiyon 3" indikatorunun hacimli asirilik kutulari
yeniden uretilir. Her kutudan iki olay cikar: kutunun dogdugu an (olusum) ve
kutuya ilk dokunus. Butun gecmis bu olaylarla etiketlenir (bolge tuttu,
kirildi, zaman asimi), olay aninin parmak izi saklanir ve canlida yeni bir
olay geldiginde ayni turdeki en benzer gecmis olaylarla karsilastirilip
"gecmiste bu yapi %X tuttu" denir. Emir gonderilmez, karar destek aracidir.

## Eklenen yeni ozellikler

| Ne | Ne ise yarar |
| --- | --- |
| Kural tabanli piyasa takvimi (`session.createMarketCalendar`) | Spot altinin acik oldugu saatleri New York kuralindan hesaplar. Vekil kaynaklarin (PAXG, XAUT) 7/24 uretti bi barlari boylece elenir. |
| Tek vekil duzeltme yolu (`loader.normalizeProxy`) | Fiyat kaydirmasi, hacim olcegi ve piyasa saati suzgeci tek yerde uygulanir. Duzeltme hesaplanamazsa bar yazilmaz. |
| Vekil aralik kaydi (`XAUUSD_<tf>.proxy.json`) | Hangi donemin vekil veriyle doldugunu tutar, o donem sonra spot veriyle degistirilebilir. |
| Depo onarim betigi (`scripts/repair-proxy.mjs`) | Vekil kaynakla yazilmis bolumu bulur, yedek alip keser, turetilmis zaman dilimlerini 1m'den yeniden uretir. |
| Yaz saati goc betigi (`scripts/fix-dst.mjs`) | Eski ayristiricinin 1 saat kaydirdigi barlari tek seferde duzeltir, isaret dosyasi ile iki kez calismayi engeller. |
| Veri doktoru (`src/core/data/doctor.js`, `scripts/data-doctor.mjs`, `data:doctor`) | Ic bosluklar, aylik kapsama, hafta sonu ve sifir hacimli barlar, hacim rejimi kirilmalari raporu. |
| Dusuk kapsama korumasi | Penceresinde veri boslugu olan olaylar hafizaya alinmaz (`stats.lowCoverage`). |
| Canli akista bosluk uyarisi (`live:gap`) | Bar yazilamadiginda arayuz eksik donemi kendiliginden indirir. |
| Ayar sinir denetimi (`settings.SINIRLAR`) | Aralik disi veya bos esikler diske yazilmaz, arayuzde kaydetme kilitlenir. |
| Yikici islemlerde onay | Hafiza silme ve varsayilanlara donus onay ister; sifirlama API anahtarlarini ve saglayici secimini korur. |
| Depo butunlugu testi (`test/repo.test.js`) | Kaynak kodun yanlislikla `.gitignore` ile disarida kalmasini yakalar. |

## Duzeltilen hatalar (olcumu veya veriyi etkileyenler)

- **Ayarlar kaydedilmiyordu.** Arayuz ciplak yama gonderiyor, IPC yalnizca
  `{patch}` taniyordu; sonucta `save({})` calisiyor ve ekranda "kaydedildi"
  yaziyordu. Artik uc yuk bicimi de tek yerde cozuluyor ve kayit dogrulaniyor.
- **Veri katmani git'te yoktu.** `.gitignore` icindeki `data/` kurali
  `src/core/data` klasorunu de yok sayiyordu (8 dosya, 2071 satir).
- **Canli mod bozuk bar yaziyordu.** Duzeltme hesaplanamadiginda ham vekil
  barlar depoya giriyor, bir kez girince duzeltme kalici olarak kapaniyordu.
- **Acik bar depoya yaziliyordu.** Kapanmis bar olcutu artik cekim anina gore
  (`series.closedEndIndex`), isci mesgulken yarim bar yazilmiyor.
- **HistData saatleri 1 saat kayikti.** Dosya saatleri sabit UTC-5 sayiliyordu;
  gercekte yaz saati uygulaniyor ve kural 2019'da degismis. Depodaki barlarin
  %63'u etkilenmisti.
- **Veri Cek bos tur atiyordu.** Gecmise dogru tarama artik yalnizca acikca
  istenirse yapilir.

## Depoda yapilan tek seferlik islemler

- 2026-09-17: `data` klasorunun tam yedegi alindi (`data.yedek-...`).
- Vekil bolum kesildi (2026-08-02 sonrasi 29.213 bar), Agustos 2026 HistData
  spot verisiyle dolduruldu.
- Yaz saati gocu uygulandi (3.839.177 bar), turetilmis zaman dilimleri
  yeniden uretildi. Dogrulama: Binance ile getiri korelasyonunun tepe noktasi
  artik gecikme 0'da.
- Hafizalarin yeniden taranmasi gerekiyor (olcum duzeltmeleri bittikten sonra
  tek seferde yapilacak).
