# Rencana Implementasi — Arsitektur Sistem Raja CRM

Dokumen rencana untuk menambahkan fitur pada `Arsitektur Sistem Raja CRM.docx` ke kodebase
`rajaemas-crm`. Disusun 2026-11-28.

Prinsip yang dipegang selama implementasi:

1. **Aditif, bukan rombak.** Tidak ada rename tabel/kolom yang sudah berisi data
   (`branches` tetap `branches`, peran lama tetap ada). Semua perubahan lewat migrasi baru.
2. **Ikuti konvensi yang ada.** `routes → service → repository`, SQL berparameter, audit log di
   dalam transaksi yang sama, envelope respons, tanpa dependensi runtime baru.
3. **Realtime pakai SSE** di atas `node:http` (keputusan 2026-11-28) — tanpa paket `ws`.
4. **Setiap fase selesai = `npm run check` hijau** (ESLint + Prettier + `node --test`).

---

## 0. Peta celah (ringkasan)

| Domain dokumen                            | Sudah ada                                                                                                           | Belum ada                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analytics & Executive Reporting (14 menu) | `/dashboard/summary`                                                                                                | Dashboard by City/Province, Transaction/CS Rating/Lead/Google Review/Outlet Rating/Customer/Bonus/QMS/Advertising Summary, Demografi App, Live Omset |
| Core CRM & Operations                     | Customers, klaster kanal, `branches`, `gold_transactions`                                                           | **Leads**, items transaksi, `cs_id`, bonus, QMS, `is_loyal` eksplisit                                                                                |
| Bullion & Buyback (LM REI)                | `appraisal_records` → buyback SETTLED                                                                               | Dashboard LM REI, produk bullion ber-SKU                                                                                                             |
| Marketing & Reputation                    | —                                                                                                                   | Advertising Budgets, Google Reviews, Dynamic Blast                                                                                                   |
| Master Data & RBAC                        | `users` (4 peran), `user_settings`                                                                                  | areas, products, categories, transaction types, references, penugasan CS, **6 peran**                                                                |
| Pola arsitektur                           | modular monolith, Redis (sesi/rate-limit/idempotensi), event bus in-process, `integrations/fetcher.js` (SSRF-guard) | WebSocket/SSE, queue worker + scheduler, read-model OLAP di Redis                                                                                    |

Skema sekarang: 12 tabel. Target dokumen: ±13 tabel baru.

---

## FASE A — Fondasi Master Data + RBAC 6 Peran

> **Status: SELESAI (2026-11-28).** Lihat A.11 untuk apa yang benar-benar dikerjakan dan
> penyimpangan dari rencana. Fase B–F bergantung pada hasil fase ini.

### A.1 Peran (RBAC)

Dokumen menyebut 6 peran. Kodebase punya 4 peran yang **sudah berisi data** (7 akun: 4 APPRAISER,
1 BRANCH_HEAD, 1 CUSTOMER_SERVICE, 1 HQ_STAFF) dan dipakai alur taksiran/buyback.

Keputusan: **6 peran dokumen + `APPRAISER` dipertahankan = 7 peran efektif.**
Menghapus `APPRAISER` akan memutus `appraisal_records` dan alur buyback yang sudah berjalan.

| Kode peran                           | Label UI               | Padanan dokumen      | Lingkup data                     |
| ------------------------------------ | ---------------------- | -------------------- | -------------------------------- |
| `SUPER_ADMIN` _(baru)_               | Super Admin            | Super Admin          | global                           |
| `HQ_STAFF` _(ada)_                   | Management / Executive | Management/Executive | global                           |
| `AREA_MANAGER` _(baru)_              | Area Manager           | Area Manager         | semua outlet dalam `area_id`-nya |
| `BRANCH_HEAD` _(ada)_                | Outlet Head            | Outlet Head          | satu outlet                      |
| `CUSTOMER_SERVICE` _(ada)_           | Customer Service       | Customer Service     | satu outlet (opsional)           |
| `DIGITAL_MARKETING` _(baru)_         | Digital Marketing      | Digital Marketing    | global, tanpa PII                |
| `APPRAISER` _(ada, di luar dokumen)_ | Penaksir               | —                    | satu outlet                      |

**Aturan `SUPER_ADMIN` vs `HQ_STAFF`** — sengaja tidak memindahkan `user:manage` dari `HQ_STAFF`,
agar akun pusat yang ada tidak kehilangan akses menu Users (menghindari lockout). `SUPER_ADMIN`
adalah superset: memegang izin yang benar-benar baru dan berisiko (`settings:manage`).

### A.2 Izin baru (`src/security/rbac.js`)

14 izin lama tetap. Tambahan:

| Izin                                        | Dipakai menu                                                  |
| ------------------------------------------- | ------------------------------------------------------------- |
| `masterdata:read` / `masterdata:manage`     | Areas, Products, Category, Transaction Types, References      |
| `outlet:manage`                             | Outlets (area, `google_place_id`, alamat)                     |
| `staffing:manage`                           | Customer Services (penugasan CS per outlet)                   |
| `role:read`                                 | Roles (matriks read-only)                                     |
| `lead:read` / `lead:write` / `lead:convert` | Leads, Lead Summary _(fase B)_                                |
| `budget:read` / `budget:manage`             | Advertising Budgets, Advertising Summary _(fase B)_           |
| `blast:read` / `blast:manage`               | Dynamic Blast _(fase F)_                                      |
| `review:read` / `review:manage`             | Google Reviews, syncer _(fase F)_                             |
| `report:executive`                          | Transaction/Customer/Bonus/QMS/CS Rating Summary _(fase C–D)_ |
| `report:outlet_rating`                      | Google Review Summary, Outlet Rating Summary _(fase F)_       |
| `lmrei:read`                                | Dashboard LM REI, LM REI Buyback _(fase D)_                   |
| `live_omset:read`                           | Live Omset _(fase E)_                                         |
| `settings:manage`                           | Settings global _(fase A: read-only dulu)_                    |

