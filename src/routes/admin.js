const router = require('express').Router();
const multer = require('multer');
const pw = require('../password');
const cfg = require('../config');
const { customOnly } = require('../defaults');
const db = require('../db');
const auth = require('../auth');
const svc = require('../service');
const mailer = require('../mailer');
const { buildResultPdf } = require('../pdf');
const { extractDocument, parseQuestions, parseAnswerKey } = require('../parser');
const settings = require('../settings');
const branding = require('../branding');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.use(auth.require('admin'));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const hasAttempts = (examId) => db.prepare('SELECT 1 FROM attempts WHERE exam_id=? LIMIT 1').get(examId);
const LOCKED = 'This exam already has attempts, so its questions can no longer be changed.';

const baseUrl = (req) => cfg.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

/* ------------------------------ dashboard ------------------------------ */
router.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  res.json({
    users: one("SELECT COUNT(*) n FROM users WHERE role='user'"),
    exams: one('SELECT COUNT(*) n FROM exams'),
    attempts: one("SELECT COUNT(*) n FROM attempts WHERE status='submitted'"),
    live_now: one("SELECT COUNT(*) n FROM attempts WHERE status='in_progress'"),
    smtp_configured: mailer.configured(),
  });
});

/* -------------------------------- exams -------------------------------- */
function examBody(b, partial = false) {
  const out = {};
  const optional = ['negative_marks', 'default_marks'];
  const num = (k, min, max) => {
    if (b[k] === undefined || b[k] === '') { if (!partial && !optional.includes(k)) throw new Error(`${k.replace('_', ' ')} is required`); return; }
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be between ${min} and ${max}`);
    out[k] = v;
  };
  if (b.name !== undefined || !partial) {
    if (!String(b.name || '').trim()) throw new Error('Exam name is required');
    out.name = String(b.name).trim().slice(0, 200);
  }
  num('duration_min', 1, 600);
  num('pass_percent', 0, 100);
  num('negative_marks', 0, 100);
  num('default_marks', 0.01, 1000);
  for (const k of ['start_at', 'end_at']) {
    if (b[k] === undefined && partial) continue;
    const t = Date.parse(b[k]);
    if (isNaN(t)) throw new Error(`${k} is not a valid date/time`);
    out[k] = new Date(t).toISOString();
  }
  if (b.instructions !== undefined || !partial) out.instructions = customOnly(b.instructions).slice(0, 5000);
  if (b.num_sets !== undefined && b.num_sets !== '') {
    const n = Number(b.num_sets);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('Number of sets must be a whole number from 1 to 100');
    out.num_sets = n;
  }
  if (b.questions_per_attempt !== undefined) {
    if (b.questions_per_attempt === '' || b.questions_per_attempt === null) out.questions_per_attempt = null;
    else {
      const n = Number(b.questions_per_attempt);
      if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error('Questions per candidate must be a whole number of at least 1 (or blank for all)');
      out.questions_per_attempt = n;
    }
  }
  return out;
}

router.get('/exams', (req, res) => {
  const rows = db.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) AS question_count,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.status='submitted') AS submitted_count,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.status='in_progress') AS running_count,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.status='submitted' AND a.passed=1) AS passed_count
    FROM exams e ORDER BY e.start_at DESC`).all();
  res.json({ exams: rows.map((e) => ({ ...e, status: svc.examStatus(e) })) });
});

router.post('/exams', (req, res) => {
  let b; try { b = examBody(req.body || {}); } catch (e) { return bad(res, e.message); }
  if (Date.parse(b.end_at) <= Date.parse(b.start_at)) return bad(res, 'Closing time must be after opening time.');
  const info = db.prepare(`INSERT INTO exams (name,instructions,duration_min,pass_percent,negative_marks,default_marks,start_at,end_at,questions_per_attempt,num_sets)
    VALUES (@name,@instructions,@duration_min,@pass_percent,@negative_marks,@default_marks,@start_at,@end_at,@questions_per_attempt,@num_sets)`)
    .run({ instructions: '', negative_marks: 0, default_marks: 1, questions_per_attempt: null, num_sets: 1, ...b });
  db.prepare('UPDATE exams SET link_base=? WHERE id=?').run(baseUrl(req), info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid });
});

