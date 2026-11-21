const router = require('express').Router();
const db = require('../db');
const cfg = require('../config');
const { DEFAULT_INSTRUCTIONS, customOnly } = require('../defaults');
const auth = require('../auth');
const svc = require('../service');
const { buildResultPdf } = require('../pdf');

router.use(auth.require('user'));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const LATE_GRACE_MS = 10000; // allows the final auto-save to land right at the deadline

/* ------------------------------ dashboard ------------------------------- */
router.get('/exams', (req, res) => {
  const now = Date.now();
  const rows = db.prepare(`SELECT e.id,e.name,e.duration_min,e.pass_percent,e.negative_marks,e.start_at,e.end_at,e.published,
      MIN(COALESCE(e.questions_per_attempt, 1000000), (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id)) AS question_count,
      a.id AS attempt_id, a.status AS attempt_status
    FROM exams e LEFT JOIN attempts a ON a.exam_id=e.id AND a.user_id=?
    WHERE e.published=1 AND e.end_at >= ? ORDER BY e.start_at`).all(req.user.id, new Date(now).toISOString());
  res.json({
    now: new Date(now).toISOString(),
    exams: rows.filter((r) => r.attempt_status !== 'submitted').map((r) => ({ ...r, status: svc.examStatus(r, now) })),
  });
});

router.get('/reports', (req, res) => {
  res.json({
    reports: db.prepare(`SELECT a.id,e.name,a.submitted_at,a.score,a.total,a.percent,a.passed,a.submit_reason
      FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.user_id=? AND a.status='submitted' ORDER BY a.submitted_at DESC`).all(req.user.id),
  });
});

function ownSubmitted(req, res) {
  const r = svc.review(req.params.aid);
  if (!r || r.attempt.user_id !== req.user.id) { bad(res, 'Result not found', 404); return null; }
  if (r.attempt.status !== 'submitted') { bad(res, 'The answer key is available only after you submit.', 403); return null; }
  return r;
}

router.get('/attempts/:aid/result', (req, res) => {
  const r = ownSubmitted(req, res); if (!r) return;
  const { password_hash, ...att } = r.attempt;
  res.json({ attempt: att, questions: r.questions });
});