Matriks (✔ = punya):

| Izin                                                                                       | SUPER_ADMIN |  HQ_STAFF   |                 AREA_MANAGER                  |                  BRANCH_HEAD                  |      CUSTOMER_SERVICE       |                 DIGITAL_MARKETING                 |              APPRAISER               |
| ------------------------------------------------------------------------------------------ | :---------: | :---------: | :-------------------------------------------: | :-------------------------------------------: | :-------------------------: | :-----------------------------------------------: | :----------------------------------: |
| seluruh izin lama (dashboard, customer, PII, appointment, appraisal, segment, transaction) |      ✔      |      ✔      | ✔ (tanpa `integration:manage`, `user:manage`) | ✔ (tanpa `integration:manage`, `user:manage`) | sebagian (seperti sekarang) | `dashboard:read`, `customer:read`, `segment:read` | seperti sekarang + `masterdata:read` |
| `masterdata:read`                                                                          |      ✔      |      ✔      |                       ✔                       |                       ✔                       |              ✔              |                         ✔                         |                  ✔                   |
| `masterdata:manage`                                                                        |      ✔      |      ✔      |                       –                       |                       –                       |              –              |                         –                         |                  –                   |
| `outlet:manage`                                                                            |      ✔      |      ✔      |                       –                       |                       –                       |              –              |                         –                         |                  –                   |
| `staffing:manage`                                                                          |      ✔      |      ✔      |                  ✔ (areanya)                  |                ✔ (outlet-nya)                 |              –              |                         –                         |                  –                   |
| `user:manage` / `integration:manage`                                                       |      ✔      |      ✔      |                       –                       |                       –                       |              –              |                         –                         |                  –                   |
| `role:read`                                                                                |      ✔      |      ✔      |                       –                       |                       –                       |              –              |                         –                         |                  –                   |
| `settings:manage`                                                                          |      ✔      |      –      |                       –                       |                       –                       |              –              |                         –                         |                  –                   |
| `lead:*`                                                                                   |      ✔      |      ✔      |                       ✔                       |                       ✔                       |     read+write+convert      |                       read                        |                  –                   |
| `budget:*`                                                                                 |      ✔      | read+manage |                     read                      |                     read                      |              –              |                    read+manage                    |                  –                   |
| `blast:*`                                                                                  |      ✔      |   manage    |                       –                       |                       –                       |              –              |                    read+manage                    |                  –                   |
| `review:*`                                                                                 |      ✔      |   manage    |                     read                      |                     read                      |              –              |                    read+manage                    |                  –                   |
| `report:executive`                                                                         |      ✔      |      ✔      |                       ✔                       |                       ✔                       |              –              |                         ✔                         |                  –                   |
| `report:outlet_rating`                                                                     |      ✔      |      ✔      |                       ✔                       |                       ✔                       |              –              |                         ✔                         |                  –                   |
| `lmrei:read`                                                                               |      ✔      |      ✔      |                       ✔                       |                       ✔                       |              –              |                         –                         |                  ✔                   |
| `live_omset:read`                                                                          |      ✔      |      ✔      |                       ✔                       |                       ✔                       |              –              |                         –                         |                  –                   |

Isolasi data tetap mengandalkan **scope**, bukan permission: permission menentukan _menu boleh
dibuka_, scope menentukan _baris mana yang terlihat_.

### A.3 Lingkup data baru (`src/shared/scope.js`)

`AREA_MANAGER` butuh tingkat lingkup di antara "satu outlet" dan "global":

```
actor.branchId terisi      → hanya outlet itu            (BRANCH_HEAD, APPRAISER, CS)
actor.areaId terisi        → semua outlet di area itu    (AREA_MANAGER)  ← BARU
keduanya null              → semua outlet                (SUPER_ADMIN, HQ_STAFF, DIGITAL_MARKETING)
```

Perubahan yang mengikuti:

- `shared/scope.js`: tambah `areaScopeOf(actor)`, `resolveBranchIds(actor, requested)`, dan
  `assertOutletAccess` yang paham area (butuh peta `branch_id → area_id`, di-cache per request).
- Kolom baru `users.area_id`; `users.branch_id` tetap.
- **Token & sesi memuat `areaId`** → `security/token.js`, `auth.service.js` (`resolveSession`),
  `auth/user.repository.js` (mapping baris → aktor).
- `user.service.js`: `BRANCH_RULE` diperluas (`SUPER_ADMIN`/`AREA_MANAGER` → `branch: none`),
  tambah `AREA_RULE` (`AREA_MANAGER` wajib `area_id`), dan `accessChanged` ikut membandingkan
  `areaId` supaya sesi dicabut saat area dipindah.

### A.4 Migrasi `db/migrations/006_master_data_rbac.sql`

Gaya mengikuti `005_kyc_partner_api.sql` (komentar header + bagian per tabel).

