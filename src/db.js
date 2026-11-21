const path = require('path');
const Database = require('better-sqlite3');
const pw = require('./password');
const cfg = require('./config');

const db = new Database(path.join(cfg.DATA_DIR, 'portal.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 8000');

db.exec(`
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
  options TEXT NOT NULL,            -- JSON array of strings
  correct_index INTEGER,            -- NULL until the key is provided
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
  status TEXT NOT NULL DEFAULT 'in_progress',   -- in_progress | submitted
  submit_reason TEXT,                            -- manual | time_up | violation
  violations INTEGER NOT NULL DEFAULT 0,
  violation_log TEXT NOT NULL DEFAULT '[]',
  score REAL, total REAL, correct INTEGER, wrong INTEGER, unanswered INTEGER,
  percent REAL, passed INTEGER,
  email_status TEXT NOT NULL DEFAULT 'none',     -- none | pending | sent | failed
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
);
`);

// --- lightweight migrations for databases created by earlier versions ---
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('exams').includes('questions_per_attempt')) db.exec('ALTER TABLE exams ADD COLUMN questions_per_attempt INTEGER');
if (!cols('attempts').includes('layout')) db.exec('ALTER TABLE attempts ADD COLUMN layout TEXT');
if (!cols('attempts').includes('paper_sig')) db.exec('ALTER TABLE attempts ADD COLUMN paper_sig TEXT');
if (!cols('exams').includes('auto_remind_min')) db.exec('ALTER TABLE exams ADD COLUMN auto_remind_min INTEGER');
if (!cols('exams').includes('reminder_sent_at')) db.exec('ALTER TABLE exams ADD COLUMN reminder_sent_at TEXT');
if (!cols('exams').includes('link_base')) db.exec('ALTER TABLE exams ADD COLUMN link_base TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- invite | reminder
  message TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_exam ON notifications(exam_id, user_id, id);`);
if (!cols('exams').includes('num_sets')) db.exec('ALTER TABLE exams ADD COLUMN num_sets INTEGER NOT NULL DEFAULT 1');
db.exec(`CREATE TABLE IF NOT EXISTS exam_sets (
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  set_no INTEGER NOT NULL,
  question_ids TEXT NOT NULL,              -- JSON array of the question ids drawn for this set
  PRIMARY KEY (exam_id, set_no)
)`);
if (!cols('questions').includes('grace')) db.exec('ALTER TABLE questions ADD COLUMN grace INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS question_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id INTEGER,
  admin TEXT NOT NULL,
  summary TEXT NOT NULL,
  rescored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
// No two candidates of the same exam may ever receive an identical paper (questions + order + option order).
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_att_sig ON attempts(exam_id, paper_sig) WHERE paper_sig IS NOT NULL');

async function seedAdmin() {
  const exists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (exists) return;
  if (!cfg.ADMIN_PASSWORD) {
    console.warn('[setup] No admin exists and ADMIN_PASSWORD is not set. Set it in .env and restart.');
    return;
  }
  db.prepare("INSERT INTO users (username,password_hash,full_name,email,role) VALUES (?,?,?,?, 'admin')")
    .run(cfg.ADMIN_USERNAME, await pw.hash(cfg.ADMIN_PASSWORD), 'Administrator', cfg.ADMIN_EMAIL);
  console.log(`[setup] Admin account "${cfg.ADMIN_USERNAME}" created.`);
}
seedAdmin().catch((e) => { console.error('[setup] admin seed failed', e); process.exit(1); });

module.exports = db;
