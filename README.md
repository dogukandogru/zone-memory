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
   Karar dokunuş barının **kapanışında** verilir, giriş o kapanıştan **sonra**
   gelir: kapanış kenarın lehte tarafındaysa bir sonraki bardan itibaren kenara
   limit emir, kapanış bölgenin içindeyse kapanıştan, kapanış geçersizliğin
   ötesindeyse işlem yoktur. Emir dolmazsa işlem yazılmaz.

Bu sinyallerin bir kısmı tutar, bir kısmı tutmaz. Zone Memory tam olarak bu
farkı öğrenir:

1. 2009'dan bugüne kadarki tüm XAUUSD mumlarında indikatörü **birebir** çalıştırır.
2. Her kutu için en fazla bir oluşum ve bir dokunuş olayı kaydeder
   (sistemin öğrenme birimi budur).
3. Her olayın sonucunu geriye dönük etiketler: bölge tuttu mu (`respect`),
   kırıldı mı (`break`), hiçbir şey olmadan ufuk mu doldu (`timeout`), yoksa
   limit emir hiç dolmadı mı (`nofill`).
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

Aşağıdaki tablo **yeni indikatörün** (proje son versiyon 3) gerçek ölçümüdür,
17 Eylül 2026'da tüm geçmiş yeniden tarandıktan sonra alındı. Tekrar üretmek
için:

```bash
node scripts/measure-all.mjs            # ölçer ve tabloyu basar
node scripts/measure-all.mjs --scan     # önce hafızaları yeniden kurar
```

Yöntem:

- 6.115.790 adet 1 dakikalık XAUUSD mumu, 2009-03 ile 2026-09 arası.
- Testin kendisi ileriye bakmaz: her olay yalnızca **sonucu kendisinden önce
  belli olmuş** kayıtlarla karşılaştırılır (ambargo olay zamanına değil,
  sonucun çözüldüğü zamana göre işler).
- Taban, **aynı türün** ve aynı dönemin oranıdır: seçim yapmadan o türün tüm
  olaylarını almak. Oluşum ve dokunuş tabanları birbirinden çok farklı olduğu
  için karıştırılmaz.
- İşlem maliyeti dahildir: fiyatın %0,0068'i, yani 4400 dolarlık altında
  0,30 dolar gidiş-dönüş spread.
- Dokunuş olaylarında giriş gerçekçidir: karar bar kapanışında verilir, emir
  bir sonraki bardan itibaren bölge kenarına konur, dolmazsa işlem yazılmaz.

Tablo **kutudan çıkan varsayılan eşiklerle** üretildi (benzerlik 0,80, en az
eşleşme 15, en az tutma %62, kalibrasyon önseli 20). Tekrar üretmek için:
`node scripts/measure-all.mjs`.

| TF | olay | işlem | isabet [%95 aralık] | taban | katkı | p | net/işlem [%95 aralık] | sonuç |
|---|---|---|---|---|---|---|---|---|
| 1m | 41.446 | 282 | %49,6 [43,9, 55,4] | %49,5 | +0,2 puan | 1,00 | -0,247 [-0,491, -0,014] | kanıtlanmadı |
| 5m | 13.729 | 733 | %44,9 [41,3, 48,5] | %45,9 | -1,1 puan | 0,58 | -0,209 [-0,361, -0,051] | kanıtlanmadı |
| 15m | 5.801 | 22 | %40,9 [23,3, 61,3] | %39,4 | +1,5 puan | 1,00 | -0,104 [-0,870, +0,702] | kanıtlanmadı |
| 1h | 1.481 | 86 | %48,8 [38,6, 59,2] | %47,8 | +1,0 puan | 0,91 | -0,128 [-0,570, +0,279] | kanıtlanmadı |
| 4h | 491 | 0 | - | - | - | - | - | yetersiz hafıza |

**Bu tablo nasıl okunur.** Bakılacak sayı, işaret değil **aralığın tamamıdır**.
Hiçbir zaman diliminde katkı tabandan ayırt edilemiyor (p değerleri 0,58 ile
1,00 arası) ve 1m ile 5m'de net beklentinin aralığı tamamen negatif, yani işlem
maliyeti brüt edimi yiyor.

**Bir ders:** Bu tablonun daha eski bir sürümünde 1h satırı +6,2 puan katkı ve
+0,103 ATR net gösteriyordu. O sayı bir düzeltmeye dayanamadı: seans ve saat
özellikleri Istanbul yerine Atina saatine taşınıp "üst zaman dilimi trendi"
gerçekten üst zaman diliminden hesaplanınca (bkz. 6.2) aynı ölçüm +1,0 puana
indi. Yüz civarı işlemde görünen bir fark, özellik tanımındaki bir değişikliğe
dayanmıyorsa gürültüdür.

Kısaca: **sistem şu an hiçbir zaman diliminde kanıtlanmış bir katma değer
üretmiyor.** Fikrin çalışmadığı anlamına gelmez, ölçümün dürüst hâli budur.
`src/core/learn/presets.js` içindeki hazır ayarlar hâlâ eski indikatörden
gelir. Eşikleri kendiniz arayabilirsiniz:

```
node scripts/search-params.mjs --tf 15m      # eşik ızgarası, seçim + doğrulama dilimi
node scripts/weight-study.mjs --tf 15m       # benzerlik ağırlıkları, AUC ile
```

İkisi de dönemi ikiye böler: ızgara **geçmiş** dilimde denenir, seçilen ayar
yalnızca **sonraki** dilimde raporlanır. Bugüne kadar hiçbir ayar doğrulama
diliminde sıfırın üstünde bir alt sınır vermedi.

Zaman dilimini değiştirdiğinizde uygulama o zaman dilimi için kayıtlı hazır
ayarı uygular (`src/core/learn/presets.js`). Sıra şudur: çekirdek varsayılanı,
sonra zaman dilimine ait hazır ayar, en üstte Ayarlar ekranından girdiğiniz
değerler. Ayarlar dosyasına yalnızca sizin değiştirdiğiniz alanlar yazılır,
böylece dokunmadığınız bir eşikte hazır ayar gerçekten devreye girer.

Tarama, Test sekmesi ve canlı mod aynı birleştirmeyi kullanır. Planın hedefi
(TP1) hafızanın etiketlendiği hedefle aynıdır: "bölge tuttu" ile "TP1 vuruldu"
aynı olaydır. Hafıza hangi ayarla kurulduğunu kendi içinde saklar; ayarı
değiştirip yeniden taramazsanız canlı mod sinyal üretmez ve Test sekmesi
sonucun eski ayarlara ait olduğunu söyler.

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

### 3.4 Bakım ve tanı betikleri

Dördü de Electron olmadan çalışır ve `ZONE_MEMORY_USER_DIR` /
`ZONE_MEMORY_DATA_DIR` değişkenlerine uyar. Her birinin `--help` çıktısı vardır.

**`node scripts/data-doctor.mjs` (veri doktoru).** Depodaki serinin sağlık
raporunu basar: iç boşluklar, aylık kapsama oranı, hafta sonu barları, sıfır
hacimli barlar, tekrar eden veya sırasız zaman damgaları ve hacim rejimi
kırılmaları. Boşluk sayarken kural tabanlı piyasa takvimini kullanır, yani
hafta sonu ve günlük ara (New York 17:00-18:00) boşluk sayılmaz. Bu rapor
gereklidir çünkü kod iç boşlukları hiç görmüyordu; ölçüldü ki 2023-02-20 ile
2023-07-28 arasında sistematik bir "bir saat var, bir saat yok" deseni var
(yaklaşık 479 tam saat eksik). Aynı rapor uygulama içinden `data:doctor`
komutuyla da alınır. Seçenekler: `--tf`, `--from`, `--to`, `--min-gap`, `--json`.

