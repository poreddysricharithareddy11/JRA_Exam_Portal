// Core exam logic: status, scoring, finalising attempts, review data.
const crypto = require('crypto');
const db = require('./db');

const LETTERS = 'ABCDEFGH';

function examStatus(exam, now = Date.now()) {
  if (!exam.published) return 'draft';
  if (now < Date.parse(exam.start_at)) return 'upcoming';
  if (now <= Date.parse(exam.end_at)) return 'live';
  return 'ended';
}

const setsOf = (examId) => db.prepare(`SELECT set_name, COUNT(*) AS count, SUM(marks) AS total,
      SUM(CASE WHEN correct_index IS NULL THEN 1 ELSE 0 END) AS missing_key
    FROM questions WHERE exam_id=? GROUP BY set_name ORDER BY set_name`).all(examId);

const parseQ = (q) => ({ ...q, options: JSON.parse(q.options) });

/* ---------- per-candidate random papers ---------- */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** How many questions each candidate gets, given the pool size. */
const paperSize = (exam, poolCount) => (exam.questions_per_attempt && exam.questions_per_attempt < poolCount ? exam.questions_per_attempt : poolCount);

/**
 * Build the exam's question sets: `exam.num_sets` sets, each a random draw of paperSize questions from the one
 * question bank. Sets are made different from each other where the bank allows it.
 */
async function generateSets(exam) {
  const pool = (await db.prepare('SELECT id FROM questions WHERE exam_id=?').all(exam.id)).map((r) => r.id);
  const n = paperSize(exam, pool.length);
  const count = Math.max(1, Math.min(100, exam.num_sets || 1));
  const seen = new Set(), sets = [];
  for (let s = 1; s <= count && pool.length; s++) {
    let ids;
    for (let t = 0; t < 300; t++) {
      ids = shuffle(pool.slice()).slice(0, n).sort((a, b) => a - b);
      if (!seen.has(ids.join(','))) break;       // identical draws are only unavoidable when n === pool size
    }
    seen.add(ids.join(',')); sets.push(ids);
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM exam_sets WHERE exam_id=?').run(exam.id);
    const ins = db.prepare('INSERT INTO exam_sets (exam_id,set_no,question_ids) VALUES (?,?,?)');
    for (const [i, ids] of sets.entries()) await ins.run(exam.id, i + 1, JSON.stringify(ids));
  })();
  return sets.length;
}
const examSets = async (examId) => (await db.prepare('SELECT set_no,question_ids FROM exam_sets WHERE exam_id=? ORDER BY set_no').all(examId))
  .map((r) => ({ set_no: r.set_no, ids: JSON.parse(r.question_ids) }));
/** Rebuild the sets unless candidates have already started (then they are frozen). */
async function refreshSets(examId) {
  if (await db.prepare('SELECT 1 FROM attempts WHERE exam_id=? LIMIT 1').get(examId)) return;
  const e = await db.prepare('SELECT * FROM exams WHERE id=?').get(examId);
  if (e) await generateSets(e);
}

/** A candidate's own paper from a set: the set's questions in a random order, each with its options shuffled. */
async function layoutForSet(ids) {
  const rows = await rowsById(ids);
  return shuffle(ids.slice()).filter((id) => rows.has(id)).map((id) => ({ id, perm: shuffle([...Array(JSON.parse(rows.get(id).options).length).keys()]) }));
}

/** Random draw + random order + random option order. layout[i] = { id, perm } where perm[displayPos] = originalOptionIndex. */
function randomLayout(exam, pool) {
  const chosen = shuffle(pool.slice()).slice(0, paperSize(exam, pool.length));
  return chosen.map((q) => ({ id: q.id, perm: shuffle([...Array(JSON.parse(q.options).length).keys()]) }));
}
const layoutSig = (layout) => layout.map((l) => l.id + ':' + l.perm.join('')).join('|');