function loadExam(req, res) {
  const e = db.prepare('SELECT * FROM exams WHERE id=?').get(req.params.id);
  if (!e) { bad(res, 'Exam not found', 404); return null; }
  return e;
}

router.get('/exams/:id', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const questions = db.prepare('SELECT * FROM questions WHERE exam_id=? ORDER BY set_name, position').all(e.id).map(svc.parseQ);
  res.json({
    exam: { ...e, instructions: customOnly(e.instructions), status: svc.examStatus(e) },
    sets: svc.setsOf(e.id),
    questions,
    locked: !!hasAttempts(e.id),
    attempt_count: db.prepare('SELECT COUNT(*) n FROM attempts WHERE exam_id=?').get(e.id).n,
    submitted_count: db.prepare("SELECT COUNT(*) n FROM attempts WHERE exam_id=? AND status='submitted'").get(e.id).n,
  });
});

router.put('/exams/:id', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  let b; try { b = examBody(req.body || {}, true); } catch (err) { return bad(res, err.message); }
  const m = { ...e, ...b };
  if (Date.parse(m.end_at) <= Date.parse(m.start_at)) return bad(res, 'Closing time must be after opening time.');
  if (hasAttempts(e.id) && (b.negative_marks !== undefined && b.negative_marks !== e.negative_marks))
    return bad(res, 'Negative marking cannot change after attempts exist.');
  if (hasAttempts(e.id) && b.questions_per_attempt !== undefined && b.questions_per_attempt !== e.questions_per_attempt)
    return bad(res, 'Questions per candidate cannot change after attempts exist.');
  if (hasAttempts(e.id) && b.num_sets !== undefined && b.num_sets !== e.num_sets)
    return bad(res, 'Number of sets cannot change after attempts exist.');
  db.prepare(`UPDATE exams SET name=@name,instructions=@instructions,duration_min=@duration_min,pass_percent=@pass_percent,
    negative_marks=@negative_marks,default_marks=@default_marks,start_at=@start_at,end_at=@end_at,questions_per_attempt=@questions_per_attempt,num_sets=@num_sets WHERE id=@id`).run(m);
  if (e.published) svc.refreshSets(e.id);   // keep the generated sets in line with the new settings (no-op once attempts exist)
  db.prepare('UPDATE exams SET link_base=? WHERE id=?').run(baseUrl(req), e.id);
  res.json({ ok: true });
});

router.delete('/exams/:id', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  db.prepare('DELETE FROM exams WHERE id=?').run(e.id);
  res.json({ ok: true });
});

router.post('/exams/:id/publish', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const want = !!(req.body && req.body.published);
  if (want) {
    const sets = svc.setsOf(e.id);
    if (!sets.length) return bad(res, 'Add questions before publishing.');
    const missing = sets.filter((s) => s.missing_key > 0);
    const pool = sets.reduce((s, x) => s + x.count, 0);
    if (e.questions_per_attempt && e.questions_per_attempt > pool)
      return bad(res, `Each candidate is set to receive ${e.questions_per_attempt} questions but the question bank has only ${pool}. Add questions or lower "Questions per candidate".`);
    if (missing.length)
      return bad(res, `Answer key incomplete in set ${missing.map((s) => `${s.set_name} (${s.missing_key} missing)`).join(', ')}. Upload or mark the answers first.`);
  }
  db.prepare('UPDATE exams SET published=?, link_base=? WHERE id=?').run(want ? 1 : 0, baseUrl(req), e.id);
  if (want) svc.refreshSets(e.id);
  res.json({ ok: true });
});

/* ------------------------------- questions ------------------------------ */

/** Replace the whole question bank with the given (already validated) questions. */
function saveBank(e, clean) {
  const ins = db.prepare('INSERT INTO questions (exam_id,set_name,position,text,options,correct_index,marks) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM questions WHERE exam_id=?').run(e.id);
    clean.forEach((q, i) => ins.run(e.id, '1', i + 1, q.text, JSON.stringify(q.options), q.correct_index, q.marks));
    db.prepare('DELETE FROM exam_sets WHERE exam_id=?').run(e.id);
    db.prepare('UPDATE exams SET published=0 WHERE id=?').run(e.id);    // must be re-checked and re-published
  })();
}