**`node scripts/repair-proxy.mjs` (vekil onarımı).** Canlı döngü bir dönem
basis ve hacim ölçeği uygulamadan ham PAXG barlarını depoya yazdı. Ham bar bir
kez girince fiyat kaydırması hesabı sıfır çıkıp düzeltme kalıcı olarak
kapanıyor, senkron da kilitleniyordu. Bu betik vekil kaynakla yazılmış bölümü
bulup keser ve türetilmiş zaman dilimlerini 1 dakikalıktan yeniden üretir.
Kesim noktasını sırasıyla `--cut`, `XAUUSD_<tf>.proxy.json` kaydı ve hacim
damgası (HistData hacmi tam sayıdır, Binance PAXG hacmi kesirlidir) verir.
**Varsayılan olarak hiçbir şey yazmaz**; `--apply` ile önce
`<ad>.bak-YYYYMMDD-HHMMSS` yedeği alınır. Koddaki kalıcı düzeltme
`loader.normalizeProxy` içindedir: düzeltme hesaplanamazsa artık hiçbir bar
yazılmaz.

**`node scripts/fix-dst.mjs` (yaz saati göçü).** Tek seferliktir. Eski
ayrıştırıcı HistData dosya saatlerini sabit UTC-5 sayıyordu; gerçekte yaz saati
uygulanıyor ve kural 2019'da değişmiş (2018 ve öncesi ABD, 2019 ve sonrası
Avrupa tarihleri). Bu yüzden yılın yedi sekiz ayında depodaki her bar bir saat
geç etiketliydi. Ayrıştırıcı düzeltildi
(`src/core/data/histdata.js` içindeki `dosyaOfsetiSn`); bu betik daha önce
yazılmış barları düzeltir. Bitince `<ad>.dst.json` işaret dosyası yazar ve
işaret varken yeniden çalışmayı **reddeder**, çünkü çift kaydırma seriyi bozar.
Sıra önemlidir: önce `repair-proxy`, sonra bu göç, en son yeni ayrıştırıcıyla
eksik ay indirilir. `--apply` verilmezse yalnızca rapor basar.

**`node scripts/measure-all.mjs` (ölçüm).** Tüm zaman dilimlerinde yürüyen
ileri testi çalıştırıp tek bir karşılaştırma tablosu üretir. 1. bölümdeki ölçüm
tablosu bu betiğin çıktısıdır. Varsayılan olarak yalnızca test eder (hafıza
zaten kuruluysa), `--scan` ile önce hafızaları yeniden kurar. `--tfs 5m,15m,1h`
ile alt küme, `--json` ve `--out` ile makine okunur çıktı alınır. Kullanıcının
`settings.json` içindeki ayar yaması okunur, yani ölçüm gerçekten kullanılan
ayarla yapılır.

---

## 4. Kullanım

### 4.1 Geçmişi Tara

Üst şeritteki zaman dilimini seçin (varsayılan: **5m**) ve **Geçmişi Tara**
düğmesine basın. Uygulama:

1. Seçilen zaman diliminde indikatörü baştan sona çalıştırır.
2. Tüm kutuları, kutu oluşum olaylarını ve bölgeye ilk geri dönüşleri bulur.
3. Her olayı hedef / geçersizlik / ufuk kuralına göre etiketler.
4. Özellik vektörlerini çıkarır ve hafızayı diske yazar.
5. Başarılı kurulumlardan şekil kümeleri üretir (bilgi amaçlı, bkz. 6.6).

Uzun bir seride bu işlem birkaç dakika sürer ve on binlerce olay üretir.
Bir kez yapılır, yeni veri gelince yeniden taranır (15m yaklaşık 0,2 sn,
1m yaklaşık 1,7 sn). Artımlı tarama **yoktur**: yeniden taramada bölge ve olay
kimlikleri sıfırdan numaralanır ve bar indeksleri kayar, bu yüzden parçalı
güncelleme sessiz veri bozulması üretirdi. İlerleme çubuğu üst şeritte
görünür.

Taramanın iki sessiz kuralı vardır:

- **Hafıza kendi ayar izini taşır.** Hangi indikatör ayarı, hangi etiket tanımı
  ve hangi özellik sürümüyle kurulduğu hafıza dosyasına yazılır (`cfgHash`).
  Ayarı değiştirip yeniden taramazsanız canlı mod sinyal üretmez ve Test
  sekmesi sonucun eski ayara ait olduğunu söyler.
- **Tarama ölçümünüzü silmez.** Eski test sinyalleri ve son test özeti
  **yalnızca ayar izi değiştiyse** silinir. Eskiden her taramada siliniyordu;
  canlı akış depoya bar ekledikçe otomatik tarama başlıyor ve ölçtüğünüz sonuç
  sessizce kayboluyordu.

Penceresinde gerçek veri boşluğu olan olaylar hafızaya **alınmaz**, yalnızca
sayılır (hafıza özetinde `lowCoverage`). Sebebi 6.2'de anlatılıyor.

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
| Kanıt durumu | Bu **türün** katma değeri son ölçümde kanıtlandı mı (aşağıda) |
| Eşleşme sayısı | Benzerlik eşiğini geçen, aynı türdeki geçmiş kayıt sayısı |
| Ortalama benzerlik | Bu eşleşmelerin ortalama benzerlik puanı (0 ile 1) |
| Kazanma oranı | Eşleşmelerin kaçı bölgeye saygı göstermiş |
| Güven skoru | Eşleşme sayısı, oranın 0,5'ten uzaklığı ve benzerliğin bileşimi |
| Benzerlerde sonuca kadar ortalama lehte / aleyhte hareket | Eşleşmelerin `mfeExitAtr` ve `maeExitAtr` ortalaması, ATR cinsinden. Tüm ufku ölçen ham MFE değil: o, stop vurulduktan sonraki hareketi de sayıyor ve hedefin 2,5 katına çıkabiliyordu |
| Plan riski (SL mesafesi) | Girişten stopa uzaklık, ATR cinsinden. Yukarıdaki aleyhte hareketle aynı şey değil |
| Durum | Sinyal üretildi mi, yoksa eşikler mi geçilmedi |
| Giriş / TP1 / SL | Bölge geometrisinden türetilen plan |
| TP2 (uzatma) | Yalnızca bölgeyi **tutmuş** benzer kayıtların risk birimi başına gittiği yoldan. Beşten az böyle kayıt varsa ya da sonuç TP1'in 1,1 katına ulaşmıyorsa TP2 **gösterilmez** |
| R/R | (TP1 - giriş) / (giriş - SL) mutlak değeri |
| Gerçekleşen sonuç | Yalnızca testte üretilen sinyallerde; bölgenin durumu ve net kazanç |
| Gerekçeler | Sinyalin neden oluştuğu veya neden oluşmadığı, Türkçe |

**Kanıt rozeti.** Sinyal kartında `KANITLI` / `ZAYIF` / `KANIT YOK` etiketi
vardır. Kaynağı son yürüyen ileri testin **o sinyal türü için** ölçtüğü net
beklentidir (R biriminde, %95 bootstrap aralığıyla): aralığın alt sınırı
sıfırın üstündeyse `KANITLI`, yalnızca ortalama pozitifse `ZAYIF`, aksi halde
`KANIT YOK`. Hiç ölçüm yoksa ya da hafızanın ayar izi ölçümdekinden farklıysa
`KANIT YOK` kabul edilir ve gerekçelere bir uyarı satırı eklenir. 1. bölümdeki
tabloya göre şu an hiçbir tür `KANITLI` değildir.