```sql
-- areas: provinsi/kota sebagai induk outlet
CREATE TABLE areas (
  area_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_code   varchar(16)  NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  province    varchar(80)  NOT NULL,
  city        varchar(80),
  region_code varchar(16),
  is_active   boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- outlets: branches diperluas (tanpa rename)
ALTER TABLE branches
  ADD COLUMN area_id         uuid REFERENCES areas (area_id),
  ADD COLUMN google_place_id varchar(120),
  ADD COLUMN address         varchar(200),
  ADD COLUMN city            varchar(80),
  ADD COLUMN province        varchar(80),
  ADD COLUMN timezone        varchar(32) NOT NULL DEFAULT 'Asia/Jakarta',
  ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX branches_google_place_uidx
  ON branches (google_place_id) WHERE google_place_id IS NOT NULL;
CREATE INDEX branches_area_idx ON branches (area_id);
CREATE TRIGGER branches_touch BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- acquisition_references: kanal asal lead (Instagram, Google Ads, Walk-in, Rajaemas App, …)
CREATE TABLE acquisition_references (
  reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(32)  NOT NULL UNIQUE,
  name         varchar(120) NOT NULL,
  channel_type varchar(24)  NOT NULL
               CHECK (channel_type IN ('DIGITAL_ADS','SOCIAL','SEARCH','WALK_IN','APP','REFERRAL','EVENT','OTHER')),
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

-- katalog: category_of_products → products
CREATE TABLE product_categories (
  category_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        varchar(32)  NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  is_active   boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE products (
  product_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id      uuid REFERENCES product_categories (category_id),
  sku              varchar(64)  NOT NULL UNIQUE,
  name             varchar(160) NOT NULL,
  karat            numeric(4,2) CHECK (karat > 0 AND karat <= 24),
  base_weight_gram numeric(10,3) CHECK (base_weight_gram > 0),
  is_bullion       boolean      NOT NULL DEFAULT false,  -- true = Logam Mulia (LM REI)
  is_active        boolean      NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users (user_id),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id) WHERE is_active;

-- transaction_types: reguler vs skema khusus LM REI Buyback
CREATE TABLE transaction_types (
  type_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               varchar(32)  NOT NULL UNIQUE,
  name               varchar(120) NOT NULL,
  side               varchar(4)   NOT NULL CHECK (side IN ('BUY','SELL')),
  is_bullion         boolean      NOT NULL DEFAULT false,
  requires_appraisal boolean      NOT NULL DEFAULT false,
  is_active          boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);

-- customer_services: penugasan CS per outlet (sumber CS Rating & Bonus Summary)
CREATE TABLE cs_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (user_id),
  branch_id     uuid NOT NULL REFERENCES branches (branch_id),
  is_primary    boolean NOT NULL DEFAULT false,
  valid_from    date    NOT NULL DEFAULT current_date,
  valid_to      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cs_assignments_window CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (user_id, branch_id, valid_from)
);
CREATE INDEX cs_assignments_branch_idx ON cs_assignments (branch_id, valid_from DESC);

-- users: 3 peran baru + lingkup area
ALTER TABLE users
  ADD COLUMN area_id   uuid REFERENCES areas (area_id),
  ADD COLUMN job_title varchar(80);

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'SUPER_ADMIN','HQ_STAFF','AREA_MANAGER','BRANCH_HEAD',
  'CUSTOMER_SERVICE','DIGITAL_MARKETING','APPRAISER'));

ALTER TABLE users DROP CONSTRAINT users_hq_without_branch;
ALTER TABLE users ADD CONSTRAINT users_global_roles_without_branch
  CHECK (role NOT IN ('SUPER_ADMIN','HQ_STAFF','AREA_MANAGER') OR branch_id IS NULL);

ALTER TABLE users DROP CONSTRAINT users_branch_roles_need_branch;
ALTER TABLE users ADD CONSTRAINT users_outlet_roles_need_branch
  CHECK (role NOT IN ('BRANCH_HEAD','APPRAISER') OR branch_id IS NOT NULL);

ALTER TABLE users ADD CONSTRAINT users_area_manager_needs_area
  CHECK (role <> 'AREA_MANAGER' OR area_id IS NOT NULL);
```

Catatan: nama constraint sudah **diverifikasi terhadap DB aktif** pada 2026-11-28
(`users_role_check`, `users_hq_without_branch`, `users_branch_roles_need_branch`), jadi
`DROP CONSTRAINT` di atas aman. Urutan `DROP` → `ADD` wajib, karena CHECK lama menolak peran baru.

**Tabel `roles` sengaja tidak dibuat.** Sumber kebenaran tetap `src/security/rbac.js`;
menu Roles membaca matriks itu lewat `GET /api/v1/roles`. Dua sumber kebenaran (tabel + kode)
berisiko tidak sinkron, dan dokumen pun menyatakan "6 entri tetap".

### A.5 Modul backend baru

```
src/modules/masterdata/
├── area.repository.js            list / findById / insert / update
├── product.repository.js         + category
├── reference.repository.js
├── transactionType.repository.js
├── csAssignment.repository.js
├── masterdata.service.js         validasi bisnis + audit log (tanpa HTTP)
└── masterdata.routes.js          registrasi rute
```

Registrasi mengikuti pola yang ada: factory repository didaftarkan di `src/infra/repositories.js`,
service dirakit di `src/container.js`, rute dipasang di `src/app.js`.

Endpoint baru (semua di bawah `/api/v1`, semua lewat `guard.authenticate` + `guard.authorize`):

| Metode   | Endpoint                         | Izin                                    |
| -------- | -------------------------------- | --------------------------------------- |
| GET/POST | `/areas`                         | `masterdata:read` / `masterdata:manage` |
| PATCH    | `/areas/:id`                     | `masterdata:manage`                     |
| GET/POST | `/references`                    | `masterdata:read` / `masterdata:manage` |
| PATCH    | `/references/:id`                | `masterdata:manage`                     |
| GET/POST | `/product-categories`            | `masterdata:read` / `masterdata:manage` |
| PATCH    | `/product-categories/:id`        | `masterdata:manage`                     |
| GET/POST | `/products`                      | `masterdata:read` / `masterdata:manage` |
| PATCH    | `/products/:id`                  | `masterdata:manage`                     |
| GET/POST | `/transaction-types`             | `masterdata:read` / `masterdata:manage` |
| PATCH    | `/transaction-types/:id`         | `masterdata:manage`                     |
| GET/POST | `/cs-assignments`                | `masterdata:read` / `staffing:manage`   |
| DELETE   | `/cs-assignments/:id`            | `staffing:manage`                       |
| GET      | `/roles`                         | `role:read`                             |
| GET      | `/branches?includeInactive=true` | `dashboard:read` (diperluas)            |
| PATCH    | `/branches/:id`                  | `outlet:manage`                         |

Semua tulis-master-data diaudit (`MASTERDATA_*`, `OUTLET_UPDATED`, `CS_ASSIGNMENT_*`) di dalam
transaksi yang sama, mengikuti aturan kode di README. Nonaktifkan memakai `is_active = false`
(soft delete), bukan `DELETE`, kecuali `cs_assignments`.

