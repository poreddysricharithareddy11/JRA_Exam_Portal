// Live rehearsal: N test candidates take a test exam AT THE SAME MOMENT on the real (deployed) site.
//
//   node test/rehearsal.js [N=20]
//
// Needs the admin password. Put it in a file called .rehearsal.env next to package.json (git ignores it):
//   REHEARSAL_ADMIN_PASSWORD=your-admin-password
// Optional lines: REHEARSAL_URL=https://...   REHEARSAL_ADMIN_USER=jayarama_exam   REHEARSAL_EMAIL=you@gmail.com
//
// What it does: creates N users (rehearsal01..), a published test exam, runs all candidates at once (login, start,
// answer every question, submit), checks the results and that the result e-mails were sent, prints timings, then
// DELETES the test exam and test users again. Result e-mails go to REHEARSAL_EMAIL using plus-addressing
// (you+r01@gmail.com ...), so they all arrive in ONE inbox and never bounce.
const fs = require('fs'), path = require('path');

function readEnvFile() {
  const o = {};
  try {
    for (const l of fs.readFileSync(path.join(__dirname, '..', '.rehearsal.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* no file */ }
  return o;
}
const env = { ...readEnvFile(), ...process.env };
const BASE = (env.REHEARSAL_URL || 'https://jayarama-exam-portal.onrender.com').replace(/\/+$/, '');
const ADMIN_USER = env.REHEARSAL_ADMIN_USER || 'jayarama_exam';
const ADMIN_PASS = env.REHEARSAL_ADMIN_PASSWORD || '';
const MAIL = env.REHEARSAL_EMAIL || 'jayaramaexamportal@gmail.com';
const N = Math.max(1, Math.min(200, parseInt(process.argv[2] || '20', 10)));
const PREFIX = 'rehearsal';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : 0; };

async function call(cookie, method, url, body) {
  const t = Date.now();
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
  const data = await r.json().catch(() => ({}));
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data, ms: Date.now() - t, cookie: sc ? sc.split(';')[0] : null };
}

(async () => {
  if (!ADMIN_PASS) {
    console.error('Missing admin password. Create the file .rehearsal.env (next to package.json) containing:\n  REHEARSAL_ADMIN_PASSWORD=your-admin-password');
    process.exit(2);
  }
  console.log(`Rehearsal on ${BASE} with ${N} candidates`);

  // 0) wake the site up (the free server sleeps when idle) and time it
  let t = Date.now();
  for (let i = 0; i < 6; i++) { try { const r = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(90000) }); if (r.ok) break; } catch (_) { /* waking up */ } }
  console.log(`site awake after ${((Date.now() - t) / 1000).toFixed(1)} s`);

  const login = await call('', 'POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS, role: 'admin' });
  if (login.status !== 200) { console.error('Admin sign-in failed (' + login.status + '). Check REHEARSAL_ADMIN_PASSWORD.'); process.exit(2); }
  const ac = login.cookie;
  let eid = null; const mk = (i) => `${PREFIX}${String(i + 1).padStart(2, '0')}`;

  const cleanup = async () => {
    try {
      if (eid) await call(ac, 'DELETE', `/api/admin/exams/${eid}`, { password: ADMIN_PASS });
      const users = (await call(ac, 'GET', '/api/admin/users')).data.users || [];
      for (const u of users.filter((x) => x.username.startsWith(PREFIX))) await call(ac, 'DELETE', `/api/admin/users/${u.id}`);
      console.log('cleanup: test exam and test users deleted');
    } catch (e) { console.log('cleanup problem (delete the "rehearsal" users and the test exam by hand):', e.message); }
  };

  let failed = false;
  try {
    await cleanup();    // leftovers from an earlier run
    const users = Array.from({ length: N }, (_, i) => ({ username: mk(i), password: 'Rehearsal-' + (1000 + i), email: MAIL.replace('@', `+r${String(i + 1).padStart(2, '0')}@`), full_name: `Rehearsal ${i + 1}` }));
    const bulk = await call(ac, 'POST', '/api/admin/users/bulk', { users });
    if (bulk.data.added !== N) throw new Error('could not create the test users: ' + JSON.stringify(bulk.data.errors || bulk.data));
    const now = Date.now();
    const ex = await call(ac, 'POST', '/api/admin/exams', { name: 'REHEARSAL - safe to delete', duration_min: 30, pass_percent: 40, num_sets: 3, questions_per_attempt: 30,
      start_at: new Date(now - 6e4).toISOString(), end_at: new Date(now + 2 * 36e5).toISOString() });
    eid = ex.data.id;
    const bank = Array.from({ length: 50 }, (_, i) => `${i + 1}. Rehearsal question number ${i + 1}: which option is correct?\nA) first option\nB) second option\nC) third option\nD) fourth option\nAnswer: B`).join('\n');
    const fd = new FormData(); fd.append('text', bank);
    const up = await fetch(`${BASE}/api/admin/exams/${eid}/questions/upload`, { method: 'POST', headers: { cookie: ac }, body: fd });
    if (!up.ok) throw new Error('question upload failed: ' + up.status);
    const pub = await call(ac, 'POST', `/api/admin/exams/${eid}/publish`, { published: true });
    if (pub.status !== 200) throw new Error('publish failed: ' + JSON.stringify(pub.data));
    // only invited candidates can see / start an exam: invite exactly the test candidates (never the real ones)
    const ids = ((await call(ac, 'GET', '/api/admin/users')).data.users || []).filter((x) => x.username.startsWith(PREFIX)).map((x) => x.id);
    const inv = await call(ac, 'POST', `/api/admin/exams/${eid}/notify`, { mode: 'selected', user_ids: ids, kind: 'invite' });
    if (inv.status !== 200) throw new Error('could not invite the test candidates: ' + JSON.stringify(inv.data));
    console.log(`exam ${eid} published; releasing ${N} candidates at the same moment...`);

    const lat = { login: [], start: [], answer: [], submit: [] }; let done = 0; const errs = [];
    t = Date.now();
    await Promise.all(Array.from({ length: N }, async (_, i) => {
      try {
        const l = await call('', 'POST', '/api/auth/login', { username: users[i].username, password: users[i].password, role: 'user' });
        if (l.status !== 200) throw new Error('login ' + l.status);
        lat.login.push(l.ms);
        const s = await call(l.cookie, 'POST', `/api/user/exams/${eid}/start`);
        if (s.status !== 200) throw new Error('start ' + s.status + ' ' + (s.data.error || ''));
        lat.start.push(s.ms);
        for (const q of s.data.questions) {
          await sleep(300 + Math.random() * 900);                 // reading + clicking (compressed human pace)
          const r = await call(l.cookie, 'POST', `/api/user/attempts/${s.data.attempt.id}/answer`, { question_id: q.id, selected_index: Math.floor(Math.random() * 4) });
          if (r.status !== 200) throw new Error('answer ' + r.status);
          lat.answer.push(r.ms);
        }
        const sub = await call(l.cookie, 'POST', `/api/user/attempts/${s.data.attempt.id}/submit`, {});
        if (sub.status !== 200) throw new Error('submit ' + sub.status);
        lat.submit.push(sub.ms); done++;
      } catch (e) { errs.push(`${users[i].username}: ${e.message}`); }
    }));
    const took = (Date.now() - t) / 1000;

    // results + e-mails
    let res, sent = 0, failedMail = 0, waited = 0;
    for (; waited < 90; waited += 3) {
      res = (await call(ac, 'GET', `/api/admin/exams/${eid}/results`)).data;
      const rows = (res.results || []).filter((r) => r.status === 'submitted');
      sent = rows.filter((r) => r.email_status === 'sent').length; failedMail = rows.filter((r) => r.email_status === 'failed').length;
      if (sent + failedMail >= rows.length && rows.length >= done) break;
      await sleep(3000);
    }
    const col = (k) => `${k.padEnd(7)} typical ${String(pct(lat[k], 0.5)).padStart(5)} ms   slowest 5% ${String(pct(lat[k], 0.95)).padStart(5)} ms   worst ${String(Math.max(0, ...lat[k])).padStart(5)} ms   (${lat[k].length} requests)`;
    console.log(`\n===== REHEARSAL RESULT: ${N} candidates at the same moment =====`);
    console.log(`finished: ${done}/${N}   errors: ${errs.length}   results recorded: ${res.summary ? res.summary.submitted : '?'}/${N}   whole exam took ${took.toFixed(0)} s`);
    for (const k of Object.keys(lat)) console.log(col(k));
    console.log(`result e-mails: ${sent} sent, ${failedMail} failed (of ${done})  -> check the inbox ${MAIL} for ${done} PDFs`);
    if (errs.length) console.log('errors:\n  ' + errs.slice(0, 10).join('\n  '));
    failed = errs.length > 0 || done !== N;
  } catch (e) { console.error('REHEARSAL STOPPED:', e.message); failed = true; }
  finally { await cleanup(); }
  process.exit(failed ? 1 : 0);
})();
