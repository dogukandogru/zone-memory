# Zone Memory

XAUUSD destek/direnç bölgelerinin geçmiş hafızası ve canlı örüntü eşleştirme masaüstü uygulaması.

---

## 1. Bu uygulama ne yapar

TradingView'deki **"proje son versiyon 3"** indikatörü fiyat grafiğinde
destek ve direnç kutuları çizer. Bir kutu ancak iki koşul birlikte sağlanınca
doğar: pivot barında **hacim patlaması** olacak ve pivot **Bollinger bandının
dışına** taşmış olacak. Yani her kutu bir "hacimli aşırılık" noktasıdır. Kutunun
üzerine yazan `BUY LIQUIDITY` / `SELL LIQUIDITY` etiketi de beklenen yönü söyler:
destek kutusunda ALIŞ, direnç kutusunda SATIŞ.

İndikatörün kendisi sinyal üretmez, sadece kutu çizer. Zone Memory bu kutulardan
**iki ayrı sinyal** üretir ve ikisini de ayrı ayrı öğrenir:

1. **Kutu oluşumu (OLUŞUM).** Kutu doğduğu anda sinyal verir, sonraki hareketi
   öngörür. Kutu pivot barından `pivotLen` bar sonra onaylanır; pivot ancak o
   zaman kesinleşir, yani ileriye bakma yoktur. Giriş, onay barının kapanışıdır.
2. **Bölge dokunuşu (DOKUNUŞ).** Kutuya yapılan ilk dokunuşta sinyal verir.
   Giriş, bölgenin yakın kenarına limit emirdir.

Bu sinyallerin bir kısmı tutar, bir kısmı tutmaz. Zone Memory tam olarak bu
farkı öğrenir:

1. 2009'dan bugüne kadarki tüm XAUUSD mumlarında indikatörü **birebir** çalıştırır.
2. Her kutu için en fazla bir oluşum ve bir dokunuş olayı kaydeder
   (sistemin öğrenme birimi budur).
3. Her olayın sonucunu geriye dönük etiketler: bölge tuttu mu (`respect`),
   kırıldı mı (`break`), yoksa hiçbir şey olmadan ufuk mu doldu (`timeout`).
4. Her olay anının "parmak izini" çıkarır: son 32 barın şekli, getiri profili
   ve bağlam bilgileri (RSI, ATR, trend, seans, bölge yaşı, bandın dışına taşma
   derinliği, hacim oranı, skor bileşenleri).
5. Canlıda yeni bir olay oluştuğunda bu parmak izini geçmişteki **aynı türdeki**
   on binlerce olayla karşılaştırır, en benzer olanları bulur ve "geçmişte bu
   yapı %78 oranında tuttu, ortalama benzerlik 0,86" gibi ölçülmüş bir
   değerlendirme verir.

İki tür asla birbiriyle karşılaştırılmaz. Kutunun doğduğu an ile fiyatın ona
geri döndüğü an farklı kurulumlardır: girişleri, riskleri ve tipik sonuçları
ayrıdır. Karıştırılsaydı "geçmişte bu yapı %78 tuttu" cümlesi başka bir
kurulumun istatistiğini taşırdı.

Yani indikatörün çizdiği kutuyu olduğu gibi kabul etmez. O kutudan doğan
sinyalin geçmişte **gerçekten tutmuş** olan versiyonlarına ne kadar benzediğini
ölçer ve size onu söyler.

Kısaca: bu bir karar destek aracıdır. Otomatik işlem açmaz, emir göndermez.

### Ölçülen sonuçlar

> **ÖNEMLİ: Aşağıdaki tablo ESKİ indikatöre aittir ve şu anki sürüm için
> GEÇERLİ DEĞİLDİR.**
>
> Uygulama önce MASTER 1 TOUCH indikatörüyle çalışıyordu ve o indikatör için
> aşağıdaki ölçüm yapılmıştı. İndikatör "proje son versiyon 3" ile değiştirildi;
> kutu oluşum kuralları, sinyal türleri ve özellik vektörü tamamen değişti.
> Tablo, kullanılan yöntemin ne olduğunu göstermek için duruyor. Yeni
> indikatörün sayıları **ölçülmedi**; ölçmek için Test sekmesindeki yürüyen
> ileri testi çalıştırın ve oradaki "Sinyal türüne göre" tablosuna bakın.
> `src/core/learn/presets.js` içindeki hazır ayarlar da aynı sebeple eski
> ölçüme dayanır ve yeniden aranmalıdır.

Yöntem (yeni indikatör için de aynen uygulanabilir):

- 6.086.450 adet 1 dakikalık XAUUSD mumu, 2009-03 ile 2026-07 arası.
- Geçmiş ikiye bölündü. Parametreler **yalnızca 2009-2018** döneminden seçildi,
  sonra hiç dokunulmamış **2019-2026** döneminde test edildi. Aşağıdaki tablo
  o ikinci dönemin sonucudur.
- Testin kendisi de ileriye bakmaz: her olay yalnızca kendinden **en az bir
  gün önce sonuçlanmış** kayıtlarla karşılaştırılır.
- İşlem maliyeti dahildir: fiyatın %0,0068'i, yani 4400 dolarlık altında
  0,30 dolar gidiş-dönüş spread.

Eski indikatörün (MASTER 1 TOUCH) doğrulama dönemi sonucu:

| TF | işlem | isabet | **taban** | brüt/işlem | maliyet | **net/işlem** | kâr faktörü |
|---|---|---|---|---|---|---|---|
| 1m | 478 | %72,0 | %52,4 | +0,377 ATR | -0,265 | **+0,112 ATR** | 1,27 |
| 5m | 113 | %57,5 | %43,2 | +0,293 ATR | -0,108 | **+0,184 ATR** | 1,30 |
| 15m | 18 | %55,6 | %38,4 | +0,264 ATR | -0,054 | **+0,210 ATR** | 1,35 |

**Taban**, hiçbir seçim yapmadan tüm olayları almanın isabet oranıdır. Sistemin
katma değeri isabet ile taban arasındaki farktır. Yeni indikatörde de bakılacak
sayı budur: Test sekmesinde `Taban başarı oranı` ile `Başarı oranı` farkı. Fark
yoksa sistem bir şey katmıyordur.

Zaman dilimini değiştirdiğinizde uygulama o zaman dilimi için kayıtlı hazır
ayarı kendiliğinden uygular (`src/core/learn/presets.js`). Ayarlar ekranından
girdiğiniz değerler bu hazır ayarı her zaman ezer.

