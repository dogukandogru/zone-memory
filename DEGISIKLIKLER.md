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
| Hacim oran eslestirmesi (`loader.hacimOranEslemesi`) | Vekil kaynagin hacim ORANI dagilimi spot seriye tasinir. Sabit olcek kutu kapisini hic degistirmiyordu. |
| Basis kalite olcumu (`loader.basisOlcumu`) | Ortak bar sayisi ve medyan mutlak sapma; tutmazsa bar yazilmaz. |
| Hacim rejimi korumasi | Canlida kutu kapisi referansin 1,5 katini asarsa sinyal uretilmez. |
| Kuyruk dosyali depo (`<ad>.bin.tail.bin`) | Bar ekleme 354 ms yerine 3,8 ms; ana dosya bayt bayt ayni kaliyor. |
| Depo yazim kilidi ve dogrulamasi | Dosya yolu bazli mutex, surec kimlikli gecici ad, boyut ve zaman denetimi, rename sonrasi fsync. |
| Artimli HistData indirmesi (`onChunk`) | Her ay geldikce depoya yaziliyor; tek ag hatasi saatleri kaybettirmiyor. |
| Turetilmis dosya kaynak izi (`<ad>.bin.meta.json`) | Zaman dilimi dosyalari 1 dakikalikla ayrisirsa kendiliginden tazeleniyor. |
| Canli yalnizca 1 dakikalige yaziyor | Grafik zaman dilimi ondan turetiliyor, dosyalar ayrisamiyor. |
| Seans capali kova secenegi (`resample(..., {capa:'seans'})`) | 4 saatlik ve gunluk kovalar New York acilisindan sayilabiliyor (varsayilan kapali). |
| API anahtari ana surecte ekleniyor | Veri Cek artik Polygon ve Twelve Data ile calisiyor; anahtar renderer'a hic gitmiyor ve URL yerine baslikta gidiyor. |
| Canli kuyruk penceresi (`requiredTailBars`) | Ust zaman dilimi EMA'si isiniyor, canli olay hafizadakiyle ayni cikiyor. |
| Canli saglik gostergesi | Uc renk, "son veri 35 sn once" metni ve ayrintili ipucu; piyasa kapaliyken uyari vermiyor. |
| Kalici gunluk dosyasi (`logs/zone-memory-YYYY-MM-DD.log`) | Hatalar yigin iziyle diske yaziliyor, 14 gun saklaniyor, menuden acilabiliyor. |
| Canli oturum kimligi | Durdur/baslat ve zaman dilimi degisiminde eski turun sonucu kullanilmiyor. |
| Masaustu bildirimi (`src/main/notify.js`) | Yalnizca tetiklenen, gecikmemis ve kanitli sinyallerde; tiklayinca sinyali aciyor. |
| "O ana kadar goster" kipi (`#asOfToggle`) | Gecmis sinyal incelenirken ekran o andan sonrasini gostermiyor: sonraki mum, sonraki isaret ve kutularin bugunku hali gizli. |
| Bolge omru arayuzde ayri durum | "Aktif" artik kirilmamis VE omru dolmamis demek; omru dolan kutu "Süresi doldu" yaziyor. |
| Alt serit mesaj gecmisi (`#messageLog`) | Son 50 mesaj saklaniyor, hata 12 saniye boyunca ezilmiyor, hata varken motor satiri kirmizi kaliyor. |
| Klavye kisayollari | Esc, J/K (onceki/sonraki sinyal), 1-6 zaman dilimi, L canli, End guncele don. |
| Isaret anahtari (`#chartMarkerKey`) | Grafikteki "OL"/"DK" oneklerinin ne demek oldugu artik grafigin kosesinde yaziyor. |
| Pine kaynagi depoda (`docs/pine/son_pro.pine`) | Portun neye gore yazildigi artik indirilenler klasorunde degil, surum kontrolunde. |
| Disa aktarim betigi (`docs/pine/son_pro_export.pine`) | Ayni mantik, kutu cizmez; her barda aktif kutu sayisini ve toplamlari yayinlar, TradingView'den CSV olarak alinabilir. |
| TradingView sadakat testi (`test/tv-parity.test.js`) | Fixture konunca portu BAR BAR karsilastirir; fixture yoksa kendini atlar ve nasil uretilecegini yazar. |
| Veri kaynagi karsilastirmasi (`scripts/tv-compare.mjs`) | TradingView mumlari ile deponun mumlari ayni indikatorden gecirilip kutu kumeleri eslestirilir; eksik kutularin kaci HACIM kapisinda takildigi raporlanir. |
| Indikator iz kancasi (`runIndicator(..., trace)`) | Her barin sonunda aktif kutu listesini verir; verilmezse maliyeti yoktur. |
| Ileriye bakma sizinti testi (`test/leak.test.js`) | Karar barindan sonraki barlar bozulunca olay alanlarinin degismedigini kilitler. |
| Bagimsiz Pine referansi (`test/helpers/pineRef.js`) | Kutu mantigi Pine metninden AYRICA yazildi; port onunla karsilastiriliyor. |
| OANDA saglayicisi (`src/core/data/oanda.js`) | Spot XAU_USD ve tick hacmi; kullanicinin TradingView'da baktigi akisin kendisi. Gecmis 2006'ya gider, ucretsiz deneme hesabi yeterli. |
| SNIPER sinyali (`signalOnSniper`) | Guncel indikatorun KENDI sinyali porta eklendi: supurme, fitil reddi, MSS, EMA trend ve bilesik skor. Eski surumde Pine hic sinyal uretmiyordu. |
| Kirilan kutu artik SILINMIYOR (`showBrokenZones`) | Guncel indikatorde kirilan kutu takipte kalir, soluklasir ve `born + boxLengthBars`a kadar uzamaya devam eder. Kutu omru 100 yerine 600 bar, kirilmis kutuya birlesen pivot onu diriltiyor. |
| Pakete gomulu API anahtari (`src/main/apiKeys.local.json`) | Musteriye kurulu halde teslim edilen yapida anahtar hazir gelir. Dosya git'te degildir. SIR SAKLAMA DEGILDIR: asar sifrelenmemistir, kuran herkes anahtari cikarabilir. |
| Kuruluma gomulu veri (`build/bundled-data` + `src/main/firstrun.js`) | Mum deposu ve hafiza kurulumun icinde geliyor, ilk acilista yerine konuyor. Musteri saatlerce indirip taramak zorunda degil. Var olan verinin USTUNE YAZILMAZ. |
| Tek komutla teslim paketi (`scripts/prepare-dist.mjs`) | Anahtari yazar, veriyi yedekler haric toplar, ayar yamasini ekler, paketler. Elle dosya olusturmak ve klasor kopyalamak gerekmiyor. |
| Ayar yamasi da paketleniyor | Hafiza, paketi hazirlayan makinenin ayarlariyla kuruldu ve kendi izini tasiyor; ayarlar gitmezse musteride iz tutmuyor ve gonderilen olcum siliniyor. |
| Otomatik guncelleme (`src/main/updater.js`) | Musteri uygulamayi acinca yeni surum var mi bakilir, varsa arka planda indirilir; KURULUM kullaniciya sorulur, cunku kurulum uygulamayi kapatir ve suren bir taramayi cope atardi. Veriye dokunmaz. |
| Surum yayinlama is akisi (`.github/workflows/release.yml`) | `v*` etiketi atilinca gercek Windows kosucusunda derlenip GitHub Releases'a yuklenir. Testler gecmeden surum cikmaz. |
| Alt seritte gorunur surum (`#statusVersion`) | Musteri guncellemenin gelip gelmedigini, biz de hangi surumde sorun oldugunu baska turlu anlayamiyorduk. Gelistirme ve commit edilmemis kod ayrica isaretleniyor. |

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
- **Vekil kaynagin hacim dagilimi duzeltilmiyordu.** Kutu kapisi bir ORANDIR
  (hacim / SMA50), sabit bir olcekle carpmak onu hic degistirmez. Olculdu:
  ham PAXG'de kapi %12,27 oraninda aciliyor, spot referansinda %3,13.
