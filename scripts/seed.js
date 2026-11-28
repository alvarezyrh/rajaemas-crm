/**
 * Development seed data: areas, outlets, one staff account per role, master data
 * (acquisition channels, product catalogue, transaction types, CS assignment) and
 * sample customers. Every account's password comes from SEED_PASSWORD (never
 * hard-coded). Safe to run repeatedly (idempotent).
 */
import { loadConfig } from '../src/config/index.js';
import { buildContainer } from '../src/container.js';
import { createLogger } from '../src/core/logger.js';
import { createBlindIndexer, hashPassword } from '../src/security/crypto.js';

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set SEED_PASSWORD (at least 12 characters) before seeding.');
  process.exit(1);
}

const AREAS = [
  { code: 'JKT', name: 'Jabodetabek', province: 'DKI Jakarta', city: 'Jakarta Pusat' },
  { code: 'BDG', name: 'Jawa Barat', province: 'Jawa Barat', city: 'Bandung' },
  { code: 'SBY', name: 'Jawa Timur', province: 'Jawa Timur', city: 'Surabaya' },
];

const BRANCHES = [
  { code: 'JKT01', name: 'RajaEmas Jakarta Pusat', region: 'DKI Jakarta', area: 'JKT' },
  { code: 'BDG01', name: 'RajaEmas Bandung', region: 'Jawa Barat', area: 'BDG' },
  { code: 'SBY01', name: 'RajaEmas Surabaya', region: 'Jawa Timur', area: 'SBY' },
];

const USERS = [
  { email: 'superadmin@rajaemas.id', name: 'Super Admin', role: 'SUPER_ADMIN', branch: null },
  { email: 'pusat@rajaemas.id', name: 'Admin Pusat', role: 'HQ_STAFF', branch: null },
  {
    email: 'area.jkt@rajaemas.id',
    name: 'Area Manager Jabodetabek',
    role: 'AREA_MANAGER',
    area: 'JKT',
  },
  {
    email: 'cs@rajaemas.id',
    name: 'Tim Layanan Pelanggan',
    role: 'CUSTOMER_SERVICE',
    branch: null,
  },
  {
    email: 'kacab.jkt@rajaemas.id',
    name: 'Kepala Cabang Jakarta',
    role: 'BRANCH_HEAD',
    branch: 'JKT01',
  },
  {
    email: 'marketing@rajaemas.id',
    name: 'Tim Digital Marketing',
    role: 'DIGITAL_MARKETING',
    branch: null,
  },
  {
    email: 'penaksir.jkt@rajaemas.id',
    name: 'Penaksir Jakarta',
    role: 'APPRAISER',
    branch: 'JKT01',
  },
];

/* ---------------------------------------------------------------------- */
/* Master data: acquisition channels, catalogue and transaction types.     */
/* ---------------------------------------------------------------------- */
const REFERENCES = [
  { code: 'WALK_IN', name: 'Datang ke gerai', channelType: 'WALK_IN' },
  { code: 'INSTAGRAM', name: 'Instagram', channelType: 'SOCIAL' },
  { code: 'GOOGLE_ADS', name: 'Google Ads', channelType: 'DIGITAL_ADS' },
  { code: 'RAJAEMAS_APP', name: 'Rajaemas App', channelType: 'APP' },
  { code: 'REFERRAL', name: 'Referral nasabah', channelType: 'REFERRAL' },
  { code: 'MARKETPLACE', name: 'Marketplace', channelType: 'OTHER' },
];

const PRODUCT_CATEGORIES = [
  { code: 'LM', name: 'Logam Mulia (LM REI)' },
  { code: 'PERHIASAN', name: 'Perhiasan Emas' },
  { code: 'BERLIAN', name: 'Berlian' },
  { code: 'DIGITAL', name: 'Emas Digital' },
];

