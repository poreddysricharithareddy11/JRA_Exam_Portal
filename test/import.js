// Import wizard: real PDF -> parse (nothing saved) -> import into Set 1..4 (replaces) -> separate answer PDF.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PDFDocument = require('pdfkit');
const PORT = 3997, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-imp-'));

const pdfOf = (lines) => new Promise((res) => {
  const d = new PDFDocument(); const b = []; d.on('data', (c) => b.push(c)); d.on('end', () => res(Buffer.concat(b)));
  lines.forEach((l) => d.text(l)); d.end();
});
let cookie = '';
const call = async (m, u, body, form) => {
  const r = await fetch(BASE + u, { method: m, headers: { ...(cookie ? { cookie } : {}), ...(body && !form ? { 'content-type': 'application/json' } : {}) }, body: form ? body : body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const fileForm = (buf, name, extra = {}) => { const f = new FormData(); f.append('file', new Blob([buf]), name); Object.entries(extra).forEach(([k, v]) => f.append(k, v)); return f; };

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }
    await call('POST', '/api/auth/login', { username: 'adm', password: 'Adm1nPass!' });
    const now = Date.now();
    const eid = (await call('POST', '/api/admin/exams', { name: 'Imp', duration_min: 20, pass_percent: 40, start_at: new Date(now - 6e4).toISOString(), end_at: new Date(now + 36e5).toISOString() })).data.id;

    const withAnswers = await pdfOf(['General Knowledge Paper', '1. Capital of India?', 'A) Mumbai', 'B) New Delhi', 'C) Kolkata', 'D) Chennai', 'Answer: B',
      '2. Largest planet?', 'A) Earth', 'B) Mars', 'C) Jupiter', 'D) Venus', 'Answer: C']);
    let r = await call('POST', `/api/admin/exams/${eid}/questions/parse`, fileForm(withAnswers, 'bank.pdf'), true);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.questions.length, 2); assert.deepEqual(r.data.questions.map((q) => q.correct_index), [1, 2]);
    assert.equal((await call('GET', `/api/admin/exams/${eid}`)).data.questions.length, 0, 'parse does not save anything');

    // save into Set 1, then re-save: replaced, not appended
    for (let i = 0; i < 2; i++) { r = await call('POST', `/api/admin/exams/${eid}/questions/import`, { questions: r.data.questions }); assert.equal(r.status, 200); r = { data: { questions: r.data.added ? (await call('GET', `/api/admin/exams/${eid}`)).data.questions.map((q) => ({ text: q.text, options: q.options, correct_index: q.correct_index })) : [] } }; }
    assert.equal((await call('GET', `/api/admin/exams/${eid}`)).data.questions.length, 2, 'the bank is replaced, not duplicated');

    // a bank WITHOUT answers replaces the previous bank, then one separate answers PDF (no set numbers anywhere)
    const noAns = await pdfOf(['1. 2+2?', 'A) 3', 'B) 4', '2. 3+3?', 'A) 6', 'B) 7']);
    const p = await call('POST', `/api/admin/exams/${eid}/questions/parse`, fileForm(noAns, 'noans.pdf'), true);
    assert.equal(p.data.with_answers, 0);
    await call('POST', `/api/admin/exams/${eid}/questions/import`, { questions: p.data.questions });
    assert.equal((await call('GET', `/api/admin/exams/${eid}`)).data.questions.length, 2, 'new bank replaced the old one');
    assert.equal((await call('POST', `/api/admin/exams/${eid}/publish`, { published: true })).status, 400, 'blocked until key supplied');
    // the admin supplies the missing answers: pasted list mapped by the server, then saved with the bank
    r = await call('POST', '/api/admin/answers/map', { text: '1-B, 2-A, 9-C', options: p.data.questions.map((q) => q.options.length) });
    assert.equal(r.status, 200); assert.equal(r.data.applied, 2); assert.deepEqual(r.data.unmatched, [9]);
    const withKey = p.data.questions.map((q, i) => ({ ...q, correct_index: r.data.answers[i] }));
    await call('POST', `/api/admin/exams/${eid}/questions/import`, { questions: withKey });
    assert.equal((await call('POST', '/api/admin/answers/map', { text: 'nothing useful here', options: [2] })).status, 400);
    assert.equal((await call('POST', `/api/admin/exams/${eid}/publish`, { published: true })).status, 200);
    console.log('IMPORT TESTS PASSED');
  } catch (e) { console.error('IMPORT TEST FAILED:', e); process.exitCode = 1; }
  finally { srv.kill(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(); }, 500); }
})();