Bu sonuçların ne olmadığı da önemlidir, bkz. **7. Bilinen sınırlar**.

---

## 2. Kurulum

Gereksinim: **Node.js 20 veya üzeri**. Kontrol:

```bash
node --version
```

### 2.1 Geliştirme kurulumu (macOS ve Windows aynı)

```bash
git clone <depo-adresi> indicator3
cd indicator3
npm install
npm start
```

`npm start` Electron penceresini açar. Geliştirici araçlarıyla açmak için:

```bash
npm run dev
```

Testler:

```bash
npm test
```

### 2.2 Paketlenmiş kurulum

Kurulum dosyası üretmek için:

```bash
npm run dist        # bulunduğunuz işletim sistemi için
npm run dist:mac    # macOS .dmg (arm64 + x64)
npm run dist:win    # Windows .exe kurulum sihirbazı (NSIS)
```

Çıktılar `release/` klasörüne yazılır.

**macOS notu:** uygulama imzalanmadığı için (`identity: null`) ilk açılışta
"geliştirici doğrulanamadı" uyarısı görebilirsiniz. Uygulamaya sağ tıklayıp
"Aç" derseniz bir kez onayladıktan sonra normal açılır.

**Windows notu:** SmartScreen "bilinmeyen yayımcı" uyarısı verebilir.
"Ek bilgi" > "Yine de çalıştır" ile geçilir.

### 2.3 Windows'ta Node ve derleme

Harici npm bağımlılığı yoktur (tek çalışma zamanı bağımlılığı
`lightweight-charts`, o da sadece arayüzde). Yani derleyici zinciri,
Python veya Visual Studio Build Tools kurmanıza gerek yoktur.

---

## 3. İlk veri kurulumu

Uygulama boş bir veri deposuyla açılır. Öğrenebilmesi için önce geçmiş mumların
yüklenmesi gerekir. İki yol vardır.

### 3.1 Eski projeden aktarma (hızlı yol, önerilen)

Eski `indicator2` projesindeki TimescaleDB'de 2009-03'ten bugüne yaklaşık
**6,1 milyon adet 1 dakikalık mum** hazır durumdadır. Docker konteyneri
çalışıyorsa bunlar doğrudan aktarılabilir:

```bash
# Eski veritabanı ayakta mı
docker ps | grep indicator2-db-1

# Değilse ayağa kaldır
cd ../indicator2 && docker compose up -d db && cd -

# Aktarımı başlat
npm run import-legacy
```

Aktarım bu makinede **7 saniye** sürdü (6.086.450 satır, yaklaşık 440 MB azami
bellek) ve şunu yapar:

- 1 dakikalık mumları `psql` üzerinden **akış halinde** okur (tüm çıktı belleğe
  string olarak alınmaz, satır satır işlenir ve büyüyen tamponlara yazılır).
- `XAUUSD_1m.bin` dosyasını yazar (yaklaşık 290 MB).
- Aynı veriden 5m, 15m, 1h ve 4h serilerini üretip ayrı dosyalara yazar.
- Sonunda her zaman dilimi için mum sayısı ve tarih aralığı özetini basar.

30m ve 1d için ayrı dosya üretilmez; o zaman dilimleri istendiğinde 1 dakikalık
seriden anında türetilir.

Seçenekler:

```bash
node scripts/import-legacy.mjs --help

  --tf <zaman>          Kaynak zaman dilimi (varsayılan 1m)
  --container <ad>      Docker konteyneri (varsayılan indicator2-db-1)
  --user <ad>           Veritabanı kullanıcısı (varsayılan xauusd)
  --db <ad>             Veritabanı adı (varsayılan xauusd)
  --out <yol>           Hedef .bin dosyası
  --limit <n>           Yalnızca ilk n satırı aktar (deneme için)
  --tfs 5m,15m,1h,4h    Türetilecek zaman dilimleri
  --no-resample         Üst zaman dilimlerini üretme
  --force               Mevcut dosyaların üzerine yaz (önce yedeklenir)
```

**Üzerine yazma koruması.** Hedef `.bin` dosyalarından biri zaten varsa betik
veritabanına hiç dokunmadan durur ve çıkış kodu 1 verir. Üzerine yazmak için
`--force` gerekir; o zaman her hedef dosya önce
`<ad>.bak-YYYYMMDD-HHMMSS` adıyla yedeklenir.

Gerçek veri klasörüne aktarım bittiğinde mevcut `XAUUSD_<tf>_memory*` dosyaları
`data/_eski_hafiza_yedek/<damga>/` altına **taşınır**: aktarılan mumlarla eski
hafızanın bar indeksleri uyuşmaz, hafızaların yeniden taranması gerekir.

Örnek deneme aktarımı (geçici klasöre yazar, gerçek depoya dokunmaz):

```bash
node scripts/import-legacy.mjs --limit 200000 --out /tmp/zone-memory-deneme/XAUUSD_1m.bin
```

`--limit` verilip `--out` verilmezse hedef zaten işletim sisteminin geçici
klasörüdür (`$TMPDIR/zone-memory-deneme/`); deneme aktarımı gerçek depoyu
hiçbir koşulda ezmez.

### 3.2 İnternetten indirme (Docker yoksa)

HistData.com aylık tick dosyalarından 1 dakikalık mum üretir. Anahtar
gerekmez, ücretsizdir, ama tam geçmiş için **uzun sürer** (her ay için ayrı
zip indirilir).

```bash
npm run fetch-history -- --provider histdata --tf 1m --from 2009-03 --to 2026-08
```

Sağlayıcı listesi ve notları:

```bash
node scripts/fetch-history.mjs --list
```

Anahtar isteyen bir sağlayıcı kullanıyorsanız:

```bash
node scripts/fetch-history.mjs --provider polygon --tf 1m --from 2024-01 --key ANAHTARINIZ
```

Anahtarı komut satırına yazmak istemezseniz `POLYGON_API_KEY` veya
`TWELVEDATA_API_KEY` ortam değişkenlerini kullanabilirsiniz.

Tarih biçimleri: `2009-03`, `2009-03-15`, `2009-03-15T22:00:00Z` veya UNIX
saniye. `--to` için ay verirseniz o ayın sonu kabul edilir.

### 3.3 Veriyi doğrulama