Önemli: eşikleri geçemeyen olaylar da listelenir, ama `fired: false`
durumundadır. Böylece "neden sinyal vermedi" sorusunun cevabı görünür kalır.

### 4.4 Test sekmesi

Yürüyen ileri test (walk forward) sonuçlarını gösterir. Her olay yalnızca
**kendinden önceki** hafızayla değerlendirilir, yani ileriye bakma yoktur.
Sekmede özet tablo, istatistik kırılımı, kalibrasyon tablosu, sinyal türüne
göre kırılım, yıllara göre kırılım, sermaye eğrisi ve canlı sinyal günlüğü
bulunur.

**Taban artık aynı türün tabanıdır.** `Taban başarı oranı (aynı tür)` satırı,
"hiçbir seçim yapmadan bu türün olaylarını al" senaryosunun oranıdır: ısınma
sonrası dönemden, aynı işlem planıyla ve tetiklenen işlemlerin tür karışımıyla
ağırlıklandırılarak hesaplanır. `Tabana göre katkı` bu ikisinin farkıdır. Eski
"tüm etiketlenmiş olayların ham oranı" tanımı iki türü karıştırdığı için ekranda
sahte katkı gösteriyordu; o sayı hâlâ hesaplanıyor ama artık yalnızca bilgi
amaçlı ayrı bir alanda duruyor (`rawWinRate`).

**Tek bir sayıya bakmayın, belirsizliğe bakın.** Özet şunları da gösterir:

| Satır | Ne söyler |
| --- | --- |
| İsabet %95 aralığı | Wilson skor aralığı, isabet oranının belirsizliği |
| Tabandan farkın p değeri | İki yönlü binom testi; büyük p "fark yok" demektir |
| Net beklenti %95 aralığı | Günlük blok bootstrap; aynı gün içindeki işlemler bağımlı sayılır |
| Aynı türden rastgele seçim bu kadar iyi olabilir mi | Permütasyon olasılığı; 1'e yakın değer "seçim bir şey katmıyor" demektir |
| Katma değer kanıtlandı mı | Net beklentinin alt sınırı tabanın üstünde mi |
| Beklenti (R) | Her işlemin kendi riskine bölünmüş sonucu; ATR birimi işlemler arası riski eşitlemez, R eşitler |
| Brüt / Maliyet / işlem, maliyetin payı, maliyet iki kat olsaydı, başa baş isabet | Maliyet kırılımı |
| Zaman aşımı, Limit emir dolmadı | Kaç işlem ufuk sonunda kapandı, kaç emir hiç dolmadı |
| Değerlendirilen dönem, Isınma | Ölçümün hangi aralığı kapsadığı ve tür/yön başına asgari aday sayısı |

**Kalibrasyon tablosu** sistemin söylediği oran ile gerçekleşen oranı yan yana
koyar ("sistem %62 dedi, gerçekleşen %50"). Altındaki **Brier skoru** küçükse
tahminler daha iyidir; sabit taban tahmininin Brier skoru da yanında yazar,
karşılaştırma için.

Hemen altındaki **"Sinyal türüne göre"** tablosu iki sinyal türünü ayrı ayrı
gösterir; her türün tabanı **kendi türünün** tabanıdır. Toplam rakam, türlerden
birinin diğerini taşıdığı durumları gizler: kutu oluşumu zarar ederken bölge
dokunuşu kazanıyor olabilir ve toplamda ikisi birden makul görünebilir. Hangi
sinyalin gerçekten çalıştığına bu tabloya bakarak karar verin. Bir tür işinize
yaramıyorsa Ayarlar ekranından
(`Kutu oluşumunda sinyal üret` / `Bölgeye dokunuşta sinyal üret`) kapatın ve
yeniden tarayın.

Örneklem yetersizse özet, katkı rakamının yerine bir **uyarı** gösterir
(`yetersiz hafıza`, `işlem yok`, `yetersiz örneklem`). Az sayıda işlemle çıkan
yüksek bir oran istatistiksel olarak anlamsızdır.

**Ölçüm diske yazılır.** Test bitince sonuç `<ad>_memory.backtest.json`
dosyasına kaydedilir (kullanılan ayar, hafızanın ayar izi, özet, yıllık kırılım,
sermaye eğrisi ve tür başına kanıt durumu). Uygulamayı kapatıp açtığınızda
panel bu dosyadan doldurulur; hafızanın izi değiştiyse sonucun artık geçerli
olmadığı yazılır.

**Canlı sinyal günlüğü** panelin altında ayrı bir bölümdür: canlıda üretilen
kayıt sayısı, tetiklenen, etiketlenen, canlı başarı oranı ve net ATR; yanında
"testte ölçülen" değerler ve aradaki fark. Böylece canlı davranışın ölçümden
sapıp sapmadığı görünür. Kayıt yoksa "Henüz canlı sinyal kaydı yok." yazar.

### 4.5 Canlı mod

Üst şeritten sağlayıcı seçip **Canlı** anahtarını açın. Uygulama seçilen
aralıkta (varsayılan 20 saniye) son mumları çeker, depoya ekler ve yeni bir
mum **kapandığında** indikatörü son pencerede çalıştırır. Yeni bölge olayları
(kutu oluşumu veya ilk dokunuş) oluşursa hafızayla karşılaştırıp sinyalleri
panele düşer.

Bilinmesi gereken beş şey:

1. **Aynı tikte birden fazla olay değerlendirilir.** Önceden yalnızca son olay
   alınıyor ve pencere kaydığı için aynı bardaki diğer olaylar kalıcı olarak
   kayboluyordu. Artık "bu tikte yeni olanların hepsi" seçilir
   (`src/core/learn/liveEvents.js`); ölçüldü, 15 dakikalıkta 5378 olayın 60'ı
   aynı barda başka bir olayla birlikte oluşuyor.
2. **Hafızanın ayar izi tutmuyorsa sinyal üretilmez.** Ayarları değiştirip
   yeniden taramadıysanız yeni tanımla üretilen olay eski tanımla etiketlenmiş
   geçmişle karşılaştırılırdı; bu durum artık sessizce geçmez, günlüğe
   "Geçmişi Tara çalıştırın" notu düşer.
3. **Gecikmiş değerlendirme işaretlenir.** Olay barının kapanışından
   değerlendirme anına kadar birden fazla bar geçtiyse sinyal `stale`
   işaretlenir ve gerekçelerine gecikme notu eklenir. Fiyat çoktan kaçmış
   olabilir.
4. **Kanıt rozeti eklenir.** Her canlı sinyale, son ölçümde o **türün** katma
   değerinin kanıtlanıp kanıtlanmadığı iliştirilir (bkz. 4.3).
5. **Her canlı olay günlüğe yazılır**, tetiklenmemiş olsa bile:
   `<ad>_memory.live.jsonl`. Ufku dolan kayıtların sonucu sonradan aynı dosyaya
   eklenir ve testteki kazanç kuralının **aynısı** kullanılır. Bu dosya tarama
   ve hafıza silme işlemlerinden etkilenmez; canlı ölçü taramadan bağımsız
   birikir.

Vekil bir kaynak kullanıyorsanız (Yahoo GC=F, Binance PAXG, OKX XAUT) fiyat
farkı otomatik olarak `computeBasis` ile ölçülür ve seri spot seviyesine
kaydırılır. Bu durum sinyalin gerekçelerine not düşülür.

### 4.6 Güncel veri ve canlı akış

HistData yalnızca **kapanmış ayları** yayınlar, bu yüzden depo her zaman
1 ile 31 gün arası geride kalır. Aradaki boşluğu kapatmak ve canlı devam etmek
için üst şeritteki **Veri Çek** düğmesi kullanılır.

Bu düğme şunları yapar:

1. Seçili sağlayıcıdan eksik aralığı indirir. Güncelleme her zaman **1 dakikalık
   taban seri** üzerinden yapılır, sonra 5m, 15m, 1h ve 4h ondan yeniden üretilir.
   Böylece zaman dilimleri birbiriyle tutarlı kalır.
2. Sağlayıcı bir **vekil** ise (Binance PAXG, OKX XAUT, Yahoo GC=F) üç düzeltme
   **tek bir yerde** uygulanır (`loader.normalizeProxy`):
   - **Fiyat kaydırması:** depodaki seriyle çakışan bölgeden medyan fark
     hesaplanır ve yeni barlara uygulanır. Ölçüldü: PAXG ile spot arasındaki
     fark 1 dakikalıkta yalnızca 0,38 dolar. Çakışma bulunamazsa **hiçbir bar
     yazılmaz**; düzeltmesiz eklemek seriye sahte bir sıçrama yazardı ve bir
     kez yazılınca sonraki basis hesabı sıfır çıkıp düzeltmeyi kalıcı olarak
     kapatıyordu.
   - **Piyasa saatleri:** kripto vekilleri 7/24 işlem görür, spot altın görmez.
     Hangi saatlerin açık olduğu artık **kural tabanlı** belirlenir
     (`session.createMarketCalendar`, New York yerel saati): piyasa Pazar
     18:00'de açılır, Cuma 17:00'de kapanır, her gün 17:00-18:00 arası aradır,
     Noel ve yılbaşı tam gün kapalıdır. Önceden takvim depodaki son 8 haftadan
     **veriye bakılarak** çıkarılıyordu; depoya bir kez kirli (hafta sonu) bar
     girince o saatler "açık" sayılıyor ve süzgeç kendi kendini bozuyordu.
   - **Hacim ölçeği:** HistData hacmi dakikadaki tick sayısıdır (~95), Binance
     ise PAXG miktarını verir (~0,4). İndikatörün flow bileşeni hacme bağlı
     olduğu için çakışma bölgesindeki medyan orana göre ölçeklenir.

   Vekil veriyle doldurulan aralıklar `XAUUSD_<tf>.proxy.json` dosyasına
   kaydedilir, böylece o dönem sonradan spot veriyle değiştirilebilir. Geçmişte
   kirlenmiş bir depoyu temizlemek için `scripts/repair-proxy.mjs` vardır
   (bkz. 3.4).

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
- **HistData dosya saatleri sabit UTC-5 değildir.** Yaz saati uygulanır ve
  uygulanan kural 2019'da değişmiştir: 2018 ve öncesinde ABD
  (America/New_York), 2019 ve sonrasında Avrupa yaz saati tarihleri. Dönüşüm
  `src/core/data/histdata.js` içindeki `dosyaOfsetiSn` fonksiyonundadır.
  Ölçüldü: sabit UTC-5 varsayımı yılın yaklaşık %63'ündeki barları bir saat
  ileri kaydırıyordu. Sınır 2018-11-04 ile 2019-03-10 arasında herhangi bir gün
  olabilir, çünkü o aralıkta iki kural da beş saat verir. Eski ayrıştırıcıyla
  indirilmiş bir depo varsa `scripts/fix-dst.mjs` ile bir kez düzeltilir
  (bkz. 3.4).
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

- **Birleştirme:** aktif listede aynı yönde ve orta noktası **pivot fiyatına**
  `atr * mergeAtrMult` (0,55 ATR) mesafesinden yakın bir kutu varsa yeni kutu
  açılmaz; yakın olan **bütün** kutular iki pivotu da kapsayacak şekilde
  genişler ve akış güçleri artar (tavan 10). Aynı seviyenin defalarca sayılması
  böyle engellenir. Birleşme yeni bir sinyal üretmez. Mesafenin pivot fiyatından
  ölçülmesi ve döngünün ilk eşleşmede durmaması Pine'daki davranışın birebir
  karşılığıdır; ölçüldü, bu iki fark 15 dakikalıkta kutuların yaklaşık %1'ini
  değiştiriyordu.
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

**Veri boşluğunda kalan olaylar hafızaya girmez.** Olayın penceresinde (50 bar
öncesi, ufuk kadar sonrası) piyasanın **açık olduğu** bir saatte eksik bar varsa
olay kaydedilmez, yalnızca sayılır. Sebebi: böyle bir bölgede pivot, ATR, hacim
ortalaması ve 48 barlık sonuç ufku gerçekte çok daha uzun bir zamana yayılır,
yani olay hafızaya başka bir şey ölçen bir kayıt olarak girerdi. Hafta sonu ve
günlük ara zaman atlaması yaratır ama veri boşluğu **değildir**; ayrım kural
tabanlı piyasa takvimiyle yapılır. Bu ayrım yapılmadığında 15 dakikalıkta 6890
olayın 6485'i atılıyordu.

**Etiketlenemeyen olaylar da hafızaya girmez** ve nedeni ayrı ayrı sayılır:
ufuk serinin sonuna sığmadıysa (`noLabelHorizon`, veri geldikçe kendiliğinden
çözülür) veya kurulum gerçekte işlenemezse (`formRiskBlocked`: oluşum olayında
risk `maxFormRiskAtr` eşiğini aştı, ya da karar barının kapanışı geçersizlik
tarafında kaldı). Bu ayrım olmadan "olayların yüzde kırkı nereye gitti" sorusu
cevapsız kalıyordu.

**Skor.** Kutu oluşumunun kapısı (hacim + Bollinger) kesin olduğu için o iki
kriter her kutuda doğrudur ve skor bileşeni olarak bilgi taşımaz. Bu yüzden skor
olayın **olduğu barda** değişen şeyleri ölçer: akış gücü, üst zaman dilimi
trendi, seans, fitil reddi ve o barın hacim gücü.

**Skor sinyal kararına girmez ve ölçülen tahmin gücü yoktur.** Hafıza
panelindeki "Skor bileşenleri" tablosu her bileşen için bileşenin doğru olduğu
ve olmadığı olayların oranını yan yana gösterir. Bugünkü ölçüm (hafıza
dosyaları, 19 Eylül 2026):

| Tür | Bileşen | Var | Yok | Fark | Sonuç |
| --- | --- | --- | --- | --- | --- |
| oluşum (15m) | hepsi | - | - | -2,7 ile +0,7 puan | hiçbiri ayırt etmiyor |
| dokunuş (15m) | fitil reddi | %11,1 (n=352) | %19,9 | -8,9 puan | ters yönde ayırıyor |
| dokunuş (15m) | hacim | %17,9 (n=2.249) | %23,2 | -5,3 puan | ters yönde ayırıyor |
| dokunuş (15m) | akış, trend, eşiği geçti | - | - | -3,0 ile -0,6 puan | fark yok |
| dokunuş (1h) | fitil reddi | %7,0 (n=86) | %19,2 | -12,2 puan | ters yönde ayırıyor |

Yani skorun hiçbir bileşeni doğru yönde ayırt etmiyor; fitil reddi ve hacim
dokunuş olaylarında **ters** yönde ayırıyor. Bu yüzden arayüz artık "Sinyal /
Kayıt" yazmıyor, yalnızca "eşik geçti / eşik altı" diyor; sinyal kararı
`Sinyal kararı` bölümündeki kNN eşikleriyle verilir.

Bileşenlerin `use...Score` varsayılanları buna rağmen **kapatılmadı**. Nedeni
şu: bu bayraklar hem skoru hem de özellik vektöründeki `pFlow` ... `pVolume`
boyutlarını besliyor. Bir bayrağı kapatmak ilgili boyutu sıfırlar, yani ters
yönlü ama **gerçek** olan bir bilgiyi benzerlik motorundan da siler. Skor zaten
sinyal kararına girmediği için kapatmanın tek etkisi bilgi kaybı olurdu.

