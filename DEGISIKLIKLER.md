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
| Aday komsu onbellegi (`learn/candcache.js`) | Komsular esikten bagimsiz oldugu icin bir kez hesaplanip diske yazilir. 1m testi 199 sn yerine 2,1 sn. Esik aramasi boylece pratik hale geldi. |
| Kalibre edilmis oran (onsel 20) | Gosterilen oran havuzun taban oranina dogru cekilir: "5 kayittan 4'u tuttu, %80" artik %80 diye gosterilmiyor. |
| Esik arama araci (`scripts/search-params.mjs`) | Izgara gecmis bir dilimde denenir, secilen ayar yalnizca sonraki dilimde raporlanir. Kac ayar denendigi de basilir. |
| Testin degerlendirme penceresi (`evalFromTime` / `evalToTime`) | Ayni kosuda donemi ikiye bolup secim ve dogrulama dilimini ayirir; pencere disi olaylar hafiza olmaya devam eder. |
| AUC olcutu (`stats.auc`) | "Verilen oran kazananla kaybedeni ayirabiliyor mu" sorusu, esiklerden bagimsiz olarak olculur. |
| Agirlik calismasi (`scripts/weight-study.mjs`) | On bir benzerlik agirligi AUC ve "en iyi 1/5 dilim" ile karsilastirilir. |
| Skor bilesenleri tablosu (`summarize().byPart`) | Her bilesenin ayirt etme gucu, kendi %95 araligiyla Hafiza panelinde gorunur. |
| Zaman agirligi secenegi (`halfLifeYears`, `baseWindowYears`) | Eski eslesmeler hafifletilebilir, kalibrasyon tabani son yillara sinirlanabilir. Varsayilan kapali, olculdu, fayda gorulmedi. |
| Ekonomik takvim (`src/core/calendar.js`) | Kullanicinin koydugu CSV ile "yuksek etkili veri penceresi" alt kumesi olculur; canlida uyari gosterilir. Kapi varsayilan kapali. |
| Ust zaman dilimi baglami (`learn/htfContext.js`) | Indikator kutu durumu ARALIKLARI uretir; "o an bu kutu bu sinirlarla biliniyor muydu" sorusu ileriye bakmadan cevaplanir. Olcum amacli, sinyale katilmaz. |
| Cok boyutlu alt kume kirilimi (`cfg.subsetOf`) | Ayni kosuda birden fazla boyut (veri penceresi, ust TF bolgesi) her biri kendi tabaniyla olculur. |
| Ulasilmaz esik uyarisi | "En az eslesme 5 + onsel 20 + en az tutma %60" gibi hic sinyal uretemeyen birlesimler Ayarlar'da yaziyla bildirilir. |

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
- **kNN on elemesi en iyi komsulari kacirabiliyordu**: on eleme yalnizca sekil
  benzerligine bakiyor, nihai skor ise baglami da sayiyordu.
- **Az eslesmeli oran oldugu gibi gosteriliyordu.** "5 kayittan 4'u tuttu"
  ekranda %80 diye cikiyordu; olculdu, sistem %70-80 dediginde gerceklesen
  %37,5 ve Brier skoru sabit taban tahmininden kotuydu.
- **TP2 sessizce TP1'e esitleniyordu.** 5m'de tetiklenen formlarin %19,6'sinda
  ekranda ayni fiyat iki kez goruluyordu. Artik uzatma hedefi yoksa satir hic
  gosterilmiyor (yeniden olculdu: oran 0).
- **"Beklenen lehte hareket" tum ufku olcuyordu**, yani stop vurulduktan
  sonraki hareketi de sayiyor ve TP1'in 2,5 katina cikabiliyordu.
- **"Beklenen aleyhte hareket" iki ayri seyi gosteriyordu**: testte plan riski,
  canlida benzerlerin ortalama aleyhte hareketi.
- **Zaman asimi "Kirilim" diye gosteriliyordu.** 15m'de form basarisizliklarinin
  %26'si zaman asimi, yani bolge kirilmadi.
- **Sekil kumeleri karara katiliyor gibi gorunuyordu.** Gerekcede "En yakin
  ortak yapi" yaziyordu; olculdu, kumelerin orani hafiza tabanindan ayirt
  edilemiyor. Karardan cikarildi.
- **Seans skor bileseni maxScore'u sisiriyordu.** Dort seans da acikken her
  olayda 1 cikiyordu, yani "5 bilesenden 3'u" diye okunan esik gercekte
  "4 bilesenden 2'si" oluyordu.
- **"Ust zaman dilimi trendi" ayni zaman diliminden geliyordu.** trendTf
  varsayilani sabit 15m oldugu icin 15m grafikte bilesen kendi EMA'sini
  soruyordu; bu, 42 olayda -14,3 puanlik sahte bir ayirt etme uretiyordu.
- **Seans ve saat ozellikleri Istanbul saatine bagliydi.** Turkiye 2016'da yaz
  saatini biraktigi icin Londra'nin 08:00 acilisi 2016 oncesi yerel 10:00,
  sonrasinda kislari 11:00 oluyordu; kNN ayni piyasa anini iki farkli saat
  olarak goruyordu. Artik Europe/Athens (ekrandaki saatler degismedi).