/** Read a question file/pasted text. Sends back a helpful explanation (and what was read) when no MCQs are found. */
async function readBank(req) {
  let doc = { text: String(req.body.text || ''), ocr: false };
  if (req.file) doc = await extractDocument(req.file);
  const preview = doc.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 60);
  if (!doc.text.trim()) {
    return { error: doc.ocr
      ? 'No text could be recognised in this scan. Try a sharper, straight-on scan or photo (at least 150 dpi), or paste the text instead.'
      : 'Choose the question bank file (or paste the questions).', preview };
  }
  const parsed = parseQuestions(doc.text);
  if (!parsed.questions.length) {
    const n = parsed.stats.skippedNoOptions;
    return {
      error: n
        ? `Found ${n} numbered question${n === 1 ? '' : 's'}, but none has answer options (A, B, C, D). This looks like a written question-and-answer document. The portal runs multiple-choice exams, so each question needs options such as "A) ... B) ... C) ... D) ...".`
        : 'No multiple-choice questions could be detected in this file. Each question should be numbered ("1. ...") and followed by its options ("A) ...", "B) ...", "C) ...", "D) ...").',
      preview, ocr: doc.ocr,
    };
  }
  const warnings = [...parsed.warnings];
  if (doc.ocr) warnings.unshift('This file was a scan, so the text was read with OCR. Please check every question, option and answer carefully — scans can contain misread characters.');
  if (doc.truncated) warnings.push('Only the first 30 pages of the scan were read.');
  return { questions: parsed.questions, warnings, ocr: doc.ocr, stats: parsed.stats, with_answers: parsed.questions.filter((q) => q.correct_index != null).length };
}

/** Step 1 of the import wizard: read the file and return the questions + answers found. Nothing is saved. */
router.post('/exams/:id/questions/parse', upload.single('file'), wrap(async (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  if (hasAttempts(e.id)) return bad(res, LOCKED, 409);
  const r = await readBank(req);
  if (r.error) return res.status(400).json(r);
  res.json(r);
}));

/** Map a pasted answer list ("1-B, 2-C ...") onto questions. options = number of options of each question, in order. */
router.post('/answers/map', (req, res) => {
  const counts = Array.isArray(req.body && req.body.options) ? req.body.options.map(Number) : [];
  const nums = Array.isArray(req.body && req.body.numbers) ? req.body.numbers.map(Number) : counts.map((_, i) => i + 1);
  const key = parseAnswerKey(String((req.body && req.body.text) || ''));
  const found = Object.keys(key).length;
  if (!found) return bad(res, 'No answers detected. Write them like "1-B, 2-C, 3-A" or one per line ("1. B").');
  const answers = {}, invalid = [], unmatched = [];
  counts.forEach((n, i) => { const k = key[nums[i]]; if (k == null) return; if (k < n) answers[i] = k; else invalid.push(nums[i]); });
  const known = new Set(nums);
  Object.keys(key).forEach((k) => { if (!known.has(Number(k))) unmatched.push(Number(k)); });
  res.json({ answers, applied: Object.keys(answers).length, found, invalid, unmatched });
});

/** Step 2: save the reviewed questions as the exam's question bank (replacing any earlier bank). */
router.post('/exams/:id/questions/import', wrap(async (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  if (hasAttempts(e.id)) return bad(res, LOCKED, 409);
  const list = Array.isArray(req.body && req.body.questions) ? req.body.questions : [];
  if (!list.length) return bad(res, 'No questions to save.');
  const clean = [];
  for (const [i, q] of list.entries()) {
    const v = validateQuestion(q, e.default_marks);
    if (v.error) return bad(res, `Question ${i + 1}: ${v.error}`);
    clean.push(v);
  }
  saveBank(e, clean);
  res.json({ added: clean.length, with_answers: clean.filter((q) => q.correct_index != null).length });
}));

/** One-step upload (file or text straight into the bank). */
router.post('/exams/:id/questions/upload', upload.single('file'), wrap(async (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  if (hasAttempts(e.id)) return bad(res, LOCKED, 409);
  const r = await readBank(req);
  if (r.error) return res.status(400).json(r);
  saveBank(e, r.questions.map((q) => ({ text: q.text, options: q.options, correct_index: q.correct_index, marks: e.default_marks })));
  res.json({ added: r.questions.length, with_answers: r.with_answers, warnings: r.warnings });
}));


