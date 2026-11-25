/** Prints strong random keys to copy into .env. */
import { randomBytes } from 'node:crypto';

const key = () => randomBytes(32).toString('base64');

console.log(`PII_ENCRYPTION_KEY=${key()}`);
console.log(`BLIND_INDEX_KEY=${key()}`);
console.log(`TOKEN_SECRET=${key()}`);
console.log(`WEBHOOK_SECRET=${randomBytes(32).toString('hex')}`);