Uygulamayı açın; alt şeritte kaç mum yüklendiği ve ilk/son tarih görünür.
Ölçülen değerler (eski veritabanından aktarım sonrası):

| Zaman dilimi | Mum sayısı | İlk | Son |
| --- | --- | --- | --- |
| 1m | 6.086.450 | 2009-03-15 22:00 | 2026-07-31 21:59 |
| 5m | 1.226.860 | 2009-03-15 22:00 | 2026-07-31 21:55 |
| 15m | 410.034 | 2009-03-15 22:00 | 2026-07-31 21:45 |
| 1h | 103.380 | 2009-03-15 22:00 | 2026-07-31 21:00 |
| 4h | 27.780 | 2009-03-15 20:00 | 2026-07-31 20:00 |

Tüm zamanlar UTC'dir. Aynı klasördeki `.bin` dosyalarının toplam boyutu
yaklaşık 360 MB'tır.

---

## 4. Kullanım

### 4.1 Geçmişi Tara

Üst şeritteki zaman dilimini seçin (varsayılan: **5m**) ve **Geçmişi Tara**
düğmesine basın. Uygulama:

1. Seçilen zaman diliminde indikatörü baştan sona çalıştırır.
2. Tüm kutuları, kutu oluşum olaylarını ve bölgeye ilk geri dönüşleri bulur.
3. Her olayı hedef / geçersizlik / ufuk kuralına göre etiketler.
4. Özellik vektörlerini çıkarır ve hafızayı diske yazar.
5. Başarılı kurulumlardan prototip kümeleri üretir.

Uzun bir seride bu işlem birkaç dakika sürer ve on binlerce olay üretir.
Bir kez yapılır, sonra artımlı olarak güncellenir. İlerleme çubuğu üst şeritte
görünür.

### 4.2 Bölgelerin okunması

Grafiğin üzerine çizilen kutular indikatörün bölgeleridir:

- **Yeşil kutu:** destek bölgesi (BUY LIQUIDITY), beklenen yön ALIŞ.
- **Kırmızı kutu:** direnç bölgesi (SELL LIQUIDITY), beklenen yön SATIŞ.
- **Soluk ve kesik çerçeveli kutu:** kırılmış bölge, artık geçerli değildir.

Bir kutuya tıklarsanız sağ panelde o bölgenin bilgileri ve olay geçmişi açılır:
akış gücü (1 ile 10 arası), doğuştaki akış, bandın dışına ne kadar taşmış, kaç
yakın pivotun bu kutuya katıldığı ve kutunun ürettiği olaylar.

### 4.3 Sinyallerin okunması

Grafikte alta bakan yukarı ok ALIŞ, üste bakan aşağı ok SATIŞ sinyalidir.
Etiketin başındaki harf sinyalin türünü söyler:

- **O** = kutu oluşumu (kutu o barda doğdu)
- **D** = bölgeye geri dönüş (fiyat kutuya döndü ve dokundu)

Harften sonraki yüzde, geçmişteki **aynı türdeki** benzer kurulumların kazanma
oranıdır. Sinyal listesinde aynı ayrım `OLUŞUM` / `DOKUNUŞ` rozetiyle görünür,
üstteki süzgeçten yalnızca bir türü de gösterebilirsiniz.

Bir sinyale tıklayınca sağ panelde detay açılır:

| Alan | Anlamı |
| --- | --- |
| Sinyal türü | Kutu oluşumu mu, bölgeye geri dönüş mü; girişin nereden alındığı |
| Eşleşme sayısı | Benzerlik eşiğini geçen, aynı türdeki geçmiş kayıt sayısı |
| Ortalama benzerlik | Bu eşleşmelerin ortalama benzerlik puanı (0 ile 1) |
| Kazanma oranı | Eşleşmelerin kaçı bölgeye saygı göstermiş |
| Güven | Eşleşme sayısı, oranın 0,5'ten uzaklığı ve benzerliğin bileşimi |
| Giriş / TP1 / TP2 / SL | Bölge geometrisinden türetilen plan, TP2 eşleşmelerin dağılımından |
| R/R | (TP1 - giriş) / (giriş - SL) mutlak değeri |
| Prototip | Kurulumun benzediği örüntü kümesinin adı |
| Gerekçeler | Sinyalin neden oluştuğu veya neden oluşmadığı, Türkçe |

Önemli: eşikleri geçemeyen olaylar da listelenir, ama `fired: false`
durumundadır. Böylece "neden sinyal vermedi" sorusunun cevabı görünür kalır.

### 4.4 Test sekmesi

Yürüyen ileri test (walk forward) sonuçlarını gösterir. Her olay yalnızca
**kendinden önceki** hafızayla değerlendirilir, yani ileriye bakma yoktur.
Sekmede özet tablo, yıllara göre kırılım ve sermaye eğrisi bulunur.

Burada bakılacak en önemli sayı `Taban başarı oranı` ile `Başarı oranı`
farkıdır: birincisi tüm olayların ham başarı oranı, ikincisi sistemin
seçtiklerinin oranıdır. Aradaki fark sistemin katma değeridir. Fark yoksa sistem
bir şey katmıyordur.

Hemen altındaki **"Sinyal türüne göre"** tablosu iki sinyal türünü ayrı ayrı
gösterir. Toplam rakam, türlerden birinin diğerini taşıdığı durumları gizler:
kutu oluşumu zarar ederken bölge dokunuşu kazanıyor olabilir ve toplamda ikisi
birden makul görünebilir. Hangi sinyalin gerçekten çalıştığına bu tabloya
bakarak karar verin. Bir tür işinize yaramıyorsa Ayarlar ekranından
(`Kutu oluşumunda sinyal üret` / `Bölgeye dokunuşta sinyal üret`) kapatın ve
yeniden tarayın.

### 4.5 Canlı mod

Üst şeritten sağlayıcı seçip **Canlı** anahtarını açın. Uygulama seçilen
aralıkta (varsayılan 20 saniye) son mumları çeker, depoya ekler ve yeni bir
mum **kapandığında** indikatörü son pencerede çalıştırır. Yeni bir bölge olayı
(kutu oluşumu veya ilk dokunuş) oluşursa hafızayla karşılaştırıp sinyali panele
düşer.

Vekil bir kaynak kullanıyorsanız (Yahoo GC=F, Binance PAXG, OKX XAUT) fiyat
farkı otomatik olarak `computeBasis` ile ölçülür ve seri spot seviyesine
kaydırılır. Bu durum sinyalin gerekçelerine not düşülür.

