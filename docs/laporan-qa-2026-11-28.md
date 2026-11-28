# Laporan QA CRM RajaEmas.id

**Tanggal:** 28 November 2026
**Revisi:** `4fee87b` (`master`)
**Status:** Layak untuk UAT/staging terkontrol; belum menjadi persetujuan rilis produksi.

## Ringkasan eksekutif

CRM berjalan dan siap pada lingkungan lokal: endpoint readiness melaporkan database dan cache
berstatus `ok`, seluruh 172 tes otomatis lulus, dan pemeriksaan gabungan `npm run check` lulus.
Coverage, uji beban readiness, viewport kecil, dan aksesibilitas dasar API Gateway diperiksa. Migrasi
`012_api_gateway_targets.sql` tercatat sudah diterapkan ke database lokal.

Integrasi langsung Google Places dan Meta WhatsApp belum diuji dengan provider nyata karena
membutuhkan kredensial. Karena itu hasil ini bukan sertifikasi produksi atau audit keamanan formal.

## Skor keseluruhan: 90/100

| Area penilaian | Bobot | Skor | Dasar penilaian |
| --- | ---: | ---: | --- |
| Fungsionalitas dan cakupan domain | 30 | 27 | Modul inti dan fase tambahan tersedia; belum semua alur provider eksternal diverifikasi langsung. |
| Tes dan kualitas kode | 25 | 24 | 172/172 tes lulus; coverage line 76.24%, branch 83.96%, function 75.06%; lint dan format lulus. |
| Keamanan dan privasi | 20 | 18 | Ada RBAC, pembatasan scope, enkripsi PII, audit, validasi webhook, dan perlindungan request partner; bukan hasil pentest. |
| UX, aksesibilitas, dan lokalisasi | 15 | 13 | Form API Gateway berbahasa Indonesia; label form, nama dialog, navigasi fokus keyboard, dan viewport 390 px diperiksa. |
| Operasional dan dokumentasi | 10 | 8 | README, migrasi, readiness, coverage, dan load smoke test tersedia; belum ada bukti CI/deployment produksi atau validasi provider. |
| **Total** | **100** | **90** | **Baik untuk UAT terkontrol; tindak lanjut perlu sebelum rilis produksi.** |

Skor adalah penilaian QA berbasis bukti yang tercantum di laporan, bukan ukuran cakupan tes atau
jaminan bebas cacat.

## Cakupan pemeriksaan

- **Otomatis:** ESLint, Prettier check, seluruh suite `node:test`, dan coverage.
- **Runtime:** `GET /readyz` pada `http://127.0.0.1:3000`; database dan cache merespons `ok`.
- **Database:** status migrasi `012_api_gateway_targets.sql` diverifikasi pada database lokal.
- **Browser:** halaman Klaster Nasabah dan API Gateway, termasuk tab, pemilih target, dan form
  tambah sumber diperiksa pada viewport 390 × 844 px. Label kontrol, nama dialog, dan navigasi
  fokus Tab diperiksa. Tidak ada sinkronisasi eksternal yang dijalankan.
- **Kode/dokumentasi:** modul pelanggan, lead, master data, transaksi/QMS, laporan, Live Omset,
  Reviews/Blast, integrasi, kontrol akses, query SQL dinamis, dan panduan proyek ditinjau.

## Hasil terperinci

### Otomatis

| Pemeriksaan | Hasil |
| --- | --- |
| `npm run lint` | Lulus |
| `npm test` | **172 lulus, 0 gagal** |
| `npm run test:coverage` | **172 lulus, 0 gagal**; line 76.24%, branch 83.96%, function 75.06% |
| `npm run qa:load` | **100/100 berhasil** ke `/readyz`; concurrency 10, 182.96 req/s, p95 134.71 ms |
| `npm run format:check` | Lulus |
| `npm run check` | **Lulus** (lint, format, dan tes) |

### Browser dan runtime

- Halaman nasabah menampilkan ringkasan klaster, grafik batang, filter, dan tabel nasabah.
- API Gateway menampilkan target impor nasabah, produk, prospek, janji temu, transaksi, serta
  dataset JSON khusus. Label yang sebelumnya tertinggal dalam bahasa Inggris kini tampil dalam
  bahasa Indonesia, termasuk label ID akun dan bagian field identitas KTP.
- Pada viewport 390 × 844 px, halaman dan dialog API Gateway tidak memiliki overflow horizontal;
  dialog form berukuran 348 px dan muat di viewport. Pengujian halaman nasabah 390 px sebelumnya
  juga tidak menemukan overflow horizontal.