### A.6 Frontend

Satu halaman **Master Data** bertab (mengikuti preseden `views/integrations.js` yang sudah bertab),
bukan 6 menu terpisah — sidebar tidak penuh dan kode lebih sedikit:

```
public/assets/js/views/masterData.js   tab: Areas · Outlets · Products · Categories ·
                                           Transaction Types · References · Customer Services
public/assets/js/views/roles.js        matriks peran × izin (read-only)
```

Perubahan pendukung:

- `public/assets/js/main.js`: tambah entri `NAV`/`ADMIN_NAV` + `ROUTES` (Master Data →
  `masterdata:read`, Roles → `role:read`).
- `public/assets/js/i18n.id.js`: label Indonesia untuk entitas, kolom, dan peran baru.
- `LABELS.role` di `main.js`: 7 label peran.
- CRUD memakai helper `dom.js`/`api.js` yang sudah ada; tanpa dependensi baru.

### A.7 Seed & tes

`scripts/seed.js` (idempoten, `ON CONFLICT DO UPDATE`) ditambah:

- 3 area contoh (Jabodetabek, Jawa Barat, Jawa Timur) + tautkan 3 `branches` yang sudah ada.
- 6 references (`INSTAGRAM`, `GOOGLE_ADS`, `WALK_IN`, `RAJAEMAS_APP`, `REFERRAL`, `MARKETPLACE`).
- 4 kategori + ±10 produk (termasuk 2 bullion `is_bullion = true` untuk LM REI).
- 5 transaction types (jual/beli perhiasan, buyback LM REI `requires_appraisal = true`).
- Penugasan CS untuk akun `cs@rajaemas.id`.
- **3 akun baru**: `superadmin@rajaemas.id`, `area.jkt@rajaemas.id`, `marketing@rajaemas.id`
  (password = `SEED_PASSWORD`, seperti akun seed lain). Akun lama tidak diubah.

Tes baru/diperluas (`node --test`, tanpa DB — mengikuti pola `test/users.test.js`):

| Berkas                             | Isi                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `test/rbac.test.js` _(baru)_       | 7 peran × seluruh izin; pastikan `APPRAISER` tidak dapat izin baru yang berbahaya; `settings:manage` hanya `SUPER_ADMIN`   |
| `test/masterdata.test.js` _(baru)_ | validasi service (SKU duplikat → 409, kategori nonaktif ditolak, `valid_to < valid_from` ditolak) memakai repository palsu |
| `test/scope.test.js` _(baru)_      | lingkup branch / area / global                                                                                             |
| `test/users.test.js`               | peran baru: `AREA_MANAGER` wajib `area_id`; pindah area mencabut sesi                                                      |
| `test/http.test.js`                | rute baru terdaftar & menolak tanpa izin                                                                                   |

### A.8 Urutan pengerjaan fase A

1. Tulis `db/migrations/006_master_data_rbac.sql` → `npm run migrate` (nama constraint sudah
   diverifikasi, lihat A.4).
2. `security/rbac.js` (peran + izin + matriks) → `test/rbac.test.js`.
3. `shared/scope.js` + token/sesi memuat `areaId` → `test/scope.test.js`.
4. Repository master data → registrasi di `infra/repositories.js`.
5. `masterdata.service.js` (+ audit) → `test/masterdata.test.js`.
6. `masterdata.routes.js` + `branches` PATCH → pasang di `app.js` → `test/http.test.js`.
7. `user.service.js`: aturan area + `accessChanged`.
8. Frontend: `views/masterData.js`, `views/roles.js`, `main.js`, `i18n.id.js`.
9. `scripts/seed.js` → jalankan → verifikasi manual lewat UI.
10. `npm run check`; perbarui README (tabel API, daftar peran, roadmap).

### A.9 Kriteria terima fase A

- [ ] `npm run migrate` bersih di DB yang sudah berisi data (tidak ada kehilangan baris).
- [ ] 7 peran dapat login; menu yang tampil sesuai matriks.
- [ ] Akun `area.jkt@rajaemas.id` hanya melihat outlet di areanya pada `/customers` dan `/dashboard/summary`.
- [ ] Master data (area, produk, kategori, jenis transaksi, referensi, penugasan CS) bisa CRUD dari UI.
- [ ] Setiap tulis master data menghasilkan baris `audit_logs`.
- [ ] `npm run check` hijau.

### A.10 Risiko

