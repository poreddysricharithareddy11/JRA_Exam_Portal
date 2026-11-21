const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const cfg = require('./config');
const db = require('./db');
const svc = require('./service');
const mailer = require('./mailer');

const app = express();
if (cfg.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(cfg.TRUST_PROXY) ? Number(cfg.TRUST_PROXY) : cfg.TRUST_PROXY);
app.disable('x-powered-by');
// Only force-upgrade to HTTPS / send HSTS when the site really is served over HTTPS (COOKIE_SECURE=true);
// otherwise a plain-HTTP deployment (LAN, IP address) would load a blank page.
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: cfg.COOKIE_SECURE ? [] : null } },
  strictTransportSecurity: cfg.COOKIE_SECURE,
  crossOriginOpenerPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());

app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/user', require('./routes/user'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve index.html with a version stamp on every script/style URL (changes whenever a file changes),
// so a browser can never keep running an outdated copy of the app.
const PUB = path.join(__dirname, '..', 'public');
function indexHtml() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const v = Math.max(...walk(PUB).map((f) => fs.statSync(f).mtimeMs)).toString(36);
  return fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/(src|href)="(\/(?:js|css)\/[^"]+)"/g, (_, k, u) => `${k}="${u}?v=${v}"`);
}
const branding = require('./branding');
app.get('/brand/logo', (req, res) => { const f = branding.logoFile(); res.set('Cache-Control', 'no-cache'); res.type(branding.mime(f)); res.sendFile(f); });
const sendIndex = (req, res) => { res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.send(indexHtml()); };
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
// no-cache = the browser re-checks (cheap ETag request) on every load, so updates appear immediately
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.use(sendIndex);   // single-page app: any other path gets the app

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (max 15 MB).' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error('[error]', req.method, req.url, err);
  res.status(500).json({ error: err.message && /Unsupported|corrupt|Invalid PDF|zip/i.test(err.message) ? `Could not read the file: ${err.message}` : 'Something went wrong. Please try again.' });
});

const server = app.listen(cfg.PORT, () => {
  console.log(`${cfg.PORTAL_NAME} listening on http://localhost:${cfg.PORT}`);
  if (!mailer.configured()) console.warn('[mail] SMTP_USER / SMTP_PASS not set — result e-mails will not be sent.');
});

// Background jobs: auto-submit expired attempts; retry pending e-mails.
svc.sweepExpired();
mailer.retryPending();
const t1 = setInterval(() => { try { svc.sweepExpired(); } catch (e) { console.error('[sweep]', e); } }, 10000);
const t2 = setInterval(() => { try { mailer.retryPending(); } catch (e) { console.error('[mail]', e); } }, 5 * 60000);

function shutdown() {
  clearInterval(t1); clearInterval(t2);
  server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
module.exports = app;