router.post('/exams/:id/questions', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  if (hasAttempts(e.id)) return bad(res, LOCKED, 409);
  const v = validateQuestion(req.body, e.default_marks);
  if (v.error) return bad(res, v.error);
  const setName = '1';
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM questions WHERE exam_id=? AND set_name=?').get(e.id, setName).p;
  const info = db.prepare('INSERT INTO questions (exam_id,set_name,position,text,options,correct_index,marks) VALUES (?,?,?,?,?,?,?)')
    .run(e.id, setName, pos, v.text, JSON.stringify(v.options), v.correct_index, v.marks);
  svc.refreshSets(e.id);
  res.json({ id: info.lastInsertRowid });
});

function validateQuestion(b, defMarks) {
  b = b || {};
  const text = String(b.text || '').trim();
  const options = Array.isArray(b.options) ? b.options.map((o) => String(o).trim()).filter(Boolean) : [];
  if (!text) return { error: 'Question text is required.' };
  if (options.length < 2 || options.length > 8) return { error: 'Provide 2 to 8 options.' };
  let ci = b.correct_index === null || b.correct_index === '' || b.correct_index === undefined ? null : Number(b.correct_index);
  if (ci !== null && (!Number.isInteger(ci) || ci < 0 || ci >= options.length)) return { error: 'Correct option is invalid.' };
  const marks = b.marks === undefined || b.marks === '' ? defMarks : Number(b.marks);
  if (!Number.isFinite(marks) || marks <= 0) return { error: 'Marks must be greater than 0.' };
  return { text, options, correct_index: ci, marks };
}

router.put('/questions/:qid', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.qid);
  if (!q) return bad(res, 'Question not found', 404);
  if (hasAttempts(q.exam_id)) return bad(res, LOCKED, 409);
  const v = validateQuestion(req.body, q.marks);
  if (v.error) return bad(res, v.error);
  db.prepare('UPDATE questions SET text=?,options=?,correct_index=?,marks=? WHERE id=?')
    .run(v.text, JSON.stringify(v.options), v.correct_index, v.marks, q.id);
  if (v.correct_index == null) db.prepare('UPDATE exams SET published=0 WHERE id=?').run(q.exam_id);
  res.json({ ok: true });
});

/**
 * Correct a question's scoring at any time, including after candidates have submitted: change the correct option,
 * change its marks, or award its marks to every candidate ("grace", for a faulty question). All submitted results
 * are recalculated and the change is written to the audit log.
 */
router.patch('/questions/:qid/scoring', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.qid);
  if (!q) return bad(res, 'Question not found', 404);
  const b = req.body || {};
  const n = JSON.parse(q.options).length;
  const next = { correct_index: q.correct_index, marks: q.marks, grace: q.grace };
  if (b.correct_index !== undefined) {
    const v = b.correct_index === null || b.correct_index === '' ? null : Number(b.correct_index);
    if (v !== null && (!Number.isInteger(v) || v < 0 || v >= n)) return bad(res, 'Choose one of the question\'s options as the correct answer.');
    next.correct_index = v;
  }
  if (b.marks !== undefined) {
    const v = Number(b.marks);
    if (!Number.isFinite(v) || v <= 0 || v > 1000) return bad(res, 'Marks must be a number greater than 0.');
    next.marks = v;
  }
  if (b.grace !== undefined) next.grace = b.grace ? 1 : 0;
  const started = !!hasAttempts(q.exam_id);
  if (started && next.correct_index === null && !next.grace) return bad(res, 'Candidates have already taken this exam, so the question must keep a correct answer (or be awarded to everyone).');

  const num = db.prepare('SELECT COUNT(*) n FROM questions WHERE exam_id=? AND (set_name<?  OR (set_name=? AND position<=?))').get(q.exam_id, q.set_name, q.set_name, q.position).n;
  const L = (i) => (i == null ? 'none' : 'ABCDEFGH'[i]);
  const parts = [];
  if (next.correct_index !== q.correct_index) parts.push(`correct answer ${L(q.correct_index)} → ${L(next.correct_index)}`);
  if (next.marks !== q.marks) parts.push(`marks ${q.marks} → ${next.marks}`);
  if (next.grace !== q.grace) parts.push(next.grace ? 'marks awarded to every candidate' : 'award to every candidate removed');
  if (!parts.length) return res.json({ ok: true, unchanged: true, rescored: 0, attempts: 0 });

  const out = db.transaction(() => {
    db.prepare('UPDATE questions SET correct_index=?, marks=?, grace=? WHERE id=?').run(next.correct_index, next.marks, next.grace, q.id);
    if (next.correct_index == null) db.prepare('UPDATE exams SET published=0 WHERE id=?').run(q.exam_id);
    const r = started ? svc.rescoreExam(q.exam_id) : { total: 0, changed: 0, flipped: 0 };
    if (started) db.prepare('INSERT INTO question_changes (exam_id,question_id,admin,summary,rescored) VALUES (?,?,?,?,?)').run(q.exam_id, q.id, req.user.username, `Q${num}: ${parts.join('; ')}`, r.changed);
    return r;
  })();
  res.json({ ok: true, rescored: out.changed, attempts: out.total, result_changes: out.flipped, summary: parts.join('; ') });
});

