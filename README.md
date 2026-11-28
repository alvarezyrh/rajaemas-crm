<p align="center"><img src="public/assets/logo.png" alt="RajaEmas.id" height="120" /></p>

# CRM RajaEmas.id

Platform Customer Relationship Management RajaEmas.id, dibangun dengan **Node.js native**
(`node:http`, `node:crypto`, `node:stream`, `node:events`, `node:cluster`). Dependensi runtime
hanya `pg` (driver PostgreSQL) dan `redis` (opsional).

## Mulai cepat

```bash
npm install
docker compose up -d                 # PostgreSQL 17 + Redis 7
cp .env.example .env
npm run keys                         # salin keluarannya ke .env
#  → isi juga SEED_PASSWORD (min. 12 karakter) di .env
npm run migrate
npm run seed                         # cabang, akun staf per peran, nasabah contoh
npm run dev                          # http://localhost:3000
npm test
npm run check                    # lint (ESLint) + format (Prettier) + tes
```

Akun hasil seed (kata sandi = `SEED_PASSWORD`):

| Peran | Email | Lingkup |
|---|---|---|
| Super Admin | `superadmin@rajaemas.id` | Semua outlet + pengaturan global |
| Staf pusat (manajemen/eksekutif) | `pusat@rajaemas.id` | Semua outlet |
| Manajer area | `area.jkt@rajaemas.id` | Semua outlet di area `JKT` |
| Kepala cabang | `kacab.jkt@rajaemas.id` | JKT01 |
| Layanan pelanggan | `cs@rajaemas.id` | Semua cabang |
| Pemasaran digital | `marketing@rajaemas.id` | Semua outlet, tanpa data identitas |
| Penaksir | `penaksir.jkt@rajaemas.id` | JKT01 |

## Arsitektur

Empat lapisan dengan dependensi satu arah (luar → dalam):

```
Transport (core/http)   server native, router radix, body limit, envelope, static
     ↓
Middleware              request-id, access log, error boundary, security headers,
                        rate limit, autentikasi, RBAC, idempotensi
     ↓
Domain service          customers, appointments, appraisals, interactions, auth
     ↓
Repository              SQL berparameter, Unit of Work (transaksi atomik)
```

```
src/
├── server.js            entry: node:cluster + graceful shutdown (SIGTERM)
├── app.js               rakit pipeline HTTP & registrasi rute
├── container.js         composition root (satu-satunya tempat wiring dependensi)
├── config/              konfigurasi tervalidasi (fail-fast)
├── core/                errors, logger JSON, validasi skema, http/{router,pipeline,...}
├── security/            AES-256-GCM, HMAC, scrypt, token, RBAC
├── middleware/
├── infra/               database (pool + transaksi), cache (Redis/memori), event bus
├── shared/              aturan domain murni: loyalitas, telepon, lingkup cabang
└── modules/<domain>/    *.routes.js → *.service.js → *.repository.js
public/                  dashboard (vanilla JS ES modules, tanpa build step)
db/migrations/           SQL berurutan, dicatat di schema_migrations
test/                    node:test: unit + integrasi HTTP (tanpa DB)
```

**Aturan kode:**
- Handler rute hanya: validasi input → panggil service → kirim envelope. Tidak ada SQL di rute.
- Service tidak mengenal HTTP. Ia menerima `actor` (id, role, branchId, requestId, ip).
- Setiap perubahan data sensitif ditulis ke `audit_logs` **di dalam transaksi yang sama**.
- Seluruh SQL memakai parameter terikat (`$1…`). Klausa dinamis hanya disusun dari fragmen konstan.
- Error yang diketahui dilempar sebagai `AppError`. Error lain menjadi 500 tanpa membocorkan detail.

## Keamanan (Bab 5–6 spesifikasi)

