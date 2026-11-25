/** Escapes LIKE wildcards so user input is matched literally. */
export const escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

/** Default business time zone (WIB). */
export const BUSINESS_TZ = 'Asia/Jakarta';

/** Converts numeric/bigint columns (strings from the pg driver) to Number. */
export const toNumber = (value) => (value === null || value === undefined ? null : Number(value));
