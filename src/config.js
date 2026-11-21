const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// JWT secret: from env, else generated once and persisted so sessions survive restarts.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') console.warn('[config] JWT_SECRET is not set: sign-ins will be lost whenever the server restarts. Set it in the hosting environment.');
  const f = path.join(DATA_DIR, '.jwt_secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) {}
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PROD: process.env.NODE_ENV === 'production',
  DATA_DIR,
  JWT_SECRET: loadSecret(),
  SESSION_HOURS: parseInt(process.env.SESSION_HOURS || '12', 10),
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
  TRUST_PROXY: process.env.TRUST_PROXY || '',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'jayarama_exam',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || '',
  SMTP: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: (process.env.SMTP_SECURE || 'true') === 'true',
    user: process.env.SMTP_USER || '',
    pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    from: process.env.MAIL_FROM || '',
  },
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),   // e.g. https://exams.example.com (used in e-mailed links)
  PORTAL_NAME: process.env.PORTAL_NAME || 'Jayarama Exam Portal',
  VIOLATION_LIMIT: 2, // 1st = warning, 2nd = auto-submit
};
