'use strict';
/**
 * Async database adapter with ONE API for two engines:
 *   - DATABASE_URL set  -> PostgreSQL (production: a free Neon database; data survives restarts and redeploys)
 *   - otherwise         -> local SQLite file (your own PC, and the automated tests)
 *
 * Usage mirrors better-sqlite3 but every call returns a Promise:
 *   await db.prepare(sql).get(...params) | .all(...params) | .run(...params)   (run -> { changes, lastInsertRowid })
 *   await db.transaction(async () => { ... })()      statements inside use the same connection automatically
 * SQL is written with "?" placeholders (or @name with an object) for both engines.
 */
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const pw = require('./password');
const cfg = require('./config');

const als = new AsyncLocalStorage();           // holds the connection of the transaction we are currently inside
const ID_TABLES = new Set(['users', 'exams', 'questions', 'attempts', 'notifications', 'question_changes']);
const DBURL = process.env.DATABASE_URL || '';

let impl;

/* ================================ PostgreSQL ================================ */
if (DBURL) {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, Number);      // BIGINT (COUNT, SUM of ints) -> number
  types.setTypeParser(1700, Number);    // NUMERIC -> number
  const pool = new Pool({
    connectionString: DBURL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.DB_POOL || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  pool.on('error', (e) => console.error('[db] idle connection dropped:', e.message));

  const translate = (sql, params) => {
    let out = sql, vals = params;
    if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0]) && !Buffer.isBuffer(params[0])) {
      const obj = params[0], names = []; vals = [];
      out = sql.replace(/@(\w+)/g, (_, k) => { let i = names.indexOf(k); if (i < 0) { names.push(k); vals.push(obj[k] === undefined ? null : obj[k]); i = names.length - 1; } return '$' + (i + 1); });
    } else { let i = 0; out = sql.replace(/\?/g, () => '$' + (++i)); }
    const m = /^\s*insert\s+into\s+(\w+)/i.exec(out);
    if (m && ID_TABLES.has(m[1].toLowerCase()) && !/\breturning\b/i.test(out)) out += ' RETURNING id';
    return { sql: out, vals: vals.map((v) => (v === undefined ? null : v)) };
  };
  const fail = (e) => { if (e && e.code === '23505') e.message = 'UNIQUE constraint failed: ' + e.message; throw e; };

  impl = {
    kind: 'postgres',
    async exec(mode, sql, params) {
      const t = translate(sql, params), c = als.getStore() || pool;
      let r;
      try { r = await c.query(t.sql, t.vals); } catch (e) { fail(e); }
      if (mode === 'all') return r.rows;
      if (mode === 'get') return r.rows[0];
      return { changes: r.rowCount, lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined };
    },
    async tx(fn) {
      if (als.getStore()) return fn();      // nested: join the outer transaction
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await als.run(c, fn);
        await c.query('COMMIT');
        return out;
      } catch (e) { try { await c.query('ROLLBACK'); } catch (_) { /* connection already gone */ } throw e; }
      finally { c.release(); }
    },
    async script(sql) { await pool.query(sql); },
    async init() {
      await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));
CREATE TABLE IF NOT EXISTS exams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  pass_percent DOUBLE PRECISION NOT NULL DEFAULT 40,
  negative_marks DOUBLE PRECISION NOT NULL DEFAULT 0,
  default_marks DOUBLE PRECISION NOT NULL DEFAULT 1,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  questions_per_attempt INTEGER,
  auto_remind_min INTEGER,
  reminder_sent_at TEXT,
  link_base TEXT,
  num_sets INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  set_name TEXT NOT NULL DEFAULT 'A',
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_index INTEGER,
  marks DOUBLE PRECISION NOT NULL DEFAULT 1,
  grace INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_q_exam ON questions(exam_id, set_name, position);
