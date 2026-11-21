const router = require('express').Router();
const db = require('../db');
const cfg = require('../config');
const { DEFAULT_INSTRUCTIONS, customOnly } = require('../defaults');
const auth = require('../auth');
const svc = require('../service');
const { buildResultPdf } = require('../pdf');

router.use(auth.require('user'));
for (const name of ['id', 'aid']) router.param(name, (req, res, next, v) => (/^\d{1,9}$/.test(v) ? next() : res.status(404).json({ error: 'Not found' })));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const LATE_GRACE_MS = 10000; // allows the final auto-save to land right at the deadline

/** A candidate can see and open an exam only after the admin has invited them (an invitation or a reminder was sent to them),
 *  or when they already have an attempt on it (so a started / finished exam never disappears). */
const hasAccess = async (examId, userId) => !!(await db.prepare(
  'SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM notifications WHERE exam_id=? AND user_id=?) OR EXISTS (SELECT 1 FROM attempts WHERE exam_id=? AND user_id=?)').get(examId, userId, examId, userId));

/* ------------------------------ dashboard ------------------------------- */
router.get('/exams', async (req, res) => {
  const now = Date.now();
  const rows = (await db.prepare(`SELECT e.id,e.name,e.duration_min,e.pass_percent,e.negative_marks,e.start_at,e.end_at,e.published,
      e.questions_per_attempt, (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) AS pool_count,
      a.id AS attempt_id, a.status AS attempt_status
    FROM exams e LEFT JOIN attempts a ON a.exam_id=e.id AND a.user_id=?
    WHERE e.published=1 AND e.end_at >= ?
      AND (a.id IS NOT NULL OR EXISTS (SELECT 1 FROM notifications n WHERE n.exam_id=e.id AND n.user_id=?))
    ORDER BY e.start_at`).all(req.user.id, new Date(now).toISOString(), req.user.id))
    .map(({ questions_per_attempt, pool_count, ...x }) => ({ ...x, question_count: svc.paperSize({ questions_per_attempt }, pool_count) }));
  res.json({
    now: new Date(now).toISOString(),
    exams: rows.filter((r) => r.attempt_status !== 'submitted').map((r) => ({ ...r, status: svc.examStatus(r, now) })),
  });
});

router.get('/reports', async (req, res) => {
  res.json({
    reports: await db.prepare(`SELECT a.id,e.name,a.submitted_at,a.score,a.total,a.percent,a.passed,a.submit_reason
      FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.user_id=? AND a.status='submitted' ORDER BY a.submitted_at DESC`).all(req.user.id),
  });
});

async function ownSubmitted(req, res) {
  const r = await svc.review(req.params.aid);
  if (!r || r.attempt.user_id !== req.user.id) { bad(res, 'Result not found', 404); return null; }
  if (r.attempt.status !== 'submitted') { bad(res, 'The answer key is available only after you submit.', 403); return null; }
  return r;
}

router.get('/attempts/:aid/result', async (req, res) => {
  const r = await ownSubmitted(req, res); if (!r) return;
  const { password_hash, ...att } = r.attempt;
  res.json({ attempt: att, questions: r.questions });
});

