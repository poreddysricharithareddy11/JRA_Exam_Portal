// Admin-only features: correcting a question after candidates took the exam (answer / marks / award to all),
// recalculation, change log, and re-sending corrected results (through a fake SMTP server).
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const PORT = 3994, SMTP_PORT = 2527, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-admin-'));
const inbox = [];

const smtp = net.createServer((sock) => {
  let buf = '', inData = false, rcpt = [];
  sock.write('220 fake\r\n');
  sock.on('data', (c) => {
    buf += c.toString('latin1');
    for (;;) {
      if (inData) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; inbox.push({ to: rcpt.slice(), raw: buf.slice(0, i) }); rcpt = []; buf = buf.slice(i + 5); inData = false; sock.write('250 ok\r\n'); continue; }
      const i = buf.indexOf('\r\n'); if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd === 'AUTH') sock.write(/BADPASS/.test(Buffer.from(line.split(' ').pop(), 'base64').toString()) ? '535 5.7.8 Username and Password not accepted\r\n' : '235 ok\r\n');
      else if (cmd === 'RCPT') { rcpt.push(line.replace(/.*<(.*)>.*/, '$1')); sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});

const jar = (c = { cookie: '' }) => c;
const call = async (c, m, u, body) => {
  const r = await fetch(BASE + u, { method: m, headers: { ...(c.cookie ? { cookie: c.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const wait = async (cond, ms = 12000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

(async () => {
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false', SMTP_USER: 'sender@test.com', SMTP_PASS: 'goodpass1234' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }
    const admin = jar();
    await call(admin, 'POST', '/api/auth/login', { username: 'adm', password: 'Adm1nPass!' });
    const now = Date.now();

    /* ===== exam: 4 questions, 2 marks each, -1 per wrong, pass 50% ===== */
    const eid = (await call(admin, 'POST', '/api/admin/exams', { name: 'Scoring', duration_min: 30, pass_percent: 50, negative_marks: 1, default_marks: 2,
      start_at: new Date(now - 6e4).toISOString(), end_at: new Date(now + 36e5).toISOString() })).data.id;
    const bank = '1. Q1?\nA) a\nB) b\nC) c\nAnswer: A\n2. Q2?\nA) a\nB) b\nC) c\nAnswer: B\n3. Q3?\nA) a\nB) b\nC) c\nAnswer: C\n4. Q4?\nA) a\nB) b\nC) c\nAnswer: A';
    const fd = new FormData(); fd.append('text', bank);
    assert.equal((await fetch(`${BASE}/api/admin/exams/${eid}/questions/upload`, { method: 'POST', headers: { cookie: admin.cookie }, body: fd })).status, 200);
    assert.equal((await call(admin, 'POST', `/api/admin/exams/${eid}/publish`, { published: true })).status, 200);
    const qs = (await call(admin, 'GET', `/api/admin/exams/${eid}`)).data.questions;   // original order, ids

    // before anyone starts: no attempt_count, scoring PATCH is allowed (no recalculation needed)
    let d = (await call(admin, 'GET', `/api/admin/exams/${eid}`)).data;
    assert.equal(d.attempt_count, 0); assert.equal(d.locked, false);

    /* ===== two candidates answer by *original option*, mapped through their shuffled view ===== */
    const people = {};
    async function sit(user, picks) {   // picks[i] = original option index for bank question i, or null
      await call(admin, 'POST', '/api/admin/users', { username: user, password: 'secret1', email: `${user}@x.com` });
      const c = jar(); await call(c, 'POST', '/api/auth/login', { username: user, password: 'secret1' });
      const st = (await call(c, 'POST', `/api/user/exams/${eid}/start`)).data;
      const ans = {};
      st.questions.forEach((q) => {
        const bi = qs.findIndex((x) => x.id === q.id); const orig = qs[bi];
        if (picks[bi] != null) ans[q.id] = q.options.indexOf(orig.options[picks[bi]]);
      });
      await call(c, 'POST', `/api/user/attempts/${st.attempt.id}/submit`, { answers: ans });
      people[user] = { c, att: st.attempt.id };
    }
    // alice: Q1 right(A) Q2 wrong(A) Q3 right(C) Q4 blank  -> 2 -1 +2 +0 = 3 / 8 = 37.5%  FAIL
    await sit('alice', [0, 0, 2, null]);
    // bob:   Q1 right Q2 right Q3 wrong(A) Q4 right      -> 2 +2 -1 +2 = 5 / 8 = 62.5%  PASS
    await sit('bob', [0, 1, 0, 0]);
    const score = async (u) => (await call(admin, 'GET', `/api/admin/attempts/${people[u].att}`)).data.attempt;
    let a = await score('alice'), b = await score('bob');
    assert.deepEqual([a.score, a.total, a.passed], [3, 8, 0]); assert.deepEqual([b.score, b.total, b.passed], [5, 8, 1]);

    d = (await call(admin, 'GET', `/api/admin/exams/${eid}`)).data;
    assert.equal(d.locked, true); assert.equal(d.attempt_count, 2); assert.equal(d.submitted_count, 2);

    /* ===== only the admin can correct; text/options stay locked ===== */
    assert.equal((await call(people.alice.c, 'PATCH', `/api/admin/questions/${qs[1].id}/scoring`, { correct_index: 0 })).status, 403, 'candidates cannot change the key');
    assert.equal((await call(admin, 'PUT', `/api/admin/questions/${qs[1].id}`, { text: 'changed', options: ['x', 'y'], correct_index: 0 })).status, 409, 'text/options locked after attempts');
    assert.equal((await call(admin, 'DELETE', `/api/admin/questions/${qs[1].id}`)).status, 409);
    assert.equal((await call(admin, 'PATCH', `/api/admin/questions/${qs[1].id}/scoring`, { correct_index: 7 })).status, 400, 'invalid option rejected');
    assert.equal((await call(admin, 'PATCH', `/api/admin/questions/${qs[1].id}/scoring`, { marks: 0 })).status, 400, 'invalid marks rejected');
    assert.equal((await call(admin, 'PATCH', `/api/admin/questions/${qs[1].id}/scoring`, { correct_index: null })).status, 400, 'cannot leave a started exam without an answer');

    /* ===== published exam: the answer key and marks are locked; only "add marks" (award to everyone) is allowed ===== */
    let r = await call(admin, 'PATCH', `/api/admin/questions/${qs[1].id}/scoring`, { correct_index: 0 });
    assert.equal(r.status, 409, 'answer key is locked once published');
    r = await call(admin, 'PATCH', `/api/admin/questions/${qs[0].id}/scoring`, { marks: 4 });
    assert.equal(r.status, 409, 'marks are locked once published');
    a = await score('alice'); b = await score('bob');
    assert.deepEqual([a.score, b.score], [3, 5], 'nothing was recalculated');

    /* ===== the question bank PDF (admin only) ===== */
    const bankPdf = await fetch(`${BASE}/api/admin/exams/${eid}/questions.pdf`, { headers: { cookie: admin.cookie } });
    assert.equal(bankPdf.status, 200); assert.match(bankPdf.headers.get('content-type'), /pdf/);
    assert.equal(Buffer.from(await bankPdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await fetch(`${BASE}/api/admin/exams/${eid}/questions.pdf`, { headers: { cookie: people.alice.c.cookie } })).status, 403, 'candidates cannot download the bank');

    /* ===== 3) Q3 was a faulty question: award its marks to everyone (alice blank/right, bob wrong -> no penalty) ===== */
    r = await call(admin, 'PATCH', `/api/admin/questions/${qs[2].id}/scoring`, { grace: true });
    assert.equal(r.data.rescored, 1, 'only bob changes (alice already had Q3 right)');
    a = await score('alice'); b = await score('bob');
    assert.equal(a.score, 3, 'alice already had Q3 right: unchanged'); assert.equal(b.score, 8, 'bob: penalty removed (+1) and full marks (+2) -> 8');
    // Q4 unanswered by alice: grace on it gives her the marks too
    r = await call(admin, 'PATCH', `/api/admin/questions/${qs[3].id}/scoring`, { grace: true });
    a = await score('alice'); assert.equal(a.score, 5, 'unanswered question awarded to everyone: alice 5/8');
    assert.equal(a.unanswered, 0);
    // the candidate's own review marks it as awarded to all and shows the right option
    const rv = (await call(people.alice.c, 'GET', `/api/user/attempts/${people.alice.att}/result`)).data;
    assert.equal(rv.questions.filter((q) => q.result === 'bonus').length, 2, 'two questions shown as awarded to all');
    assert.ok(rv.attempt.score === 5);
    // PDF still builds
    const pdf = await fetch(`${BASE}/api/user/attempts/${people.alice.att}/pdf`, { headers: { cookie: people.alice.c.cookie } });
    assert.equal((await pdf.arrayBuffer()).byteLength > 1000, true);
    // removing the award restores scoring
    r = await call(admin, 'PATCH', `/api/admin/questions/${qs[3].id}/scoring`, { grace: false });
    a = await score('alice'); assert.equal(a.score, 3, 'back to 3 / 8');
    // no-op change reports unchanged and does not log
    r = await call(admin, 'PATCH', `/api/admin/questions/${qs[3].id}/scoring`, { grace: false });
    assert.equal(r.data.unchanged, true);

    /* ===== change log ===== */
    const log = (await call(admin, 'GET', `/api/admin/exams/${eid}/changes`)).data.changes;
    assert.equal(log.length, 3, 'every real change recorded'); assert.ok(log.every((c) => c.admin === 'adm'));
    assert.ok(log.some((c) => /awarded to every candidate/.test(c.summary)));

    /* ===== results table and CSV reflect the recalculation ===== */
    const res = (await call(admin, 'GET', `/api/admin/exams/${eid}/results`)).data;
    assert.equal(res.results.find((x) => x.username === 'alice').score, 3);
    assert.equal(res.summary.submitted, 2);

    // with e-mail configured the corrected results can be re-sent to everyone, and the stats say it is configured
    assert.equal((await call(admin, 'GET', '/api/admin/stats')).data.smtp_configured, true);
    const before = inbox.length;
    r = await call(admin, 'POST', `/api/admin/exams/${eid}/resend-all`);
    assert.equal(r.status, 200); assert.equal(r.data.queued, 2);
    assert.ok(await wait(() => inbox.length >= before + 2), 'updated result e-mails sent');
    assert.ok(inbox.slice(before).every((m) => /application\/pdf/.test(m.raw)), 'with the PDF attached');

    // the company logo is served publicly (the sign-in page needs it)
    const logoRes = await fetch(BASE + '/brand/logo');
    assert.equal(logoRes.status, 200); assert.match(logoRes.headers.get('content-type'), /^image\//);

    /* ===== a published exam: only the closing time can be extended ===== */
    const cur = (await call(admin, 'GET', `/api/admin/exams/${eid}`)).data.exam;
    assert.equal(cur.published, 1);
    const later = new Date(Date.parse(cur.end_at) + 36e5).toISOString();
    r = await call(admin, 'PUT', `/api/admin/exams/${eid}`, { name: 'Renamed' });
    assert.equal(r.status, 409, 'name is locked once published');
    r = await call(admin, 'PUT', `/api/admin/exams/${eid}`, { start_at: new Date(now - 36e5).toISOString() });
    assert.equal(r.status, 409, 'opening time is locked once published');
    r = await call(admin, 'PUT', `/api/admin/exams/${eid}`, { questions_per_attempt: 2 });
    assert.equal(r.status, 409, 'questions per candidate is locked once published');
    r = await call(admin, 'PUT', `/api/admin/exams/${eid}`, { num_sets: 3 });
    assert.equal(r.status, 409, 'number of sets is locked once published');
    r = await call(admin, 'PUT', `/api/admin/exams/${eid}`, { end_at: new Date(Date.parse(cur.end_at) - 6e4).toISOString() });
    assert.equal(r.status, 409, 'closing time cannot be brought forward');
    r = await call(admin, 'PUT', `/api/admin/exams/${eid}`, { end_at: later });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await call(admin, 'GET', `/api/admin/exams/${eid}`)).data.exam.end_at, later, 'closing time extended');
    assert.equal((await call(admin, 'GET', `/api/admin/exams/${eid}`)).data.exam.name, cur.name, 'nothing else changed');

    /* ===== deleting an exam needs the admin password ===== */
    assert.equal((await call(admin, 'DELETE', `/api/admin/exams/${eid}`)).status, 400, 'no password');
    r = await call(admin, 'DELETE', `/api/admin/exams/${eid}`, { password: 'wrong-password' });
    assert.equal(r.status, 403); assert.match(r.data.error, /Incorrect password/);
    assert.equal((await call(admin, 'GET', `/api/admin/exams/${eid}`)).status, 200, 'still there after a wrong password');
    assert.equal((await call(admin, 'DELETE', `/api/admin/exams/${eid}`, { password: 'Adm1nPass!' })).status, 200, 'deleted with the right password');
    assert.equal((await call(admin, 'GET', `/api/admin/exams/${eid}`)).status, 404, 'gone');

    console.log('ADMIN TESTS PASSED');
  } catch (e) { console.error('ADMIN TEST FAILED:', e); process.exitCode = 1; }
  finally { srv.kill(); smtp.close(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(); }, 600); }
})();
