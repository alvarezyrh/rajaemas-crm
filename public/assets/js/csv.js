/**
 * Minimal RFC 4180 CSV parser for customer imports (runs in the browser).
 * Handles quoted fields, escaped quotes, CRLF/LF, a UTF-8 BOM, and both comma
 * and semicolon separators (Excel in Indonesian locales saves with ";").
 */
export function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.slice(0, source.search(/\r?\n|$/));
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Header spellings we accept → API field names. */
const HEADER_ALIASES = {
  fullName: ['full_name', 'fullname', 'name', 'nama', 'nama_lengkap', 'customer_name'],
  phone: ['phone', 'phone_number', 'mobile', 'telepon', 'no_hp', 'nomor_telepon', 'whatsapp'],
  email: ['email', 'e_mail', 'email_address'],
  nik: ['nik', 'national_id', 'ktp'],
  preferredChannel: ['preferred_channel', 'contact_via', 'channel', 'kanal'],
  marketingConsent: ['marketing_consent', 'consent', 'promo_consent'],
  homeBranchCode: ['home_branch_code', 'branch_code', 'branch', 'cabang', 'home_branch'],
  birthPlace: ['birth_place', 'place_of_birth', 'tempat_lahir'],
  birthDate: ['birth_date', 'date_of_birth', 'dob', 'tanggal_lahir', 'tgl_lahir'],
  gender: ['gender', 'sex', 'jenis_kelamin'],
  addressLine: ['address', 'address_line', 'street', 'alamat'],
  city: ['city', 'regency', 'kota', 'kabupaten', 'kota_kabupaten'],
  province: ['province', 'provinsi'],
  postalCode: ['postal_code', 'zip', 'zip_code', 'kode_pos'],
  occupation: ['occupation', 'job', 'pekerjaan'],
};

const normalizeHeader = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/'/g, '');

/**
 * @returns {{ rows: object[], mapped: Record<string,string>, ignored: string[], missing: string[] }}
 * rows carry the 1-based spreadsheet row number so errors point at the right line.
 */
export function toCustomerRows(table) {
  const [header = [], ...body] = table;
  const index = {};
  const mapped = {};
  const ignored = [];
  header.forEach((raw, col) => {
    const key = Object.keys(HEADER_ALIASES).find((k) =>
      HEADER_ALIASES[k].includes(normalizeHeader(raw)),
    );
    if (key && index[key] === undefined) {
      index[key] = col;
      mapped[key] = raw.trim();
    } else if (raw.trim()) ignored.push(raw.trim());
  });
  const missing = ['fullName', 'phone'].filter((k) => index[k] === undefined);

  const rows = body.map((cells, i) => {
    const row = { row: i + 2 };
    for (const [key, col] of Object.entries(index)) {
      // undo the formula guard our own export adds ('=…, '+…)
      const value = (cells[col] ?? '').trim().replace(/^'(?=[=+\-@])/, '');
      if (value) row[key] = value;
    }
    return row;
  });
  return { rows, mapped, ignored, missing };
}

export const TEMPLATE_CSV =
  'full_name,phone,email,nik,preferred_channel,marketing_consent,home_branch_code,' +
  'birth_place,birth_date,gender,address,city,province,postal_code,occupation\r\n' +
  'Siti Rahmawati,0812-3456-7801,siti@example.com,3171014101900001,WHATSAPP,yes,JKT01,' +
  'Jakarta,1990-01-01,F,"Jl. Melati No. 5 RT 003/RW 004, Kebon Kacang, Tanah Abang",' +
  'Jakarta Pusat,DKI Jakarta,10240,Karyawan swasta\r\n';