İki bileşen ayrıca düzeltildi:

- **Seans bileşeni**, dört seansın hepsi açıkken her olayda 1 çıkıyordu, yani
  hiçbir şey ayırt etmiyor ama `maxScore`'u bir artırıyordu: "5 bileşenden 3'ü"
  diye okunan eşik gerçekte "4 bileşenden 2'si" oluyordu. Artık bileşen ancak
  en az bir seans **kapalıysa** sayılıyor.
- **Üst zaman dilimi trendi** için `trendTf` varsayılanı `auto` (grafiğin 4
  katı). Eskiden sabit `15m` olduğu için 15m grafikte bileşen kendi zaman
  diliminin EMA'sını soruyordu.

Skor bir kapı değildir; niteliksiz olaylar da hafızaya girer, çünkü benzerlik
motoru tüm olayları korpus olarak kullanır.

**Seans saat dilimi.** Seans ve saat özellikleri `Europe/Athens` yerel saatine
göre hesaplanır (ekranda görünen saatler yine Istanbul saatidir). Nedeni:
Türkiye 2016 Eylül'ünde yaz saatini bıraktı, bu yüzden Londra'nın 08:00 açılışı
2016 öncesi yerel 10:00, sonrasında kışları yerel 11:00 oluyordu ve kNN aynı
piyasa anını iki farklı saat olarak görüyordu. Atina AB kuralını kesintisiz
sürdürdüğü için aynı an bütün tarihte aynı yerel saate düşer.

### 6.3 Sonuç etiketleme

Buradaki tanım sistemin tamamını belirler, çünkü hafızanın öğrendiği şey budur.

Sorulan soru şu: **bölge gerçekten tuttu mu?** Genel fiyat hareketi değil,
bölgenin kendisi. Bu yüzden seviyeler bölge geometrisinden türetilir. İki olay
türünün girişi farklı olduğu için hedef hesabı da farklıdır:

|  | dokunuş olayı | oluşum olayı |
| --- | --- | --- |
| Karar anı | dokunuş barının kapanışı | onay barının kapanışı |
| Giriş | kapanıştan **sonra** (aşağıdaki üç dal) | onay barının kapanışı |
| Geçersizlik | bölgenin uzak kenarından `breakBufferAtr` \* ATR dışarıda | aynı |
| Hedef | kenardan `targetAtr` \* ATR uzakta | girişten `formTargetRr` \* risk kadar uzakta |
| Ödül | her zaman `targetAtr` | her zaman `formTargetRr` risk birimi |

- **Ufuk:** `horizonBars`, varsayılan 48 bar (her iki türde de).

**Dokunuşta giriş: karar kapanışta, giriş sonra.** Karar dokunuş barının
kapanışında verilir (`touchEntryMode = 'afterClose'`) ve kapanışın konumu üç
daldan birini seçer:

1. **Kapanış kenarın lehte tarafında** ise bir **sonraki** bardan itibaren
   kenara limit emir konur. Emrin dolmuş sayılması için fiyatın kenarı
   `fillOffsetAtr` (0,05 ATR) kadar geçmesi gerekir; kenara tam değen fiyat
   gerçekte doldurmayabilir.
2. **Kapanış bölgenin içinde** ise kapanıştan girilir.
3. **Kapanış geçersizliğin ötesinde** ise bölge o barda zaten kırılmıştır,
   olay işlem üretmez ve etiketlenmez.

**Dolmayan emir: `nofill`.** Limit emir ufuk boyunca dolmazsa, ya da dolmadan
fiyat hedefe giderse ortada işlem yoktur. Kayıt hafızada **kalır** ama komşu
havuzuna, isabet oranına ve taban hesabına **girmez**; yalnızca dolum oranı
olarak raporlanır.

**Neden değişti.** Önceki model (`zoneEdge`) girişi dokunuş barının **içinde**
kenardan dolmuş sayıyordu. Bu bar içi ileriye bakmaydı: karar bar kapanışındaki
bilgiyle (fitil reddi, penetrasyon, hacim) veriliyor ama giriş o bilgi oluşmadan
önceki bir fiyattan yazılıyordu. Ölçüldü: 5 dakikalıkta fitil reddi alt kümesi
eski modelde %58,4 isabet ve +0,490 ATR veriyordu, gerçekleştirilebilir modelde
%30,9 ve -0,117 ATR. Eski mod karşılaştırma için `outcomeCfg.touchEntryMode`
ile hâlâ seçilebilir.

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
| `nofill` | Limit emir ufuk boyunca hiç dolmadı, ortada işlem yok |

Aynı barda ikisi de olduysa **muhafazakâr** davranılır ve kırılma sayılır.
Bar içi sıralama bilinmediği için iyimser varsayım yapılmaz. Aynı kural emrin
**dolduğu** bar için de geçerlidir: o bar geçersizlik seviyesini de gördüyse
anında kırılma yazılır. Oluşum olayında böyle bir kural yoktur, çünkü emir bar
kapanınca dolar.

**Zaman aşımı tam stop zararı değildir.** `timeout` sonucunda pozisyondan ufuk
sonu kapanışından çıkılır; çıkış fiyatı `exitPrice`, risk birimi cinsinden
sonuç `realizedR` alanında durur. Önceden her zaman aşımı `-1R` yazılıyordu ve
oluşum olayında risk 1,2 ile 2,8 ATR arasında olduğu için bu ortalama -2,5 ATR
sahte zarar demekti. Test, taban oranı ve canlı günlük artık **tek bir kazanç
tanımı** kullanır (`backtest.tradeResult`).

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
   Bu sıkıştırma önceki projede, yani **eski indikatörle (MASTER 1 TOUCH)**
   ölçüldü: ham 32 barlık vektöre göre sinyal başına yaklaşık **3 kat daha
   fazla anlamlı eşleşme** üretmişti. Yeni indikatörde bu karşılaştırma
   tekrarlanmadı, yani sayı doğrulanmış değildir. Yöntemin gerekçesi ise
   ölçümden bağımsız geçerlidir: normalize edilmiş şekil fiyat seviyesinden ve
   mutlak oynaklıktan bağımsız hale gelir, böylece 2011'in 1900 dolarındaki bir
   yapı 2015'in 1100 dolarındaki yapıyla karşılaştırılabilir olur.
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

**Aday havuzu kuralı.** Bir hafıza kaydı ancak şunların hepsi doğruysa aday
olabilir:

- Sonucu hesaplanmış olmalı (`outcome` tanımlı) ve özellik vektörü bulunmalı.
- **`nofill` olmamalı.** Limit emrin hiç dolmadığı olaydan gerçekte bir işlem
  çıkmamıştır: ne kazanç ne kayıp. Havuzda tutulsaydı "geçmişte bu yapı %X
  tuttu" oranı yanlış hesaplanırdı.
- `kind`: yalnızca **aynı türdeki** olaylar aday olur. Kutu oluşumu yalnızca
  geçmişteki oluşumlarla, dokunuş yalnızca geçmişteki dokunuşlarla
  karşılaştırılır.
- `direction`: yalnızca aynı yöndeki olaylar.
- `excludeWithinSec` (varsayılan 3 gün): sorgu zamanına çok yakın kayıtlar
  elenir. Aksi halde aynı kurulum kendisiyle eşleşir.
- `beforeTime`: yalnızca belirtilen zamandan önceki kayıtlar aday olur.
  Yürüyen ileri testte bu şarttır, ileriye bakmayı imkânsız kılar.

Sinyal katmanı komşu bulmayı (pahalı) ve karar vermeyi (ucuz) ayrı iki adımda
yapar. Eşikler değiştiğinde komşular değişmediği için eşik taraması aynı komşu
listesini yeniden kullanabilir.

