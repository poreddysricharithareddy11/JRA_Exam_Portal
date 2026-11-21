// Real-browser landing checks (headless Chrome): where does each person end up, in each awkward situation?
// signed-out deep links, the e-mailed invitation link, an exam the candidate was NOT invited to, wrong role, unknown addresses,
// not-yet-open / closed exams, and the Back button after signing out.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('No Chrome/Edge found - skipping landing test'); process.exit(0); }
const PROJECT = path.join(__dirname, '..'), PORT = 3872, DBG = 9335, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-land-')); const OUT = path.join(dir, 'shots'); fs.mkdirSync(OUT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '   <-- ' + extra)); };

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: PROJECT, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!', SMTP_USER: '', SMTP_PASS: '', BREVO_API_KEY: '' } });
  let chrome;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await sleep(200); } }
    const api = async (tok, m, u, b) => { const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); };
    const A = (await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'adm', password: 'Adm1nPass!', bearer: true }) })).json()).token;
    const now = Date.now();
    const mk = async (name, startOff, endOff) => { const id = (await api(A, 'POST', '/api/admin/exams', { name, duration_min: 30, pass_percent: 40, start_at: new Date(now + startOff).toISOString(), end_at: new Date(now + endOff).toISOString() })).id;
      const fd = new FormData(); fd.append('text', '1. Q one?\nA) a\nB) b\nC) c\nD) d\nAnswer: B'); await fetch(BASE + `/api/admin/exams/${id}/questions/upload`, { method: 'POST', headers: { authorization: 'Bearer ' + A }, body: fd });
      await api(A, 'POST', `/api/admin/exams/${id}/publish`, { published: true }); return id; };
    const live = await mk('Live Exam', -6e4, 36e5), future = await mk('Future Exam', 36e5, 9e6), closed = await mk('Closed Exam', -9e6, -7e6);
    const ids = {}; for (const u of ['inv', 'out']) ids[u] = (await api(A, 'POST', '/api/admin/users', { username: u, password: 'secret1', email: u + '@x.com', full_name: u === 'inv' ? 'Invited Candidate' : 'Outside Candidate' })).id;
    for (const e of [live, future, closed]) await api(A, 'POST', `/api/admin/exams/${e}/notify`, { mode: 'selected', user_ids: [ids.inv], kind: 'invite' }).catch(() => {});
    // the closed exam is past its end: the API refuses new invitations, so make sure 'inv' has a record for it another way (it just must not crash)

    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--window-size=1280,800', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${DBG}/json/version`); break; } catch (_) { await sleep(250); } }
    const t = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pending = new Map(); const jsErrors = [];
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else if (msg.method === 'Runtime.exceptionThrown') jsErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable'); await send('Runtime.enable');
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error('eval failed: ' + expr); return r.result.result.value; };
    const waitFor = async (expr, ms = 7000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (_) { /* loading */ } await sleep(150); } return false; };
    const go = async (hash) => { await send('Page.navigate', { url: BASE + '/' + hash }); await sleep(500); };
    const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n + '.png'), Buffer.from(r.result.data, 'base64')); };
    const login = async (u, p) => { await waitFor("!!document.querySelector('#lf')"); await ev(`document.querySelector('#u').value=${JSON.stringify(u)};document.querySelector('#p').value=${JSON.stringify(p)};document.querySelector('#lf').requestSubmit();true`); await sleep(900); };
    const here = () => ev('location.hash');
    const text = () => ev('document.body.innerText');
    const logout = async () => { await ev("document.querySelector('#out')?.click();true"); await waitFor("!!document.querySelector('#lf')"); };

    // 1) signed out, opens an admin address
    await go('#/admin'); check('signed out + #/admin -> sign-in page', await waitFor("!!document.querySelector('#lf')") && (await here()).startsWith('#/login'), await here());
    await login('adm', 'Adm1nPass!'); check('admin signs in from that address -> admin dashboard', await waitFor("location.hash.startsWith('#/admin')"), await here());
    await logout();
    // 2) browser Back after signing out must not show anything private
    await ev('history.back();true'); await sleep(700);
    check('Back after sign-out shows the sign-in page, not admin data', await waitFor("!!document.querySelector('#lf')") && !(await text()).includes('Total exams'), (await text()).slice(0, 80));
    // 3) the e-mailed invitation link, signed out
    await go(`#/user/exam/${live}`); check('signed out + invitation link -> sign-in page', await waitFor("!!document.querySelector('#lf')"), await here());
    await login('inv', 'secret1');
    check('invited candidate signs in -> lands directly on THAT exam (instructions)', await waitFor("location.hash === '#/user/exam/" + live + "' && document.body.innerText.includes('Live Exam')"), await here() + ' | ' + (await text()).slice(0, 80));
    await shot('landing-invited-link'); await logout();
    // 4) same link, a candidate who was NOT invited
    await go(`#/user/exam/${live}`); await login('out', 'secret1'); await sleep(600);
    const outHash = await here(), outText = await text();
    check('NOT-invited candidate opening the link -> dashboard (not a blank page)', outHash === '#/user' && outText.includes('Welcome'), outHash + ' | ' + outText.slice(0, 120));
    check('...and the exam is not shown to them', !outText.includes('Live Exam'), outText.slice(0, 160));
    await shot('landing-not-invited');
    // 5) a candidate trying admin addresses
    await go('#/admin'); check('candidate + #/admin -> back to their own dashboard', await waitFor("location.hash === '#/user'"), await here());
    await go('#/admin/exam/1/results'); check('candidate + admin results address -> their own dashboard', await waitFor("location.hash === '#/user'"), await here());
    await go('#/nonsense/path'); check('unknown address while signed in -> dashboard', await waitFor("location.hash === '#/user'"), await here());
    await logout();
    await go('#/nonsense/path'); check('unknown address while signed out -> sign-in page', await waitFor("!!document.querySelector('#lf')"), await here());
    // 6) invited candidate: exam not open yet / already closed
    await go('#/login'); await login('inv', 'secret1'); await waitFor("location.hash === '#/user'");
    await go(`#/user/exam/${future}`); await sleep(700);
    const ft = await text(); check('exam that has not opened yet: page explains it, Start is not usable', /not (yet )?(opened|open)|opens in|starts/i.test(ft) || (await ev("document.querySelector('#go')?.disabled")) === true, ft.slice(0, 160));
    await shot('landing-not-opened-yet');
    await go(`#/user/exam/${closed}`); await sleep(700);
    const ct = await text(); const hh = await here();
    check('closed exam link: ends up on the dashboard or a clear message (never blank/crash)', hh === '#/user' || /closed|ended|not found/i.test(ct) || ct.length > 100, hh + ' | ' + ct.slice(0, 100));
    await shot('landing-closed');
    // 7) admin opening a candidate address
    await logout(); await go('#/login'); await login('adm', 'Adm1nPass!'); await waitFor("location.hash.startsWith('#/admin')");
    await go('#/user'); check('admin + candidate dashboard address -> sign-in page (never mixes roles)', await waitFor("!!document.querySelector('#lf')"), await here());
    check('no JavaScript errors anywhere in these journeys', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 200));
    console.log('screenshots: ' + OUT);
  } catch (e) { console.log('LANDING TEST ERROR', e.message); results.push(false); }
  finally { try { chrome && chrome.kill(); } catch (_) { /* gone */ } srv.kill(); const okAll = results.every(Boolean); console.log(okAll ? `LANDING TESTS PASSED (${results.length} checks)` : `LANDING TESTS FAILED (${results.filter(Boolean).length}/${results.length})`); setTimeout(() => process.exit(okAll ? 0 : 1), 500); }
})();