| Kontrol | Implementasi |
|---|---|
| PII | NIK & telepon dienkripsi AES-256-GCM (AAD per kolom). Pencarian memakai blind index HMAC. Kunci disimpan di env/secret manager, terpisah dari DB |
| Masking | Daftar hanya menampilkan `+62 ••• •••• 1234`. Pembukaan penuh (`POST /customers/:id/pii/reveal`) dicatat `CUSTOMER_PII_REVEALED` |
| RBAC | Matriks peran ke izin (`security/rbac.js`) dan lingkup data berbasis outlet **atau area** (`shared/scope.js`) |
| Sesi | Token HS256 (header dikunci) + sesi di Redis, sehingga logout berlaku lintas instance |
| Idempotensi | `Idempotency-Key` wajib pada POST/PATCH appointments & appraisals: replay, deteksi payload berbeda, dan kunci paralel |
| Webhook | `X-Signature: sha256=HMAC(ts.rawBody)` + `X-Timestamp` (anti-replay 5 menit) + `timingSafeEqual` + dedupe `eventId` |
| Audit | `audit_logs` append-only, dijaga trigger DB (UPDATE/DELETE/TRUNCATE ditolak) |
| HTTP | Batas body, timeout soket, CSP ketat, nosniff, frame-deny, HSTS (produksi), rate limit global & login |

## Leads & anggaran akuisisi

Prospek (`leads`) adalah funnel di depan Customer 360: dari kanal akuisisi sampai menjadi nasabah.

**Mesin status** — `NEW → CONTACTED → QUALIFIED`, lalu `CONVERTED` (hanya lewat aksi konversi) atau
`LOST` (wajib disertai alasan). `EXPIRED` dicadangkan untuk job latar belakang, bukan diubah manual.
Lead yang sudah mencapai status akhir dibekukan: tidak bisa diedit lagi.

**PII** — nomor telepon prospek diperlakukan seperti nomor nasabah: dienkripsi AES-256-GCM dengan
AAD `leads.phone`, dan di-blind-index dengan domain `phone` yang **sama** seperti `customers`.
Karena domainnya sama, "nomor ini sudah jadi nasabah?" bisa dijawab tanpa mendekripsi apa pun.
Nomor utuh hanya dikirim ke peran yang memegang `customer:pii:reveal`; peran lain menerima bentuk
tersamar (aturan yang sama dengan export CSV).

**Pencegahan duplikat** — satu prospek aktif per nomor (indeks unik parsial: lead yang sudah
`CONVERTED`/`LOST`/`EXPIRED` tidak menghalangi pendekatan ulang). Nomor yang sudah terdaftar sebagai
nasabah ditolak dengan `409`, bukan dibuatkan lead.

**Konversi** memakai jalur `customer.intake` yang sama dengan webhook dan API partner, jadi lead yang
nomornya sudah menjadi nasabah **ditautkan** ke profil itu, bukan diduplikasi. Atribusi ditulis dua
arah: `leads.converted_customer_id` dan `customers.lead_id` + `customers.acquisition_reference_id`
(atribusi pertama menang, tidak pernah ditimpa). Konversi idempoten — memanggil dua kali mengembalikan
nasabah yang sama tanpa membuat apa pun.

**Lingkup** — lead membawa `branch_id` dan `area_id` (area diturunkan dari outlet, tidak dipercaya
dari permintaan). Staf outlet melihat lead outletnya, manajer area melihat seluruh areanya, kantor
pusat melihat semua.

**Advertising Summary** menyandingkan belanja iklan dengan prospek pada periode yang sama per
area × kanal. Atribusinya sengaja sederhana (periode sama, tanpa modelling jeda iklan→lead).
Karena anggaran dicatat per **area** sedangkan lead dihitung sesuai **lingkup pemanggil**, rasio
biaya-per-lead hanya ditampilkan bila keduanya populasi yang sama (`comparable: true`); untuk staf
outlet angka mentahnya tetap ditampilkan tetapi rasionya `null` agar tidak menyesatkan.

## Peran & lingkup data

Tujuh peran: enam dari arsitektur sistem, ditambah **Penaksir** yang dipertahankan karena seluruh
alur taksiran & buyback bergantung padanya.

| Kode | Label | Lingkup data |
|---|---|---|
| `SUPER_ADMIN` | Super Admin | semua outlet + pengaturan global |
| `HQ_STAFF` | Manajemen / Eksekutif (kantor pusat) | semua outlet |
| `AREA_MANAGER` | Manajer Area | semua outlet dalam satu `area` |
| `BRANCH_HEAD` | Kepala Cabang (Outlet Head) | satu outlet |
| `CUSTOMER_SERVICE` | Layanan Nasabah | satu outlet (opsional) |
| `DIGITAL_MARKETING` | Pemasaran Digital | semua outlet, **tanpa** data identitas (PII) |
| `APPRAISER` | Penaksir | satu outlet |

Dua hal yang bekerja bersamaan, dan sengaja dipisah:

- **Izin** (`security/rbac.js`) menentukan *menu/endpoint mana yang boleh dibuka*.
- **Lingkup** (`shared/scope.js`) menentukan *baris mana yang terlihat*: staf outlet dibatasi pada
  outletnya, manajer area pada seluruh outlet di areanya (`branch_id IN (SELECT … WHERE area_id = …)`),
  kantor pusat tidak dibatasi. Keduanya di-AND, jadi menyempitkan filter tidak pernah melebarkan akses.

Master data (area, outlet, katalog produk, kategori, jenis transaksi, kanal akuisisi, penugasan CS)
dinonaktifkan lewat `is_active = false`, bukan dihapus, agar transaksi lama tetap punya referensi.
Menu **Roles** menampilkan matriks apa adanya dari kode, sehingga tidak mungkin berbeda dari yang
benar-benar ditegakkan server.

## API `/api/v1`

| Metode | Endpoint | Keterangan |
|---|---|---|
| POST | `/auth/login` · `/auth/logout` · GET `/auth/me` | Sesi staf |
| GET | `/dashboard/summary` | KPI, sebaran tier, janji mendatang |
| GET/POST | `/customers` | Cari (`?phone=` eksak lintas cabang, `?q=` nama dalam lingkup, `?segment=` klaster) / daftar |
| GET | `/segments/summary?activeDays=30` | Agregat per klaster + irisan kanal (lihat *Klaster nasabah*) |
| GET | `/customers/:id/channels` | Keanggotaan klaster nasabah beserta nilai transaksinya |
| POST | `/customers/:id/transactions` | Catat jual/beli emas di toko (wajib `Idempotency-Key`) |
| GET | `/customers/export?segment=&q=` | Unduh CSV nasabah sesuai filter (teraudit) |
| POST | `/customers/import` | Import baris CSV (`{ rows, dryRun }`, maks. 500 baris per permintaan) |
| GET/POST · PUT/DELETE | `/integrations` · `/integrations/:id` | Kelola sumber API partner (khusus staf pusat) |
| POST | `/integrations/:id/test` · `/integrations/:id/sync` | Uji koneksi + pratinjau pemetaan · mulai sinkronisasi (202) |
| GET | `/integrations/runs/:runId` | Status & hasil satu sinkronisasi |
| PATCH | `/customers/:id` | Edit profil & data KTP oleh staf (teraudit tanpa nilai) |
| GET/POST | `/api-clients` · POST `/api-clients/:id/revoke` | Kelola API key untuk APPS/STORE (khusus staf pusat) |
| GET | `/api/partner/v1/customers` · `/customers/:id` · `/customers/lookup` | **API partner** untuk APPS/STORE (pakai API key, lihat di bawah) |
| GET · PATCH | `/account` | Profil sendiri (nama dapat diubah) |
| POST | `/account/password` · `/account/sessions/revoke-others` | Ganti password · keluar dari perangkat lain (keduanya mengembalikan token baru) |
| GET/POST · PATCH | `/users` · `/users/:id` | Kelola akun staf (khusus staf pusat) |
| POST | `/users/:id/reset-password` | Buat password sementara baru |
| GET/POST | `/leads` | Prospek: cari (`?q=`, `?phone=`, `?status=`, `?referenceId=`) / buat |
| GET · PATCH | `/leads/:id` | Detail prospek · ubah status/catatan/kanal/outlet |
| POST | `/leads/:id/convert` | Konversi prospek → nasabah (idempoten) |
| GET | `/leads/summary` | Lead Summary: total, per status, per kanal, per area, rasio konversi |
| GET/POST · PATCH | `/advertising-budgets` · `/advertising-budgets/:id` | Anggaran akuisisi per area × kanal × bulan |
| GET | `/advertising/summary?groupBy=area\|reference` | Advertising Summary: belanja vs prospek vs konversi + biaya per lead |
| GET | `/roles` | Matriks peran × izin, dibaca dari `security/rbac.js` (khusus pusat) |
| GET/POST · PATCH | `/areas` · `/references` · `/product-categories` · `/products` · `/transaction-types` | Master data: wilayah, kanal akuisisi, katalog produk, jenis transaksi. Menulis khusus pusat |
| GET · PATCH | `/branches` · `/branches/:id` | Direktori outlet sesuai lingkup pemanggil; ubah area, alamat, zona waktu, Google Place ID |
| GET/POST · DELETE | `/cs-assignments` · `/cs-assignments/:id` | Penugasan Customer Service per outlet. `GET /cs-assignments/staff` = daftar staf yang boleh ditugaskan |
| POST | `/webhooks/commerce` | Akun & pesanan dari aplikasi mobile dan website e-commerce |
| GET | `/customers/:id` · `/customers/:id/timeline` | Profil & kronologi terpadu |
| POST | `/customers/:id/pii/reveal` | Buka PII (teraudit) |
| POST | `/customers/:id/interactions` | Catat interaksi manual |
| GET/POST | `/appointments` · PATCH `/appointments/:id` | Slot berkapasitas, mesin status, jadwal ulang |
| GET/POST | `/appraisals` · PATCH `/appraisals/:id/status` | Taksiran → buyback. SETTLED butuh izin approve dan memberi poin loyalitas |
| POST | `/webhooks/omnichannel` | Pesan masuk / status kirim dari penyedia |
| GET | `/healthz` · `/readyz` | Liveness / readiness (DB + cache) |