| Risiko                                                                              | Mitigasi                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DROP`/`ADD CONSTRAINT` pada `users` mengunci tabel (ACCESS EXCLUSIVE)              | `scripts/migrate.js` sudah membungkus tiap migrasi dalam satu transaksi + advisory lock `727274`, jadi atomik; tabel `users` kecil (7 baris). Jalankan saat trafik rendah di produksi |
| Token lama di Redis tidak memuat `areaId` → `AREA_MANAGER` bisa melihat data global | `resolveSession` memperlakukan `areaId` yang hilang sebagai "tanpa lingkup area"; `user.service.js` sudah mencabut semua sesi saat peran/cabang berubah, diperluas ke `areaId`        |
| Akun pusat terkunci dari menu Users                                                 | `user:manage` tetap diberikan ke `HQ_STAFF`, tidak dipindah ke `SUPER_ADMIN`                                                                                                          |
| Menu baru muncul untuk peran yang belum seharusnya                                  | `NAV` di `main.js` difilter `can(permission)` dan matriks RBAC diubah dalam commit yang sama                                                                                          |
| Seed dijalankan ulang di DB berisi data                                             | seed tetap idempoten (`ON CONFLICT DO UPDATE`) dan hanya menambah; akun & nasabah lama tidak diubah                                                                                   |
| `branches.updated_at` baru terisi `now()` untuk semua baris lama                    | diterima (bukan kolom audit); trigger `touch_updated_at` menjaga nilai berikutnya                                                                                                     |

### A.11 Hasil pengerjaan (2026-11-28)

**Yang dikerjakan** — sesuai rencana, dengan beberapa penyesuaian yang ditemukan saat implementasi:

| Berkas                                                               | Isi                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/006_master_data_rbac.sql`                             | 7 tabel baru (`areas`, `acquisition_references`, `product_categories`, `products`, `transaction_types`, `cs_assignments`) + perluasan `branches` & `users` + 3 peran baru |
| `src/security/rbac.js`                                               | 7 peran, 33 izin, matriks, `ROLE_ORDER`, `roleMatrix()`                                                                                                                   |
| `src/shared/scope.js`                                                | `areaScopeOf`, `dataScopeOf`, `assertOutletInScope`, `resolveScopedBranchId`                                                                                              |
| `src/shared/sql.js`                                                  | `outletScopeFilter` / `outletScopeSql` — fragmen SQL lingkup (outlet / area / keduanya / bebas)                                                                           |
| `src/modules/masterdata/*`                                           | repository (6 entitas), service (CRUD + audit + aturan bisnis), routes                                                                                                    |
| `src/modules/branches/branch.service.js`                             | direktori outlet sesuai lingkup + `PATCH` beraudit                                                                                                                        |
| Repository & service lama                                            | `dashboard`, `customers`, `customer.transfer`, `appointments`, `appraisals`, `segments` semua menerima objek scope, bukan `branchId` tunggal                              |
| `src/modules/auth/*`, `src/core/http/context.js`                     | token/sesi/aktor membawa `areaId`                                                                                                                                         |
| `public/assets/js/views/masterData.js`                               | 1 halaman, 7 tab (Areas, Outlets, Products, Categories, Transaction Types, References, Customer Services)                                                                 |
| `public/assets/js/views/roles.js`                                    | matriks peran × izin, dikelompokkan per domain                                                                                                                            |
| `scripts/seed.js`                                                    | 3 area, 6 kanal, 4 kategori, 10 produk, 5 jenis transaksi, 1 penugasan CS, 3 akun peran baru                                                                              |
| `test/rbac.test.js`, `test/scope.test.js`, `test/masterdata.test.js` | 38 tes baru (total 111, semua lulus)                                                                                                                                      |

**Penyimpangan dari rencana (semuanya disengaja):**

1. **`GET /api/v1/branches` kini mengikuti lingkup pemanggil.** Sebelumnya semua peran melihat
   seluruh outlet. Kepala cabang sekarang hanya melihat outletnya — konsisten dengan manajer area.
   Endpoint tetap terbuka untuk semua peran yang terautentikasi karena dipakai mengisi dropdown.
2. **Endpoint tambahan `GET /api/v1/cs-assignments/staff`.** Pemegang `staffing:manage`
   (kepala cabang, manajer area) tidak punya `user:manage`, jadi form penugasan CS butuh sumber
   daftar staf sendiri — sudah disaring menurut lingkup pemanggil.
3. **`audit_logs.entity_type` dinormalkan ke lowercase snake_case** (`area`, `product_category`,
   `cs_assignment`) agar seragam dengan entri lama (`user`, `customer`, `branch`).
4. **Kode/SKU tidak dapat diubah setelah dibuat** (tidak dikirim saat edit), karena menjadi
   rujukan stabil bagi tabel lain. Form hanya menampilkannya saat membuat.
5. **`users.countOtherActiveHq` kini menghitung `SUPER_ADMIN` + `HQ_STAFF`**, sehingga penjaga
   "minimal satu akun pusat aktif" tidak putus saat akun pusat dipromosikan jadi Super Admin.

**Verifikasi yang dijalankan** (bukan asumsi):

- `npm run check` → ESLint + Prettier + `node --test`: **111 tes lulus, 0 gagal**.
- `npm run migrate` di DB yang sudah berisi data → bersih, 246 nasabah & 7 akun lama utuh.
- 37 pemeriksaan HTTP langsung ke server dev untuk **ketujuh peran**: login, CRUD master data
  (201/409/422), penolakan izin (403), dan lingkup data.
- Bukti lingkup: nasabah terlihat `pusat=246`, `area manager=4`, `kepala cabang=4`;
  outlet terlihat `pusat=3`, `area=1 (JKT01)`, `kepala cabang=1`; janji temu ke outlet di luar
  area ditolak `403`.

---

## FASE B — Leads & Akuisisi

> **Status: SELESAI (2026-11-28).** Lihat B.1 untuk hasil dan penyimpangan dari rencana.

**Migrasi `007_leads_advertising.sql`**

```sql
CREATE TABLE leads (
  lead_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     varchar(120) NOT NULL,
  phone_hash    char(64)     NOT NULL,          -- blind index, seperti customers
  phone_encrypted text       NOT NULL,
  phone_last4   char(4)      NOT NULL,
  email         varchar(160),
  reference_id  uuid REFERENCES acquisition_references (reference_id),
  area_id       uuid REFERENCES areas (area_id),
  branch_id     uuid REFERENCES branches (branch_id),
  status        varchar(16)  NOT NULL DEFAULT 'NEW'
                CHECK (status IN ('NEW','CONTACTED','QUALIFIED','CONVERTED','LOST','EXPIRED')),
  notes         varchar(500),
  owner_id      uuid REFERENCES users (user_id),
  converted_customer_id uuid,                    -- FK dipasang setelah tabel ada
  converted_at  timestamptz,
  lost_reason   varchar(120),
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE advertising_budgets (
  budget_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id      uuid NOT NULL REFERENCES areas (area_id),
  reference_id uuid NOT NULL REFERENCES acquisition_references (reference_id),
  period_month date NOT NULL,                    -- selalu tanggal 1
  spend_amount numeric(16,2) NOT NULL CHECK (spend_amount >= 0),
  notes        varchar(300),
  created_by   uuid REFERENCES users (user_id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_id, reference_id, period_month)
);

ALTER TABLE leads ADD CONSTRAINT leads_converted_customer_fk
  FOREIGN KEY (converted_customer_id) REFERENCES customers (customer_id);
ALTER TABLE customers ADD COLUMN lead_id uuid REFERENCES leads (lead_id);
ALTER TABLE customers ADD COLUMN acquisition_reference_id uuid REFERENCES acquisition_references (reference_id);
```