// [sku, name, category, karat, base weight (gram), bullion]
const PRODUCTS = [
  ['LM-REI-1', 'LM REI 1 gram', 'LM', 24, 1, true],
  ['LM-REI-5', 'LM REI 5 gram', 'LM', 24, 5, true],
  ['LM-REI-10', 'LM REI 10 gram', 'LM', 24, 10, true],
  ['LM-REI-25', 'LM REI 25 gram', 'LM', 24, 25, true],
  ['LM-REI-100', 'LM REI 100 gram', 'LM', 24, 100, true],
  ['PRS-CIN-22', 'Cincin emas 22K', 'PERHIASAN', 22, 4.2, false],
  ['PRS-KAL-24', 'Kalung emas 24K', 'PERHIASAN', 24, 10.5, false],
  ['PRS-GLG-18', 'Gelang emas 18K', 'PERHIASAN', 18, 7.8, false],
  ['DIA-SOL-05', 'Berlian solitaire 0.5 ct', 'BERLIAN', null, null, false],
  ['DGT-EMAS-1', 'Emas digital 1 gram', 'DIGITAL', 24, 1, false],
];

// [code, name, side, bullion, requires appraisal]
const TRANSACTION_TYPES = [
  ['BUY_JEWELRY', 'Pembelian perhiasan di gerai', 'BUY', false, false],
  ['BUY_BULLION', 'Pembelian logam mulia LM REI', 'BUY', true, false],
  ['BUY_DIGITAL', 'Pembelian emas digital', 'BUY', false, false],
  ['SELL_BUYBACK', 'Buyback perhiasan (butuh taksiran)', 'SELL', false, true],
  ['SELL_BULLION', 'Buyback logam mulia LM REI', 'SELL', true, true],
];

/* ---------------------------------------------------------------------- */
/* Acquisition samples: leads across the funnel + monthly ad budgets.      */
/* Phones use a distinct prefix so they never collide with seeded customers.*/
/* ---------------------------------------------------------------------- */
// [nama, telepon, kode kanal, kode outlet, status akhir, catatan]
const LEAD_DEMO = [
  ['Agus Salim', '+6281199900001', 'INSTAGRAM', 'JKT01', 'NEW', 'Tanya harga LM 5 gram lewat DM'],
  [
    'Belinda Kusuma',
    '+6281199900002',
    'GOOGLE_ADS',
    'JKT01',
    'CONTACTED',
    'Sudah dihubungi, minta katalog',
  ],
  [
    'Candra Wijaya',
    '+6281199900003',
    'WALK_IN',
    'JKT01',
    'QUALIFIED',
    'Datang ke gerai, rencana buyback 20 g',
  ],
  [
    'Dina Puspita',
    '+6281199900004',
    'RAJAEMAS_APP',
    'BDG01',
    'CONVERTED',
    'Upgrade dari pengguna aplikasi',
  ],
  [
    'Eko Prasetyo',
    '+6281199900005',
    'REFERRAL',
    'BDG01',
    'LOST',
    'Tidak menanggapi setelah 3 kali kontak',
  ],
  [
    'Fitri Handayani',
    '+6281199900006',
    'MARKETPLACE',
    'SBY01',
    'NEW',
    'Tanya cicilan emas 10 gram',
  ],
  ['Gilang Ramadhan', '+6281199900007', 'INSTAGRAM', 'SBY01', 'CONTACTED', 'Minta jadwal taksiran'],
  [
    'Hana Safitri',
    '+6281199900008',
    'GOOGLE_ADS',
    'JKT01',
    'CONVERTED',
    'Konversi dari iklan pencarian',
  ],
];

// [kode area, kode kanal, bulan ke-n dari sekarang (0 = bulan ini), nominal]
const BUDGET_DEMO = [
  ['JKT', 'INSTAGRAM', 0, 12_500_000],
  ['JKT', 'GOOGLE_ADS', 0, 20_000_000],
  ['JKT', 'INSTAGRAM', 1, 11_000_000],
  ['JKT', 'GOOGLE_ADS', 1, 18_500_000],
  ['BDG', 'INSTAGRAM', 0, 7_500_000],
  ['BDG', 'MARKETPLACE', 0, 4_000_000],
  ['SBY', 'GOOGLE_ADS', 0, 9_000_000],
  ['SBY', 'REFERRAL', 1, 2_500_000],
];

const firstOfMonth = (monthsAgo) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsAgo, 1))
    .toISOString()
    .slice(0, 10);
};