Bentuk respons:

```json
{ "success": true, "code": "OK", "requestId": "…", "data": { }, "meta": { "page": 1, "pageSize": 20, "total": 3, "totalPages": 1 } }
```

## Klaster nasabah

Nasabah dikelompokkan berdasarkan **perilaku di tiap kanal**, bukan label manual. Satu nasabah
dapat masuk ke beberapa klaster sekaligus.

| Klaster | Kode | Masuk klaster bila… | Sumber data |
|---|---|---|---|
| Toko | `STORE` | pernah jual/beli emas di gerai | Transaksi toko yang dicatat staf, dan buyback yang `SETTLED` (otomatis) |
| Aplikasi mobile | `MOBILE_APP` | memiliki akun aplikasi yang tertaut | Webhook `account.registered` / `order.completed` |
| E-commerce | `ECOMMERCE` | membeli emas di website | Webhook `order.completed` (hanya `BUY`) |

Filter `?segment=` juga menerima `MULTI` (lebih dari satu kanal) dan `NONE` (belum terklaster).
Untuk staf cabang, populasi klaster mengikuti lingkup cabangnya.

**Webhook `/webhooks/commerce`** memakai tanda tangan yang sama dengan omnichannel
(`X-Timestamp` + `X-Signature: sha256=HMAC(WEBHOOK_SECRET, ts.rawBody)`) dan di-dedupe per `eventId`:

```json
{ "eventId": "evt-9f2", "type": "order.completed", "source": "ECOMMERCE",
  "accountId": "web-5001", "phone": "081234567890", "fullName": "Dewi Lestari",
  "orderId": "INV-2026-0042", "side": "BUY", "weightGram": 5, "amount": 9750000,
  "occurredAt": "2026-11-25T10:00:00+07:00" }
```

- `type: account.registered` mewajibkan `phone`. `order.completed` mewajibkan `orderId`, `side`, `weightGram`, dan `amount`.
- Pencocokan nasabah dilakukan berurutan: `accountId` kanal, lalu nomor telepon (blind index). Bila
  keduanya tidak cocok dan `fullName` ada, profil baru dibuat dan dicatat ke audit.
- Pesanan idempoten per `source:orderId`. Pengiriman ulang tidak menggandakan transaksi.

## Menu API: tarik data nasabah dari aplikasi lain

Menu **API** ada di bagian bawah sidebar dan hanya terlihat oleh staf pusat. Setiap *sumber* adalah endpoint
`GET` milik aplikasi lain yang mengembalikan daftar nasabah dalam format JSON.

- **Pemetaan:** `listPath` menunjukkan letak daftar di dalam respons (mis. `data.members`). Setiap field
  dipetakan dengan *dot path* (nama, telepon, email opsional, id akun opsional).
- **Paginasi:** `page` menambahkan `?page=N&pageSize=M` sampai halaman yang diterima kurang dari `pageSize`
  (maks. 200 halaman).
- **Pencocokan:** urutannya id akun di kanal itu, lalu nomor telepon, lalu profil baru dibuat. Data nasabah
  yang sudah ada **tidak pernah ditimpa**. Bila sumber diberi klaster, nasabah ikut masuk klaster tersebut.