**Modul:** `src/modules/leads/` (repository, service, routes) + `src/modules/advertising/`.
**Aturan bisnis:**

- Nomor lead unik per `phone_hash`; lead yang nomornya sudah jadi nasabah ditandai `CONVERTED`.
- `POST /leads/:id/convert` → dalam satu transaksi: buat/perbarui `customers` (memakai
  `customer.intake.js` yang sudah ada), set `customers.lead_id`, status `CONVERTED`, audit
  `LEAD_CONVERTED`. Konversi idempoten (lead yang sudah `CONVERTED` mengembalikan nasabah yang sama).
- Mesin status: `NEW → CONTACTED → QUALIFIED → CONVERTED|LOST`; `EXPIRED` diisi job (fase F).

**Endpoint:** `GET/POST /leads`, `PATCH /leads/:id`, `POST /leads/:id/convert`,
`GET /leads/summary?from=&to=&branchId=` (Lead Summary),
`GET/POST/PATCH /advertising-budgets`, `GET /advertising/summary` (Advertising Summary:
spend vs jumlah lead vs konversi per area/kanal → biaya per lead & per konversi).
**UI:** `views/leads.js`, `views/advertising.js`. **Impor CSV lead** menyusul pola `customerCsv.js`.

### B.1 Hasil pengerjaan (2026-11-28)

| Berkas                                           | Isi                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `db/migrations/007_leads_advertising.sql`        | `leads`, `advertising_budgets`, + `customers.lead_id` & `customers.acquisition_reference_id` |
| `src/modules/leads/`                             | `lead.repository.js`, `lead.service.js`, `lead.routes.js`                                    |
| `src/modules/advertising/`                       | `advertising.repository.js`, `advertising.service.js`, `advertising.routes.js`               |
| `src/modules/customers/customer.repository.js`   | `linkAcquisition()` — atribusi pertama menang (`COALESCE`)                                   |
| `src/modules/customers/customer.service.js`      | `assertHomeBranchAllowed()` (dari Fase A, dipakai juga oleh lead)                            |
| `public/assets/js/views/leads.js`                | funnel + KPI Lead Summary + rincian per kanal                                                |
| `public/assets/js/views/advertising.js`          | KPI belanja, ringkasan per kanal/area, CRUD anggaran                                         |
| `public/assets/js/dom.js`                        | `kpiCard()` dipindah ke sini agar dipakai ulang (sebelumnya privat di `overview.js`)         |
| `scripts/seed.js`                                | 8 prospek di seluruh funnel (2 terkonversi) + 8 anggaran area × kanal × bulan                |
| `test/leads.test.js`, `test/advertising.test.js` | 26 tes baru (total 137, semua lulus)                                                         |

**Penyimpangan & keputusan tambahan:**

1. **Indeks unik prospek bersifat parsial** — `leads_active_phone_uidx` hanya mencakup status
   `NOT IN ('CONVERTED','LOST','EXPIRED')`, jadi nomor yang pernah kalah bisa didekati lagi.
   Konsekuensinya seed harus memeriksa sendiri "sudah ada lead dengan nomor ini?" agar idempoten.
2. **`area_id` lead diturunkan dari outlet**, tidak pernah dipercaya dari permintaan klien.
3. **Nomor telepon prospek memakai domain blind index `phone` yang sama dengan `customers`** —
   disengaja, supaya "sudah jadi nasabah?" terjawab tanpa dekripsi. Konteks enkripsinya tetap beda
   (`leads.phone` vs `customers.phone`), jadi ciphertext tidak dapat dipindah antar kolom.
4. **Konversi memanggil `intake.upsert` di luar transaksi lead.** `intake` mengelola transaksinya
   sendiri; memanggilnya di dalam transaksi lead akan membuat transaksi bersarang. Urutannya:
   intake dulu (idempoten, mencocokkan lewat nomor), lalu transaksi lead mengunci baris
   (`FOR UPDATE`) dan menulis status + atribusi + audit. Dua konversi paralel tidak menggandakan apa pun.
5. **Rasio biaya-per-lead disembunyikan bila populasi tidak sebanding.** Anggaran dicatat per area,
   lead dihitung sesuai lingkup pemanggil. Untuk staf outlet, `comparable: false` dan rasio `null`;
   angka mentahnya tetap ditampilkan.
6. **`GET /leads` memakai konvensi envelope yang sudah ada** — `data` berisi array, `meta` sebagai
   sibling (sama seperti `/customers`), bukan `{items, meta}` di dalam `data`.
7. **Impor CSV lead belum dikerjakan** (direncanakan menyusul pola `customerCsv.js`).

**Verifikasi yang dijalankan:**

- `npm run check` → **137 tes lulus, 0 gagal**.
- 52 pemeriksaan HTTP langsung ke server dev untuk 5 peran (pusat, kepala cabang, manajer area,
  pemasaran digital, penaksir): **SEMUA LULUS**.
- Bukti lingkup: lead terlihat `pusat=8`, `manajer area JKT=4`, `kepala cabang JKT01=4`; manajer
  area JKT yang meminta lead Surabaya mendapat `404` (bukan `403`, agar keberadaan data tidak bocor).
- Bukti aturan: nomor duplikat `409`; nomor yang sudah jadi nasabah `409`; nomor tak valid `422`;
  kanal tak dikenal `422`; `PATCH` ke `CONVERTED` `409` dengan pesan mengarahkan ke aksi konversi;
  `EXPIRED` manual `409`; `LOST` tanpa alasan `422`; lead `CONVERTED` dibekukan `409`.
- Bukti konversi: menghasilkan nasabah, `alreadyConverted: true` saat diulang, lead berstatus
  `CONVERTED`, profil nasabah tertaut.
