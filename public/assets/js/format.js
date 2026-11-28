import { h, icon } from './dom.js';
import { locale } from './i18n.js';

// Indonesian number grouping in both languages (Rp 7.400.000); words follow the
// language: "Rp 60M" in English, "Rp 60 jt" in Indonesian.
const TZ = 'Asia/Jakarta';
const FORMATS = {
  rupiah: ['Number', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }],
  rupiahCompact: [
    'Number',
    { style: 'currency', currency: 'IDR', notation: 'compact', maximumFractionDigits: 1 },
  ],
  number: ['Number', {}],
  dateTime: ['DateTime', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }],
  date: ['DateTime', { dateStyle: 'medium', timeZone: TZ }],
  time: ['DateTime', { timeStyle: 'short', timeZone: TZ }],
};
const cache = new Map();
/** Intl formatters are costly to build: one per (format, language), reused. */
function formatter(name) {
  const key = `${name}:${locale()}`;
  if (!cache.has(key)) {
    const [kind, options] = FORMATS[name];
    cache.set(key, new Intl[`${kind}Format`](locale(), options));
  }
  return cache.get(key);
}

export const rupiah = (n) => (n === null || n === undefined ? '—' : formatter('rupiah').format(n));
/** For tight spaces (KPIs): Rp 60M / Rp 60 jt. */
export const rupiahCompact = (n) => formatter('rupiahCompact').format(n ?? 0);
export const number = (n) => formatter('number').format(n ?? 0);
export const dateTime = (iso) => formatter('dateTime').format(new Date(iso));
export const date = (iso) => formatter('date').format(new Date(iso));
export const time = (iso) => formatter('time').format(new Date(iso));

/** Today's date in Jakarta time as YYYY-MM-DD. */
export const todayJakarta = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

/* Status labels & tones — single source of truth for every view */
export const LABELS = {
  appointment: {
    SCHEDULED: ['Scheduled', 'info'],
    CONFIRMED: ['Confirmed', 'brand'],
    CHECKED_IN: ['Checked in', 'warning'],
    COMPLETED: ['Completed', 'success'],
    CANCELLED: ['Cancelled', 'neutral'],
    NO_SHOW: ['No-show', 'danger'],
  },
  appraisal: {
    OFFERED: ['Offered', 'info'],
    ACCEPTED: ['Accepted by customer', 'warning'],
    REJECTED: ['Rejected', 'neutral'],
    SETTLED: ['Buyback settled', 'success'],
  },
  tier: {
    REGULER: ['Regular', 'neutral'],
    SILVER: ['Silver', 'info'],
    GOLD: ['Gold', 'gold'],
    PLATINUM: ['Platinum', 'brand'],
  },
  service: { APPRAISAL: 'Appraisal', BUYBACK: 'Buyback', CONSULTATION: 'Consultation' },
  lead: {
    NEW: ['New', 'info'],
    CONTACTED: ['Contacted', 'warning'],
    QUALIFIED: ['Qualified', 'brand'],
    CONVERTED: ['Converted', 'success'],
    LOST: ['Lost', 'neutral'],
    EXPIRED: ['Expired', 'danger'],
  },
  channel: { WHATSAPP: 'WhatsApp', PHONE: 'Phone', EMAIL: 'Email', VISIT: 'In-person visit' },
  kind: {
    INTERACTION: 'Interaction',
    APPOINTMENT: 'Appointment',
    APPRAISAL: 'Appraisal',
    TRANSACTION: 'Transaction',
  },
  side: { BUY: 'Buy', SELL: 'Sell' },
  gender: { M: 'Male', F: 'Female' },
  role: {
    SUPER_ADMIN: 'Super Admin',
    HQ_STAFF: 'Head Office',
    AREA_MANAGER: 'Area Manager',
    BRANCH_HEAD: 'Branch Head',
    CUSTOMER_SERVICE: 'Customer Service',
    DIGITAL_MARKETING: 'Digital Marketing',
    APPRAISER: 'Appraiser',
  },
};

/**
 * Customer clusters. Fixed order (colour follows the entity, never its rank):
 * STORE → MOBILE_APP → ECOMMERCE. Colours live in CSS (--seg-*).
 */
export const SEGMENT_ORDER = ['STORE', 'MOBILE_APP', 'ECOMMERCE'];
export const SEGMENTS = {
  STORE: {
    label: 'In-store',
    long: 'Buys & sells at a store',
    icon: 'store',
    key: 'store',
    hint: 'Bought or sold gold at a branch, including buybacks.',
  },
  MOBILE_APP: {
    label: 'Mobile app',
    long: 'Mobile app user',
    icon: 'app',
    key: 'app',
    hint: 'Has a linked RajaEmas mobile app account.',
  },
  ECOMMERCE: {
    label: 'E-commerce',
    long: 'Buys on the website',
    icon: 'web',
    key: 'web',
    hint: 'Bought gold on the e-commerce website.',
  },
};

/** Cluster chips — colour + icon + name, so identity never relies on colour alone. */
export function segmentChips(channels = [], { compact = false } = {}) {
  if (channels.length === 0) return h('span', { class: 'muted' }, '—');
  return h(
    'span',
    { class: 'seg-chips' },
    SEGMENT_ORDER.filter((c) => channels.includes(c)).map((c) =>
      h(
        'span',
        {
          class: `seg-chip seg-chip--${SEGMENTS[c].key}${compact ? ' seg-chip--icon' : ''}`,
          title: SEGMENTS[c].long,
        },
        icon(SEGMENTS[c].icon),
        compact ? h('span', { class: 'sr-only' }, SEGMENTS[c].label) : SEGMENTS[c].label,
      ),
    ),
  );
}

export function badge(group, value) {
  const [label, tone] = LABELS[group]?.[value] ?? [value, 'neutral'];
  return h('span', { class: `badge badge--${tone}` }, label);
}

export const options = (map) =>
  Object.entries(map).map(([value, label]) => ({
    value,
    label: Array.isArray(label) ? label[0] : label,
  }));