CREATE TABLE IF NOT EXISTS attempts (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  submit_reason TEXT,
  violations INTEGER NOT NULL DEFAULT 0,
  violation_log TEXT NOT NULL DEFAULT '[]',
  score DOUBLE PRECISION, total DOUBLE PRECISION, correct INTEGER, wrong INTEGER, unanswered INTEGER,
  percent DOUBLE PRECISION, passed INTEGER,
  email_status TEXT NOT NULL DEFAULT 'none',
  email_error TEXT,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  layout TEXT,
  paper_sig TEXT,
  UNIQUE (exam_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_att_status ON attempts(status, deadline_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_sig ON attempts(exam_id, paper_sig) WHERE paper_sig IS NOT NULL;
CREATE TABLE IF NOT EXISTS answers (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_index INTEGER,
  PRIMARY KEY (attempt_id, question_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_exam ON notifications(exam_id, user_id, id);
CREATE TABLE IF NOT EXISTS exam_sets (
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  set_no INTEGER NOT NULL,
  question_ids TEXT NOT NULL,
  PRIMARY KEY (exam_id, set_no)
);
CREATE TABLE IF NOT EXISTS question_changes (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id INTEGER,
  admin TEXT NOT NULL,
  summary TEXT NOT NULL,
  rescored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);`);
    },
    async close() { await pool.end(); },
  };

/* ================================== SQLite ================================== */
} else {
  const Database = require('better-sqlite3');
  const sdb = new Database(path.join(cfg.DATA_DIR, 'portal.db'));
  sdb.pragma('journal_mode = WAL');
  sdb.pragma('synchronous = NORMAL');
  sdb.pragma('foreign_keys = ON');
  sdb.pragma('busy_timeout = 8000');

  // One connection: transactions must not interleave with other requests, so everything outside the
  // current transaction waits for it (a simple promise-chain mutex).
  let tail = Promise.resolve();
  const lock = () => { let release; const prev = tail; tail = new Promise((r) => { release = r; }); return prev.then(() => release); };
  const norm = (params) => params.map((v) => (v === undefined ? null : v));

  const run = (mode, sql, params) => {
    const st = sdb.prepare(sql);
    try {
      if (mode === 'all') return st.all(...params);
      if (mode === 'get') return st.get(...params);
      const r = st.run(...params);
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    } catch (e) { if (/UNIQUE constraint/i.test(e.message)) e.code = '23505'; throw e; }
  };
  impl = {
    kind: 'sqlite',
    async exec(mode, sql, params) {
      if (als.getStore()) return run(mode, sql, params);
      const release = await lock();
      try { return run(mode, sql, params); } finally { release(); }
    },
    async tx(fn) {
      if (als.getStore()) return fn();
      const release = await lock();
      try {
        sdb.exec('BEGIN IMMEDIATE');
        try { const out = await als.run(true, fn); sdb.exec('COMMIT'); return out; }
        catch (e) { try { sdb.exec('ROLLBACK'); } catch (_) { /* nothing to roll back */ } throw e; }
      } finally { release(); }
    },
    async script(sql) { sdb.exec(sql); },
    async init() {
      sdb.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  pass_percent REAL NOT NULL DEFAULT 40,
  negative_marks REAL NOT NULL DEFAULT 0,
  default_marks REAL NOT NULL DEFAULT 1,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  set_name TEXT NOT NULL DEFAULT 'A',
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_index INTEGER,
  marks REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_q_exam ON questions(exam_id, set_name, position);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  submit_reason TEXT,
  violations INTEGER NOT NULL DEFAULT 0,
  violation_log TEXT NOT NULL DEFAULT '[]',
  score REAL, total REAL, correct INTEGER, wrong INTEGER, unanswered INTEGER,
  percent REAL, passed INTEGER,
  email_status TEXT NOT NULL DEFAULT 'none',
  email_error TEXT,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (exam_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_att_status ON attempts(status, deadline_at);
CREATE TABLE IF NOT EXISTS answers (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_index INTEGER,
  PRIMARY KEY (attempt_id, question_id)
);`);
      // lightweight migrations for databases created by earlier versions
      const cols = (t) => sdb.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const add = (t, c, def) => { if (!cols(t).includes(c)) sdb.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
      add('exams', 'questions_per_attempt', 'INTEGER');
      add('attempts', 'layout', 'TEXT');
      add('attempts', 'paper_sig', 'TEXT');
      add('exams', 'auto_remind_min', 'INTEGER');
      add('exams', 'reminder_sent_at', 'TEXT');
      add('exams', 'link_base', 'TEXT');
      add('exams', 'num_sets', 'INTEGER NOT NULL DEFAULT 1');
      add('questions', 'grace', 'INTEGER NOT NULL DEFAULT 0');
      sdb.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_exam ON notifications(exam_id, user_id, id);
CREATE TABLE IF NOT EXISTS exam_sets (
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  set_no INTEGER NOT NULL,
  question_ids TEXT NOT NULL,
  PRIMARY KEY (exam_id, set_no)
);
CREATE TABLE IF NOT EXISTS question_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id INTEGER,
  admin TEXT NOT NULL,
  summary TEXT NOT NULL,
  rescored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_sig ON attempts(exam_id, paper_sig) WHERE paper_sig IS NOT NULL;`);
    },
    async close() { sdb.close(); },
  };
}

/* ================================ public API ================================ */
const db = {
  kind: impl.kind,
  prepare(sql) {
    return {
      get: (...p) => impl.exec('get', sql, norm(p)),
      all: (...p) => impl.exec('all', sql, norm(p)),
      run: (...p) => impl.exec('run', sql, norm(p)),
    };
  },
  /** db.transaction(async () => {...})(...args) -> Promise; commits on success, rolls back on any error. */
  transaction: (fn) => (...args) => impl.tx(() => fn(...args)),
  close: () => impl.close(),
};
function norm(p) { return p.map((v) => (v === undefined ? null : v)); }

async function seedAdmin() {
  if (await db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) return;
  if (!cfg.ADMIN_PASSWORD) {
    console.warn('[setup] No admin exists and ADMIN_PASSWORD is not set. Set it in .env and restart.');
    return;
  }
  try {
    await db.prepare("INSERT INTO users (username,password_hash,full_name,email,role) VALUES (?,?,?,?, 'admin')")
      .run(cfg.ADMIN_USERNAME, await pw.hash(cfg.ADMIN_PASSWORD), 'Administrator', cfg.ADMIN_EMAIL);
    console.log(`[setup] Admin account "${cfg.ADMIN_USERNAME}" created.`);
  } catch (e) { if (!/UNIQUE/i.test(e.message)) throw e; }   // another instance created it first
}

/** Resolves once the schema exists and the admin account is in place. */
db.ready = impl.init().then(seedAdmin).catch((e) => { console.error('[db] startup failed:', e); process.exit(1); });

module.exports = db;