- **Onbellekli test yolu havuz tabanini tasimiyordu**, bu yuzden kalibrasyon
  iki yolda farkli cikiyordu.

## Depoda yapilan tek seferlik islemler

- 2026-09-17: `data` klasorunun tam yedegi alindi (`data.yedek-...`).
- Vekil bolum kesildi (2026-08-02 sonrasi 29.213 bar), Agustos 2026 HistData
  spot verisiyle dolduruldu.
- Yaz saati gocu uygulandi (3.839.177 bar), turetilmis zaman dilimleri
  yeniden uretildi. Dogrulama: Binance ile getiri korelasyonunun tepe noktasi
  artik gecikme 0'da.
- Olcum duzeltmelerinden sonra 1m, 5m, 15m, 1h ve 4h hafizalari yeniden
  tarandi (2026-09-17).
- Skor bileseni ve seans saati duzeltmelerinden sonra 1m, 5m, 15m, 1h ve 4h
  hafizalari BIR KEZ DAHA tarandi (2026-09-19).

## Olculen son durum (2026-09-19, kalibrasyon ve skor duzeltmelerinden sonra)

Kutudan cikan varsayilan esiklerle (benzerlik 0,80, en az 15 eslesme, en az
tutma %62, kalibrasyon onseli 20) yuruyen ileri test:

| TF | olay | sinyal | isabet [%95] | ayni tur tabani | katki | p | net/islem [%95] |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1m | 41.446 | 282 | %49,6 [43,9, 55,4] | %49,5 | +0,2 puan | 1,00 | -0,247 [-0,491, -0,014] |
| 5m | 13.729 | 733 | %44,9 [41,3, 48,5] | %45,9 | -1,1 puan | 0,58 | -0,209 [-0,361, -0,051] |
| 15m | 5.801 | 22 | %40,9 [23,3, 61,3] | %39,4 | +1,5 puan | 1,00 | -0,104 [-0,870, +0,702] |
| 1h | 1.481 | 86 | %48,8 [38,6, 59,2] | %47,8 | +1,0 puan | 0,91 | -0,128 [-0,570, +0,279] |
| 4h | 491 | 0 | - | - | - | - | yetersiz hafiza |

**Onemli bir ders.** 17 Eylul olcumunde 1h satiri +6,2 puan katki ve +0,103 ATR
net gosteriyordu. O sayi bir DUZELTMEYE dayanamadi: seans ve saat ozellikleri
Atina saatine tasinip "ust zaman dilimi trendi" gercekten ust dilimden
hesaplaninca ayni olcum +1,0 puana indi. Yuz civari islemde gorunen bir fark,
ozellik tanimindaki bir degisiklige dayanmiyorsa gurultudur.

Ayrica olculen uc sey:

- **Siralama gucu var, para kazanci yok.** kNN'in verdigi oran kazananlari
  kaybedenlerden ayirabiliyor (dogrulama diliminde AUC 1h'de 0,68, 5m'de 0,62,
  15m'de 0,57) ama en iyi %20 dilimin net sonucu yalnizca 1h'de sifir civari,
  5m ve 15m'de negatif. Yani darbogaz benzerlik motoru degil, islem planinin
  geometrisi ve maliyet.
- **Skorun hicbir bileseni dogru yonde ayirt etmiyor.** 15m dokunusta fitil
  reddi -8,9 puan, hacim -5,3 puan ile TERS yonde ayiriyor. Arayuz artik
  "Sinyal / Kayit" demiyor, "esik gecti / esik alti" diyor.
- **Ust zaman dilimi uyumu naif zamanlamayla sahte katki uretiyor.** 15m
  olusum olaylari icin "ayni yonlu 4h bolgesi yakin" naif zamanlamayla %45,6
  (taban %42,4), dogru zamanlamayla %30,3 (taban %42,8). Ozellik bu yuzden
  sinyale baglanmadi.

## Kanitlanmamis ama kodda duran secenekler (varsayilan kapali)

Bunlarin hepsi olculdu ve dogrulama diliminde yeterli iyilesme gostermedigi
icin KAPALI birakildi. Kendi verinizle tekrar olcup acabilirsiniz:

| Secenek | Nasil olculur | Bugunku sonuc |
| --- | --- | --- |
| `minLift` (asgari katma deger) | `scripts/search-params.mjs` | Hicbir esik dogrulama diliminde sifirin ustunde alt sinir vermedi |
| `halfLifeYears`, `baseWindowYears` (zaman agirligi) | `scripts/search-params.mjs --ablation` | En iyi kazanc 0,002 Brier, olcum hatasinin icinde |
| `newsBlackoutMin` (veri penceresi kapisi) | Takvim dosyasi + Test sekmesi alt kume tablosu | Takvim kullanicinin sorumlulugunda; ornek sayisi kucuk |
| Ust TF uyumu | Test sekmesi "Ust TF bolgesi" tablosu | Katki yok, hatta ters yonde |
