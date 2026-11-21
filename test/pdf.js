// Result PDF layout: no blank/extra pages, whatever the number or length of questions.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-pdf-'));
process.env.ADMIN_PASSWORD = 'x'; process.env.SMTP_USER = ''; process.env.SMTP_PASS = '';

const db = require('../src/db');
const svc = require('../src/service');
const { buildResultPdf } = require('../src/pdf');
const { openPdf } = require('../src/pdfjs');

const now = new Date().toISOString();
const exam = db.prepare("INSERT INTO exams (name,duration_min,pass_percent,negative_marks,default_marks,start_at,end_at,published) VALUES ('PDF layout',30,40,0.5,1,?,?,1)").run(now, new Date(Date.now() + 36e5).toISOString()).lastInsertRowid;
const user = db.prepare("INSERT INTO users (username,password_hash,full_name,email,role) VALUES ('pdfuser','x','PDF User','p@x.com','user')").run().lastInsertRowid;

/** Make an exam paper of n questions (optionally with very long text) and return the finished attempt id. */
function makeAttempt(n, long) {
  const q = db.prepare('INSERT INTO questions (exam_id,set_name,position,text,options,correct_index,marks) VALUES (?,?,?,?,?,?,1)');
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const text = `Question ${i} ` + (long ? 'lorem ipsum dolor sit amet consectetur '.repeat(14) : 'about something?');
    ids.push(q.run(exam, '1', i, text, JSON.stringify(['first option ' + (long ? 'x '.repeat(40) : ''), 'second', 'third', 'fourth']), 1).lastInsertRowid);
  }
  const layout = ids.map((id) => ({ id, perm: [0, 1, 2, 3] }));
  const a = db.prepare("INSERT INTO attempts (exam_id,user_id,set_name,started_at,deadline_at,layout,paper_sig) VALUES (?,?,'1',?,?,?,?)")
    .run(exam, user + 0, now, now, JSON.stringify(layout), 'sig-' + n + '-' + Math.random()).lastInsertRowid;
  svc.finalize(a, 'manual', Object.fromEntries(ids.slice(0, Math.ceil(n / 2)).map((id) => [id, 1])));
  return { a, ids };
}

async function pagesOf(buf) {
  const { doc } = await openPdf(buf);
  try {
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      out.push((await page.getTextContent()).items.map((i) => i.str).join(' '));
    }
    return out;
  } finally { await doc.destroy(); }
}

(async () => {
  let checked = 0;
  for (const [n, long] of [[1, false], [3, false], [8, false], [13, false], [14, false], [15, false], [25, false], [60, false], [4, true], [12, true]]) {
    // fresh user per attempt (one attempt per user and exam)
    db.prepare('DELETE FROM attempts').run(); db.prepare('DELETE FROM questions').run();
    const { a } = makeAttempt(n, long);
    const pages = await pagesOf(await buildResultPdf(a));
    const label = `${n} question(s)${long ? ' (long text)' : ''}`;
    assert.ok(pages.length >= 1, label + ': has pages');
    pages.forEach((t, i) => {
      assert.ok(/Q\d+\./.test(t), `${label}: page ${i + 1} of ${pages.length} has no questions on it (blank/extra page)`);
      assert.ok(new RegExp(`Page ${i + 1} of ${pages.length}`).test(t), `${label}: page ${i + 1} footer shows the right page count`);
    });
    const all = pages.join(' ');
    for (let i = 1; i <= n; i++) assert.ok(new RegExp(`Q${i}\\.`).test(all), `${label}: question ${i} is present`);
    if (n <= 8 && !long) assert.equal(pages.length, 1, `${label}: fits on a single page, so exactly one page`);
    checked++;
  }
  console.log(`PDF LAYOUT TESTS PASSED (${checked} sizes, no blank pages)`);
  process.exit();
})().catch((e) => { console.error('PDF LAYOUT TEST FAILED:', e.message); process.exit(1); });