router.get('/attempts/:aid/pdf', async (req, res, next) => {
  try {
    const r = ownSubmitted(req, res); if (!r) return;
    const pdf = await buildResultPdf(r.attempt.id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="result-exam-${r.attempt.exam_id}.pdf"` });
    res.send(pdf);
  } catch (e) { next(e); }
});

/* ------------------------------ taking exam ----------------------------- */
function publicExam(e) {
  return { id: e.id, name: e.name, instructions: customOnly(e.instructions), duration_min: e.duration_min, pass_percent: e.pass_percent,
    negative_marks: e.negative_marks, start_at: e.start_at, end_at: e.end_at };
}

router.get('/exams/:id/info', (req, res) => {
  const e = db.prepare('SELECT * FROM exams WHERE id=? AND published=1').get(req.params.id);
  if (!e) return bad(res, 'Exam not found', 404);
  const pool = db.prepare('SELECT COUNT(*) c, AVG(marks) a, MIN(marks) mn, MAX(marks) mx FROM questions WHERE exam_id=?').get(e.id);
  const n = svc.paperSize(e, pool.c);
  const done = db.prepare("SELECT 1 FROM attempts WHERE exam_id=? AND user_id=? AND status='submitted'").get(e.id, req.user.id);
  res.json({
    now: new Date().toISOString(), exam: { ...publicExam(e), status: svc.examStatus(e) },
    question_count: n, total_marks: Math.round(n * (pool.a || 0) * 100) / 100, marks_vary: pool.mn !== pool.mx,
    already_submitted: !!done, default_instructions: DEFAULT_INSTRUCTIONS.split('\n'), violation_limit: cfg.VIOLATION_LIMIT,
  });
});

function attemptPayload(att, exam) {
  const layout = svc.attemptLayout(att);
  const byId = svc.rowsById(layout.map((l) => l.id));
  const qs = layout.filter((l) => byId.has(l.id)).map((l, i) => {
    const q = byId.get(l.id), opts = JSON.parse(q.options);
    return { id: q.id, position: i + 1, text: q.text, marks: q.marks, options: l.perm.map((o) => opts[o]) };
  });
  const permOf = new Map(layout.map((l) => [l.id, l.perm]));
  const saved = {};   // sent to the browser as *displayed* option indexes
  db.prepare('SELECT question_id,selected_index FROM answers WHERE attempt_id=?').all(att.id)
    .forEach((a) => { saved[a.question_id] = a.selected_index == null ? null : permOf.get(a.question_id).indexOf(a.selected_index); });
  return {
    now: new Date().toISOString(),
    attempt: { id: att.id, set_name: att.set_name, deadline_at: att.deadline_at, violations: att.violations },
    exam: publicExam(exam), questions: qs, answers: saved, violation_limit: cfg.VIOLATION_LIMIT,
  };
}

const startTx = db.transaction((exam, userId) => {
  const existing = db.prepare('SELECT * FROM attempts WHERE exam_id=? AND user_id=?').get(exam.id, userId);
  if (existing) return existing;
  // Allocate the least-used set (random among ties), then give this candidate their own random order of
  // that set's questions and options. Retry until the paper differs from every paper already issued.
  let sets = svc.examSets(exam.id);
  if (!sets.length) { svc.generateSets(exam); sets = svc.examSets(exam.id); }
  const counts = new Map(db.prepare('SELECT set_name, COUNT(*) n FROM attempts WHERE exam_id=? GROUP BY set_name').all(exam.id).map((r) => [r.set_name, r.n]));
  const least = Math.min(...sets.map((x) => counts.get(String(x.set_no)) || 0));
  const candidates = sets.filter((x) => (counts.get(String(x.set_no)) || 0) === least);
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  let layout = null, sig = null;
  for (let i = 0; i < 500; i++) {
    const l = svc.layoutForSet(pick.ids), sg = svc.layoutSig(l);
    if (!db.prepare('SELECT 1 FROM attempts WHERE exam_id=? AND paper_sig=?').get(exam.id, sg)) { layout = l; sig = sg; break; }
  }
  if (!layout) throw Object.assign(new Error('No further unique papers can be generated for this exam. Please contact the administrator.'), { status409: true });
  const now = Date.now();
  const deadline = Math.min(now + exam.duration_min * 60000, Date.parse(exam.end_at));
  const info = db.prepare('INSERT INTO attempts (exam_id,user_id,set_name,started_at,deadline_at) VALUES (?,?,?,?,?)')
    .run(exam.id, userId, String(pick.set_no), new Date(now).toISOString(), new Date(deadline).toISOString());
  db.prepare('UPDATE attempts SET layout=?, paper_sig=? WHERE id=?').run(JSON.stringify(layout), sig, info.lastInsertRowid);
  return db.prepare('SELECT * FROM attempts WHERE id=?').get(info.lastInsertRowid);
});

router.post('/exams/:id/start', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id=? AND published=1').get(req.params.id);
  if (!exam) return bad(res, 'Exam not found', 404);
  const existing = db.prepare('SELECT * FROM attempts WHERE exam_id=? AND user_id=?').get(exam.id, req.user.id);
  if (existing && existing.status === 'submitted') return bad(res, 'You have already completed this exam.', 409);

  if (existing) { // resume
    if (Date.now() > Date.parse(existing.deadline_at)) {
      svc.submit(existing.id, 'time_up');
      return res.status(409).json({ error: 'Your time for this exam has ended. It was submitted automatically.', submitted: true, attempt_id: existing.id });
    }
    return res.json(attemptPayload(existing, exam));
  }
  const now = Date.now();
  if (now < Date.parse(exam.start_at)) return bad(res, 'This exam has not opened yet.', 403);
  if (now > Date.parse(exam.end_at)) return bad(res, 'This exam has closed.', 403);
  const poolCount = db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=?').get(exam.id).c;
  if (!poolCount) return bad(res, 'This exam has no questions.', 409);
  let att;
  try { att = startTx(exam, req.user.id); } catch (e) { if (e.status409) return bad(res, e.message, 409); throw e; }
  res.json(attemptPayload(att, exam));
});

function ownLive(req, res) {
  const att = db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.aid, req.user.id);
  if (!att) { bad(res, 'Attempt not found', 404); return null; }
  return att;
}

router.post('/attempts/:aid/answer', (req, res) => {
  const att = ownLive(req, res); if (!att) return;
  if (att.status !== 'in_progress') return res.status(409).json({ error: 'Exam already submitted.', submitted: true });
  if (Date.now() > Date.parse(att.deadline_at) + LATE_GRACE_MS) {
    svc.submit(att.id, 'time_up');
    return res.status(409).json({ error: 'Time is up.', submitted: true });
  }
  const { question_id, selected_index } = req.body || {};
  const entry = svc.attemptLayout(att).find((l) => l.id === Number(question_id));
  if (!entry) return bad(res, 'Invalid question');
  const shown = selected_index === null || selected_index === undefined ? null : Number(selected_index);   // index as displayed to this candidate
  if (shown !== null && (!Number.isInteger(shown) || shown < 0 || shown >= entry.perm.length)) return bad(res, 'Invalid option');
  const sel = shown === null ? null : entry.perm[shown];                                                    // stored as original option index
  db.prepare(`INSERT INTO answers (attempt_id,question_id,selected_index) VALUES (?,?,?)
    ON CONFLICT(attempt_id,question_id) DO UPDATE SET selected_index=excluded.selected_index`).run(att.id, question_id, sel);
  res.json({ ok: true });
});

router.post('/attempts/:aid/violation', (req, res) => {
  const att = ownLive(req, res); if (!att) return;
  if (att.status !== 'in_progress') return res.json({ submitted: true });
  const type = String((req.body && req.body.type) || 'unknown').slice(0, 40);
  const log = JSON.parse(att.violation_log);
  log.push({ type, at: new Date().toISOString() });
  const n = att.violations + 1;
  db.prepare('UPDATE attempts SET violations=?, violation_log=? WHERE id=?').run(n, JSON.stringify(log), att.id);
  if (n >= cfg.VIOLATION_LIMIT) {
    svc.submit(att.id, 'violation', svc.toOriginal(att, req.body && req.body.answers));
    return res.json({ submitted: true, violations: n });
  }
  res.json({ submitted: false, violations: n, limit: cfg.VIOLATION_LIMIT });
});

router.post('/attempts/:aid/submit', (req, res) => {
  const att = ownLive(req, res); if (!att) return;
  if (att.status === 'in_progress') {
    const late = Date.now() > Date.parse(att.deadline_at) + LATE_GRACE_MS;
    const reason = req.body && req.body.reason === 'time_up' ? 'time_up' : 'manual';
    // After the deadline only the already-saved answers count.
    svc.submit(att.id, late ? 'time_up' : reason, late ? undefined : svc.toOriginal(att, req.body && req.body.answers));
  }
  res.json({ ok: true, attempt_id: att.id });
});

module.exports = router;
