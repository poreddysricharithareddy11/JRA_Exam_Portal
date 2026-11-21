// E-mail features against a local fake SMTP server (nothing leaves this machine).
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const PORT = 3996, SMTP_PORT = 2526, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-mail-'));
const inbox = [];

// Minimal SMTP server: accepts everything, stores the raw messages.
const smtp = net.createServer((sock) => {
  let data = '', inData = false, rcpt = [];
  sock.write('220 fake ESMTP\r\n');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    for (;;) {
      if (inData) {
        const i = buf.indexOf('\r\n.\r\n');
        if (i < 0) return;
        data = buf.slice(0, i); buf = buf.slice(i + 5); inData = false;
        inbox.push({ to: rcpt.slice(), raw: data }); rcpt = [];
        sock.write('250 queued\r\n'); continue;
      }
      const i = buf.indexOf('\r\n'); if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd === 'AUTH') sock.write('235 ok\r\n');
      else if (cmd === 'MAIL') sock.write('250 ok\r\n');
      else if (cmd === 'RCPT') { rcpt.push(line.replace(/.*<(.*)>.*/, '$1')); sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});

let cookie = '';
const call = async (m, u, body, c = null) => {
  const jar = c || { get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
  const r = await fetch(BASE + u, { method: m, headers: { ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar.cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const wait = async (cond, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const decode = (raw) => raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

(async () => {
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const start = (env) => spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!', ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  const up = async () => { for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); return; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } } };
  let srv = start({ SMTP_USER: '', SMTP_PASS: '' });
  try {
    await up();
    await call('POST', '/api/auth/login', { username: 'adm', password: 'Adm1nPass!' });
    const now = Date.now();
    const mk = async (name, startOff, extra = {}) => {
      const id = (await call('POST', '/api/admin/exams', { name, duration_min: 30, pass_percent: 40, start_at: new Date(now + startOff).toISOString(), end_at: new Date(now + startOff + 7200e3).toISOString(), ...extra })).data.id;
      const fd = new FormData(); fd.append('text', '1. Q one?\nA) a\nB) b\nAnswer: B\n2. Q two?\nA) a\nB) b\nAnswer: A');
      await fetch(BASE + `/api/admin/exams/${id}/questions/upload`, { method: 'POST', headers: { cookie }, body: fd });
      assert.equal((await call('POST', `/api/admin/exams/${id}/publish`, { published: true })).status, 200);
      return id;
    };
    const eid = await mk('Mail Exam', -60e3);
    for (const [u, e] of [['alice', 'alice@x.com'], ['bob', 'bob@x.com'], ['carol', 'carol@x.com']]) await call('POST', '/api/admin/users', { username: u, password: 'secret1', email: e, full_name: u.toUpperCase() });

    // 1) refuses politely when e-mail isn't configured
    let r = await call('POST', `/api/admin/exams/${eid}/notify`, { mode: 'all', kind: 'invite' });
    assert.equal(r.status, 400); assert.match(r.data.error, /not configured/i);
    assert.equal((await call('GET', '/api/admin/stats')).data.smtp_configured, false);

    // restart with SMTP pointing at the fake server
    srv.kill(); await new Promise((r) => setTimeout(r, 800));
    srv = start({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false', SMTP_USER: 'portal@test', SMTP_PASS: 'x', PUBLIC_URL: 'https://exams.example.com' });
    await up(); cookie = '';
    await call('POST', '/api/auth/login', { username: 'adm', password: 'Adm1nPass!' });

    // 2) invite everyone
    r = await call('POST', `/api/admin/exams/${eid}/notify`, { mode: 'all', kind: 'invite', message: 'Please be on time.' });
    assert.equal(r.status, 200); assert.equal(r.data.queued, 3);
    assert.ok(await wait(() => inbox.length >= 3), 'three invitations delivered');
    const first = decode(inbox[0].raw);
    assert.match(first, /Subject: .*invited.*Mail Exam/i);
    assert.ok(first.includes(`https://exams.example.com/#/user/exam/${eid}`), 'direct assessment link in the e-mail');
    assert.ok(first.includes('Please be on time.'), 'custom message included');
    assert.deepEqual(inbox.map((m) => m.to[0]).sort(), ['alice@x.com', 'bob@x.com', 'carol@x.com']);

    // 3) audience shows delivery status
    r = await call('GET', `/api/admin/exams/${eid}/audience`);
    assert.ok(r.data.users.every((u) => u.last_status === 'sent' && u.last_kind === 'invite'), 'status tracked per user');
    assert.equal(r.data.link, `https://exams.example.com/#/user/exam/${eid}`);

    // 4) alice takes and submits -> result e-mail with a PDF; reminders then skip her
    const alice = { cookie: '' };
    await call('POST', '/api/auth/login', { username: 'alice', password: 'secret1' }, alice);
    const st = (await call('POST', `/api/user/exams/${eid}/start`, null, alice)).data;
    assert.equal(st.questions.length, 2);
    // live monitor sees her
    r = await call('GET', `/api/admin/exams/${eid}/live`);
    assert.equal(r.data.writing.length, 1); assert.equal(r.data.writing[0].total, 2);
    await call('POST', `/api/user/attempts/${st.attempt.id}/answer`, { question_id: st.questions[0].id, selected_index: 0 }, alice);
    r = await call('GET', `/api/admin/exams/${eid}/live`); assert.equal(r.data.writing[0].answered, 1);
    const before = inbox.length;
    await call('POST', `/api/user/attempts/${st.attempt.id}/submit`, {}, alice);
    assert.ok(await wait(() => inbox.length > before), 'result e-mail sent');
    const res = inbox[inbox.length - 1];
    assert.deepEqual(res.to, ['alice@x.com']); assert.match(res.raw, /application\/pdf/); assert.match(res.raw, /Subject: Your result/);
    assert.equal((await call('GET', `/api/admin/exams/${eid}/live`)).data.writing.length, 0);

    // reminders are refused once the exam has started (this exam opened a minute ago)
    r = await call('POST', `/api/admin/exams/${eid}/notify`, { mode: 'pending', kind: 'reminder' });
    assert.equal(r.status, 400); assert.match(r.data.error, /before the exam starts/i);
    r = await call('POST', `/api/admin/exams/${eid}/notify`, { mode: 'selected', user_ids: [], kind: 'invite' });
    assert.equal(r.status, 400, 'no recipients rejected');

    // reminders before the start: only when the admin clicks send, only to people who have not submitted
    const upc = await mk('Upcoming Exam', 3600e3);
    const quiet = inbox.length;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(inbox.length, quiet, 'nothing is e-mailed automatically');
    r = await call('POST', `/api/admin/exams/${upc}/notify`, { mode: 'pending', kind: 'reminder' });
    assert.equal(r.status, 200); assert.equal(r.data.queued, 3);
    assert.ok(await wait(() => inbox.length >= quiet + 3), 'reminders delivered');
    assert.ok(inbox.slice(quiet).every((x) => /Subject: Reminder: Upcoming Exam/.test(decode(x.raw)) && decode(x.raw).includes(`/#/user/exam/${upc}`)));

    // 5) unpublished exam cannot be announced
    const dr = (await call('POST', '/api/admin/exams', { name: 'Draft', duration_min: 10, pass_percent: 40, start_at: new Date(now + 3600e3).toISOString(), end_at: new Date(now + 7200e3).toISOString() })).data.id;
    assert.equal((await call('POST', `/api/admin/exams/${dr}/notify`, { mode: 'all', kind: 'invite' })).status, 400);

    console.log('MAIL TESTS PASSED');
  } catch (e) { console.error('MAIL TEST FAILED:', e); process.exitCode = 1; }
  finally { srv.kill(); smtp.close(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(); }, 600); }
})();
