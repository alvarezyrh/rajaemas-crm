/**
 * Normalises an Indonesian mobile number to E.164 (+62...).
 * Accepts: 0812..., 62812..., +62 812-..., 812...
 * @returns {string | undefined} undefined when invalid.
 */
export function normalizeIndonesianPhone(input) {
  let digits = String(input).replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return undefined;

  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) digits = `62${digits}`;

  return /^628\d{7,12}$/.test(digits) ? `+${digits}` : undefined;
}

export const maskPhone = (last4) => `+62 ••• •••• ${last4}`;
