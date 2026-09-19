# test/fixtures

Testlerin kullandigi kucuk ornek dosyalar. `.gitignore` bu klasoru ozellikle
izler (`!test/fixtures/**`), cunku depo kokundeki `*.bin` ve `*.vec` kurallari
aksi halde buradakileri de yok sayardi.

## TradingView sadakat verisi (A4)

`test/tv-parity.test.js` su dosyalari arar, yoksa kendini atlar:

| Dosya | Zaman dilimi |
| --- | --- |
| `tv_xauusd_15m.csv.gz` | 15m |
| `tv_xauusd_1h.csv.gz` | 1h |
| `tv_xauusd_5m.csv.gz` | 5m (istege bagli) |

Uretme adimlari `docs/pine/son_pro_export.pine` dosyasinin basinda yazili.
Ozetle: o betigi TradingView'de KENDI kullandiginiz XAUUSD sembolune ekleyin,
"Export chart data" ile CSV alin, `gzip` ile sikistirip buraya koyun.

Veri neden baska bir yerden alinamaz: kutu kapisi HACME baglidir ve hacim
brokere gore degisir. Baska bir kaynaktan alinan "referans", portu dogrulamak
yerine yanlis bir guven verirdi.

Beklenen sutunlar: `time, open, high, low, close, volume` ve disa aktarim
betiginin urettigi `zAktif` (ayrica varsa `zTopTop`, `zBotTop`, `zScoreTop`).
Zaman sutunu UNIX saniye ya da ISO metin olabilir, ikisi de okunur.
