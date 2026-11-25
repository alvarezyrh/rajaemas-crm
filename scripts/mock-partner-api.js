/**
 * Mock partner API for trying the "API" menu locally (development only).
 *
 *   node scripts/mock-partner-api.js          → http://127.0.0.1:4010
 *
 * GET /api/members?page=1&pageSize=100   (header  X-API-Key: demo-key-123)
 * → { "data": { "members": [ { "id", "name", "contact": { "phone", "email" },
 *        "ktp": { "nik", "birthPlace", "birthDate", "sex", "address", "city", "province", "zip", "job" } } ] },
 *     "total": 230 }
 *
 * Matching source settings in the CRM:
 *   Endpoint URL   http://127.0.0.1:4010/api/members
 *   Auth header    X-API-Key   ·   Token  demo-key-123
 *   List path      data.members
 *   Fields         name → name · phone → contact.phone · email → contact.email · account id → id
 *   Identity       NIK → ktp.nik · place of birth → ktp.birthPlace · date of birth → ktp.birthDate
 *                  gender → ktp.sex · address → ktp.address · city → ktp.city · province → ktp.province
 *                  postal code → ktp.zip · occupation → ktp.job
 *   Pagination     page (pageSize 100)
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const API_KEY = 'demo-key-123';
const FIRST = [
  'Ayu',
  'Bayu',
  'Citra',
  'Dimas',
  'Eka',
  'Fitri',
  'Gilang',
  'Hana',
  'Indra',
  'Joko',
  'Kirana',
  'Lukman',
];
const LAST = ['Saputra', 'Wijaya', 'Lestari', 'Nugraha', 'Pratiwi', 'Hidayat', 'Kusuma', 'Siregar'];

const CITIES = [
  ['Jakarta Selatan', 'DKI Jakarta', '12', '31', '74'],
  ['Bandung', 'Jawa Barat', '40', '32', '73'],
  ['Surabaya', 'Jawa Timur', '60', '35', '78'],
  ['Medan', 'Sumatera Utara', '20', '12', '71'],
  ['Makassar', 'Sulawesi Selatan', '90', '73', '71'],
];
const JOBS = ['Karyawan swasta', 'Wiraswasta', 'PNS', 'Ibu rumah tangga', 'Pedagang'];

const members = Array.from({ length: 230 }, (_, i) => {
  const [city, province, zip, prov, reg] = CITIES[i % CITIES.length];
  const female = i % 2 === 1;
  const day = (i % 28) + 1;
  const month = (i % 12) + 1;
  const year = 1965 + (i % 40);
  // NIK: province + regency + district + DDMMYY (day + 40 for women) + sequence
  const dd = String(female ? day + 40 : day).padStart(2, '0');
  const nik = `${prov}${reg}01${dd}${String(month).padStart(2, '0')}${String(year).slice(2)}${String(i + 1).padStart(4, '0')}`;
  return {
    id: `MBR-${String(i + 1).padStart(5, '0')}`,
    name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    contact: {
      phone: `0813${String(70000000 + i).padStart(8, '0')}`,
      email: i % 3 === 0 ? `member${i + 1}@example.com` : null,
    },
    ktp: {
      nik,
      birthPlace: city,
      birthDate: `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`,
      sex: female ? 'PEREMPUAN' : 'LAKI-LAKI',
      address: `Jl. Merdeka No. ${i + 1} RT 00${(i % 9) + 1}/RW 00${(i % 5) + 1}`,
      city,
      province,
      zip: `${zip}${String(100 + (i % 800)).padStart(3, '0')}`,
      job: JOBS[i % JOBS.length],
    },
  };
});
// a few realistic problems: an existing CRM customer, a bad phone, no phone at all
members[5].contact.phone = '+6281234567801';
members[11].contact.phone = '12345';
members[17].contact.phone = null;
// …and identity data with problems: a malformed NIK and an impossible birth date
members[3].ktp.nik = '12345';
members[4].ktp.birthDate = '31-02-1990';

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname !== '/api/members') return send(404, { error: 'not found' });
    if (req.headers['x-api-key'] !== API_KEY) return send(401, { error: 'invalid api key' });

    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const size = Math.min(500, Math.max(1, Number(url.searchParams.get('pageSize') ?? 100)));
    send(200, {
      data: { members: members.slice((page - 1) * size, page * size) },
      total: members.length,
    });
  })
  .listen(PORT, '127.0.0.1', () =>
    console.log(`Mock partner API on http://127.0.0.1:${PORT}/api/members (X-API-Key: ${API_KEY})`),
  );
