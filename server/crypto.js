// Encryption for the Noctyl server.
//
// Every account has its own random data key. Everything stored for that account (settings, chats, images, API keys) is
// encrypted with it (AES-256-GCM). The data key itself is only kept "wrapped": encrypted with a key derived from the
// account's password (scrypt), and a second copy with a key derived from its recovery code. So the server's disk holds
// nothing readable, a wrong password can't unwrap anything, and nobody — the server admin included — can read an
// account without its password or recovery code. While you're signed in, your data key lives only in the server's memory.
'use strict';
const crypto = require('node:crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

function deriveKey(secret, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(secret).normalize('NFKC'), salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
}

/** AES-256-GCM: buffer → [12-byte iv][16-byte tag][ciphertext] */
function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
/** the reverse of seal; throws if the key is wrong or the data was changed */
function open(key, box) {
  if (!Buffer.isBuffer(box) || box.length < 28) throw new Error('Damaged data');
  const d = crypto.createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
  d.setAuthTag(box.subarray(12, 28));
  return Buffer.concat([d.update(box.subarray(28)), d.final()]);
}

/** Wrap a data key with a secret (password or recovery code): { salt, box } as base64 */
async function wrap(dataKey, secret) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64'), box: seal(await deriveKey(secret, salt), dataKey).toString('base64') };
}
/** Unwrap → the data key, or null when the secret is wrong */
async function unwrap(wrapped, secret) {
  try { return open(await deriveKey(secret, Buffer.from(wrapped.salt, 'base64')), Buffer.from(wrapped.box, 'base64')); }
  catch { return null; }
}

/** A recovery code: 25 random characters in 5 groups (≈ 125 bits), easy to read and type: ABCDE-FGHJK-… */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1
function recoveryCode() {
  const bytes = crypto.randomBytes(25);
  const chars = [...bytes].map(b => ALPHABET[b % 32]);
  return [0, 5, 10, 15, 20].map(i => chars.slice(i, i + 5).join('')).join('-');
}
const normaliseCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

module.exports = { deriveKey, seal, open, wrap, unwrap, recoveryCode, normaliseCode, token, hash, sameText };
