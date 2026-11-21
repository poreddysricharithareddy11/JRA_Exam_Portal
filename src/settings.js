// Admin-editable settings stored in the database (currently: the e-mail account used to send mail).
// Secrets are encrypted at rest (AES-256-GCM, key derived from the server's JWT secret).
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const KEY = crypto.createHash('sha256').update('settings:' + cfg.JWT_SECRET).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  try {
    const raw = Buffer.from(String(blob).slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_) { return ''; }
}

const getRaw = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setRaw = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const delRaw = (k) => db.prepare('DELETE FROM settings WHERE key=?').run(k);

/** The e-mail account in effect: the admin's saved settings, else the .env values. */
function smtp() {
  const saved = getRaw('smtp_user') && getRaw('smtp_pass');
  if (saved) {
    return {
      source: 'portal', host: getRaw('smtp_host') || 'smtp.gmail.com', port: parseInt(getRaw('smtp_port') || '465', 10),
      secure: (getRaw('smtp_secure') || 'true') === 'true', user: getRaw('smtp_user'), pass: decrypt(getRaw('smtp_pass')), from: getRaw('smtp_from') || '',
    };
  }
  return { source: cfg.SMTP.user && cfg.SMTP.pass ? 'env' : 'none', ...cfg.SMTP };
}

function saveSmtp({ host, port, secure, user, pass, from }) {
  setRaw('smtp_host', host); setRaw('smtp_port', port); setRaw('smtp_secure', secure ? 'true' : 'false'); setRaw('smtp_user', user); setRaw('smtp_from', from || '');
  if (pass) setRaw('smtp_pass', encrypt(pass));
}
function clearSmtp() { ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from'].forEach(delRaw); }

module.exports = { smtp, saveSmtp, clearSmtp };