router.get('/exams/:id/changes', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  res.json({ changes: db.prepare('SELECT id,admin,summary,rescored,created_at FROM question_changes WHERE exam_id=? ORDER BY id DESC LIMIT 200').all(e.id) });
});

// Re-send every submitted candidate's result PDF (after a correction changed the results).
router.post('/exams/:id/resend-all', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  if (!mailer.configured()) return bad(res, 'E-mail is not set up yet. Open Email settings to connect an account first.');
  const rows = db.prepare("SELECT id FROM attempts WHERE exam_id=? AND status='submitted'").all(e.id);
  rows.forEach((r) => mailer.resend(r.id));
  res.json({ queued: rows.length });
});

router.delete('/questions/:qid', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(req.params.qid);
  if (!q) return bad(res, 'Question not found', 404);
  if (hasAttempts(q.exam_id)) return bad(res, LOCKED, 409);
  db.transaction(() => {
    db.prepare('DELETE FROM questions WHERE id=?').run(q.id);
    db.prepare('UPDATE questions SET position=position-1 WHERE exam_id=? AND set_name=? AND position>?').run(q.exam_id, q.set_name, q.position);
  })();
  svc.refreshSets(q.exam_id);
  res.json({ ok: true });
});

// The generated sets: which questions (by their number in the bank) each set contains.
router.get('/exams/:id/sets', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const order = db.prepare('SELECT id FROM questions WHERE exam_id=? ORDER BY set_name, position').all(e.id).map((r, i) => [r.id, i + 1]);
  const num = new Map(order);
  const sets = svc.examSets(e.id);
  res.json({
    num_sets: e.num_sets, per_candidate: svc.paperSize(e, order.length), bank: order.length,
    sets: sets.map((x) => ({ set_no: x.set_no, count: x.ids.length, questions: x.ids.map((id) => num.get(id)).filter(Boolean).sort((a, b) => a - b) })),
  });
});

// Draw the sets again (before anyone has started).
router.post('/exams/:id/sets/regenerate', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  if (hasAttempts(e.id)) return bad(res, 'Candidates have already started, so the sets are fixed.', 409);
  if (!db.prepare('SELECT 1 FROM questions WHERE exam_id=? LIMIT 1').get(e.id)) return bad(res, 'Upload the question bank first.');
  res.json({ sets: svc.generateSets(e) });
});

/* --------------------- invitations, reminders, live view -------------------- */
const examLink = (req, e) => `${baseUrl(req)}/#/user/${'exam'}/${e.id}`;

// Audience for an exam: every candidate with their attempt state and the last notice sent to them.
router.get('/exams/:id/audience', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const users = db.prepare(`SELECT u.id,u.username,u.full_name,u.email,
      a.status AS attempt_status,
      n.kind AS last_kind, n.status AS last_status, n.error AS last_error, n.created_at AS last_at, n.sent_at AS last_sent_at,
      (SELECT COUNT(*) FROM notifications x WHERE x.exam_id=? AND x.user_id=u.id AND x.status='sent') AS sent_count
    FROM users u
    LEFT JOIN attempts a ON a.exam_id=? AND a.user_id=u.id
    LEFT JOIN notifications n ON n.id=(SELECT MAX(id) FROM notifications WHERE exam_id=? AND user_id=u.id)
    WHERE u.role='user' ORDER BY u.username`).all(e.id, e.id, e.id);
  res.json({ exam: { ...e, status: svc.examStatus(e) }, link: examLink(req, e), smtp_configured: mailer.configured(), users });
});