---


### 4.6 Güncel veri ve canlı akış

HistData yalnızca **kapanmış ayları** yayınlar, bu yüzden depo her zaman
1 ile 31 gün arası geride kalır. Aradaki boşluğu kapatmak ve canlı devam etmek
için üst şeritteki **Veri Çek** düğmesi kullanılır.

Bu düğme şunları yapar:

1. Seçili sağlayıcıdan eksik aralığı indirir. Güncelleme her zaman **1 dakikalık
   taban seri** üzerinden yapılır, sonra 5m, 15m, 1h ve 4h ondan yeniden üretilir.
   Böylece zaman dilimleri birbiriyle tutarlı kalır.
2. Sağlayıcı bir **vekil** ise (Binance PAXG, OKX XAUT, Yahoo GC=F) üç düzeltme
   uygulanır:
   - **Fiyat kaydırması:** depodaki seriyle çakışan bölgeden medyan fark
     hesaplanır ve yeni barlara uygulanır. Ölçüldü: PAXG ile spot arasındaki
     fark 1 dakikalıkta yalnızca 0,38 dolar. Çakışma bulunamazsa **ekleme
     yapılmaz** ve hata verilir; düzeltmesiz eklemek seriye sahte bir sıçrama
     yazardı.
   - **Piyasa saatleri:** kripto vekilleri 7/24 işlem görür, spot altın görmez.
     Hangi saatlerin açık olduğu depodaki son 8 haftadan **veriye bakılarak**
     çıkarılır ve kapalı saatlerdeki barlar elenir. Ölçüldü: 18 günlük boşlukta
     9.360 bar (yaklaşık üçte biri) bu şekilde elendi.
   - **Hacim ölçeği:** HistData hacmi dakikadaki tick sayısıdır (~95), Binance
     ise PAXG miktarını verir (~0,4). İndikatörün flow bileşeni hacme bağlı
     olduğu için çakışma bölgesindeki medyan orana göre ölçeklenir.

**Canlı** anahtarı açıldığında seçili sağlayıcı `livePollSeconds` aralığıyla
(varsayılan 20 saniye) yoklanır, aynı düzeltmeler uygulanır, kapanan her yeni
bar depoya yazılır ve indikatör son pencerede yeniden çalıştırılır. Yeni bir ilk
dokunuş oluşursa hafızayla karşılaştırılıp sinyal üretilir. Durum çubuğunda
kullanılan kaynak ve uygulanan kaydırma miktarı yazar.

Ölçülen sağlayıcı durumu (bu ağdan, 2026-08):

| Sağlayıcı | Canlı | Not |
| --- | --- | --- |
| Binance PAXGUSDT | ✅ | Anahtarsız, gerçek zamanlı, gerçek hacim. **Varsayılan.** |
| OKX XAUT-USDT | ✅ | Anahtarsız, hacim çoğu barda zayıf |
| Yahoo GC=F | ⚠️ | Tekrarlı isteklerde HTTP 429, canlı için güvenilmez |
| Twelve Data | 🔑 | Spot doğru fiyat ama forexte hacim vermez |
| Polygon C:XAUUSD | 🔑 | Ücretli, gerçek spot + tick hacmi. **En doğru seçenek.** |

---

## 5. Veri kaynakları

Aşağıdaki durumlar bu makineden **ölçülmüştür**, tahmin değildir.

| Kaynak | Sembol | Anahtar | Fiyat | Hacim | Durum |
| --- | --- | --- | --- | --- | --- |
| HistData | XAUUSD tick | Gerekmez | Spot | Tick sayısı | Çalışıyor, geçmiş için en iyi ücretsiz kaynak |
| Yahoo Finance | GC=F | Gerekmez | Vekil (COMEX vadeli) | Gerçek | Çalışıyor, 1m verisi yalnızca son 30 gün |
| Binance | PAXGUSDT | Gerekmez | Vekil (PAXG token) | Gerçek | Çalışıyor, hafta sonu da bar üretir |
| OKX | XAUT-USDT | Gerekmez | Vekil (Tether Gold) | Çoğunlukla 0 | Çalışıyor ama flow bileşeni için zayıf |
| Twelve Data | XAU/USD | Gerekli | Spot | **Yok (0)** | Çalışıyor, forexte hacim vermiyor |
| Polygon.io | C:XAUUSD | Gerekli | Spot | Tick sayısı | Çalışıyor, önerilen canlı kaynak (ücretli) |
| Dukascopy | XAUUSD | Gerekmez | Spot | Gerçek | **Erişilemez**, BTK engeli var |

Açıklamalar:

- **Dukascopy** alan adı Türkiye'den engel sunucusuna çözülüyor, doğrudan IP
  bağlantısı da düşüyor. Bu yüzden sağlayıcı listesinde bulunmaz.
- **HistData**, hazır 1 dakikalık bar dosyaları yerine **tick** dosyalarını
  kullanır. Sebep: hazır bar dosyalarında hacim sütunu her zaman 0'dır ve
  indikatörün flow hesabı hacme bağlıdır. Tick dosyalarından üretilen mumlarda
  hacim = dakikadaki tick sayısıdır. TradingView'in XAUUSD hacmi de tick
  hacmidir, yani aynı cinstendir. HistData içinde bulunulan ayı yayımlamaz.
- **Vekil kaynaklar** (`isProxy: true`) spot XAUUSD değildir. Şekil ve örüntü
  bilgisi kullanılabilir, ama mutlak fiyat seviyesi kayar. Basis düzeltmesi bu
  kaymayı kapatır; yine de canlı takip için spot bir kaynak tercih edilmelidir.
- **Twelve Data** doğru spot fiyatı verir ama forex serilerinde hacim gelmez.
  Hacimsiz seride indikatörün flow bileşeni çalışmaz, dolayısıyla sinyal sayısı
  ve kalitesi düşer.
- **Polygon.io** hem spot fiyat hem tick tabanlı hacim verdiği için canlı mod
  önerisidir. Ücretsiz planında dakikada 5 istek sınırı vardır.

API anahtarları uygulama içinde **Ayarlar** sekmesinden girilir ve
`settings.json` dosyasında saklanır.

---

## 6. Sistem nasıl çalışır

### 6.1 Bölge oluşumu