/** Walks a lead through the funnel with the real service, so statuses stay valid. */
async function seedLeads({ db, services, actor, branchIds, blindIndex }) {
  const { rows } = await db.query('SELECT reference_id, code FROM acquisition_references');
  const referenceIds = Object.fromEntries(rows.map((r) => [r.code, r.reference_id]));
  let created = 0;

  for (const [fullName, phone, refCode, branchCode, status, notes] of LEAD_DEMO) {
    // The unique index only guards leads still in the funnel, so a LOST or
    // CONVERTED sample would be re-created on every run: check any status here.
    const { rows: known } = await db.query('SELECT 1 FROM leads WHERE phone_hash = $1', [
      blindIndex('phone', phone),
    ]);
    if (known.length > 0) continue;

    let lead;
    try {
      lead = await services.leads.create(actor, {
        fullName,
        phone,
        referenceId: referenceIds[refCode],
        branchId: branchIds[branchCode],
        notes,
      });
      created += 1;
    } catch (err) {
      if (err.status === 409) continue; // the number already belongs to a customer
      throw err;
    }

    if (status === 'NEW') continue;
    if (status === 'LOST') {
      await services.leads.update(actor, lead.id, {
        status: 'LOST',
        lostReason: 'Tidak menanggapi',
      });
      continue;
    }
    await services.leads.update(actor, lead.id, { status: 'CONTACTED' });
    if (status === 'CONTACTED') continue;
    await services.leads.update(actor, lead.id, { status: 'QUALIFIED' });
    if (status === 'QUALIFIED') continue;
    await services.leads.convert(actor, lead.id);
  }
  if (created > 0) console.log(`✔ Leads: ${created} prospek contoh di seluruh funnel`);
}

async function seedBudgets({ db, services, actor, areaIds }) {
  const { rows } = await db.query('SELECT reference_id, code FROM acquisition_references');
  const referenceIds = Object.fromEntries(rows.map((r) => [r.code, r.reference_id]));
  let created = 0;

  for (const [areaCode, refCode, monthsAgo, amount] of BUDGET_DEMO) {
    try {
      await services.advertising.create(actor, {
        areaId: areaIds[areaCode],
        referenceId: referenceIds[refCode],
        periodMonth: firstOfMonth(monthsAgo),
        spendAmount: amount,
        notes: 'Seed pengembangan',
      });
      created += 1;
    } catch (err) {
      if (err.status === 409) continue; // period already budgeted
      throw err;
    }
  }
  if (created > 0) console.log(`✔ Advertising budgets: ${created} alokasi area × kanal × bulan`);
}

