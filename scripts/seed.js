/**
 * Development seed data: branches, one staff account per role, and sample customers.
 * Every account's password comes from SEED_PASSWORD (never hard-coded).
 * Safe to run repeatedly (idempotent).
 */
import { loadConfig } from '../src/config/index.js';
import { buildContainer } from '../src/container.js';
import { createLogger } from '../src/core/logger.js';
import { hashPassword } from '../src/security/crypto.js';

const password = process.env.SEED_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set SEED_PASSWORD (at least 12 characters) before seeding.');
  process.exit(1);
}

const BRANCHES = [
  { code: 'JKT01', name: 'RajaEmas Jakarta Pusat', region: 'DKI Jakarta' },
  { code: 'BDG01', name: 'RajaEmas Bandung', region: 'Jawa Barat' },
  { code: 'SBY01', name: 'RajaEmas Surabaya', region: 'Jawa Timur' },
];

const USERS = [
  { email: 'pusat@rajaemas.id', name: 'Admin Pusat', role: 'HQ_STAFF', branch: null },
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
    email: 'penaksir.jkt@rajaemas.id',
    name: 'Penaksir Jakarta',
    role: 'APPRAISER',
    branch: 'JKT01',
  },
];

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
  const branchIds = {};
  for (const b of BRANCHES) {
    const { rows } = await db.query(
      `INSERT INTO branches (branch_code, name, region) VALUES ($1, $2, $3)
       ON CONFLICT (branch_code) DO UPDATE SET name = EXCLUDED.name
       RETURNING branch_id`,
      [b.code, b.name, b.region],
    );
    branchIds[b.code] = rows[0].branch_id;
  }

  const passwordHash = await hashPassword(password);
  const userIds = {};
  for (const u of USERS) {
    const { rows } = await db.query(
      `INSERT INTO users (email, full_name, role, branch_id, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING user_id`,
      [u.email, u.name, u.role, u.branch ? branchIds[u.branch] : null, passwordHash],
    );
    userIds[u.role] = rows[0].user_id;
  }

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

  console.log('✔ Seed complete. Accounts:');
  for (const u of USERS) console.log(`   ${u.role.padEnd(17)} ${u.email}`);
} finally {
  await container.dispose();
}
