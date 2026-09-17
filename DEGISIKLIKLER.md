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
| Tek ayar birlestirme (`presets.resolveCfg`) | Tarama, test ve canli ayni esikleri ve ayni hedefi kullanir. Katman sirasi: cekirdek varsayilani, zaman dilimi hazir ayari, kullanicinin yamasi. |
| Ayar dosyasi yalnizca degisiklikleri tutuyor | Dokunulmayan alanlarda hazir ayar gercekten devreye giriyor, cekirdek varsayilan degisiklikleri kullaniciya ulasiyor. |
| Hafizanin ayar izi (`cfgHash`) | Hafiza hangi indikator ayari ve etiket tanimiyla kuruldugunu saklar. Ayar degisip tarama yapilmazsa canli sinyal uretilmez, test sonucu "eski ayara ait" diye isaretlenir. |
| Kalici test ozeti (`<ad>_memory.backtest.json`) | "Hangi ayarla ne olculdu" bilgisi uygulama kapaninca kaybolmuyor; Test paneli fiilen kullanilan ayari gosteriyor. |
| Yapi damgasi olcume baglandi | Tarama ve test ciktilari uretildikleri commit ve kaynak ozetini tasir; kirli calisma agaci basligta gorunur, paketleme kirli agacta durur. |
| Gercekci dokunus giris modeli | Karar bar kapanisinda, giris kapanistan SONRA: kenara limit emir, dolmazsa islem yok ('nofill'). Dolum orani raporlanir. |
| Tek kazanc tanimi (`tradeResult`) | Test, taban orani ve ileride canli gunluk ayni fonksiyonu kullanir. Zaman asimi ufuk sonu kapanisiyla degerlenir. |
| Tur bazli taban ve katki | Ozet ve tablolar katkiyi hem puan hem net ATR olarak, AYNI turun tabanina gore gosterir. |
| Sonuc zamanina gore ambargo | Bir olay, sonucu henuz belli degilken baska bir olaya komsu olamaz. |
| Tur ve yon basina isinma | Sabit 500 olay yerine "ayni tur ve yonden en az N aday"; orneklem yetersizse sayi yerine uyari. |
| Pine aralik kirpmasi | Indikator ayarlari Pine input araliklarina kirpilir, kirpilanlar raporlanir. |
| Istatistik modulu (`src/core/learn/stats.js`) | Wilson araligi, binom testi, gunluk blok onyukleme, permutasyon, kalibrasyon ve Brier skoru. Test ozeti artik belirsizligi de gosterir. |
| Kalibrasyon tablosu | "Sistem %62 dedi, gerceklesen %50" gibi sapmalar ekranda gorunur. |
| Maliyet ve kayma ayari (`backtestCfg`) | Kendi spreadini girebilirsin; maliyet kirilimi, maliyet iki kat duyarliligi ve maliyet dahil basa bas isabet raporlanir. |
| Tekrarlanabilir olcum betigi (`scripts/measure-all.mjs`) | Tum zaman dilimlerini tek komutla olcup istatistikli tablo basar (`--scan`, `--json`). |

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
- **Test sekmesi baska bir sistemi olcuyordu.** Esikler ve isinma degeri
  motora hic ulasmiyordu (yuk bicimi uyusmazligi), yani olculen sey
  kullanicinin canlida kullandigi sistem degildi.
- **Ayni dokunus uc farkli hedefle degerlendiriliyordu.** Tarama kullanicinin
  hedefiyle etiketliyor, test hazir ayarin hedefiyle olcuyor, canli ise
  varsayilan hedefle plan kuruyordu. Artik hepsi hafizanin etiket hedefini
  kullanir.
- **Tarama kullanicinin olcumunu siliyordu.** Her yeni barda otomatik tarama
  basliyor ve test sinyalleriyle ozeti siliyordu. Artik yalnizca ayar izi
  degistiyse silinir.
- **Dokunus olayinda bar ici ileriye bakma vardi.** Karar bar kapanisindaki
  bilgiyle veriliyor, giris ayni barin ICINDE kenardan dolmus sayiliyordu.
  Karli gorunen alt kumeler gercekci girisle cokuyordu.
- **Zaman asimi tam zarar sayiliyordu.** Ufuk sonunda sifira yakin kapanan
  islemler -1R gibi yaziliyor, net beklenti 2-4 kat kotu gorunuyordu.
- **Taban orani turleri karistiriyordu.** Ekranda +9 ile +13 puan katki
  gorunuyordu; ayni turun tabaniyla gercek fark -1,5 ile +6 puan arasinda.
- **Ambargo olay zamanina bakiyordu**, sonucun belli oldugu zamana degil.
- **Birlestirme kurali Pine'dan farkliydi**: mesafe yeni kutunun ortasindan
  olculuyor ve ilk eslesmede duruluyordu.

## Depoda yapilan tek seferlik islemler

- 2026-09-17: `data` klasorunun tam yedegi alindi (`data.yedek-...`).
- Vekil bolum kesildi (2026-08-02 sonrasi 29.213 bar), Agustos 2026 HistData
  spot verisiyle dolduruldu.
- Yaz saati gocu uygulandi (3.839.177 bar), turetilmis zaman dilimleri
  yeniden uretildi. Dogrulama: Binance ile getiri korelasyonunun tepe noktasi
  artik gecikme 0'da.
- Olcum duzeltmelerinden sonra 1m, 5m, 15m, 1h ve 4h hafizalari yeniden
  tarandi (2026-09-17).

## Olculen son durum (2026-09-17, duzeltmelerden sonra)

Kullanicinin kayitli ayarlariyla (benzerlik 0,80, en az 5 eslesme, en az
tutma %60, en az R/R 0,8, hedef 1,5 ATR) yuruyen ileri test:

| TF | olay | sinyal | isabet | ayni tur tabani | katki | net/islem | taban net |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1m | 41.260 | 3.705 | %50,6 | %49,4 | +1,2 puan | -0,229 ATR | -0,241 ATR |
| 5m | 13.680 | 990 | %47,7 | %45,9 | +1,8 puan | -0,084 ATR | -0,141 ATR |
| 15m | 5.781 | 124 | %39,5 | %39,3 | +0,3 puan | -0,167 ATR | -0,120 ATR |
| 1h | 1.471 | 122 | %54,1 | %47,9 | +6,2 puan | **+0,103 ATR** | -0,071 ATR |
| 4h | 490 | 0 | - | - | - | - | - |

Notlar: 1h ilk kez pozitif net beklenti veriyor ama 122 islemle guven araligi
henuz hesaplanmadi (bir sonraki adim). 15m sistemin tabandan kotu oldugu tek
zaman dilimi. 4h'de hafiza istatistik icin yetersiz.