/** Idempotent master data: areas, references, catalogue, transaction types, CS assignment. */
async function seedMasterData({ db, branchIds, userIds }) {
  for (const r of REFERENCES) {
    await db.query(
      `INSERT INTO acquisition_references (code, name, channel_type) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, channel_type = EXCLUDED.channel_type`,
      [r.code, r.name, r.channelType],
    );
  }

  const categoryIds = {};
  for (const c of PRODUCT_CATEGORIES) {
    const { rows } = await db.query(
      `INSERT INTO product_categories (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING category_id`,
      [c.code, c.name],
    );
    categoryIds[c.code] = rows[0].category_id;
  }

  for (const [sku, name, category, karat, weight, bullion] of PRODUCTS) {
    await db.query(
      `INSERT INTO products (sku, name, category_id, karat, base_weight_gram, is_bullion)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sku) DO UPDATE
         SET name = EXCLUDED.name, category_id = EXCLUDED.category_id, karat = EXCLUDED.karat,
             base_weight_gram = EXCLUDED.base_weight_gram, is_bullion = EXCLUDED.is_bullion`,
      [sku, name, categoryIds[category], karat, weight, bullion],
    );
  }

  for (const [code, name, side, bullion, needsAppraisal] of TRANSACTION_TYPES) {
    await db.query(
      `INSERT INTO transaction_types (code, name, side, is_bullion, requires_appraisal)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, side = EXCLUDED.side,
             is_bullion = EXCLUDED.is_bullion, requires_appraisal = EXCLUDED.requires_appraisal`,
      [code, name, side, bullion, needsAppraisal],
    );
  }

  // The CS account serves the Jakarta outlet; used later by CS Rating & Bonus Summary.
  if (userIds.CUSTOMER_SERVICE && branchIds.JKT01) {
    await db.query(
      `INSERT INTO cs_assignments (user_id, branch_id, is_primary, valid_from)
       VALUES ($1, $2, true, current_date)
       ON CONFLICT (user_id, branch_id, valid_from) DO UPDATE SET is_primary = true`,
      [userIds.CUSTOMER_SERVICE, branchIds.JKT01],
    );
  }

  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM acquisition_references) AS refs,
            (SELECT count(*) FROM products) AS products,
            (SELECT count(*) FROM transaction_types) AS types,
            (SELECT count(*) FROM areas) AS areas`,
  );
  console.log(
    `✔ Master data: ${rows[0].areas} areas, ${rows[0].refs} references, ` +
      `${rows[0].products} products, ${rows[0].types} transaction types`,
  );
}

const DEMO_CUSTOMERS = [
  {
    fullName: 'Siti Rahmawati',
    phone: '+6281234567801',
    preferredChannel: 'WHATSAPP',
    marketingConsent: true,
  },
  {
    fullName: 'Budi Santoso',
    phone: '+6281234567802',
    preferredChannel: 'PHONE',
    marketingConsent: false,
  },
  {
    fullName: 'Dewi Lestari',
    phone: '+6281234567803',
    preferredChannel: 'WHATSAPP',
    marketingConsent: true,
  },
];

/* ---------------------------------------------------------------------- */
/* Cluster samples: mobile-app and e-commerce events go through the same   */
/* ingestion path as the webhook, plus a few in-store transactions.       */
/* ---------------------------------------------------------------------- */
const GRAM_PRICE = 1_950_000;
const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600_000);

const COMMERCE_DEMO = [
  // [name, phone, channel, account, [ [side, grams, days ago], ... ] ]
  ['Siti Rahmawati', '+6281234567801', 'MOBILE_APP', 'app-1001', [['BUY', 1, 12]]],
  ['Dewi Lestari', '+6281234567803', 'ECOMMERCE', 'web-5001', [['BUY', 5, 40]]],
  [
    'Rina Wulandari',
    '+6281234567804',
    'MOBILE_APP',
    'app-1002',
    [
      ['BUY', 2, 3],
      ['BUY', 0.5, 1],
    ],
  ],
  [
    'Andi Pratama',
    '+6281234567805',
    'MOBILE_APP',
    'app-1003',
    [
      ['BUY', 10, 60],
      ['SELL', 4, 5],
    ],
  ],
  ['Lina Marlina', '+6281234567806', 'MOBILE_APP', 'app-1004', []],
  ['Maya Sari', '+6281234567807', 'ECOMMERCE', 'web-5002', [['BUY', 25, 9]]],
  ['Fajar Nugroho', '+6281234567808', 'ECOMMERCE', 'web-5003', [['BUY', 3, 75]]],
  ['Fajar Nugroho', '+6281234567808', 'MOBILE_APP', 'app-1005', [['BUY', 1, 2]]],
  ['Hendra Wijaya', '+6281234567809', 'MOBILE_APP', 'app-1006', [['SELL', 2, 20]]],
  ['Hendra Wijaya', '+6281234567809', 'ECOMMERCE', 'web-5004', [['BUY', 50, 15]]],
];

const STORE_DEMO = [
  // [telepon, sisi, gram, keterangan]
  ['+6281234567801', 'BUY', 5, '5 g gold bar'],
  ['+6281234567802', 'BUY', 10, '10 g gold bar'],
  ['+6281234567809', 'BUY', 25, '25 g gold bar'],
];

async function seedSegments({ db, services, hqId, branchIds }) {
  const { rows } = await db.query(
    "SELECT count(*)::int AS total FROM customer_channels WHERE channel <> 'STORE'",
  );
  if (rows[0].total > 0) return;

  let n = 0;
  for (const [fullName, phone, source, accountId, orders] of COMMERCE_DEMO) {
    n += 1;
    await services.segments.ingestCommerceEvent({
      eventId: `seed-acc-${n}`,
      type: 'account.registered',
      source,
      accountId,
      phone,
      fullName,
      occurredAt: daysAgo(90),
    });
    for (const [index, [side, grams, ago]] of orders.entries()) {
      await services.segments.ingestCommerceEvent({
        eventId: `seed-ord-${n}-${index}`,
        type: 'order.completed',
        source,
        accountId,
        orderId: `SEED-${accountId}-${index}`,
        side,
        weightGram: grams,
        amount: grams * GRAM_PRICE,
        description: side === 'BUY' ? 'Digital gold' : 'Digital gold sale',
        occurredAt: daysAgo(ago),
      });
    }
  }

  const hq = { id: hqId, role: 'HQ_STAFF', branchId: null, requestId: 'seed', ip: 'local' };
  for (const [phone, side, grams, description] of STORE_DEMO) {
    const { items } = await services.customers.search(hq, { phone, page: 1, pageSize: 1 });
    if (!items[0]) continue;
    await services.segments.recordStoreTransaction(hq, items[0].id, {
      side,
      branchId: branchIds.JKT01,
      description,
      weightGram: grams,
      amount: grams * GRAM_PRICE,
    });
  }
  console.log('✔ Cluster samples: mobile app, e-commerce and in-store transactions');
}

const config = loadConfig();
const container = await buildContainer(config, createLogger({ level: 'warn' }));
const { db, services } = container;

try {
  const areaIds = {};
  for (const a of AREAS) {
    const { rows } = await db.query(
      `INSERT INTO areas (area_code, name, province, city) VALUES ($1, $2, $3, $4)
       ON CONFLICT (area_code) DO UPDATE
         SET name = EXCLUDED.name, province = EXCLUDED.province, city = EXCLUDED.city
       RETURNING area_id`,
      [a.code, a.name, a.province, a.city],
    );
    areaIds[a.code] = rows[0].area_id;
  }

  const branchIds = {};
  for (const b of BRANCHES) {
    const { rows } = await db.query(
      `INSERT INTO branches (branch_code, name, region, area_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (branch_code) DO UPDATE SET name = EXCLUDED.name, area_id = EXCLUDED.area_id
       RETURNING branch_id`,
      [b.code, b.name, b.region, b.area ? areaIds[b.area] : null],
    );
    branchIds[b.code] = rows[0].branch_id;
  }

  const passwordHash = await hashPassword(password);
  const userIds = {};
  for (const u of USERS) {
    const { rows } = await db.query(
      `INSERT INTO users (email, full_name, role, branch_id, area_id, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING user_id`,
      [
        u.email,
        u.name,
        u.role,
        u.branch ? branchIds[u.branch] : null,
        u.area ? areaIds[u.area] : null,
        passwordHash,
      ],
    );
    userIds[u.role] = rows[0].user_id;
  }

  await seedMasterData({ db, branchIds, userIds });

  const { rows: existing } = await db.query('SELECT count(*)::int AS total FROM customers');
  if (existing[0].total === 0) {
    const hq = {
      id: userIds.HQ_STAFF,
      role: 'HQ_STAFF',
      branchId: null,
      requestId: 'seed',
      ip: 'local',
    };
    const appraiser = {
      id: userIds.APPRAISER,
      role: 'APPRAISER',
      branchId: branchIds.JKT01,
      requestId: 'seed',
      ip: 'local',
    };

    for (const [index, data] of DEMO_CUSTOMERS.entries()) {
      const customer = await services.customers.register(hq, {
        ...data,
        homeBranchId: branchIds.JKT01,
      });
      const tomorrow = new Date(Date.now() + 24 * 3600_000);
      tomorrow.setUTCHours(2 + index, 0, 0, 0); // 09:00, 10:00, 11:00 WIB
      await services.appointments.create(hq, {
        customerId: customer.id,
        branchId: branchIds.JKT01,
        serviceType: index === 1 ? 'BUYBACK' : 'APPRAISAL',
        scheduledAt: tomorrow,
      });
      await services.appraisals.record(appraiser, {
        customerId: customer.id,
        itemDescription: ['Kalung emas 24K', 'Cincin emas 22K', 'Gelang emas 18K'][index],
        weightGram: [10.5, 4.2, 7.8][index],
        purityKarat: [24, 22, 18][index],
        offeredPrice: [14_500_000, 5_300_000, 7_400_000][index],
      });
    }
    console.log(`✔ ${DEMO_CUSTOMERS.length} sample customers with appointments & appraisals`);
  }

  await seedSegments({ db, services, hqId: userIds.HQ_STAFF, branchIds });

  const hqActor = {
    id: userIds.HQ_STAFF,
    role: 'HQ_STAFF',
    branchId: null,
    areaId: null,
    requestId: 'seed',
    ip: 'local',
  };
  await seedLeads({
    db,
    services,
    actor: hqActor,
    branchIds,
    blindIndex: createBlindIndexer(config.security.blindIndexKey),
  });
  await seedBudgets({ db, services, actor: hqActor, areaIds });

  console.log('✔ Seed complete. Accounts:');
  for (const u of USERS) console.log(`   ${u.role.padEnd(17)} ${u.email}`);
} finally {
  await container.dispose();
}
