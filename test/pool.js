// Random per-candidate papers: 30 of 50, shuffled options, unique papers, correct scoring.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-pool-'));

function client() {
  let cookie = '';
  return async (method, url, body, form) => {
    const headers = cookie ? { cookie } : {};
    if (body && !form) headers['content-type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers, body: form ? body : body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : null };
  };
}
const bank = (n) => Array.from({ length: n }, (_, i) =>
  `${i + 1}. Question number ${i + 1}?\nA) a${i}\nB) b${i}\nC) c${i}\nD) d${i}\nAnswer: ${'ABCD'[i % 4]}`).join('\n');

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!', SMTP_USER: '', SMTP_PASS: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await new Promise((r) => setTimeout(r, 200)); } }
    const admin = client();
    await admin('POST', '/api/auth/login', { username: 'adm', password: 'Adm1nPass!', role: 'admin' });
    const now = Date.now();
    const window_ = { start_at: new Date(now - 6e4).toISOString(), end_at: new Date(now + 36e5).toISOString() };
    const upload = async (id, text) => { const fd = new FormData(); fd.append('text', text); return admin('POST', `/api/admin/exams/${id}/questions/upload`, fd, true); };

    // ---- 30 of 50 ----
    let r = await admin('POST', '/api/admin/exams', { name: 'Pool', duration_min: 30, pass_percent: 40, questions_per_attempt: 30, num_sets: 4, ...window_ });
    const pid = r.data.id;
    assert.equal((await upload(pid, bank(50))).data.added, 50);
    await admin('PUT', `/api/admin/exams/${pid}`, { questions_per_attempt: 60 });
    assert.equal((await admin('POST', `/api/admin/exams/${pid}/publish`, { published: true })).status, 400, 'per-candidate > bank is rejected');
    await admin('PUT', `/api/admin/exams/${pid}`, { questions_per_attempt: 30 });
    assert.equal((await admin('POST', `/api/admin/exams/${pid}/publish`, { published: true })).status, 200);
    const key = new Map((await admin('GET', `/api/admin/exams/${pid}`)).data.questions.map((q) => [q.id, q]));
    const byNo = new Map([...key.values()].map((q) => [q.position, q.id]));

    // the admin typed 4 sets: the portal built exactly 4, each a 30-question random draw from the 50
    const gen = (await admin('GET', `/api/admin/exams/${pid}/sets`)).data;
    assert.equal(gen.sets.length, 4, 'exactly the typed number of sets');
    assert.ok(gen.sets.every((s) => s.count === 30 && new Set(s.questions).size === 30), 'each set holds 30 different questions');
    assert.equal(new Set(gen.sets.map((s) => s.questions.join())).size, 4, 'the four sets are different from each other');
    const setIds = new Map(gen.sets.map((s) => [String(s.set_no), s.questions.map((n) => byNo.get(n)).sort((a, b) => a - b).join()]));
    const perSet = new Map();

    const sigs = new Set(), drawn = new Map(), orderSet = new Set();
    const USERS = 25;
    for (let i = 0; i < USERS; i++) {
      const un = 'cand' + i;
      await admin('POST', '/api/admin/users', { username: un, password: 'secret1', email: `${un}@example.com` });
      const c = client(); await c('POST', '/api/auth/login', { username: un, password: 'secret1', role: 'user' });
      const st = (await c('POST', `/api/user/exams/${pid}/start`)).data;
      assert.equal(st.questions.length, 30, '30 questions per candidate');
      assert.equal(new Set(st.questions.map((q) => q.id)).size, 30, 'no repeated question within a paper');
      assert.ok(!JSON.stringify(st).includes('correct_index'), 'key not leaked');
      // the candidate's questions are exactly one of the generated sets (the one they were allocated)
      assert.equal([...st.questions.map((q) => q.id)].sort((a, b) => a - b).join(), setIds.get(st.attempt.set_name), 'paper is drawn from the allocated set');
      perSet.set(st.attempt.set_name, (perSet.get(st.attempt.set_name) || 0) + 1);
      const sig = st.questions.map((q) => q.id + ':' + q.options.join(',')).join('|');
      assert.ok(!sigs.has(sig), 'paper is unique'); sigs.add(sig);
      orderSet.add(st.questions.map((q) => q.id).join());

      const ans = {};
      st.questions.forEach((q, n) => {
        const o = key.get(q.id), shown = q.options.indexOf(o.options[o.correct_index]);
        assert.ok(shown >= 0 && q.options.length === 4);
        if (n < 20) ans[q.id] = shown;                  // 20 correct (by displayed text)
        else if (n < 25) ans[q.id] = (shown + 1) % 4;   // 5 wrong; remaining 5 unanswered
        drawn.set(q.id, (drawn.get(q.id) || 0) + 1);
      });
      const first = Object.keys(ans)[0];
      assert.equal((await c('POST', `/api/user/attempts/${st.attempt.id}/answer`, { question_id: Number(first), selected_index: ans[first] })).status, 200);
      // resume must give back the same paper and the saved answer in displayed terms
      const again = (await c('POST', `/api/user/exams/${pid}/start`)).data;
      assert.deepEqual(again.questions, st.questions, 'resume returns the identical paper');
      assert.equal(again.answers[first], ans[first], 'saved answer restored at the displayed position');
      await c('POST', `/api/user/attempts/${st.attempt.id}/submit`, { answers: ans });
      const res = (await c('GET', `/api/user/attempts/${st.attempt.id}/result`)).data;
      assert.deepEqual([res.attempt.correct, res.attempt.wrong, res.attempt.unanswered], [20, 5, 5], 'shuffled options mark correctly');
      assert.deepEqual(res.questions.map((q) => q.id), st.questions.map((q) => q.id), 'review keeps the candidate\'s order');
      assert.ok(res.questions.every((q, n) => q.options.join() === st.questions[n].options.join()), 'review keeps the candidate\'s option order');
      assert.ok(res.questions.every((q) => { const o = key.get(q.id); return q.options[q.correct_index] === o.options[o.correct_index]; }), 'review highlights the right option');
      const pdf = await fetch(`${BASE}/api/user/attempts/${st.attempt.id}/pdf`, { headers: { cookie: '' } }); void pdf;
      assert.equal((await c('POST', `/api/user/exams/${pid}/start`)).status, 409, 'one attempt only');
    }
    assert.equal(sigs.size, USERS);
    assert.ok(orderSet.size === USERS, 'question order differs between candidates');
    assert.deepEqual([...perSet.keys()].sort(), ['1', '2', '3', '4'], 'all four sets were handed out');
    assert.ok([...perSet.values()].every((n) => n === 6 || n === 7), 'sets are shared out evenly: ' + JSON.stringify([...perSet]));
    assert.ok(drawn.size > 30, 'different sets cover different questions (' + drawn.size + ' of 50 used)');
    console.log(`4 sets of 30-from-50: ${USERS} candidates, ${sigs.size} unique papers, sets used ${JSON.stringify([...perSet])}`);

    // ---- bank of 30, 30 per candidate: all questions, but each paper still differs ----
    r = await admin('POST', '/api/admin/exams', { name: 'Full', duration_min: 30, pass_percent: 40, questions_per_attempt: 30, ...window_ });
    const fid = r.data.id;
    await upload(fid, bank(30));
    assert.equal((await admin('POST', `/api/admin/exams/${fid}/publish`, { published: true })).status, 200);
    const papers = new Set();
    for (let i = 0; i < 8; i++) {
      const c = client(); await c('POST', '/api/auth/login', { username: 'cand' + i, password: 'secret1', role: 'user' });
      const st = (await c('POST', `/api/user/exams/${fid}/start`)).data;
      assert.equal(st.questions.length, 30);
      assert.equal(new Set(st.questions.map((q) => q.id)).size, 30, 'all 30 questions present');
      papers.add(st.questions.map((q) => q.id + st.questions.length + q.options.join()).join('|'));
    }
    assert.equal(papers.size, 8, '30-of-30: every candidate still has a different order/options');

    // ---- locked once attempts exist ----
    assert.equal((await admin('PUT', `/api/admin/exams/${pid}`, { questions_per_attempt: 10 })).status, 400);
    console.log('POOL TESTS PASSED');
  } catch (e) {
    console.error('POOL TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(); }, 500);
  }
})();