Pivot noktalarında (varsayılan `pivotLen = 5` bar sol/sağ) bir kutu adayı doğar.
Adayın kutuya dönüşmesi için **iki kesin kapıyı** birden geçmesi gerekir:

- **Hacim:** pivot barının hacmi kendi 50 barlık ortalamasının en az
  `minVolRatio` (1,05) katı olacak **ve** akış gücü `minFlowToShow` (6,0)
  eşiğini geçecek. Akış gücü `hacim oranı × 3` olarak hesaplanır, tavanı 10'dur;
  yani 6,0 eşiği kabaca iki kat hacim demektir.
- **Bollinger:** pivot dibi alt bandın altında (destek) veya pivot tepesi üst
  bandın üstünde (direnç) olacak.

İkisi birlikte kutuyu bir "hacimli aşırılık" noktası yapar. Sinyalin yönü de
buradan gelir: aşırılık ortalamaya dönüş beklentisi taşır, bu yüzden destek
kutusu ALIŞ, direnç kutusu SATIŞ yönündedir.

Kutu geometrisi, `zH = atr[pivot] * zoneAtrMult` (0,35 ATR) olmak üzere:

- **Destek:** üst kenar `pivot dibi + zH/4`, alt kenar `pivot dibi - zH`.
- **Direnç:** üst kenar `pivot tepesi + zH`, alt kenar `pivot tepesi - zH/4`.

Kutunun ömrü boyunca:

- **Birleştirme:** aktif listede aynı yönde ve orta noktası `atr * mergeAtrMult`
  (0,55 ATR) mesafesinden yakın bir kutu varsa yeni kutu açılmaz; mevcut kutu
  iki pivotu da kapsayacak şekilde genişler ve akış gücü artar. Aynı seviyenin
  defalarca sayılması böyle engellenir. Birleşme yeni bir sinyal üretmez.
- **Dokunuş:** kutuya her dokunuşta (aynı kutu için `touchCooldown` = 12 bar
  aralığıyla) akış gücü 0,35 artar, tavan 10.
- **Kırılma:** destekte kapanış alt kenarın `atr * 0,15` kadar altına inerse,
  dirençte üst kenarın o kadar üstüne çıkarsa kutu kırılır. **Onay barı yoktur,
  tek bar yeter.** Kırılan kutu takipten düşer.
- **Ömür:** kutu pivot barından itibaren `maxAgeBars` (100) bar yaşar, çizimi
  `boxLengthBars` (100) bar ileri uzar. Aynı anda en fazla `maxZones` (24) kutu
  takip edilir; liste dolunca en eski kutu takipten düşer ama grafikte kalır.

### 6.2 İki sinyal türü ve bölge başına birer olay kuralı

Her kutu **her türden en fazla bir** olay üretir.

**Kutu oluşumu (`kind = 'form'`).** Kutu doğduğu barda üretilir. Pivot ancak
kendisinden `pivotLen` bar sonra kesinleştiği için olay o barda açılır, yani
ileriye bakma yoktur. Fiyat bu anda kutunun içinde değildir; onay barına kadar
pivottan ne kadar uzaklaştığı `entryDistAtr` alanında tutulur ve özellik
vektörüne girer.

**Bölge dokunuşu (`kind = 'touch'`).** Kutuya yapılan **ilk dokunuşta**
üretilir. Bu, kutunun doğduğu bara denk gelebilir: kutu pivotun etrafında
doğduğu için fiyat o anda zaten kutunun içinde olabilir. Bilinçli bir tercihtir.
Önceki bir sürümde kutunun önce tamamen terk edilmesini bekleyen bir kural vardı,
kaldırıldı.

İkinci, üçüncü dokunuşlar olay üretmez. Sebebi şudur: aynı bölgeye art arda
yapılan dokunuşlar birbirinin neredeyse kopyasıdır. Hepsi hafızaya girseydi,
benzerlik motoru "geçmişte çok benzer 20 kayıt buldum" derken aslında aynı
olayın 20 kopyasını bulmuş olurdu. Bu kural hafızayı bağımsız olaylardan oluşan
bir kütüğe dönüştürür.

**İki tür asla karıştırılmaz.** Benzerlik motoru bir oluşum olayını yalnızca
geçmişteki oluşum olaylarıyla, bir dokunuşu yalnızca geçmişteki dokunuşlarla
karşılaştırır. Girişleri, riskleri ve tipik sonuçları farklı olduğu için
karıştırmak istatistiği anlamsızlaştırırdı.

**Skor.** Kutu oluşumunun kapısı (hacim + Bollinger) kesin olduğu için o iki
kriter her kutuda doğrudur ve skor bileşeni olarak bilgi taşımaz. Bu yüzden skor
olayın **olduğu barda** değişen beş şeyi ölçer: akış gücü, üst zaman dilimi
trendi, seans, fitil reddi ve o barın hacim gücü. `minScoreForSignal` (3) eşiğini
geçen olay "nitelikli" sayılır. Skor bir kapı değildir; niteliksiz olaylar da
hafızaya girer, çünkü benzerlik motoru tüm olayları korpus olarak kullanır.

### 6.3 Sonuç etiketleme

Buradaki tanım sistemin tamamını belirler, çünkü hafızanın öğrendiği şey budur.

Sorulan soru şu: **bölge gerçekten tuttu mu?** Genel fiyat hareketi değil,
bölgenin kendisi. Bu yüzden seviyeler bölge geometrisinden türetilir. İki olay
türünün girişi farklı olduğu için hedef hesabı da farklıdır:

|  | dokunuş olayı | oluşum olayı |
| --- | --- | --- |
| Giriş | bölgenin yakın kenarı, limit emir | onay barının kapanışı |
| Geçersizlik | bölgenin uzak kenarından `breakBufferAtr` \* ATR dışarıda | aynı |
| Hedef | kenardan `targetAtr` \* ATR uzakta | girişten `formTargetRr` \* risk kadar uzakta |
| Ödül | her zaman `targetAtr` | her zaman `formTargetRr` risk birimi |

- **Ufuk:** `horizonBars`, varsayılan 48 bar (her iki türde de).

**Dokunuşta giriş neden kenar.** Dokunuş tanımı gereği fiyat o kenarı geçmiştir,
yani limit emir dolar. Risk ve ödül yalnızca bölge geometrisine bağlı kalır.

