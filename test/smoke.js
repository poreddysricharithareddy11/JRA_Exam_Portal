// End-to-end smoke test: boots the server on a temp DB and walks through the main flows.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-'));

function client() {
  let cookie = '';
  return async (method, url, body, form) => {
    const headers = cookie ? { cookie } : {};
    if (body && !form) headers['content-type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers, body: form ? body : body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}

const BANK = `Sample Paper
1. What is 2 + 2?
A) 3
B) 4
C) 5
D) 6
2. Capital of France?
A. Berlin   B. Paris   C. Rome   D. Madrid
3. Which is a prime number?
(a) 4
(b) 6
(c) 7
(d) 9
Answer Key
1. B  2. B  3. C
`;

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'jayarama_exam', ADMIN_PASSWORD: 'Jayarama@123', SMTP_USER: '', SMTP_PASS: '' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }

    const admin = client();
    let r = await admin('POST', '/api/auth/login', { username: 'jayarama_exam', password: 'wrong', role: 'admin' });
    assert.equal(r.status, 401, 'bad password rejected');
    r = await admin('POST', '/api/auth/login', { username: 'jayarama_exam', password: 'Jayarama@123', role: 'user' });
    assert.equal(r.status, 401, 'admin cannot log in on the candidate tab');
    r = await admin('POST', '/api/auth/login', { username: 'jayarama_exam', password: 'Jayarama@123', role: 'admin' });
    assert.equal(r.status, 200, 'admin login');

    // users
    for (const n of ['stu1', 'stu2']) {
      r = await admin('POST', '/api/admin/users', { username: n, password: 'secret1', email: `${n}@example.com`, full_name: n.toUpperCase() });
      assert.equal(r.status, 200, 'create user ' + n);
    }
    r = await admin('POST', '/api/admin/users', { username: 'stu1', password: 'secret1', email: 'a@b.co' });
    assert.equal(r.status, 409, 'duplicate username');

    // exam open now
    const now = Date.now();
    r = await admin('POST', '/api/admin/exams', { name: 'Maths Test', duration_min: 30, pass_percent: 50, negative_marks: 0.5, default_marks: 2,
      start_at: new Date(now - 60000).toISOString(), end_at: new Date(now + 3600000).toISOString() });
    assert.equal(r.status, 200); const eid = r.data.id;

    r = await admin('POST', `/api/admin/exams/${eid}/publish`, { published: true });
    assert.equal(r.status, 400, 'cannot publish empty exam');

    // ONE question bank: 5 questions, the key in the file covers only the first 3
    const bank5 = BANK.replace('Answer Key\n', '4. 1+1?\nA) 1\nB) 2\n5. 3+3?\nA) 6\nB) 7\nAnswer Key\n');
    const fd = new FormData(); fd.append('text', bank5);
    r = await admin('POST', '/api/admin/exams/' + eid + '/questions/upload', fd, true);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.added, 5); assert.equal(r.data.with_answers, 3, 'answer key section parsed');
    r = await admin('POST', '/api/admin/exams/' + eid + '/publish', { published: true });
    assert.equal(r.status, 400, 'publish blocked while some answers are missing');
    // the two answers missing from the file are chosen by the admin in the question list
    const bank = (await admin('GET', '/api/admin/exams/' + eid)).data.questions;
    assert.equal(bank.filter((q) => q.correct_index == null).length, 2);
    for (const [q, a] of [[bank[3], 1], [bank[4], 0]]) {
      r = await admin('PUT', '/api/admin/questions/' + q.id, { text: q.text, options: q.options, correct_index: a, marks: q.marks });
      assert.equal(r.status, 200);
    }
    r = await admin('POST', '/api/admin/exams/' + eid + '/publish', { published: true });
    assert.equal(r.status, 200, 'published');
    r = await admin('GET', '/api/admin/exams/' + eid + '/sets');
    assert.equal(r.data.sets.length, 1); assert.equal(r.data.sets[0].count, 5, 'one set holding the whole bank');

    // student 1: answers 1 right, 1 wrong, then two violations -> auto-submit
    const s1 = client();
    await s1('POST', '/api/auth/login', { username: 'stu1', password: 'secret1', role: 'user' });
    r = await s1('GET', '/api/user/exams');
    assert.equal(r.data.exams.length, 1);
    assert.equal((await s1('GET', '/api/user/reports')).data.reports.length, 0, 'no reports yet');
    r = await s1('POST', `/api/user/exams/${eid}/start`);
    assert.equal(r.status, 200); const att = r.data.attempt.id;
    assert.ok(!JSON.stringify(r.data.questions).includes('correct_index'), 'key not leaked to candidate');
    const qs = r.data.questions;
    assert.equal(qs.length, 5, 'both sets are merged into one pool of 5');
    const keyMap = new Map((await admin('GET', '/api/admin/exams/' + eid)).data.questions.map((q) => [q.id, q]));
    const shownCorrect = (q) => { const o = keyMap.get(q.id); return q.options.indexOf(o.options[o.correct_index]); };
    await s1('POST', '/api/user/attempts/' + att + '/answer', { question_id: qs[0].id, selected_index: shownCorrect(qs[0]) });
    await s1('POST', '/api/user/attempts/' + att + '/answer', { question_id: qs[1].id, selected_index: (shownCorrect(qs[1]) + 1) % qs[1].options.length });
    assert.equal((await s1('GET', '/api/user/attempts/' + att + '/result')).status, 403, 'key hidden until submit');
    r = await s1('POST', '/api/user/attempts/' + att + '/violation', { type: 'tab_switch' });
    assert.deepEqual([r.data.submitted, r.data.violations], [false, 1], '1st violation = warning');
    r = await s1('POST', '/api/user/attempts/' + att + '/violation', { type: 'fullscreen_exit' });
    assert.equal(r.data.submitted, true, '2nd violation auto-submits');
    r = await s1('GET', '/api/user/attempts/' + att + '/result');
    assert.equal(r.status, 200); assert.equal(r.data.attempt.submit_reason, 'violation');
    assert.equal(r.data.attempt.correct, 1); assert.equal(r.data.attempt.wrong, 1);
    assert.equal(r.data.attempt.score, 2 - 0.5, 'negative marking applied (2 marks - 0.5)');
    r = await s1('POST', `/api/user/exams/${eid}/start`);
    assert.equal(r.status, 409, 'single attempt only');
    r = await s1('POST', `/api/user/attempts/${att}/answer`, { question_id: qs[0].id, selected_index: 0 });
    assert.equal(r.status, 409, 'cannot answer after submit');
    r = await s1('GET', `/api/user/attempts/${att}/pdf`);
    assert.equal(r.status, 200); assert.ok(r.data.slice(0, 4).toString() === '%PDF', 'PDF generated');
    assert.equal((await s1('GET', '/api/user/reports')).data.reports.length, 1);

    // student 2 gets the other set (round robin), submits manually
    const s2 = client();
    await s2('POST', '/api/auth/login', { username: 'stu2', password: 'secret1', role: 'user' });
    r = await s2('POST', `/api/user/exams/${eid}/start`);
    r = await s2('POST', `/api/user/attempts/${r.data.attempt.id}/submit`, { answers: {} });
    assert.equal(r.status, 200);

    // access control
    assert.equal((await s1('GET', '/api/admin/users')).status, 403, 'candidate blocked from admin API');
    assert.equal((await client()('GET', '/api/user/exams')).status, 401, 'anonymous blocked');

    // exam window enforcement
    r = await admin('POST', '/api/admin/exams', { name: 'Future', duration_min: 10, pass_percent: 40,
      start_at: new Date(now + 3600e3).toISOString(), end_at: new Date(now + 7200e3).toISOString() });
    const fid = r.data.id;
    const fdq = new FormData(); fdq.append('text', '1. Q?\nA) x\nB) y\nAnswer: A');
    console.log('UP', JSON.stringify((await admin('POST', `/api/admin/exams/${fid}/questions/upload`, fdq, true)).data));
    console.log('PUB', JSON.stringify((await admin('POST', `/api/admin/exams/${fid}/publish`, { published: true })).data));
    r = await s2('POST', `/api/user/exams/${fid}/start`);
    assert.equal(r.status, 403, 'cannot start before opening time');

    // blank instructions get the default text; custom ones are kept
    r = await s1('GET', `/api/user/exams/${eid}/info`);
    assert.ok(r.data.default_instructions.join(' ').includes('Read each question'), 'standard instructions always provided');
    assert.equal(r.data.exam.instructions, '', 'nothing extra from administration when left blank');
    r = await admin('POST', '/api/admin/exams', { name: 'Custom ins', duration_min: 10, pass_percent: 40, instructions: 'Bring your ID card.', start_at: new Date(now - 6e4).toISOString(), end_at: new Date(now + 36e5).toISOString() });
    assert.equal((await admin('GET', `/api/admin/exams/${r.data.id}`)).data.exam.instructions, 'Bring your ID card.');
    r = await admin('PUT', `/api/admin/exams/${r.data.id}`, { instructions: '   ' });
    assert.equal(r.status, 200);

    // results + csv
    r = await admin('GET', `/api/admin/exams/${eid}/results`);
    assert.equal(r.data.summary.submitted, 2);
    r = await admin('GET', `/api/admin/exams/${eid}/results.csv`);
    assert.ok(r.data.toString().includes('stu1'));
    r = await admin('PUT', `/api/admin/questions/${[...keyMap.keys()][0]}`, { text: 'x', options: ['a', 'b'] });
    assert.equal(r.status, 409, 'questions locked after attempts');

    // delete user
    const uid = (await admin('GET', '/api/admin/users')).data.users.find((u) => u.username === 'stu2').id;
    assert.equal((await admin('DELETE', `/api/admin/users/${uid}`)).status, 200);
    assert.equal((await s2('GET', '/api/user/exams')).status, 401, 'deleted user loses access immediately');

    console.log('\nALL SMOKE TESTS PASSED');
  } catch (e) {
    console.error('\nTEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(); }, 500);
  }
})();