- **Canli 1 barlik ekleme 293 MB dosyayi bastan yaziyordu** (354 ms, gunde
  yaklasik 400 GB disk yazimi).
- **Veri Cek API anahtarini hic almiyordu**: Polygon ve Twelve Data secilince
  senkron her zaman "anahtar gerekli" hatasi veriyordu.
- **Turetilmis zaman dilimi dosyalari 1 dakikalikla ayrisiyordu** (5m 323 bar
  geride, 15m'de 181 fazla / 95 eksik bar) ve yukleyici bunu hic fark
  etmiyordu.
- **Canli gosterge hata durumunda da yesil kaliyordu**: "sinyal yok" ile
  "akis olmus" ayirt edilemiyordu.
- **Canli tik iki await noktasinda yaris durumuna aciykti**: durdur/baslat ya
  da zaman dilimi degisiminde eski turun barlari yeni zaman diliminin
  etiketiyle yazilabiliyordu.
- **extendMemory hic cagrilmiyordu** ama belgeler artimli guncelleme vaat
  ediyordu; baglansa bar indeksleri kayardi.
- **Sekil penceresi artik ayarlanabiliyor.** Gecmiste benzer kurulum
  aranirken seklin KAC BARA baktigi kodda 32 olarak sabitti; kullanici
  "sadece cok kisa oncesine bakiyor" dedi ve haklıydı. Ayarlar'dan 16 ile 512
  arasinda secilebiliyor (5 dakikalikta 32 bar ~2,5 saat, 96 bar ~8 saat).
  Sekil her zaman 16 noktadir; pencere buyudukce her nokta daha cok barin
  ortalamasi olur, yani daha genis ama daha kaba bir bicim karsilastirilir.
  KASITLI SINIR: yalnizca SEKIL penceresi degisir, getiri vektoru 32 kalir.
  Uzunlugu degisseydi hafiza dosyasinin satir boyu degisir, eski dosyalar
  okunamaz hale gelirdi.
  Ayar izine dahil: degisince yeniden tarama ve olcum kendiliginden isteniyor.
- **"Neye gore benzetti" karsilastirmasi.** Sinyal ayrintisinda "en benzer
  gecmis ornekler" listesi vardi ama benzerligin NEREDEN geldigi
  gorunmuyordu: yalnizca bir sayi (0,942) vardi ve o sayinin sekilden mi
  baglamdan mi geldigi, sekillerin gercekten ne kadar ortustugu belli
  degildi. Bir ornege tiklayinca satirin altinda acilip kapanan bir
  karsilastirma geliyor. Egriler GRAFIGIN UZERINDE, gercek mumlarin uzerine
  ve gercek fiyatlara cizilir: yesil duz cizgi simdiki kurulum, sari kesikli
  cizgi secilen ornek. Panelde ayrica benzerlik dokumu (hangi bilesen hangi
  agirlikla toplama katildi) ve baglam degerlerinin yan yana karsilastirmasi
  durur.
  Ilk surumde egri panelde kucuk bir kutuda ciziliyordu ve kullanici onu
  grafikle bagdastiramadi. Hakliydi: sekil vektoru mumlarin birebir kopyasi
  degil, son 32 kapanisin 5 barlik ortalamayla yumusatilmis, 16 kovaya
  indirgenmis halidir. Iki ayri resmi zihinde ust uste koymak gerekiyordu.
  Egriler artik mumlarin uzerinde, her nokta isaretli ve ekranda "her nokta
  ikiser barin ortalamasidir" diye yaziyor. Agirligi sifir olan bilesenler de listeleniyor ama katkisi
  "-" yaziyor; neye BAKILMADIGI da gorunmeli.
  Olaylar zamanla bulunuyor, kimlikle degil: ozellik mevcut sinyal
  dosyalariyla da calisiyor, listeyi yeniden hesaplamak gerekmiyor.
- **Yakinlastirmisken sinyale tiklayinca grafik bos gorunuyordu.** Fiyat
  eksenini elle surukleyip yakinlastirinca kutuphane o eksenin otomatik
  olceklemesini kapatiyor ve araligi sabitliyor. Sonra baska bir tarihe
  atlayinca o tarihin fiyatlari sabitlenmis araligin disinda kaliyor, yani
  mumlar ekranin disinda ciziliyordu; ancak elle uzaklasinca goruluyordu.
  Sinyale atlarken dikey olcek artik yeniden otomatige aliniyor. Yatay
  yakinlastirma korunuyor.
- **Benzerlik neye baksin, artik Ayarlar'dan secilebiliyor.** Gecmiste benzer
  kurulum aranirken neye bakilacagi bugune kadar kodda sabitti (sekil %60,
  baglam %25, getiri %15). Alti secenek var: yalnizca gorsel sekil, agirlikla
  sekil, dengeli, agirlikla baglam, yalnizca baglam, ozel. VARSAYILAN
  "yalnizca gorsel sekil".
  Olculdu (dogrulama dilimi, esikler kullanilmadan, olcut AUC): 5m'de yalniz
  sekil 0,6155 ve yalniz baglam 0,6254; 15m'de 0,5899 ve 0,6055. Iki zaman
  diliminde de baglam arttikca tahmin iyilesiyor, yani varsayilan olarak
  secilen secenek olcumde en zayif olandir; fark kucuktur (0,01 AUC bandi).
  Sekil vektoru normalize edildigi icin hareketin ATR'ye gore buyuklugu, kutu
  genisligi, hacim patlamasi ve seans bilgisi sekilde YOKTUR, hepsi baglam
  tarafindadir.
  Ayar degisince sinyal listesi kendiliginden yeniden hesaplaniyor; ayni sey
  uygulamanin varsayilani surum yukseltmesiyle degistiginde de oluyor.
- **Olcum yenileme isareti fazla erken siliniyordu.** Isareti tarama biter
  bitmez siliyorduk, oysa olcumu asil yeniden kuran sey taramadan SONRA gelen
  testtir ve test en uzun adimdir. Kullanici test sirasinda uygulamayi
  kapatirsa isaret gitmis, olcum dosyalari da yedege tasinmis oluyordu;
  sonraki acilista hafiza guncel oldugu icin tarama hic calismiyor ve sinyal
  listesi KALICI olarak bos kaliyordu. Isareti artik test tuketiyor.
- **Hafta sonu acilista zaman dilimi dosyalari olusmuyordu.** Veri paketi
  turetilmis dosyalari siliyor, geri yazma ise yalnizca "yeni bar indirildi"
  kosuluna bagliydi. Piyasa kapaliyken saglayici sifir bar dondurdugu icin
  dosyalar silinmis kaliyor ve her acilista milyonlarca bar bastan
  orneklenmek zorunda kaliyordu. Eksik dosya artik yeni bar gelmese de
  uretiliyor.
- **Sebep yanlis soyleniyordu.** Veri kaynagi degistigi halde kullaniciya
  "Ayarlar degisti" deniyordu; hicbir ayara dokunmamis biri kendi esiklerinin
  bozuldugunu sanip Ayarlar'i kurcalayabilirdi.
- **Acilista bos grafik.** Olcum yenilenmesi gerektiginde test, grafik
  yuklenmeden ONCE calisiyordu; kullanici depo ve hafiza hazir oldugu halde
  dakikalarca "Veri yok" yazan bos bir ekrana bakiyordu. Test artik ekran
  dolduktan sonra basliyor.
- **Tek veri kaynagi: OANDA.** Kutulara TradingView'da OANDA:XAUUSD
  grafiginde bakiliyor; uygulama ise gecmiste HistData, canlida Binance
  PAXGUSDT (bir token, yani vekil) kullaniyordu. Olculdu: ayni donemde
  grafikteki kutularin %56,7'si uretiliyordu, OANDA ile %100'u. Eksiklerin
  %96,6'si hacim kapisinda takiliyordu, cunku hacim baska bir akistan
  sayiliyordu. Artik varsayilan OANDA, kurulu makineler bir kez OANDA'ya
  tasiniyor ve ayarlarda baska kaynak gorunmuyor (yanlislikla secilip deponun
  iki akistan karismasi mumkun degil).
- **Depo OANDA surumuyle bir kez degistiriliyor.** Ayari degistirmek tek
  basina yetmiyor: depo oldugu yerde kalir ve yeni barlar ESKI deponun fiyat
  ve hacim olcegine uydurulur. Deponun yeniden kurulmasi gerekiyor ve
  OANDA'dan tek tek indirmek olculdu: 1 dakikalik tam gecmis ~7 milyon mum,
  bir saatten uzun suruyor. Bu yuzden hazir dosya yayinlaniyor, uygulama bir
  kez indiriyor. Yalnizca 1 dakikalik iniyor; 5m/15m/30m/1h/4h zaten ondan
  turetiliyor, yani tek dosya butun zaman dilimlerini OANDA yapiyor.
  Eski depo SILINMIYOR, `.oncekiKaynak` ekiyle duruyor; bozuk veya yarim inen
  dosya asla yerine gecmiyor.
- **OANDA anahtari artik pakete gomulu geliyor.** Musteri guncelledikten
  sonra "OANDA icin API anahtari gerekli" uyarisini aliyordu. Anahtar artik
  kurulum dosyasinin icinde geliyor, kimse elle girmiyor. Depo herkese acik
  oldugu icin anahtar depoya YAZILMIYOR: GitHub'in sirrinda duruyor ve
  yalnizca paketleme aninda dosyaya dokuluyor. Ayrica gomulu anahtar artik
  yalnizca BOSLUGU dolduruyor; ayar dosyasinda bos bir anahtar kaliysa onu da
  dolduruyor, girilmis bir anahtari ise asla ezmiyor.
  Not: bu bir sir saklama yontemi degildir, kurulum dosyasini eline geciren
  anahtari cikarabilir. Deneme hesabi anahtari oldugu icin yetkisi piyasa
  verisi okumakla sinirli.
- **Bir guncelleme musterinin sinyal listesini siliyordu.** Indikator
  varsayilanlari degisince ayar izi tutmuyor ve tarama olcum dosyalarini
  SILIYORDU. Kullanici hicbir sey degistirmemis oluyor, uygulamayi acip
  listesini bos buluyordu; geri donusu de yoktu (bir kez 990 sinyal boyle
  gitti). Artik dosyalar silinmiyor, `.onceki` ekiyle yedekleniyor ve test
  KENDILIGINDEN yeniden calisiyor, yani liste kullanicidan hicbir sey
  istemeden doluyor. Olculdu: test 5m'de 9 sn, 15m'de 3 sn, 1m'de 45 sn.
- **Kirilip DIRILEN kutular gecmiste saglam gorunuyordu.** Kutu, yeni bir
  pivot birlesince dirilir (Pine de boyle yapar), ama kayit yalnizca SON
  durumu tasiyordu. Gecmis bir sinyale tiklayip "o an" kipiyle bakildiginda
  o tarihte KIRIK olan bir kutu saglam ciziliyordu, yani ileriye bakmayi
  onleyen kural tersinden deliniyordu. Kayit artik kirilma ve dirilme
  anlarini sirayla tasiyor. Olculdu (15m, 20 yil): 4664 kutunun 458'i
  diriliyor, 166'si kayitta "hic kirilmadi" gorunuyordu.
- **SNIPER sinyali arayuzde "DOKUNUS" yaziyordu.** Indikatorun kendi sinyali
  ayri bir olay turu olarak yaziliyordu; bu kayitlar hafizada olu kaliyor
  (komsu aramasinda hic eslesmiyor) ama olcumde dokunus kovasina giriyordu.
  Artik nitelenmis bir dokunus: rozeti SNIPER, Pine'in skorunu tasiyor,
  istatistigi dokunusla ayni kovada kaliyor. Ayni barda ayni kutuya denk
  gelen ikiz kayit da birlestiriliyor.
- **Kutular soldan bes bar kirpik ciziliyordu.** Cizim, pivotun ONAYLANDIGI
  bardan basliyordu; Pine ise kutuyu PIVOT barindan baslatir
  (`box.new(left = bar_index - pivotLen, ...)`). Kutular 100 yerine 95 bar
  genisligindeydi. Ileriye bakma degil: kutu yine ancak onaylandiktan sonra
  GORUNUR, yalnizca sol kenari pivota kadar uzanir, TradingView'in yaptigi da
  budur.
- **Calismasi biten kutular ekrandan siliniyordu.** Kullanici bunu ekranda
  gordu: TradingView'da kutu kirildiktan sonra da duruyor, bizde kayboluyordu.
  Sebep, portun ESKI indikator surumune yazilmis olmasiydi. Guncel surumde
  (`docs/pine/bollinger_box.pine`) kirilan kutu takip listesinde KALIR, her
  barda sag kenarini yeniden alir ve `born + boxLengthBars`a kadar UZAR;
  yalnizca soluklasip "BROKEN" yazisi alir. Ayrica kutu omru 100 degil 600
  bar ve kirilmis bir kutuya yeni pivot birlesirse kutu DIRILIR.
- **Gecmis sinyal, GELECEGIYLE birlikte cizilliyordu.** Sinyal aninda saglam
  olan bir destek, haftalar sonra kirildigi icin kesikli ve solgun
  gorunuyordu; ekrandaki mumlar da sinyalden sonrasini gosteriyordu.
  Kullanici "zaten kirilacakmis" diye okuyup kendi degerlendirmesini gecmise
  uyduruyordu. Olculemeyen ama karari dogrudan bozan bir ileriye bakma
  bicimiydi.
- **Grafige tiklamak yanlislikla sinyal seciyordu.** Herhangi bir noktaya
  tiklamak 1,5 bar icindeki sinyali seciyordu; bir kutunun kenarina tiklayip
  bolgeyi incelemek isteyen kullanici sinyal paneline atiyordu. Asil olmasi
  gereken ISARET tiklamasi ise chart.js'te ad cakismasi yuzunden hic
  calismiyordu (ayni kapsamda iki `onChartClick` bildirimi vardi, ikincisi
  birincisini eziyordu).
- **Gecmise kaydirma uzun tatillerde takiliyordu.** Eski mum istegi duvar
  saatine gore bir pencere kuruyordu; piyasa kapaliyken bar olusmadigi icin
  uzun bir tatil bu pencerenin tamamini yutabiliyordu (1m serisinde 4000
  dakikadan uzun 30 bosluk var, en uzunu 3,2 gun).
- **Motor hatadan sonra "hazır" yaziyordu** ve hata mesaji bir sonraki log
  satiriyla siliniyordu.
- **Mum yuklenemeyince ekranda "Veri yok" yaziyordu.** Kullanici saatlerce
  veri indirmeye calisiyor, oysa sorun motorun cevap verememesiydi.
- **Turetilen zaman dilimlerinde "kayıt yok" yaziyordu.** Durum satiri zaman
  dilimi basina bir `.bin` dosyasina bakiyor; 30m'nin kendi dosyasi yok, seri
  1m'den uretiliyor. Grafikte binlerce mum gorunurken alt serit "kayıt yok"
  diyordu.
- **Musteriye gonderilen sinyaller ilk acilista siliniyordu.** Hafiza, paketi
  hazirlayan makinenin ayarlariyla kurulur ve kendi ayar izini (cfgHash)
  tasir. Ayar yamasi pakete girmeyince musteri fabrika ayarlariyla aciyor, iz
  TUTMUYOR, uygulama da dogru davranip gonderilen olcumu "eski ayara ait"
  sayiyor: otomatik tarama hafizayi bastan kuruyor ve test sinyallerini
  siliyordu. Olculdu: 5m'de 990 yayinlanan sinyal ilk acilista silindi, liste
  bos gorundu. Ayar yamasi artik verinin yaninda gidiyor.
- **`Number(null)` SIFIR tuzagi dorduncu kez.** Bu kez kirilma ani tasimayan
  kutular "1970'te kirilmis" sayiliyor ve her an icin kirik gorunuyordu.
  Tuzak, onu yakalayan testle birlikte kodda adiyla yaziyor.

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

**Port Pine'a uyuyor, bu artik olculdu.** Kutu mantigi Pine kaynagindan
(`docs/pine/son_pro.pine`) AYRICA, porta bakilmadan yeniden yazildi
(`test/helpers/pineRef.js`) ve 5 tohum x 10.000 bar x 5 ayar kumesi = 25
kosuda karsilastirildi: kutu sayisi, kenarlar, dogum/kirilma/bitis barlari,
dokunus sayisi ve flow skoru BIREBIR ayni. Kilitlerin gercekten kilitledigi
mutasyon testiyle dogrulandi (birlestirme dongusune `break` koymak, cooldown
kosulunu kaldirmak, `live.shift()` yerine `live.pop()`, bar ici sirayi
degistirmek, mesafeyi `atr[pivotLen]` ile olcmek: besi de yakalandi).
DIKKAT: bu, portun Pine METNINE uydugunu gosterir; TradingView'in gercek
calismasiyla karsilastirma icin fixture gerekiyor (README 7.12).

**Pivot esitlik kurali olculdu.** Port "kesin" kurali varsayiyor (merkez bar
komsularindan kesinlikle buyuk/kucuk, esitlikte pivot yok). Esitlik dahil
edilseydi varsayilan ayarda bes tohumda 170 yerine 174 kutu cikiyordu;
kapilar kapaliyken fark tohum basina +1 ile +8 arasinda. Yani bu bir kagit
uzeri ayrinti degil.

**Ileriye bakma sizintisi aranip bulunamadi.** Karar barindan sonraki barlar
bozulup her sey yeniden hesaplandiginda hicbir olay alani degismiyor. Testin
ilk hali, kasitli yerlestirilmis BIR BARLIK bir ileriye bakmayi yakalayamadi
(sabit uc kesme noktasiyla kuruldugu icin); K her olayin kendi karar barina
esitlenince iki ayri kasitli hata da yakalandi.

**`ta.stdev` uzun seride birikim yapmiyor ama iptal (cancellation) var.**
25.000 barda bagil hata 5,3e-14. Ancak sapma fiyat seviyesinin yaninda
kuculdukce anlamli basamak eriyor: 4800 dolarlik fiyatta 0,05 genlikte bagil
hata 4,85e-4. Mutlak hata en fazla 4,76e-6 dolar, yani tikin iki binde biri.
DUZELTILMEDI: TradingView de ayni kayan toplam formulunu kullaniyor,
Welford'a gecmek Pine'dan UZAKLASTIRABILIR.

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
