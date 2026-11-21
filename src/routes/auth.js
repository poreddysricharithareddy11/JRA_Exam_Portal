const router = require('express').Router();
const pw = require('../password');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const auth = require('../auth');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,   // only failed attempts count
  // per IP *and* username, so a classroom behind one NAT cannot lock each other out
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String((req.body && req.body.username) || '').toLowerCase()}`,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});


router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter username and password.' });
  const u = await db.prepare('SELECT * FROM users WHERE lower(username)=lower(?)').get(String(username).trim());
  const ok = await pw.verify(password, u ? u.password_hash : pw.DUMMY);
  if (!u || !ok || (role && u.role !== role)) return res.status(401).json({ error: 'Invalid username or password.' });
  const user = { id: u.id, username: u.username, full_name: u.full_name, email: u.email, role: u.role };
  // Browser app (bearer: true): the sign-in goes to that tab only and no shared cookie is set. Other clients: cookie as before.
  if (req.body.bearer) return res.json({ user, token: auth.sign(u) });
  auth.issue(res, u);
  res.json({ user });
});

router.post('/logout', (req, res) => { auth.clear(res); res.json({ ok: true }); });

router.get('/me', auth.require(), (req, res) => res.json({ user: req.user }));

router.post('/change-password', auth.require(), async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!(await pw.verify(current || '', u.password_hash))) return res.status(400).json({ error: 'Current password is incorrect.' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await pw.hash(next), u.id);
  res.json({ ok: true });
});

module.exports = router;