router.post('/exams/:id/notify', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const b = req.body || {};
  if (!e.published) return bad(res, 'Publish the exam before sending invitations.');
  if (!mailer.configured()) return bad(res, 'E-mail is not configured on the server. Add the Gmail App Password (SMTP_PASS) to the .env file and restart.');
  const kind = b.kind === 'reminder' ? 'reminder' : 'invite';
  const now = Date.now();
  if (now > Date.parse(e.end_at)) return bad(res, 'This exam has already ended.');
  if (kind === 'reminder' && now >= Date.parse(e.start_at))
    return bad(res, 'Reminders can only be sent before the exam starts. The exam has already opened.');
  const message = String(b.message || '').trim().slice(0, 1000);
  let users;
  if (b.mode === 'selected') {
    const ids = (Array.isArray(b.user_ids) ? b.user_ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
    users = ids.length ? db.prepare(`SELECT id,email FROM users WHERE role='user' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  } else if (b.mode === 'pending') {
    users = db.prepare(`SELECT id,email FROM users WHERE role='user' AND id NOT IN (SELECT user_id FROM attempts WHERE exam_id=? AND status='submitted')`).all(e.id);
  } else users = db.prepare("SELECT id,email FROM users WHERE role='user'").all();
  if (!users.length) return bad(res, 'No recipients selected.');
  const r = mailer.notifyUsers({ exam: e, users, kind, message, link: examLink(req, e) });
  if (!r.queued) return bad(res, 'None of the selected users has an e-mail address.');
  res.json({ queued: r.queued, skipped_no_email: r.noEmail });
});

router.post('/notifications/:nid/retry', (req, res) => {
  const n = db.prepare('SELECT id FROM notifications WHERE id=?').get(req.params.nid);
  if (!n) return bad(res, 'Not found', 404);
  db.prepare("UPDATE notifications SET status='pending', attempts=0, error=NULL WHERE id=?").run(n.id);
  mailer.enqueueNotice(n.id);
  res.json({ ok: true });
});

// Live monitor: who is writing right now, progress, time left, violations.
router.get('/exams/:id/live', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const rows = db.prepare(`SELECT a.id,a.started_at,a.deadline_at,a.violations,a.layout,u.username,u.full_name,
      (SELECT COUNT(*) FROM answers x WHERE x.attempt_id=a.id AND x.selected_index IS NOT NULL) AS answered
    FROM attempts a JOIN users u ON u.id=a.user_id WHERE a.exam_id=? AND a.status='in_progress' ORDER BY a.started_at`).all(e.id);
  const total = (r) => { try { return JSON.parse(r.layout).length; } catch (_) { return null; } };
  const counts = db.prepare("SELECT status, COUNT(*) n FROM attempts WHERE exam_id=? GROUP BY status").all(e.id);
  const candidates = db.prepare("SELECT COUNT(*) n FROM users WHERE role='user'").get().n;
  res.json({
    now: new Date().toISOString(), status: svc.examStatus(e),
    writing: rows.map((r) => ({ id: r.id, username: r.username, full_name: r.full_name, started_at: r.started_at, deadline_at: r.deadline_at, violations: r.violations, answered: r.answered, total: total(r) })),
    submitted: (counts.find((c) => c.status === 'submitted') || {}).n || 0, candidates,
  });
});

/* -------------------------------- results ------------------------------- */
const RESULT_SQL = `SELECT a.id,a.user_id,a.set_name,a.started_at,a.submitted_at,a.status,a.submit_reason,a.violations,a.score,a.total,
    a.correct,a.wrong,a.unanswered,a.percent,a.passed,a.email_status,a.email_error,u.username,u.full_name,u.email
  FROM attempts a JOIN users u ON u.id=a.user_id WHERE a.exam_id=? ORDER BY a.percent DESC, a.submitted_at`;

router.get('/exams/:id/results', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const rows = db.prepare(RESULT_SQL).all(e.id);
  const done = rows.filter((r) => r.status === 'submitted');
  const avg = done.length ? done.reduce((s, r) => s + r.percent, 0) / done.length : 0;
  const notTaken = db.prepare(`SELECT id,username,full_name,email FROM users WHERE role='user'
    AND id NOT IN (SELECT user_id FROM attempts WHERE exam_id=?) ORDER BY username`).all(e.id);
  res.json({
    exam: { ...e, status: svc.examStatus(e) },
    summary: {
      submitted: done.length, in_progress: rows.length - done.length,
      passed: done.filter((r) => r.passed).length, failed: done.filter((r) => !r.passed).length,
      average_percent: Math.round(avg * 100) / 100,
      highest: done.length ? Math.max(...done.map((r) => r.percent)) : 0,
      lowest: done.length ? Math.min(...done.map((r) => r.percent)) : 0,
    },
    results: rows, not_attempted: notTaken,
  });
});

router.get('/exams/:id/results.csv', (req, res) => {
  const e = loadExam(req, res); if (!e) return;
  const q = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; }; // neutralise spreadsheet formulas
  const head = ['Username', 'Name', 'Email', 'Set', 'Status', 'Score', 'Total', 'Percent', 'Result', 'Correct', 'Wrong', 'Unanswered', 'Violations', 'Submitted by', 'Submitted at'];
  const lines = [head.map(q).join(',')];
  for (const r of db.prepare(RESULT_SQL).all(e.id))
    lines.push([r.username, r.full_name, r.email, r.set_name, r.status, r.score, r.total, r.percent,
      r.status === 'submitted' ? (r.passed ? 'PASS' : 'FAIL') : '', r.correct, r.wrong, r.unanswered, r.violations, r.submit_reason, r.submitted_at].map(q).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="results-exam-${e.id}.csv"` });
  res.send('﻿' + lines.join('\r\n'));
});