- Form memiliki label yang dapat diakses untuk kontrolnya dan dialog kini memiliki nama aksesibel
  dari judulnya. Navigasi Tab tetap berada di dialog sepanjang 30 perpindahan fokus, dan tombol
  Batal mengembalikan fokus ke pemicu dialog. Pengujian ini bukan audit WCAG atau pembaca layar.
- Penutupan dialog dengan tombol Escape tidak dapat dipastikan oleh harness browser; dialog native
  terisolasi juga tidak tertutup saat tombol tersebut disimulasikan.
- Server merespons readiness dengan database dan cache `ok`.
- Halaman API Gateway belum memiliki sumber sinkronisasi pada lingkungan yang diperiksa, sehingga
  alur sinkronisasi nyata tidak dijalankan.

Uji beban hanya mengukur endpoint readiness lokal, bukan endpoint bisnis atau provider eksternal.
Tidak ada SLO performa yang didefinisikan; hasil throughput dan latency bukan jaminan kapasitas
produksi.

### Cakupan keamanan yang terlihat dalam implementasi

- Enkripsi AES-256-GCM dan blind index HMAC dipakai untuk data identitas tertentu.
- Endpoint integrasi dibatasi izin; pembacaan dataset khusus diaudit.
- Koneksi sumber eksternal memiliki validasi URL, pembatasan respons, timeout, dan penolakan
  redirect.
- Webhook menggunakan verifikasi signature; kampanye WhatsApp memeriksa consent.
- API menggunakan RBAC dan pembatasan scope data.

Pemeriksaan di atas adalah peninjauan implementasi, bukan penetration test, threat-model review
formal, atau verifikasi konfigurasi produksi.

## Temuan dan tindak lanjut

| ID | Prioritas | Status | Temuan | Tindakan yang disarankan |
| --- | --- | --- | --- | --- |
| QA-01 | Sedang | Selesai | Tiga file gagal format Prettier. Ketiganya sudah diformat dan `npm run check` lulus. | Tidak ada tindakan tersisa dalam lingkup temuan ini. |
| QA-02 | Sedang | Terbuka | Integrasi langsung Google Places dan Meta WhatsApp belum diverifikasi tanpa kredensial provider. | Uji di staging dengan kredensial yang disimpan secara aman; hindari blast nyata tanpa persetujuan eksplisit. |
| QA-03 | Rendah | Selesai | Label form API Gateway yang tertinggal dalam bahasa Inggris sudah diterjemahkan dan dilindungi tes regresi. | Tidak ada tindakan tersisa dalam lingkup temuan ini. |
| QA-04 | Rendah | Selesai, terbatas | Coverage, load smoke test, viewport 390 px, label form, nama dialog, dan navigasi fokus dasar sudah diperiksa. | Sebelum produksi, lakukan audit WCAG/pembaca layar dan uji performa dengan SLO serta endpoint bisnis yang disepakati. |

## Batasan dan keputusan produk

- Bonus dan loyalitas masih ditandai provisional dalam dokumentasi; jangan gunakan sebagai dasar
  payroll sebelum aturan bisnis disahkan.
- Impor produk mencakup katalog, bukan jumlah stok. Dataset stok/QMS disimpan sebagai JSON dan
  tidak mengubah inventori atau tiket QMS operasional.
- Uji provider nyata membutuhkan konfigurasi out-of-band. Tidak ada data yang dikirim ke provider
  selama QA ini.
- Uji beban hanya mencakup endpoint readiness lokal; tidak dilakukan uji kapasitas endpoint bisnis,
  pemulihan backup, rotasi kunci, atau pentest.
- Aksesibilitas diperiksa secara dasar di browser; tidak dilakukan audit WCAG formal atau pengujian
  dengan pembaca layar. Simulasi Escape pada harness tidak berhasil menutup dialog native sehingga
  perilaku ini masih perlu dikonfirmasi secara manual di browser.

## Rekomendasi rilis

1. Jalankan uji integrasi provider di staging tanpa melakukan pengiriman pesan nyata yang tidak
   disetujui.
2. Lengkapi audit akses role/scope, aksesibilitas formal, dan uji beban endpoint bisnis berdasarkan
   target operasional yang disepakati.
3. Terapkan migrasi pada lingkungan rilis melalui prosedur deployment dan backup yang berlaku.