**Oluşumda giriş neden kapanış.** Kutu doğduğunda fiyat kutunun içinde değildir
ve oraya hiç dönmeyebilir, dolayısıyla kenara limit emir konamaz. Bunun bedeli
şudur: risk artık sabit değildir, fiyat pivottan ne kadar kaçtıysa o kadar
büyüktür. Hedef sabit bir ATR mesafesi olsaydı risk/ödül kurulumdan kuruluma
0,3 ile 2,0 arasında savrulur ve "geçmişte bu yapı %70 tuttu" cümlesi
karşılaştırılamaz şeylerin ortalaması olurdu. `formTargetRr` (varsayılan 1,0)
bunu tek eksene indirir: bütün oluşum olayları aynı risk/ödül oranını taşır,
aralarındaki tek fark isabet oranıdır. Riski büyük olan kurulumun hedefi de
uzaktır, yani vurulması zordur; ceza otomatiktir.

**Oluşumda iki eleme.** Pivot onaylanana kadar fiyat kutunun öbür tarafına
geçtiyse ortada işlem yoktur. Fiyat çok uzağa kaçtıysa (giriş ile geçersizlik
arası `maxFormRiskAtr`, varsayılan 3,0 ATR'yi aşıyorsa) kurulum gerçekte
işlenmez. Her iki durumda da olay **etiketlenmez ve hafızaya hiç girmez**;
canlıda böyle bir olay geldiğinde sinyal üretilmez ve gerekçesi yazılır.

| Etiket | Koşul |
| --- | --- |
| `respect` | Geçersizlik görülmeden hedefe ulaşıldı, bölge tuttu, `success = true` |
| `break` | Önce geçersizlik seviyesi görüldü, bölge kırıldı |
| `timeout` | Ufuk boyunca hiçbiri olmadı |

Aynı barda ikisi de olduysa **muhafazakâr** davranılır ve kırılma sayılır.
Bar içi sıralama bilinmediği için iyimser varsayım yapılmaz. Dokunuş olayında
aynı kural olay barının kendisi için de geçerlidir: emir o bar içinde
dolduğundan, o bar geçersizlik seviyesini de gördüyse anında kırılma yazılır.
Oluşum olayında böyle bir kural yoktur, çünkü emir bar kapanınca dolar.

**Neden bu tanım önemli.** Sinyal planındaki TP1 ve SL, etiketin kullandığı
seviyelerin **aynısıdır**. Yani "bölge tuttu" ile "TP1 vuruldu" aynı olaydır.
Bunlar ayrı tanımlar olduğunda sistem bir şeyi öğrenip başka bir şeyi işlemeye
kalkıyordu; eski indikatörle ölçüldü, 15 dakikalıkta seçimin kazandırdığı
+5,1 puanlık fayda bu tutarsızlık yüzünden -11,5 puanlık zarara dönüyordu.

Her olay için ayrıca MFE ve MAE (lehte ve aleyhte azami hareket) iki biçimde
kaydedilir: ufkun tamamı üzerinden (özellik olarak) ve yalnızca sonuca kadar
(`mfeExitAtr`, `maeExitAtr`). İkincisi plan hedeflerinde ve testin kazanç
kuralında kullanılır, çünkü stop vurulduktan sonraki hareket gerçekte
yakalanamaz.

Eski `atr` modu (giriş +- N ATR) `outcomeCfg.mode = 'atr'` ile hâlâ seçilebilir,
karşılaştırma için korundu. O mod bölgeden bağımsız ölçüm yaptığı için "bölge
çalıştı mı" sorusunu ölçmez.

### 6.4 Özellik vektörü

Her olay üç parçadan oluşan bir parmak izi taşır:

1. **shape (16 değer):** olay barıyla biten son 32 kapanış. Önce 5'lik
   hareketli ortalamayla yumuşatılır, sonra 16 kovaya bölünüp her kovanın
   ortalaması alınır, sonra min-max ile 0 ile 1 arasına normalize edilir.
   Bu sıkıştırma önceki projede ölçüldü: ham 32 barlık vektöre göre sinyal
   başına yaklaşık **3 kat daha fazla anlamlı eşleşme** üretti. Sebebi,
   normalize edilmiş şeklin fiyat seviyesinden ve mutlak oynaklıktan bağımsız
   hale gelmesidir; 2011'in 1900 dolarındaki bir yapı 2015'in 1100 dolarındaki
   yapıyla karşılaştırılabilir olur.
2. **ret (32 değer):** son 33 kapanışın logaritmik getirileri, z-score ile
   normalize edilmiş. Hareketin hızını ve ritmini taşır.
3. **ctx (24 değer):** bağlam. RSI, ATR yüzdesi, SMA20 ve SMA50'ye ATR
   cinsinden uzaklık, saatin ve haftanın gününün sinüs/kosinüs kodlaması,
   bölge genişliği, bölge yaşı, akış gücü, penetrasyon derinliği, skor oranı,
   skorun hangi bileşenlerden geldiği (akış, trend, seans, fitil reddi, hacim),
   yön, trend durumu, **olay türü** (oluşum mu dokunuş mu), pivotun Bollinger
   bandından ne kadar dışarı taştığı, olay barının hacim oranı ve kapanışın
   bölgenin yakın kenarına uzaklığı.

Bağlam vektörünün boyutları indikatöre bağlıdır. Eski bir sürümle üretilmiş
hafıza dosyası yeni olaylarla karşılaştırılamaz; motor bunu yakalar ve
"Geçmişi Tara" ile yeniden oluşturmanızı ister.

### 6.5 Benzerlik

İki kurulumun benzerliği üç ölçünün ağırlıklı toplamıdır:

| Bileşen | Ölçü | Ağırlık | Neyi yakalar |
| --- | --- | --- | --- |
| shapeSim | Pearson korelasyonu | 0,60 | Fiyat şeklinin aynılığı |
| ctxSim | Kosinüs benzerliği | 0,25 | Bağlamın aynılığı |
| dtwSim | DTW mesafesi (Sakoe-Chiba bantlı) | 0,15 | Zamanda esneyen ritim benzerliği |

Hepsi 0 ile 1 arasına taşınır. DTW pahalı olduğu için önce ucuz `shapeSim` ile
ön eleme yapılır (en iyi `k * 8` aday), DTW yalnızca o adaylarda hesaplanır.

Üç filtre vardır:

- `kind`: yalnızca **aynı türdeki** olaylar aday olur. Kutu oluşumu yalnızca
  geçmişteki oluşumlarla, dokunuş yalnızca geçmişteki dokunuşlarla
  karşılaştırılır.
- `excludeWithinSec` (varsayılan 3 gün): sorgu zamanına çok yakın kayıtlar
  elenir. Aksi halde aynı kurulum kendisiyle eşleşir.
- `beforeTime`: yalnızca belirtilen zamandan önceki kayıtlar aday olur.
  Yürüyen ileri testte bu şarttır, ileriye bakmayı imkânsız kılar.

### 6.6 Prototip kümeleme

Yalnızca **başarılı** olayların şekil vektörleri k-means++ ile kümelenir
(varsayılan `k = 8`, en az 15 üyeli kümeler kalır, sabit tohum ile
deterministik). Her küme, geçmişte gerçekten işe yaramış bir kurulum kalıbını
temsil eder ve eğim, oynaklık ve son hareketten türetilen okunabilir bir ad
alır, örneğin `Düşen + sıkışık + V dönüş`.

Canlı bir kurulum geldiğinde en yakın prototip de raporlanır. Bu, sayısal
benzerlik puanının yanında "bu, şu bilinen kalıba benziyor" şeklinde insan
tarafından okunabilir bir bağlam verir.

### 6.7 Sinyal eşikleri

Varsayılan değerler:

| Ayar | Varsayılan | Anlamı |
| --- | --- | --- |
| `k` | 25 | En fazla kaç komşu incelenir |
| `minSimilarity` | 0,80 | Bir kaydın "benzer" sayılması için eşik |
| `minMatches` | 15 | Eşiği geçen en az kaç kayıt gerekli |
| `minWinRate` | 0,62 (1m) / 0,55 (5m, 15m) | Bu kayıtlarda en az tutma oranı |
| `minExpectancy` | 0,10 | Asgari beklenen değer, risk birimi cinsinden |
| `minRr` | 0 (kapalı) | Asgari risk/ödül oranı |
| `tp2Pct` | 70 | Uzatma hedefi için MFE dağılımının yüzdeliği |

Zaman dilimine göre değişen değerler `src/core/learn/presets.js` içindedir.
**Bu hazır ayarlar eski indikatörle (MASTER 1 TOUCH) yapılan taramadan gelir ve
yeni indikatör için yeniden aranmalıdır.** Şimdilik makul bir başlangıç noktası
olarak duruyorlar; kendi ayarınızı bulmak için Test sekmesindeki yürüyen ileri
testi farklı eşiklerle çalıştırın ve "Sinyal türüne göre" tablosuna bakın.

TP1 ve SL bölge geometrisinden gelir (bkz. 6.3), yüzdelikten değil. `tp1Pct` ve
`slPct` yalnızca bölge bilgisi olmayan yedek yolda kullanılır.

Kutu oluşumu olayında ek bir kapı vardır: fiyat pivottan `maxFormRiskAtr`
(3,0 ATR) üstünde uzaklaştıysa sinyal hiç üretilmez ve gerekçesi yazılır.

Sinyal ancak şu dördü birden sağlanırsa tetiklenir:
`matchCount >= minMatches`, `winRate >= minWinRate`, `rr >= minRr` ve
`winRate * rr - (1 - winRate) >= minExpectancy`. Son koşul isabet oranı ile
risk/ödülü tek ölçüte bağlar: yüksek isabet tek başına yetmez, kurulumun
matematiği de olumlu olmalıdır.

`minRr` varsayılan olarak **kapalıdır**. Eski indikatörle ölçülmüştü: kenardan
girişte risk ve ödül zaten bölge geometrisine bağlı olduğu için ek bir oran
filtresi yalnızca örnek sayısını azaltıyordu. Yeni indikatörde dokunuş olayı için
aynı mantık geçerlidir; oluşum olayında risk/ödül `formTargetRr` ile zaten sabit
tutulduğu için bu filtre yine bağlayıcı değildir.

Güven puanı üç parçadan gelir: eşleşme sayısı (0,40), tutma oranının 0,5'ten
uzaklığı (0,35) ve ortalama benzerliğin eşiği ne kadar aştığı (0,25).

### 6.8 Yürüyen ileri test

Hafızadaki her olay zaman sırasına konur ve her biri **yalnızca kendinden
önceki** olaylarla değerlendirilir. Isınma için ilk `warmupEvents` olay
atlanır, ayrıca sorgu zamanına çok yakın kayıtlar için ambargo uygulanır.

Özet çıktısı: toplam olay, tetiklenen sinyal, kazanan, kaybeden, kazanma oranı,
ATR cinsinden beklenti, kâr faktörü, azami geri çekilme, ortalama R/R,
`baselineWinRate` ve **iki sinyal türünün ayrı kırılımı** (`byKind`).

**İşlem maliyeti teste dahildir.** Bu, küçük zaman dilimlerinde sonucu tamamen
değiştirir. Ölçülen medyan ATR: 1 dakikalıkta tüm geçmişte yalnızca 0,35 dolar,
5 dakikalıkta 0,94, 15 dakikalıkta 1,87 dolar (2025-2026'da sırasıyla 1,40, 3,92
ve 6,55 dolar). Yani 1 dakikalıkta ATR biriminde görünen ince bir brüt beklenti,
tipik bir spread karşısında kolayca eriyebilir.

Maliyet iki şekilde verilebilir:

- `costPct` (varsayılan 0,000068): fiyata oranlı. 17 yıllık testte doğru ölçü
  budur, çünkü altın 900 dolardan 4400 dolara çıkmıştır ve sabit dolar maliyeti
  eski yılları haksız yere ağır cezalandırır.
- `costUsd`: sabit dolar. `costPct` sıfırlanırsa kullanılır.

Özet, brüt ve net beklentiyi ayrı ayrı raporlar (`grossExpectancyAtr`,
`costPerTradeAtr`, `expectancyAtr`) ve maliyetin edimin ne kadarını yediğini
gösterir (`costShare`). Kâr faktörü net sonuç üzerinden hesaplanır; isabet oranı
ise maliyetten bağımsızdır, çünkü hedefin vurulup vurulmadığını ölçer.

---

## 7. Bilinen sınırlar

Bunlar açıkça bilinen ve kabul edilmiş sınırlardır:

1. **TradingView sekmesine çizim yapılamaz.** O sekme gömülü bir TradingView
   widget'ıdır ve iframe içeriğine dışarıdan erişilemez. Kendi bölgelerimiz ve
   sinyallerimiz yalnızca uygulamanın kendi grafiğinde görünür. TradingView
   sekmesi sadece karşılaştırma ve tanıdık bir görünüm içindir.
2. **Yeni indikatörün sayıları henüz ölçülmedi.** İndikatör MASTER 1 TOUCH'tan
   "proje son versiyon 3"e geçirildi. README'deki tablo ve `presets.js`
   içindeki hazır ayarlar eski indikatöre aittir. Yeni indikatörün gerçekten
   kazandırıp kazandırmadığı, siz Test sekmesinde yürüyen ileri testi
   çalıştırana kadar **bilinmiyor**. Özellikle kutu oluşumu sinyali tamamen yeni
   bir fikirdir ve hiç doğrulanmamıştır.
3. **Kutu oluşumu sinyalinin riski sabit değildir.** Dokunuş olayında giriş
   bölge kenarıdır, risk bölge yüksekliğine eşittir ve her kurulumda aynıdır.
   Oluşum olayında giriş onay barının kapanışıdır; fiyat pivottan ne kadar
   kaçtıysa risk o kadar büyür. `formTargetRr` hedefi riske orantılayarak
   risk/ödülü sabitler ve `maxFormRiskAtr` aşırı olanları eler, ama bu türün
   doğası gereği daha gürültülü olduğunu unutmayın.
4. **Sinyal sayısı eşiklere çok duyarlıdır.** `minSimilarity` değerini 0,80'den
   0,85'e çekmek sinyal sayısını birkaç kat azaltabilir. Eşikleri değiştirdikten
   sonra mutlaka Test sekmesinden yürüyen ileri testi yeniden çalıştırın; az
   sayıda işlemle çıkan yüksek kazanma oranı istatistiksel olarak anlamsızdır.
5. **Kutu sayısı iki kesin kapıya bağlıdır.** Hacim ve Bollinger filtreleri
   birlikte çok seçicidir; varsayılan ayarlarda bir yılda sadece birkaç yüz kutu
   oluşabilir. Hafıza kuracak kadar olay çıkmıyorsa `minFlowToShow` değerini
   düşürün veya Bollinger çarpanını küçültün, ama bunun kurulumun "aşırılık"
   niteliğini zayıflattığını bilin.
6. **Edim ince, maliyet belirleyici.** İşlem maliyeti küçük zaman dilimlerinde
   beklentinin çoğunu yiyebilir. Spreadiniz varsayılandan (fiyatın %0,0068'i)
   belirgin biçimde yüksekse, ya da kayma (slippage) eklenirse pay hızla erir.
   Test sekmesinde kendi maliyetinizi girip sonucu yeniden ölçün.
7. **Limit emir varsayımı.** Dokunuş olayında plan girişi bölge kenarına konan
   limit emirdir ve dokunuş tanımı gereği fiyat o kenarı geçtiği için emrin
   dolduğu varsayılır. Gerçekte hızlı hareketlerde kısmi dolum veya hiç dolmama
   olabilir; test bunu modellemez.
8. **Hacim kaynağa göre değişir.** HistData ve Polygon tick hacmi verir, Yahoo
   ve Binance gerçek hacim verir, Twelve Data hiç vermez, OKX çoğunlukla sıfır
   verir. Hafıza bir hacim cinsiyle kurulup başka bir hacim cinsiyle canlıya
   çıkılırsa flow bileşeni tutarsız olur. Geçmiş ve canlı için aynı cinsi
   kullanmaya çalışın. Akış gücü doğrudan hacim oranından hesaplandığı için bu
   tutarsızlık kutu oluşumunu bile etkiler.
9. **Vekil fiyat kayması.** GC=F, PAXG ve XAUT spot XAUUSD değildir. Basis
   düzeltmesi seviyeyi hizalar ama vadeli primi zamanla değişir, tam eşitlik
   sağlanmaz.
10. **Geçmiş performans geleceği garanti etmez.** Sistem geçmişteki
   koşullanmalı olasılıkları ölçer. Piyasa rejimi değişirse (2020 gibi) ölçülen
   oranlar bozulabilir.
11. **Bu bir karar destek aracıdır, yatırım tavsiyesi değildir.** Emir
   göndermez, pozisyon açmaz. Verdiği sayılar geçmiş verinin istatistiğidir,
   gelecek vaadi değildir. Alım satım kararları ve sonuçları kullanıcıya aittir.

---

## 8. Ayarlar ve veriler nerede saklanır

Uygulama tüm verisini işletim sisteminin standart kullanıcı veri klasöründe
tutar. Uygulama içinden hiçbir şey proje klasörüne yazılmaz.

| İşletim sistemi | Klasör |
| --- | --- |
| macOS | `~/Library/Application Support/Zone Memory` |
| Windows | `%APPDATA%\Zone Memory` |
| Linux | `~/.config/Zone Memory` |

Klasör içeriği:

```
Zone Memory/
  settings.json                    Tüm ayarlar ve API anahtarları
  data/
    XAUUSD_1m.bin                  Mum deposu (ikili, ZMEM0001 biçimi)
    XAUUSD_5m.bin
    XAUUSD_15m.bin
    XAUUSD_1h.bin
    XAUUSD_4h.bin
    XAUUSD_15m_memory.json         Hafıza üst verisi (olaylar, sonuçlar)
    XAUUSD_15m_memory.vec          Özellik vektörleri (float32)
    XAUUSD_15m_memory.protos.json  Prototip kümeleri
    XAUUSD_15m_memory.zones.json   Kayıtlı bölgeler
```

Klasörü başka bir yere almak isterseniz ortam değişkenlerini kullanın:

```bash
export ZONE_MEMORY_USER_DIR=/istediginiz/yol
export ZONE_MEMORY_DATA_DIR=/istediginiz/yol/data
```

Bu değişkenler hem uygulamada hem de `scripts/` altındaki betiklerde geçerlidir.

**Sıfırdan başlamak** için: uygulamayı kapatın, `data/` klasörünü silin ve
3. bölümdeki veri kurulumunu tekrarlayın. Ayarları da sıfırlamak isterseniz
`settings.json` dosyasını silin.

**Yedekleme:** `data/` klasörü büyüktür (1m serisi yaklaşık 290 MB) ama
tamamen yeniden üretilebilir. Yedeklenmeye değer tek dosya `settings.json`
dosyasıdır.