router.get('/attempts/:aid', (req, res) => {
  const r = svc.review(req.params.aid);
  if (!r) return bad(res, 'Attempt not found', 404);
  res.json(r);
});

router.get('/attempts/:aid/pdf', wrap(async (req, res) => {
  const r = svc.review(req.params.aid);
  if (!r || r.attempt.status !== 'submitted') return bad(res, 'Result not available', 404);
  const pdf = await buildResultPdf(r.attempt.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="result-${r.attempt.username}-exam-${r.attempt.exam_id}.pdf"` });
  res.send(pdf);
}));

router.post('/attempts/:aid/resend', (req, res) => {
  const r = svc.review(req.params.aid);
  if (!r || r.attempt.status !== 'submitted') return bad(res, 'Result not available', 404);
  mailer.resend(r.attempt.id);
  res.json({ ok: true, smtp_configured: mailer.configured() });
});

router.post('/exams/:id/resend-failed', (req, res) => {
  const rows = db.prepare("SELECT id FROM attempts WHERE exam_id=? AND status='submitted' AND email_status IN ('failed','none')").all(req.params.id);
  rows.forEach((r) => mailer.resend(r.id));
  res.json({ queued: rows.length });
});

/* ------------------------------ e-mail settings ------------------------------ */
const mailView = () => { const c = settings.smtp(); return { configured: !!(c.user && c.pass), source: c.source, host: c.host, port: c.port, secure: c.secure, user: c.user || '', from: c.from || '', has_password: !!c.pass }; };
router.get('/settings/email', (req, res) => res.json(mailView()));

router.put('/settings/email', (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').trim(), user = String(b.user || '').trim(), from = String(b.from || '').trim();
  const port = Number(b.port), pass = String(b.password || '').replace(/\s+/g, '');
  if (!host || !/^[\w.-]+$/.test(host)) return bad(res, 'Enter the mail server name, e.g. smtp.gmail.com.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return bad(res, 'Enter a valid port (465 for SSL, 587 for STARTTLS).');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return bad(res, 'Enter the sender e-mail address.');
  const prev = settings.smtp();
  if (!pass && !(prev.pass && prev.user === user)) return bad(res, 'Enter the password (for Gmail: the 16-character App Password).');
  settings.saveSmtp({ host, port, secure: b.secure === undefined ? port === 465 : !!b.secure, user, pass: pass || '', from });
  mailer.resetTransport();
  res.json(mailView());
});

router.delete('/settings/email', (req, res) => { settings.clearSmtp(); mailer.resetTransport(); res.json(mailView()); });

router.post('/settings/email/test', wrap(async (req, res) => {
  const to = String((req.body && req.body.to) || req.user.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return bad(res, 'Enter the address to send the test e-mail to.');
  try { await mailer.sendTest(to); res.json({ ok: true, to }); } catch (e) { bad(res, e.message); }
}));

router.get('/settings/branding', (req, res) => res.json({ custom: branding.isCustom() }));
router.post('/settings/branding', upload.single('file'), (req, res) => {
  try { branding.saveLogo(req.file && req.file.buffer); res.json({ custom: true }); } catch (e) { bad(res, e.message); }
});
router.delete('/settings/branding', (req, res) => { branding.resetLogo(); res.json({ custom: false }); });

/* --------------------------------- users -------------------------------- */
router.get('/users', (req, res) => {
  res.json({
    users: db.prepare(`SELECT u.id,u.username,u.full_name,u.email,u.created_at,
      (SELECT COUNT(*) FROM attempts a WHERE a.user_id=u.id AND a.status='submitted') AS exams_taken
      FROM users u WHERE u.role='user' ORDER BY u.created_at DESC`).all(),
  });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function checkUser(b, needPass) {
  const username = String(b.username || '').trim();
  const email = String(b.email || '').trim();
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) return { error: 'Username must be 3-64 characters (letters, digits, . _ - @).' };
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' };
  if (needPass && String(b.password || '').length < 6) return { error: 'Password must be at least 6 characters.' };
  return { username, email, full_name: String(b.full_name || '').trim().slice(0, 120), password: b.password ? String(b.password) : '' };
}

router.post('/users', wrap(async (req, res) => {
  const u = checkUser(req.body || {}, true);
  if (u.error) return bad(res, u.error);
  try {
    const info = db.prepare("INSERT INTO users (username,password_hash,full_name,email,role) VALUES (?,?,?,?, 'user')")
      .run(u.username, await pw.hash(u.password), u.full_name, u.email);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'That username already exists.', 409);
    throw e;
  }
}));

// Bulk add: body { users: [{username,password,email,full_name}] }
router.post('/users/bulk', wrap(async (req, res) => {
  const list = Array.isArray(req.body && req.body.users) ? req.body.users : [];
  const ins = db.prepare("INSERT INTO users (username,password_hash,full_name,email,role) VALUES (?,?,?,?, 'user')");
  const added = []; const errors = [];
  for (const [i, row] of list.slice(0, 2000).entries()) {
    const u = checkUser(row, true);
    if (u.error) { errors.push({ row: i + 1, error: u.error }); continue; }
    try { ins.run(u.username, await pw.hash(u.password), u.full_name, u.email); added.push(u.username); }
    catch (e) { errors.push({ row: i + 1, error: String(e.message).includes('UNIQUE') ? `"${u.username}" already exists` : e.message }); }
  }
  res.json({ added: added.length, errors });
}));

router.put('/users/:id', wrap(async (req, res) => {
  const cur = db.prepare("SELECT * FROM users WHERE id=? AND role='user'").get(req.params.id);
  if (!cur) return bad(res, 'User not found', 404);
  const u = checkUser({ ...cur, ...req.body }, false);
  if (u.error) return bad(res, u.error);
  if (u.password && u.password.length < 6) return bad(res, 'Password must be at least 6 characters.');
  try {
    db.prepare('UPDATE users SET username=?,email=?,full_name=?,password_hash=? WHERE id=?')
      .run(u.username, u.email, u.full_name, u.password ? await pw.hash(u.password) : cur.password_hash, cur.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'That username already exists.', 409);
    throw e;
  }
  res.json({ ok: true });
}));

router.delete('/users/:id', (req, res) => {
  const cur = db.prepare("SELECT id FROM users WHERE id=? AND role='user'").get(req.params.id);
  if (!cur) return bad(res, 'User not found', 404);
  db.prepare('DELETE FROM users WHERE id=?').run(cur.id); // cascades their attempts
  res.json({ ok: true });
});

module.exports = router;
