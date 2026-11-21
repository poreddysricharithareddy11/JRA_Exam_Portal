// Load test: N candidates log in, start, answer every question and submit concurrently.
// Usage: node test/load.js [users=200]   (server must be running on PORT 3000 with a fresh DB)
const BASE = process.env.BASE || 'http://localhost:3000';
const N = parseInt(process.argv[2] || '200', 10);
async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { r, data: await r.json().catch(() => ({})) };
}
(async () => {
  const a = await call('', 'POST', '/api/auth/login', { username: 'jayarama_exam', password: process.env.ADMIN_PASSWORD || 'Smoke-Test-Pw1', role: 'admin' });
  const ac = a.r.headers.get('set-cookie').split(';')[0];
  const users = Array.from({ length: N }, (_, i) => ({ username: `load${i}`, password: 'secret1', email: `load${i}@example.com` }));
  await call(ac, 'POST', '/api/admin/users/bulk', { users });
  const now = Date.now();
  const e = await call(ac, 'POST', '/api/admin/exams', { name: 'Load test', duration_min: 30, pass_percent: 40, start_at: new Date(now - 6e4).toISOString(), end_at: new Date(now + 36e5).toISOString() });
  const eid = e.data.id;
  const bank = Array.from({ length: 50 }, (_, i) => `${i + 1}. Question ${i + 1}?\nA) a\nB) b\nC) c\nD) d\nAnswer: B`).join('\n');
  const fd = new FormData(); fd.append('text', bank);
  await fetch(`${BASE}/api/admin/exams/${eid}/questions/upload`, { method: 'POST', headers: { cookie: ac }, body: fd });
  await call(ac, 'POST', `/api/admin/exams/${eid}/publish`, { published: true });
  const t0 = Date.now(); let ok = 0, errs = 0;
  await Promise.all(users.map(async (u) => {
    try {
      const l = await call('', 'POST', '/api/auth/login', { ...u, role: 'user' });
      const c = l.r.headers.get('set-cookie').split(';')[0];
      const s = await call(c, 'POST', `/api/user/exams/${eid}/start`);
      const att = s.data.attempt.id;
      for (const q of s.data.questions) await call(c, 'POST', `/api/user/attempts/${att}/answer`, { question_id: q.id, selected_index: 1 });
      await call(c, 'POST', `/api/user/attempts/${att}/submit`, {});
      ok++;
    } catch (_) { errs++; }
  }));
  console.log(`${ok}/${N} candidates completed (${errs} errors) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const res = await call(ac, 'GET', `/api/admin/exams/${eid}/results`);
  console.log('Server shows submitted:', res.data.summary.submitted, ' avg%:', res.data.summary.average_percent);
})();