/** The paper an attempt was given. Attempts created before this feature fall back to the stored set in natural order. */
async function attemptLayout(att) {
  if (att.layout) return JSON.parse(att.layout);
  return (await db.prepare('SELECT id,options FROM questions WHERE exam_id=? AND set_name=? ORDER BY position').all(att.exam_id, att.set_name))
    .map((q) => ({ id: q.id, perm: [...Array(JSON.parse(q.options).length).keys()] }));
}
async function rowsById(ids) {
  if (!ids.length) return new Map();
  const rows = await db.prepare(`SELECT id,position,text,options,correct_index,marks,grace FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return new Map(rows.map((q) => [q.id, q]));
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Score one paper. qs = the candidate's question rows (marks, correct_index, grace); given = Map(questionId -> chosen original index).
 * A question the admin flagged "grace" (e.g. it was wrong) gives full marks to everybody and never costs negative marks.
 */
function computeScore(exam, qs, given) {
  let score = 0, total = 0, correct = 0, wrong = 0, unanswered = 0;
  for (const q of qs) {
    total += q.marks;
    if (q.grace) { correct++; score += q.marks; continue; }
    const sel = given.get(q.id);
    if (sel == null) unanswered++;
    else if (sel === q.correct_index) { correct++; score += q.marks; }
    else { wrong++; score -= exam.negative_marks; }
  }
  score = Math.max(0, round2(score)); total = round2(total);   // negative marking can lower a score but never below zero
  const percent = total > 0 ? round2((score / total) * 100) : 0;
  return { score, total, correct, wrong, unanswered, percent, passed: percent >= exam.pass_percent ? 1 : 0 };
}

/** Recalculate every submitted attempt of an exam from the current key / marks / grace flags. */
const rescoreExam = db.transaction(async (examId) => {
  const exam = await db.prepare('SELECT * FROM exams WHERE id=?').get(examId);
  const atts = await db.prepare("SELECT * FROM attempts WHERE exam_id=? AND status='submitted'").all(examId);
  const upd = db.prepare('UPDATE attempts SET score=?, total=?, correct=?, wrong=?, unanswered=?, percent=?, passed=? WHERE id=?');
  let changed = 0, flipped = 0;
  for (const a of atts) {
    const layout = await attemptLayout(a);
    const byId = await rowsById(layout.map((l) => l.id));
    const qs = layout.map((l) => byId.get(l.id)).filter(Boolean);
    const given = new Map((await db.prepare('SELECT question_id,selected_index FROM answers WHERE attempt_id=?').all(a.id)).map((x) => [x.question_id, x.selected_index]));
    const c = computeScore(exam, qs, given);
    if (c.score !== a.score || c.total !== a.total || c.correct !== a.correct || c.wrong !== a.wrong || c.passed !== a.passed) {
      changed++; if (c.passed !== a.passed) flipped++;
      await upd.run(c.score, c.total, c.correct, c.wrong, c.unanswered, c.percent, c.passed, a.id);
    }
  }
  return { total: atts.length, changed, flipped };
});

/** Convert a { questionId: displayedIndex } map from the browser to original option indexes. */
async function toOriginal(att, answers) {
  if (!answers || typeof answers !== 'object') return undefined;
  const perms = new Map((await attemptLayout(att)).map((l) => [l.id, l.perm]));
  const out = {};
  for (const [qid, d] of Object.entries(answers)) {
    const perm = perms.get(Number(qid));
    if (!perm) continue;
    out[qid] = Number.isInteger(d) && d >= 0 && d < perm.length ? perm[d] : null;
  }
  return out;
}

// Pending email hook is injected by mailer to avoid a circular import.
let onSubmitted = () => {};
function setSubmitHook(fn) { onSubmitted = fn; }

/**
 * Score and close an attempt. Idempotent: only the first caller wins (the row lock taken by the first UPDATE
 * makes a concurrent second caller wait, then find the attempt already closed).
 * `answers` (optional) is a { questionId: selectedIndex|null } map to merge first.
 */
const finalize = db.transaction(async (attemptId, reason, answers) => {
  const lock = await db.prepare("UPDATE attempts SET submit_reason=submit_reason WHERE id=? AND status='in_progress'").run(attemptId);
  if (!lock.changes) return null;
  const att = await db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId);
  const exam = await db.prepare('SELECT * FROM exams WHERE id=?').get(att.exam_id);

  const layout = await attemptLayout(att);
  const byId = await rowsById(layout.map((l) => l.id));
  const qs = layout.map((l) => byId.get(l.id)).filter(Boolean);
  const valid = new Map(qs.map((q) => [q.id, JSON.parse(q.options).length]));

  if (answers && typeof answers === 'object') {
    const rows = [];
    for (const [qid, idx] of Object.entries(answers)) {
      const n = valid.get(Number(qid));
      if (n == null) continue;
      rows.push([attemptId, Number(qid), Number.isInteger(idx) && idx >= 0 && idx < n ? idx : null]);
    }
    if (rows.length) {   // one multi-row upsert instead of one round trip per question
      await db.prepare(`INSERT INTO answers (attempt_id,question_id,selected_index) VALUES ${rows.map(() => '(?,?,?)').join(',')}
        ON CONFLICT(attempt_id,question_id) DO UPDATE SET selected_index=excluded.selected_index`).run(...rows.flat());
    }
  }

  const given = new Map((await db.prepare('SELECT question_id,selected_index FROM answers WHERE attempt_id=?')
    .all(attemptId)).map((a) => [a.question_id, a.selected_index]));

  const { score, total, correct, wrong, unanswered, percent, passed } = computeScore(exam, qs, given);

  await db.prepare(`UPDATE attempts SET status='submitted', submitted_at=?, submit_reason=?, score=?, total=?,
      correct=?, wrong=?, unanswered=?, percent=?, passed=?, email_status='pending' WHERE id=?`)
    .run(new Date().toISOString(), reason, score, total, correct, wrong, unanswered, percent, passed, attemptId);
  return attemptId;
});

async function submit(attemptId, reason, answers) {
  const r = await finalize(attemptId, reason, answers);
  if (r) setImmediate(() => onSubmitted(attemptId));
  return r;
}

/** Auto-close attempts whose time ran out (e.g. the browser was closed). */
async function sweepExpired(graceMs = 12000) {
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  const rows = await db.prepare("SELECT id FROM attempts WHERE status='in_progress' AND deadline_at < ?").all(cutoff);
  for (const r of rows) await submit(r.id, 'time_up');
  return rows.length;
}

/** Full question-by-question review of a submitted attempt. */
async function review(attemptId) {
  const att = await db.prepare(`SELECT a.*, e.name AS exam_name, e.pass_percent, e.negative_marks, e.duration_min,
      u.username, u.full_name, u.email
    FROM attempts a JOIN exams e ON e.id=a.exam_id JOIN users u ON u.id=a.user_id WHERE a.id=?`).get(attemptId);
  if (!att) return null;
  // Show the paper exactly as this candidate saw it: their question order and their option order.
  const layout = await attemptLayout(att);
  const byId = await rowsById(layout.map((l) => l.id));
  const given = new Map((await db.prepare('SELECT question_id,selected_index FROM answers WHERE attempt_id=?').all(attemptId)).map((x) => [x.question_id, x.selected_index]));
  const questions = layout.filter((l) => byId.has(l.id)).map((l, i) => {
    const r = byId.get(l.id), opts = JSON.parse(r.options), sel = given.get(l.id);
    return {
      id: r.id, position: i + 1, text: r.text, marks: r.marks,
      options: l.perm.map((o) => opts[o]),
      correct_index: r.correct_index == null ? null : l.perm.indexOf(r.correct_index),
      selected_index: sel == null ? null : l.perm.indexOf(sel),
      grace: !!r.grace,
      result: r.grace ? 'bonus' : sel == null ? 'unanswered' : sel === r.correct_index ? 'correct' : 'wrong',
    };
  });
  return { attempt: att, questions };
}

module.exports = { computeScore, rescoreExam, LETTERS, examStatus, setsOf, parseQ, finalize, submit, sweepExpired, review, setSubmitHook, randomLayout, generateSets, examSets, refreshSets, layoutForSet, layoutSig, attemptLayout, rowsById, toOriginal, paperSize };