router.get('/attempts/:aid/pdf', async (req, res, next) => {
  try {
    const r = await ownSubmitted(req, res); if (!r) return;
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

router.get('/exams/:id/info', async (req, res) => {
  const e = await db.prepare('SELECT * FROM exams WHERE id=? AND published=1').get(req.params.id);
  if (!e || !(await hasAccess(e.id, req.user.id))) return bad(res, 'Exam not found', 404);
  const pool = await db.prepare('SELECT COUNT(*) c, AVG(marks) a, MIN(marks) mn, MAX(marks) mx FROM questions WHERE exam_id=?').get(e.id);
  const n = svc.paperSize(e, pool.c);
  const done = await db.prepare("SELECT 1 FROM attempts WHERE exam_id=? AND user_id=? AND status='submitted'").get(e.id, req.user.id);
  res.json({
    now: new Date().toISOString(), exam: { ...publicExam(e), status: svc.examStatus(e) },
    question_count: n, total_marks: Math.round(n * (pool.a || 0) * 100) / 100, marks_vary: pool.mn !== pool.mx,
    already_submitted: !!done, default_instructions: DEFAULT_INSTRUCTIONS.split('\n'), violation_limit: cfg.VIOLATION_LIMIT,
  });
});

async function attemptPayload(att, exam) {
  const layout = await svc.attemptLayout(att);
  const byId = await svc.rowsById(layout.map((l) => l.id));
  const qs = layout.filter((l) => byId.has(l.id)).map((l, i) => {
    const q = byId.get(l.id), opts = JSON.parse(q.options);
    return { id: q.id, position: i + 1, text: q.text, marks: q.marks, options: l.perm.map((o) => opts[o]) };
  });
  const permOf = new Map(layout.map((l) => [l.id, l.perm]));
  const saved = {};   // sent to the browser as *displayed* option indexes
  (await db.prepare('SELECT question_id,selected_index FROM answers WHERE attempt_id=?').all(att.id))
    .forEach((a) => { saved[a.question_id] = a.selected_index == null ? null : permOf.get(a.question_id).indexOf(a.selected_index); });
  return {
    now: new Date().toISOString(),
    attempt: { id: att.id, set_name: att.set_name, deadline_at: att.deadline_at, violations: att.violations },
    exam: publicExam(exam), questions: qs, answers: saved, violation_limit: cfg.VIOLATION_LIMIT,
  };
}

const startTx = db.transaction(async (exam, userId) => {
  const existing = await db.prepare('SELECT * FROM attempts WHERE exam_id=? AND user_id=?').get(exam.id, userId);
  if (existing) return existing;
  // Allocate the least-used set (random among ties), then give this candidate their own random order of
  // that set's questions and options. Retry until the paper differs from every paper already issued.
  let sets = await svc.examSets(exam.id);
  if (!sets.length) { await svc.generateSets(exam); sets = await svc.examSets(exam.id); }
  const counts = new Map((await db.prepare('SELECT set_name, COUNT(*) n FROM attempts WHERE exam_id=? GROUP BY set_name').all(exam.id)).map((r) => [r.set_name, r.n]));
  const least = Math.min(...sets.map((x) => counts.get(String(x.set_no)) || 0));
  const candidates = sets.filter((x) => (counts.get(String(x.set_no)) || 0) === least);
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  let layout = null, sig = null;
  for (let i = 0; i < 500; i++) {
    const l = await svc.layoutForSet(pick.ids), sg = svc.layoutSig(l);
    if (!(await db.prepare('SELECT 1 FROM attempts WHERE exam_id=? AND paper_sig=?').get(exam.id, sg))) { layout = l; sig = sg; break; }
  }
  if (!layout) throw Object.assign(new Error('No further unique papers can be generated for this exam. Please contact the administrator.'), { status409: true });
  const now = Date.now();
  const deadline = Math.min(now + exam.duration_min * 60000, Date.parse(exam.end_at));
  const info = await db.prepare('INSERT INTO attempts (exam_id,user_id,set_name,started_at,deadline_at,layout,paper_sig) VALUES (?,?,?,?,?,?,?)')
    .run(exam.id, userId, String(pick.set_no), new Date(now).toISOString(), new Date(deadline).toISOString(), JSON.stringify(layout), sig);
  return db.prepare('SELECT * FROM attempts WHERE id=?').get(info.lastInsertRowid);
});

/** Create (or fetch) the candidate's attempt. Two requests racing each other (double click, two tabs), or two
 *  candidates drawing the same paper, hit a unique index: then look again / draw another paper. */
async function startAttempt(exam, userId) {
  for (let i = 0; i < 6; i++) {
    try { return await startTx(exam, userId); }
    catch (e) {
      if (!/UNIQUE/i.test(e.message)) throw e;
      const again = await db.prepare('SELECT * FROM attempts WHERE exam_id=? AND user_id=?').get(exam.id, userId);
      if (again) return again;
    }
  }
  throw Object.assign(new Error('Could not start the exam. Please try again.'), { status409: true });
}

router.post('/exams/:id/start', async (req, res) => {
  const exam = await db.prepare('SELECT * FROM exams WHERE id=? AND published=1').get(req.params.id);
  if (!exam || !(await hasAccess(exam.id, req.user.id))) return bad(res, 'Exam not found', 404);
  const existing = await db.prepare('SELECT * FROM attempts WHERE exam_id=? AND user_id=?').get(exam.id, req.user.id);
  if (existing && existing.status === 'submitted') return bad(res, 'You have already completed this exam.', 409);

  if (existing) { // resume
    if (Date.now() > Date.parse(existing.deadline_at)) {
      await svc.submit(existing.id, 'time_up');
      return res.status(409).json({ error: 'Your time for this exam has ended. It was submitted automatically.', submitted: true, attempt_id: existing.id });
    }
    return res.json(await attemptPayload(existing, exam));
  }
  const now = Date.now();
  if (now < Date.parse(exam.start_at)) return bad(res, 'This exam has not opened yet.', 403);
  if (now > Date.parse(exam.end_at)) return bad(res, 'This exam has closed.', 403);
  const poolCount = (await db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=?').get(exam.id)).c;
  if (!poolCount) return bad(res, 'This exam has no questions.', 409);
  let att;
  try { att = await startAttempt(exam, req.user.id); } catch (e) { if (e.status409) return bad(res, e.message, 409); throw e; }
  res.json(await attemptPayload(att, exam));
});

async function ownLive(req, res) {
  const att = await db.prepare('SELECT * FROM attempts WHERE id=? AND user_id=?').get(req.params.aid, req.user.id);
  if (!att) { bad(res, 'Attempt not found', 404); return null; }
  return att;
}

router.post('/attempts/:aid/answer', async (req, res) => {
  const att = await ownLive(req, res); if (!att) return;
  if (att.status !== 'in_progress') return res.status(409).json({ error: 'Exam already submitted.', submitted: true });
  if (Date.now() > Date.parse(att.deadline_at) + LATE_GRACE_MS) {
    await svc.submit(att.id, 'time_up');
    return res.status(409).json({ error: 'Time is up.', submitted: true });
  }
  const { question_id, selected_index } = req.body || {};
  const entry = (await svc.attemptLayout(att)).find((l) => l.id === Number(question_id));
  if (!entry) return bad(res, 'Invalid question');
  const shown = selected_index === null || selected_index === undefined ? null : Number(selected_index);   // index as displayed to this candidate
  if (shown !== null && (!Number.isInteger(shown) || shown < 0 || shown >= entry.perm.length)) return bad(res, 'Invalid option');
  const sel = shown === null ? null : entry.perm[shown];                                                    // stored as original option index
  await db.prepare(`INSERT INTO answers (attempt_id,question_id,selected_index) VALUES (?,?,?)
    ON CONFLICT(attempt_id,question_id) DO UPDATE SET selected_index=excluded.selected_index`).run(att.id, Number(question_id), sel);
  res.json({ ok: true });
});

router.post('/attempts/:aid/violation', async (req, res) => {
  const att = await ownLive(req, res); if (!att) return;
  if (att.status !== 'in_progress') return res.json({ submitted: true });
  const type = String((req.body && req.body.type) || 'unknown').slice(0, 40);
  const log = JSON.parse(att.violation_log);
  log.push({ type, at: new Date().toISOString() });
  const n = att.violations + 1;
  await db.prepare('UPDATE attempts SET violations=?, violation_log=? WHERE id=?').run(n, JSON.stringify(log), att.id);
  if (n >= cfg.VIOLATION_LIMIT) {
    await svc.submit(att.id, 'violation', await svc.toOriginal(att, req.body && req.body.answers));
    return res.json({ submitted: true, violations: n });
  }
  res.json({ submitted: false, violations: n, limit: cfg.VIOLATION_LIMIT });
});

router.post('/attempts/:aid/submit', async (req, res) => {
  const att = await ownLive(req, res); if (!att) return;
  if (att.status === 'in_progress') {
    const late = Date.now() > Date.parse(att.deadline_at) + LATE_GRACE_MS;
    const reason = req.body && req.body.reason === 'time_up' ? 'time_up' : 'manual';
    // After the deadline only the already-saved answers count.
    await svc.submit(att.id, late ? 'time_up' : reason, late ? undefined : await svc.toOriginal(att, req.body && req.body.answers));
  }
  res.json({ ok: true, attempt_id: att.id });
});

module.exports = router;
