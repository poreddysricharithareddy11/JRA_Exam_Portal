const jwt = require('jsonwebtoken');
const cfg = require('./config');
const db = require('./db');

const COOKIE = 'jep_token';

function issue(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, cfg.JWT_SECRET, { expiresIn: `${cfg.SESSION_HOURS}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cfg.COOKIE_SECURE,
    maxAge: cfg.SESSION_HOURS * 3600 * 1000,
  });
}

function clear(res) { res.clearCookie(COOKIE); }

// role: 'admin' | 'user' | undefined (any logged-in)
function require_(role) {
  return (req, res, next) => {
    const token = req.cookies && req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    let payload;
    try { payload = jwt.verify(token, cfg.JWT_SECRET); }
    catch (_) { return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
    // Re-check the DB so deleted users lose access immediately.
    const user = db.prepare('SELECT id,username,full_name,email,role FROM users WHERE id=?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed.' });
    req.user = user;
    next();
  };
}

module.exports = { issue, clear, require: require_ };