### 6.6 Şekil kümeleri (bilgi amaçlı, sinyale katkısı yok)

Yalnızca **başarılı** olayların şekil vektörleri k-means++ ile kümelenir
(varsayılan `k = 8`, en az 15 üyeli kümeler kalır, sabit tohum ile
deterministik). Her küme eğim ve son hareketten türetilen okunabilir bir ad
alır, örneğin `Düşen + V dönüş`; aynı ad iki kümeye düşerse sonuna `#id`
eklenir.

**Bu kümeler sinyal kararına katılmaz ve gerekçe metinlerinde görünmez.**
Ölçüldü: kümelerin tutma oranı hafıza tabanından ayırt edilemiyor (15m'de
sekiz kümenin oranı %31,2 - %35,5, hafıza tabanı %33,4; prototip oranı
başarılı ve başarısız olaylarda 0,3343'e karşı 0,3336). Bir dönem sinyal
gerekçesinde "En yakın ortak yapı" satırı vardı ve olmayan bir dayanak hissi
veriyordu; kaldırıldı. `Signal.prototypeId`, `prototypeSim` ve
`prototypeLabel` alanları uyumluluk için duruyor ama her zaman boş döner.

Hafıza panelindeki küme listesi her kümenin yanında hafıza tabanına göre puan
farkını ve %95 Wilson aralığını gösterir; renk yalnızca aralık tabanı
dışarıda bırakıyorsa kullanılır.

### 6.7 Sinyal eşikleri

Varsayılan değerler:

Çekirdek varsayılanları (`DEFAULT_SIGNAL_CFG`):

| Ayar | Varsayılan | Anlamı |
| --- | --- | --- |
| `k` | 25 | En fazla kaç komşu incelenir |
| `minSimilarity` | 0,80 | Bir kaydın "benzer" sayılması için eşik |
| `minMatches` | 15 | Eşiği geçen en az kaç kayıt gerekli |
| `minWinRate` | 0,62 | Bu kayıtlarda en az tutma oranı |
| `minExpectancy` | 0,10 | Asgari beklenen değer, risk birimi cinsinden |
| `minRr` | 0 (kapalı) | Asgari risk/ödül oranı |
| `useZoneStop` | açık | TP1 ve SL bölge geometrisinden alınır |
| `tp2Pct` | 70 | Uzatma hedefi için, **tutmuş** komşuların risk birimi başına gittiği yolun yüzdeliği |
| `priorStrength` | 20 | Kalibrasyon önseli: gösterilen oran havuz tabanına bu ağırlıkta çekilir |
| `minLift` | 0 (kapalı) | Kalibre oranın tabandan en az farkı |
| `halfLifeYears` | null (kapalı) | Zaman ağırlığı: eski eşleşmelerin yarı ömrü |
| `baseWindowYears` | null (kapalı) | Kalibrasyon tabanı yalnızca son N yıldan |

**Zaman ağırlığı neden kapalı.** kNN zamanı yalnızca filtre olarak kullanıyor:
2023 sonrası sorgularda eşleşmelerin ortalama yaşı 15m'de 8,2 yıl. Yıllık taban
da belirgin oynuyor (15m dokunuşta 2018'de %15,5, 2020'de %33,1, aralıklar
örtüşmüyor). Ölçüldü (`node scripts/search-params.mjs --tf 15m --ablation`),
doğrulama dilimi:

| Varyant | 15m Brier (taban) | 1h Brier (taban) |
| --- | --- | --- |
| kapalı | 0,226 (0,229) | 0,207 (0,231) |
| yarı ömür 8 yıl | 0,224 (0,227) | 0,205 (0,227) |
| yarı ömür 2 yıl | 0,219 (0,220) | 0,212 (0,228) |
| taban 3 yıl | 0,222 (0,224) | 0,216 (0,231) |

Kazanç en iyi durumda 0,002 Brier, yani ölçüm hatasının içinde; 15m'de en iyi
1/5 dilimin net sonucu ağırlıkla **kötüleşiyor** (-0,023 R'den -0,084 R'ye).
Bu yüzden seçenek kodda var ama varsayılan kapalı. Açmadan önce kendi
verinizde bu ablasyonu çalıştırın.

Hazır ayar katmanı bu üç alanı zaman dilimine göre ezer
(`src/core/learn/presets.js`):

| TF | `minSimilarity` | `minMatches` | `minWinRate` | `targetAtr` |
| --- | --- | --- | --- | --- |
| 1m | 0,80 | 15 | 0,62 | 1,0 |
| 5m | 0,80 | 15 | 0,55 | 1,5 |
| 15m | 0,85 | 15 | 0,55 | 1,5 |
| 30m | 0,85 | 10 | 0,55 | 2,0 |
| 1h | 0,85 | 10 | 0,55 | 2,0 |
| 4h | 0,85 | 8 | 0,55 | 2,0 |

**Bu hazır ayarlar eski indikatörle (MASTER 1 TOUCH) yapılan taramadan gelir ve
yeni indikatör için yeniden aranmalıdır.** 30m, 1h ve 4h satırları o taramada
bile ölçülmedi, 15 dakikalıktan türetildi. Şimdilik makul bir başlangıç noktası
olarak duruyorlar; kendi ayarınızı bulmak için Test sekmesindeki yürüyen ileri
testi farklı eşiklerle çalıştırın ve "Sinyal türüne göre" tablosuna bakın.

Sıra şudur: çekirdek varsayılanı, sonra hazır ayar, en üstte sizin Ayarlar
ekranından girdiğiniz değer. Tarama, Test ve canlı mod bu birleştirmenin
**aynısını** kullanır (`presets.resolveCfg`); plan geometrisi ise her zaman
hafızanın etiketlendiği `outcomeCfg` değerinden gelir.

TP1 ve SL bölge geometrisinden gelir (bkz. 6.3), yüzdelikten değil. `tp1Pct` ve
`slPct` yalnızca bölge bilgisi olmayan yedek yolda kullanılır.

Kutu oluşumu olayında ek bir kapı vardır: fiyat pivottan `maxFormRiskAtr`
(3,0 ATR) üstünde uzaklaştıysa sinyal hiç üretilmez ve gerekçesi yazılır.
Hafıza da böyle bir olayı etiketlememiştir, yani öğrenilmiş bir istatistiği
zaten yoktur.

Sinyal ancak şu dördü birden sağlanırsa tetiklenir:
`matchCount >= minMatches`, `winRate >= minWinRate`, `rr >= minRr` ve
`beklenen değer >= minExpectancy`.

**Beklenen değer formülü** risk birimi cinsindendir:

```
bd = pR * rr - pB + pT * mT
```

`pR` eşleşmelerde bölgenin tuttuğu oran, `pB` kırılma oranı, `pT` zaman aşımı
oranı, `mT` ise zaman aşımına uğrayan komşuların ortalama gerçekleşen R'sidir.
Eski formül (`winRate * rr - (1 - winRate)`) zaman aşımını **tam zarar**
sayıyordu, yani ufuk sonunda sıfıra yakın kapanan işlemler -1R gibi görünüyordu.
Bu alanı taşımayan eski hafızalarda eski formüle düşülür. Koşulun anlamı
değişmedi: yüksek isabet tek başına yetmez, kurulumun matematiği de olumlu
olmalıdır.

`minRr` varsayılan olarak **kapalıdır**. Eski indikatörle ölçülmüştü: kenardan
girişte risk ve ödül zaten bölge geometrisine bağlı olduğu için ek bir oran
filtresi yalnızca örnek sayısını azaltıyordu. Yeni indikatörde dokunuş olayı için
aynı mantık geçerlidir; oluşum olayında risk/ödül `formTargetRr` ile zaten sabit
tutulduğu için bu filtre yine bağlayıcı değildir.

Güven puanı üç parçadan gelir: eşleşme sayısı (0,40), tutma oranının 0,5'ten
uzaklığı (0,35) ve ortalama benzerliğin eşiği ne kadar aştığı (0,25).

### 6.7.1 Ekonomik takvim (istersen)

Yüksek etkili ABD verisi anlarında bölgeler daha hızlı kırılıyor: ölçüldü,
yaklaşık NFP penceresinde 15m dokunuş isabeti %15,3 (n=59), diğer zamanlarda
%28,1; bir bar içinde kırılma %79,7 ile %54,0. **Ama örneklem küçük ve güven
aralıkları örtüşüyor, yani filtrenin faydası kanıtlı değil.** Bu yüzden özellik
iki parçaya ayrıldı ve kapı varsayılan olarak kapalı.

Takvimi kendiniz koyarsınız. Veri klasörünüzde (Ayarlar ekranının altında
yazılı) şu dosyayı oluşturun:

```
calendar/high_impact.csv
```

```
timeUtc,code,currency
2024-07-05T12:30:00Z,NFP,USD
2024-07-11T12:30:00Z,CPI,USD
2024-07-31T18:00:00Z,FOMC,USD
```

Saatler UTC olmalı, `#` ile başlayan satırlar yorumdur, baş satır isteğe
bağlıdır, bozuk satırlar atlanır ve kaç satırın atlandığı günlüğe yazılır.
**Dosya yoksa hiçbir şey değişmez:** özellik sessizce kapalı kalır.

Dosya varken:

- **Test sekmesi** "Yüksek etkili veri penceresi" tablosunu gösterir: `veri ±30
  dk`, `veri ±60 dk` ve `normal` alt kümeleri, tür bazında, her birinin kendi
  tabanıyla. Aralıklar örtüşüyorsa pencerenin sonucu değiştirdiği söylenemez.
- **Canlı mod** sinyal kartında ve bildirimde "Yüksek etkili veri: NFP 20 dk
  sonra" uyarısı gösterir. Bu uyarı kapıdan bağımsızdır.
- **Kapıyı açmak** isterseniz Ayarlar > Sinyal kararı > "Veri penceresi (dk)"
  alanına sıfırdan büyük bir değer yazın. Açmadan önce kendi takviminizle Test
  sekmesindeki alt küme tablosuna bakın: fark iki dönem yarısında da
  tekrarlanmıyorsa kapı yalnızca örnek sayınızı azaltır.

Özellik vektörüne yeni bir boyut **eklenmedi**. Tek ikili boyut kNN
mesafesinde kaybolur ve mevcut bütün hafızaları geçersiz kılardı.

### 6.7.2 Üst zaman dilimi bölgesi (ölçüm, sinyale katılmaz)

15m olayına 4h bölgesini eklemek (1m'ye 15m, 5m'ye 1h) cazip görünüyor ama
**zamanlaması kolayca sızdırıyor.** `zones.json` kaydındaki `createdTime` barın
**açılışıdır** ve `top` / `bottom` kutunun **nihai** sınırlarıdır; ikisini
kullanmak henüz onaylanmamış bir kutuyu ve henüz oluşmamış birleşme
sınırlarını görmek demektir.

Bu yüzden indikatör `recordTimeline` seçeneğiyle **kutu durumu aralıkları**
üretir: her aralık "bu kutu, bu sınırlarla, bu zaman aralığında biliniyordu"
demektir. Aralık doğum ya da birleşme barının **kapanışında** açılır, kırılma,
yaşlanma veya `maxZones` çıkarma barının kapanışında kapanır.

Ölçüldü (15m olayları, 4h bölgeleri, oluşum türü, `taban %42,8`):

| Zamanlama | Aynı yön yakın | Olay | Net / işlem |
| --- | --- | --- | --- |
| **naif** (bar açılışı + nihai sınırlar) | %45,6 [39,6, 51,6] | 598 | +0,083 |
| **doğru** (bar kapanışı + o anki sınırlar) | %30,3 [20,6, 42,2] | 147 | -0,557 |

Yani naif zamanlama **+3,2 puanlık olmayan bir katkı** gösteriyor; doğru
zamanlamayla aynı ölçüm **-12,5 puan**. Dönem ikiye bölündüğünde işaret
tekrarlıyor (ilk yarı %29,6, ikinci yarı %30,8) ama her yarının %95 aralığı
tabanı hâlâ içeriyor, yani ters yönlü bir kapı da kanıtlanmış değil.

Bu nedenle özellik **sinyale bağlanmadı**: Test sekmesinde alt küme tablosu
olarak, canlı sinyal kartında "4h bölgesi: aynı yön yakın - bilgi, sinyale
katılmaz" satırı olarak görünür. Özellik vektörüne de dokunulmadı.

### 6.8 Yürüyen ileri test

Hafızadaki her olay zaman sırasına konur ve her biri **yalnızca kendinden
önceki** olaylarla değerlendirilir.

**Ambargo olay zamanına değil, sonucun belli olduğu zamana bakar.** Bir olayın
etiketi ufuk dolana kadar bilinemez; dolayısıyla o olay daha erken bir sorguya
komşu olamaz. Aday havuzu bu yüzden her kaydın `resolvedTime` değerini
kullanır. Önceden ölçüt olayın başladığı zamandı, yani sonucu henüz belli
olmayan kayıtlar komşu olarak kullanılabiliyordu.

**Isınmanın iki ölçütü vardır.** `warmupEvents` (varsayılan 500) bir **alt
sınırdır**; asıl ölçüt `warmupPerBucket` (varsayılan 100), yani havuzda **aynı
tür ve aynı yönden** en az bu kadar aday görülmüş olmasıdır. Sabit olay sayısı
tek başına yüksek zaman dilimlerinde testi anlamsız kılıyordu: 4 saatlikte 518
olayın 500'ü ısınmaya gidiyor, geriye 18 olay kalıyordu.

**Taban aynı türün tabanıdır.** `baselineWinRate`, "hiçbir seçim yapmadan al"
senaryosunun oranıdır ve ısınma sonrası dönemden, olayın **kendi** etiket
seviyeleriyle (aynı plan, aynı maliyet) ve tetiklenen işlemlerin **tür
karışımıyla** ağırlıklandırılarak hesaplanır. Hiç işlem yoksa `null` döner. İki
türün taban oranı birbirinden çok farklıdır (ölçüldü: oluşum %39-50, dokunuş
%23-28) ve tetiklenen işlemlerin neredeyse tamamı oluşumdur; karışık taban
kullanıldığında ekranda +9 ile +13 puanlık katkı görünüyordu, gerçek fark -1,5
ile +3,6 puandı. Etiketlenmiş tüm olayların ham oranı artık ayrı bir alandadır:
`rawWinRate`, yalnızca bilgi amaçlı.

**`nofill` olaylar değerlendirilmez.** Ne değerlendirilen olay sayısına ne taban
sayacına girerler; yalnızca dolum oranı (`fillRate`) için sayılırlar.

Özet çıktısı: toplam olay, tetiklenen sinyal, kazanan, kaybeden, kazanma oranı,
ATR ve R cinsinden beklenti, kâr faktörü, azami geri çekilme, ortalama R/R,
`baselineWinRate` ve türlere göre katkı, güven aralıkları (Wilson ve bootstrap),
tabandan farkın p değeri, permütasyon olasılığı, kalibrasyon tablosu, Brier
skoru, maliyet kırılımı, dolum oranı, değerlendirilen dönem ve örneklem
yetersizse bir uyarı. Ayrıca **iki sinyal türünün ayrı kırılımı** (`byKind`)
ve yıllara göre kırılım (`byYear`) vardır; ikisinde de taban aynı kuralla
hesaplanır.

**Aynı testin iki koşu yolu vardır.** Biri her olayda komşuları baştan hesaplar
(referans yol), diğeri komşuları önbellekten okur ve eşik taraması içindir.
İkisi de aynı iç çekirdeği kullanır, yani muhasebe, taban oranı ve özet üretimi
tek yerde yazılıdır; çıktıları birebir aynıdır ve bu bir testle kilitlenmiştir.

**İşlem maliyeti teste dahildir.** Bu, küçük zaman dilimlerinde sonucu tamamen
değiştirir. Ölçülen medyan ATR: 1 dakikalıkta tüm geçmişte yalnızca 0,35 dolar,
5 dakikalıkta 0,94, 15 dakikalıkta 1,87 dolar (2026'da sırasıyla 2,18, 5,97 ve
9,49 dolar). Yani 1 dakikalıkta ATR biriminde görünen ince bir brüt beklenti,
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
2. **Sistem şu an kanıtlanmış bir katma değer üretmiyor.** Yeni indikatör
   17 Eylül 2026'da tüm geçmişte ölçüldü (bkz. 1. bölümdeki tablo): hiçbir
   zaman diliminde net beklentinin %95 aralığı sıfırın üstünde kalmıyor.
   1 dakikalıkta işlem maliyeti brüt edimi yiyor, 1 saatlikte pozitif bir iz
   var ama 122 işlemle şansla açıklanabilir. `presets.js` içindeki hazır
   ayarlar hâlâ eski indikatörden gelir ve yeniden aranmalıdır. Özellikle kutu
   oluşumu sinyalinin ölçülebilir bir üstünlüğü yoktur.
3. **Kutu oluşumu sinyalinin riski sabit değildir.** Dokunuş olayında giriş
   çoğunlukla bölge kenarına konan limit emirdir, yani risk bölge
   geometrisinden gelir; karar barının kapanışı bölgenin içinde kaldığında
   giriş o kapanıştan olur ve risk biraz değişir. Oluşum olayında giriş her
   zaman onay barının kapanışıdır; fiyat pivottan ne kadar kaçtıysa risk o
   kadar büyür. `formTargetRr` hedefi riske orantılayarak risk/ödülü sabitler
   ve `maxFormRiskAtr` aşırı olanları eler, ama bu türün doğası gereği daha
   gürültülü olduğunu unutmayın.
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
   belirgin biçimde yüksekse pay hızla erir. Ayarlar ekranındaki
   **İşlem maliyeti ve ölçüm** bölümünden kendi maliyetinizi girip Test
   sekmesinden sonucu yeniden ölçün. Özette "maliyet iki kat olsaydı net" ve
   "maliyet dahil başa baş isabet" satırları bu duyarlılığı gösterir.
7. **Limit emir modeli gerçekçi ama kısmi dolumu kapsamaz.** Dokunuş olayında
   karar bar kapanışında verilir, emir bir sonraki bardan itibaren kenara
   konur ve dolum için fiyatın kenarı 0,05 ATR geçmesi aranır; dolmayan emir
   `nofill` olur ve işlem sayılmaz (dolum oranı Test sekmesinde raporlanır).
   Modellenmeyen şeyler: kısmi dolum, sıçramalı (gap) açılışta emrin daha kötü
   fiyattan dolması ve kayma. Ayarlarda bir `Kayma (ATR)` alanı vardır ama
   **şu an ölçüme girmiyor**; maliyet yalnızca `costPct` / `costUsd`
   üzerinden modellenir.
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
11. **Veri kalitesi ölçümün tavanıdır.** Depoda kalıcı boşluklar olabilir;
   ölçüldü, 2023-02-20 ile 2023-07-28 arasında yaklaşık 479 tam saat eksik ve
   bu saatler HistData kaynağında da yok. Böyle bir pencerede kalan olaylar
   hafızaya alınmaz, yani o dönem fiilen ölçüm dışıdır. Deponuzun durumunu
   `node scripts/data-doctor.mjs` ile görün.
12. **Bu bir karar destek aracıdır, yatırım tavsiyesi değildir.** Emir
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
  settings.json                     Yalnızca sizin değiştirdiğiniz alanlar + settingsVersion
  data/
    XAUUSD_1m.bin                   Mum deposu (ikili, ZMEM0001 biçimi)
    XAUUSD_5m.bin
    XAUUSD_15m.bin
    XAUUSD_1h.bin
    XAUUSD_4h.bin
    XAUUSD_1m.proxy.json            Vekil kaynakla doldurulan aralıkların kaydı
    XAUUSD_1m.dst.json              Yaz saati göçünün yapıldığını gösteren işaret
    XAUUSD_15m_memory.json          Hafıza üst verisi (olaylar, sonuçlar, ayar izi)
    XAUUSD_15m_memory.vec           Özellik vektörleri (float32)
    XAUUSD_15m_memory.protos.json   Şekil kümeleri (bilgi amaçlı)
    XAUUSD_15m_memory.zones.json    Kayıtlı bölgeler
    XAUUSD_15m_memory.signals.json  Son testte üretilen sinyaller
    XAUUSD_15m_memory.backtest.json Son yürüyen ileri test özeti
    XAUUSD_15m_memory.live.jsonl    Canlı sinyal günlüğü (JSON Lines)
    _eski_hafiza_yedek/             Aktarım sonrası taşınan eski hafıza dosyaları
```

Birkaç not:

- **`settings.json` yalnızca farkları tutar.** Dokunmadığınız bir alan dosyaya
  yazılmaz; böylece o alanda hazır ayar ve çekirdek varsayılanı gerçekten
  devreye girer ve varsayılan değişiklikleri size ulaşır. Dosyada bir de
  `settingsVersion` alanı bulunur.
- **`.bin` dışındaki her şey yeniden üretilebilir.** Hafıza, şekil kümeleri,
  sinyaller ve test özeti "Geçmişi Tara" ve Test ile yeniden kurulur.
- **`.live.jsonl` yeniden üretilemez.** Canlıda gerçekten ne olduğunun kaydıdır
  ve tarama ile hafıza silme işlemlerinden etkilenmez; yalnızca yeni satır
  eklenir, dosya hiç yeniden yazılmaz.
- **`.proxy.json` ve `.dst.json`** bakım betiklerinin işaretleridir (bkz. 3.4).
  `.dst.json` varken `fix-dst.mjs` yeniden çalışmayı reddeder, çünkü ikinci bir
  kaydırma seriyi bozar.
- Dosya adlarındaki `15m` örnektir; her zaman dilimi için ayrı bir takım
  oluşur.

Klasörü başka bir yere almak isterseniz ortam değişkenlerini kullanın:

```bash
export ZONE_MEMORY_USER_DIR=/istediginiz/yol
export ZONE_MEMORY_DATA_DIR=/istediginiz/yol/data
```

Bu değişkenler hem uygulamada hem de `scripts/` altındaki betiklerde geçerlidir.

**Sıfırdan başlamak** için: uygulamayı kapatın, `data/` klasörünü silin ve
3. bölümdeki veri kurulumunu tekrarlayın. Ayarları da sıfırlamak isterseniz
`settings.json` dosyasını silin.

**Yedekleme:** `data/` klasörü büyüktür (1m serisi yaklaşık 290 MB) ama büyük
kısmı yeniden üretilebilir. Yedeklenmeye değen iki şey vardır: `settings.json`
ve canlı sinyal günlükleri (`*_memory.live.jsonl`). İkincisi canlıda gerçekten
ne olduğunun tek kaydıdır ve yeniden üretilemez.
