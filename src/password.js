// Password hashing with Node's built-in scrypt. Runs on the libuv thread pool, so a burst of
// logins (e.g. everyone signing in as an exam opens) never blocks the event loop.
const crypto = require('crypto');
const N = 16384, R = 8, P = 1, KEYLEN = 32;

const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

async function hash(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw), salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verify(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(String(pw), Buffer.from(saltHex, 'hex'));
  const want = Buffer.from(keyHex, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

// Fixed hash used to equalise timing when the username does not exist.
const DUMMY = `scrypt$${'00'.repeat(16)}$${'00'.repeat(KEYLEN)}`;

module.exports = { hash, verify, DUMMY };