- Bukti anggaran: `409` untuk kombinasi area × kanal × bulan yang sama; kepala cabang `403` saat
  menulis tetapi `200` saat membaca ringkasan; `costPerLead` terisi untuk pusat dan `null` untuk
  kepala cabang.
- Seed dijalankan 3× berturut-turut: jumlah baris stabil (8 lead, 8 anggaran, 248 nasabah).

---

## FASE C — Transaksi Kaya (items, CS, bonus, QMS)

> **Status: API dan UI operasional tersedia (2026-11-28).** Angka bonus dan loyalitas masih
> provisional; jangan gunakan ringkasan bonus untuk payroll sebelum aturan bisnis dikonfirmasi.

**Skema yang diterapkan:** [008_transactions_qms.sql](../db/migrations/008_transactions_qms.sql)
menambahkan item transaksi, QMS, CS rating, serta kolom transaksi yang nullable/ber-default agar
data lama tetap valid. [009_transaction_item_lines.sql](../db/migrations/009_transaction_item_lines.sql)
menambahkan nomor urut baris (`line_no`) untuk mempertahankan urutan item pada struk. DDL di
migrasi tersebut adalah sumber kebenaran; rancangan SQL awal di dokumen ini telah digantikan.

**Aturan bisnis:** `bonus_amount` dihitung oleh [`bonusFor`](../src/shared/bonus.js) dari sisi
transaksi, persentase, cap, dan pembulatan. Nilai bonus masih provisional. Loyalitas diturunkan
oleh [`isLoyal`](../src/shared/loyalty.js) dari tier atau frekuensi/nominal dalam jendela waktu;
flag tidak disimpan terpisah agar tidak drift.

**Endpoint:** `POST /transactions` (multi-item, wajib `Idempotency-Key`), `GET /transactions`,
`GET /transactions/summary`, `GET /bonus/summary`, `GET/POST /qms/tickets`,
`PATCH /qms/tickets/:id`, `GET /qms/summary`, `POST /cs-ratings`, `GET /cs-ratings/summary`.

### C.1 Pengerjaan lanjutan (2026-11-28)

- [operations.js](../public/assets/js/views/operations.js) menyediakan halaman Transactions & QMS: pencatatan
  transaksi multi-item, filter/daftar transaksi, antrean, transisi status, rating CS, dan ringkasan.
- [main.js](../public/assets/js/main.js) menambahkan navigasi sesuai izin `transaction:read` dan tab QMS hanya
  untuk pemegang `qms:read`.
- Tiket antrean menyertakan `isRated` agar UI tidak menawarkan rating berulang.
- [i18n.id.js](../public/assets/js/i18n.id.js) menambahkan label bahasa Indonesia untuk alur ini.
- Aturan bonus aktif tetap ditampilkan sebagai provisional; angka final masih menunggu konfirmasi.

---

## FASE D — Suite Analitik + Read-Model OLAP

> **Status: TERAPKAN UNTUK SUMBER DATA YANG SUDAH ADA.** Dua laporan rating menunggu integrasi
> Google Reviews di fase F; endpoint katalog menandainya belum tersedia dan tidak mengarang angka.

Pola: **jalur tulis OLTP tidak boleh terbebani query laporan.** Setiap transaksi/buyback
menerbitkan event ke `src/infra/eventBus.js`; subscriber memperbarui read-model.

- `src/infra/readModel.js` — subscriber idempoten pasca-commit untuk transaksi/buyback; tabel
  `daily_branch_summary` dan `daily_city_summary` di Postgres dapat dibangun ulang dari `gold_transactions`.
  Snapshot Redis memakai `omset:live:{branch}:{yyyymmdd}`, `omset:city:{city}:{yyyymmdd}`, dan
  sorted set `omset:hourly:{branch}:{yyyymmdd}`. Saat startup, transaksi yang belum terproses
  direkonsiliasi dari sumber; ringkasan pelanggan disegarkan tiap lima menit dengan lock Redis.
- `src/modules/reports/` — whitelist service + repository. Query baru menerima scope branch/area/global;
  ringkasan prospek, advertising, QMS, rating, dan bonus memakai service sumbernya yang sudah menerapkan scope.
- `db/migrations/010_reporting.sql` — backfill tabel harian, ledger transaksi terproses untuk mencegah
  hitung ganda, serta `mv_customer_summary` teragregasi tanpa PII baris-per-orang.
- Tanggal bisnis transaksi mengikuti `branches.timezone`. Demografi hanya memakai agregat umur/jenis
  kelamin pengguna dengan kanal `MOBILE_APP`; kelompok berisi kurang dari lima nasabah disembunyikan.

**Laporan tersedia:** Dashboard by City/Province, Transaction, Customer, Bonus, CS Rating, QMS,
Lead, Advertising, Demografi Rajaemas App, dan Dashboard LM REI. Google Review Summary serta
Outlet Rating Summary ditampilkan di katalog sebagai belum tersedia sampai fase F.

`GET /api/v1/reports` memberi katalog sesuai izin pengguna.
`GET /api/v1/reports/:name?from=&to=&groupBy=area|city|branch|reference` — satu endpoint generik
dengan whitelist nama laporan, validasi rentang tanggal, scope baris, response envelope + `meta.report`.

---

## FASE E — Live Omset (SSE)

> **Status: selesai (2026-11-28).**

- `src/core/http/sse.js` — helper `openStream(ctx)`: header `text/event-stream`, `Cache-Control:
no-store`, heartbeat komentar tiap 25 s, dan cleanup melalui `res.close`/`req.aborted`.
- `src/modules/liveomset/` — `GET /api/v1/live-omset/stream` (izin `live_omset:read`), snapshot
  awal dan pembaruan dua detik dari Redis. Daftar outlet dimuat sekali per koneksi dengan scope
  branch/area/global yang sama seperti direktori outlet.
- `src/modules/liveomset/liveOmset.service.js` membaca key harian menurut zona waktu tiap outlet;
  proyeksi Postgres tetap menjadi sumber kebenaran. Kegagalan snapshot dicatat lalu stream ditutup
  dengan event error yang aman.