- **Keamanan:**
  - Token disimpan terenkripsi (AES-256-GCM) dan tidak pernah dikirim balik ke browser.
  - Di produksi hanya `https` ke alamat publik yang diizinkan. Alamat privat, loopback, dan link-local
    ditolak, redirect tidak diikuti, ada batas waktu 15 detik, dan respons maksimal 10 MB.
    `INTEGRATION_ALLOW_PRIVATE_HOSTS=true` membuka aturan ini (bawaan di luar produksi).
- **Riwayat:** sinkronisasi berjalan di latar belakang, satu per sumber. Hasil dan alasan baris yang dilewati
  tercatat di riwayat dan di audit log.

Coba secara lokal dengan API tiruan: `node scripts/mock-partner-api.js`. Pengaturan yang cocok tertulis di
kepala berkas tersebut.

## Data KTP nasabah & pertukaran data dengan APPS / STORE

**Field identitas (KTP):** NIK, tempat lahir, tanggal lahir, jenis kelamin, alamat, kota/kabupaten,
provinsi, kode pos, dan pekerjaan.
- **Disimpan terenkripsi:** NIK (dengan blind index untuk pencarian) dan alamat jalan (termasuk RT/RW,
  kelurahan, dan kecamatan) memakai AES-256-GCM. Keduanya hanya terlihat lewat tombol *Show full details*
  yang tercatat di audit.
- **Disimpan apa adanya:** kota dan provinsi, untuk kebutuhan laporan wilayah.
- **Sengaja tidak disimpan:** agama dan status perkawinan (prinsip minimisasi data, UU PDP).
- **Normalisasi masukan:** NIK dengan spasi atau tanda hubung, jenis kelamin `L/P` atau
  `Laki-laki/Perempuan`, tanggal `DD-MM-YYYY`, dan seterusnya diseragamkan di satu tempat
  (`src/shared/kyc.js`), baik untuk form, CSV, maupun API.

**APPS / STORE ke CRM (menu API, tab "Pull from APPS / STORE"):**
- **Pemetaan:** setiap sumber dapat memetakan field KTP dari respons API-nya.
- **Pencocokan:** urutannya id akun, lalu nomor telepon, lalu NIK.
- **Nasabah baru** dibuat lengkap dengan data KTP.
- **Nasabah yang sudah ada** hanya **diisi pada field yang masih kosong**. Data yang diisi staf atau sumber
  lain tidak pernah ditimpa.
- **Nilai yang tidak valid** (mis. NIK salah format) hanya membuang field itu, bukan seluruh baris, dan
  tercatat di riwayat sinkronisasi.
- **Asal data** setiap nasabah dicatat (`kyc_source`, mis. "API: Member App", "CSV import",
  "Staff: …").

**CRM ke APPS / STORE (menu API, tab "Access for APPS / STORE"):**
- **API key:** setiap sistem mendapat key sendiri (`rei_<prefix>_<rahasia>`). Server hanya menyimpan
  hash SHA-256, dan key utuh ditampilkan sekali saat dibuat.
- **Akses:** *Profiles* (`customers:read`) berisi profil, tier, poin, klaster, cabang, jenis kelamin,
  kota/provinsi, dan pekerjaan. *Identity data* (`customers:read:pii`) menambahkan nomor telepon lengkap,
  NIK, email, tempat/tanggal lahir, alamat, dan kode pos.
- **Pemanggilan:** kirim `Authorization: Bearer <key>` (atau `X-API-Key`).

```
GET /api/partner/v1/customers?limit=100[&updatedSince=ISO][&cursor=…]
    → data: [...], meta: { count, nextCursor }
GET /api/partner/v1/customers/:id
GET /api/partner/v1/customers/lookup?phone=0812…   (atau ?nik=… — perlu akses Identity data)
```

- **Penarikan inkremental:** simpan `meta.nextCursor` dan kirim kembali sampai bernilai `null`. Urutannya
  stabil (`updated_at`, `id`), sehingga tidak ada data yang terlewat atau terduplikasi antarhalaman.
  Nasabah muncul lagi setiap kali profil, tier, atau klasternya berubah.
- **Audit & pencabutan:** setiap permintaan dicatat di audit log (`PARTNER_API_READ`). Key yang dicabut
  langsung berhenti bekerja.

## Pengaturan akun & manajemen user

- **Settings:** klik kartu nama di bawah sidebar untuk membuka halaman ini. Isinya: ubah nama, ganti
  password, pilihan tema, dan keluar dari semua perangkat lain.
