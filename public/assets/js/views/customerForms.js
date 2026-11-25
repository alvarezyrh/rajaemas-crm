/** Form fields shared by "New Customer" and "Edit profile". */
import { LABELS, options } from '../format.js';

/**
 * Identity (KTP) fields. For an existing customer the encrypted ones (NIK,
 * address) are never sent to the browser, so their inputs start empty and an
 * empty value keeps what is stored.
 */
export function kycFields(customer) {
  const keep = (has, what) =>
    has ? `On file — leave empty to keep the current ${what}` : undefined;
  return [
    {
      name: 'nik',
      label: 'NIK (16 digits, encrypted)',
      placeholder: keep(customer?.hasNik, 'NIK') ?? '3171xxxxxxxxxxxx',
      inputmode: 'numeric',
    },
    { name: 'birthPlace', label: 'Place of birth', value: customer?.birthPlace },
    { name: 'birthDate', label: 'Date of birth', type: 'date', value: customer?.birthDate },
    {
      name: 'gender',
      label: 'Gender',
      type: 'select',
      options: options(LABELS.gender),
      value: customer?.gender ?? '',
    },
    {
      name: 'addressLine',
      label: 'Address (street, RT/RW, kelurahan, kecamatan — encrypted)',
      type: 'textarea',
      max: 300,
      placeholder: keep(customer?.hasAddress, 'address'),
    },
    { name: 'city', label: 'City / regency', value: customer?.city },
    { name: 'province', label: 'Province', value: customer?.province },
    { name: 'postalCode', label: 'Postal code', inputmode: 'numeric', value: customer?.postalCode },
    { name: 'occupation', label: 'Occupation', value: customer?.occupation },
  ];
}

/** Whole years between a YYYY-MM-DD birth date and today. */
export function ageOf(birthDate, today = new Date()) {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1;
  return age;
}