- UI: `public/assets/js/views/liveOmset.js` memakai Fetch streaming agar token Bearer dapat dikirim
  di header (native `EventSource` tidak mendukung header tersebut), melakukan reconnect dengan
  exponential backoff, dan menutup koneksi saat pengguna meninggalkan halaman.
- Setiap worker dapat membuka stream sendiri karena read-model dibagikan lewat Redis. `REDIS_URL`
  wajib untuk deployment multi-worker/instance; mode satu worker tetap dapat berjalan dengan cache
  memori untuk development.

---

## FASE F — Google Reviews, Dynamic Blast, Job Worker

**Infra job:** `src/infra/jobs.js` — scheduler + token-owned Redis lock, retry dengan backoff,
riwayat `job_runs`, dan lifecycle stop saat shutdown. Runner dijalankan dari container.

**Google Reviews (on-demand, tanpa penyimpanan):** `GET /api/v1/reviews/outlets/:id` mengambil
Place Details hanya setelah pengguna memilih outlet. `GOOGLE_PLACES_API_KEY` dan
`branches.google_place_id` diperlukan. Response hanya berada di memori/request UI, menampilkan
atribusi Google Maps serta penulis jika tersedia, dan tidak dicache atau disimpan ke tabel/OLAP.
Karena itu Google Review Summary tidak tersedia sebagai laporan historis/berkala. Tanpa key atau
Place ID, endpoint mengembalikan error konfigurasi secara eksplisit.

**Dynamic Blast** (`011_marketing_jobs.sql` → `dynamic_blasts`, `blast_runs`, `blast_recipients`):

- Seleksi target menggunakan filter whitelist (kota, tier, klaster kanal, transaksi terbaru);
  preview hanya menampilkan jumlah, tidak menampilkan PII.
- **Hanya nasabah dengan `marketing_consent = true`** dimasukkan saat penjadwalan dan persetujuan
  diperiksa kembali tepat sebelum setiap pengiriman. Nomor terenkripsi hanya didekripsi di worker
  untuk mengirim template WhatsApp yang telah disetujui melalui Meta Cloud API.
- Worker mengirim dalam batch kecil; hasil provider dan delivery status dikaitkan melalui webhook
  Meta yang diverifikasi dengan HMAC. Pesan `STOP`, `UNSUBSCRIBE`, `CANCEL`, atau `BERHENTI`
  mencabut persetujuan dan diaudit. Pengiriman tidak diulang otomatis saat hasil jaringan ambigu
  untuk mencegah duplikasi pesan.
- `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_APP_SECRET`, dan
  `META_WEBHOOK_VERIFY_TOKEN` opsional. Tanpa konfigurasi, aplikasi tetap start tetapi jadwal/kirim
  dan verifikasi webhook gagal secara eksplisit.
- UI: fetch ulasan per outlet → komposisi dan preview jumlah → jadwal → statistik/status kirim.

---

## Urutan & perkiraan

| Fase  | Isi                                                       | Dependensi                          | Status                                                     |
| ----- | --------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| **A** | Master data + RBAC 7 peran + scope area                   | —                                   | ✅ selesai 2026-11-28                                      |
| **B** | Leads + Advertising Budgets + Lead/Advertising Summary    | A (areas, references)               | ✅ selesai 2026-11-28                                      |
| **C** | Transaction items + CS + Bonus + QMS + CS Rating          | A (products, types, cs_assignments) | ✅ API + UI operasional; angka bonus/loyalitas provisional |
| **D** | Read-model + 13 laporan                                   | B, C                                | ✅ selesai 2026-11-28                                      |
| **E** | Live Omset SSE                                            | D                                   | ✅ selesai 2026-11-28                                      |
| **F** | Google Reviews on-demand + Meta Dynamic Blast + job infra | A, D | ✅ API/UI, migrasi, tes; validasi provider menunggu kredensial |

Setiap fase diakhiri `npm run check` + verifikasi manual pada server dev yang sudah berjalan
(`http://localhost:3000`), dan README diperbarui (tabel API, daftar peran, roadmap).

## Keputusan terbuka (perlu jawaban Anda saat fasenya tiba)

1. **Fase C:** aturan bonus riil (persentase per jenis transaksi, cap, dan pembulatan) — dokumen
   hanya menyebut `bonus_amount`. Perlu angka bisnisnya.
2. **Fase C:** ambang `Loyal Customer` (`is_loyal`) — frekuensi/nominal berapa dalam periode apa?
   Sekarang `tier_code` dihitung `src/shared/loyalty.js` dari poin.
3. **Fase D:** zona waktu laporan — dokumen menyebut area/kota lintas WIB/WITA/WIT. Kolom
   `branches.timezone` disiapkan di fase A; default `Asia/Jakarta`.

## Keputusan yang sudah diambil

- **Realtime = SSE di atas `node:http`** (bukan WebSocket), agar tidak menambah dependensi runtime
  di luar `pg` dan `redis`. Berlaku untuk Fase E.
- **`APPRAISER` dipertahankan** di luar 6 peran dokumen → 7 peran efektif, karena 4 akun aktif dan
  seluruh alur taksiran/buyback bergantung padanya.
- **`user:manage` tetap pada `HQ_STAFF`**, tidak dipindah ke `SUPER_ADMIN`, agar akun pusat yang
  sudah ada tidak kehilangan menu Users.
- **Tidak ada tabel `roles`** — sumber kebenaran matriks tetap `src/security/rbac.js`, dan menu
  Roles membacanya lewat `GET /api/v1/roles`.
- **Master data dinonaktifkan, bukan dihapus** (`is_active = false`), kecuali penugasan CS yang
  memang periode waktu sehingga diakhiri dengan `DELETE` (jejaknya tetap ada di audit log).
- **Kode/SKU tidak dapat diubah setelah dibuat** karena menjadi rujukan stabil tabel lain.