- **Users:** menu di bawah sidebar, khusus staf pusat. Di sini admin menambah, mengubah, dan menonaktifkan
  akun, mengatur peran dan cabang, serta mereset password.
- **Akun baru dan reset password** menghasilkan password sementara yang ditampilkan **sekali**. Server
  menolak semua endpoint lain (`403 PASSWORD_CHANGE_REQUIRED`) sampai user memilih password sendiri.
- **Aturan password:** minimal 10 karakter, berisi huruf dan angka, serta tidak boleh mengandung nama atau
  email user.
- **Perubahan berlaku seketika:** perubahan peran atau cabang, penonaktifan, reset password, dan ganti
  password langsung mencabut sesi user di semua perangkat. Server menyimpan cap waktu "sesi sebelum T tidak
  berlaku", jadi token lama tidak bisa dipakai lagi meskipun belum kedaluwarsa.
- **Pengaman:** admin tidak dapat mengubah peran atau menonaktifkan akunnya sendiri, dan minimal satu staf
  pusat aktif selalu dipertahankan.

## Import & export CSV nasabah

- **Export** mengikuti pencarian dan filter klaster yang sedang aktif, serta lingkup cabang pengguna.
  - Nomor telepon lengkap (format `0812-3456-7801`) hanya untuk peran yang boleh membuka PII. Peran lain
    mendapat nomor tersamar.
  - NIK tidak pernah diekspor.
  - Sel yang diawali `= + - @` dinetralkan agar tidak dijalankan sebagai rumus oleh Excel atau Sheets.
- **Import:** kolom wajib `full_name` dan `phone`. Kolom opsional: `email`, `nik`, `preferred_channel`,
  `marketing_consent`, `home_branch_code`. Nama kolom berbahasa Indonesia (mis. `Nama`, `No HP`, `Cabang`)
  dan pemisah `;` juga dikenali. Setiap baris divalidasi dengan aturan yang sama seperti form
  "New Customer". File diperiksa dulu (*dry run*) dan baru disimpan setelah dikonfirmasi. Nomor yang sudah
  terdaftar dilewati, tidak ditimpa.

## Deployment

- `CLUSTER_WORKERS=auto` menjalankan satu worker per core. Atau jalankan satu proses per kontainer lalu skalakan secara horizontal.
- **Wajib `REDIS_URL` bila lebih dari satu proses/instance** (sesi, rate limit, idempotensi, dedupe webhook).
- `TRUST_PROXY=true` di belakang load balancer. TLS diterminasi di reverse proxy.
- SIGTERM: `/readyz` langsung 503, koneksi baru ditolak, permintaan berjalan diselesaikan, lalu pool ditutup.
- Jalankan `npm run migrate` sebagai langkah rilis (aman paralel karena memakai advisory lock).

## Roadmap

- [x] **Fase 1**: server HTTP native, RBAC, Customer 360, enkripsi PII, audit dasar
- [x] **Fase 2** (fondasi): webhook omnichannel, janji temu cabang, riwayat taksiran
- [x] **Arsitektur Raja CRM — Fase A**: master data (area, outlet, katalog produk, kategori, jenis
      transaksi, kanal akuisisi, penugasan CS), RBAC 7 peran, dan lingkup data per area.
      Rencana lengkap fase A–F: [`docs/rencana-arsitektur-crm.md`](docs/rencana-arsitektur-crm.md)
- [x] **Arsitektur Raja CRM — Fase B**: Leads (funnel + konversi idempoten + Lead Summary) dan
      Advertising Budgets (anggaran per area × kanal × bulan + Advertising Summary)
- [ ] Fase C: item transaksi, CS, bonus, QMS →
      Fase D: 13 laporan + read-model OLAP → Fase E: Live Omset (SSE) →
      Fase F: Google Reviews & Dynamic Blast (job worker)
- [ ] Fase 2 lanjutan: event bus berbasis Redis Streams (lintas instance), pengiriman pesan keluar, UI jadwal ulang
- [ ] **Fase 3**: segmentasi loyalitas otomatis, pengingat tindak lanjut pasca-transaksi, laporan performa cabang
- [ ] Operasional: rotasi kunci PII (`keyId` sudah ada di format ciphertext), zona waktu per cabang (kolom `branches.timezone` sudah ada, logikanya belum), CI (lint + test + migrasi terhadap DB sementara)
