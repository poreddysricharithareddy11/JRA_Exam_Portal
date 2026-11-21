// Two browser tabs signed in as different people (admin + candidate) must stay independent, also after a refresh.
// Real headless Chrome over the DevTools protocol (no extra packages).
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('No Chrome/Edge found - skipping tab test'); process.exit(0); }

const PORT = 3996, DBG = 9334, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-tabs-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!', SMTP_USER: '', SMTP_PASS: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let chrome;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await sleep(200); } }
    const a = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'adm', password: 'Adm1nPass!' }) });
    const ck = a.headers.get('set-cookie').split(';')[0];
    await fetch(BASE + '/api/admin/users', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ username: 'cand', password: 'secret1', email: 'c@x.com', full_name: 'Casey Candidate' }) });

    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--window-size=1200,800', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${DBG}/json/version`); break; } catch (_) { await sleep(250); } }

    // each "tab" is its own DevTools target in the SAME browser profile (so they share cookies/localStorage, like real tabs)
    const openTab = async () => {
      const t = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
      let id = 0; const pending = new Map();
      ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
      const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
      await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      const touch = (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error('eval failed: ' + expr); return r.result.result.value; };
      const waitFor = async (expr, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (_) { /* page loading */ } await sleep(150); } throw new Error('timeout waiting for: ' + expr); };
      return {
        go: async (hash) => { await send('Page.navigate', { url: BASE + '/' + hash }); await sleep(300); },
        reload: async () => { await send('Page.reload'); await sleep(400); },
        ev, waitFor,
        swipe: async (x1, y1, x2, y2) => { await fetch(`http://127.0.0.1:${DBG}/json/activate/${t.id}`); await sleep(150);   // Chrome only delivers input to the visible tab
          await touch('touchStart', x1, y1); await touch('touchMove', (x1 + x2) / 2, (y1 + y2) / 2); await touch('touchMove', x2, y2); await touch('touchEnd'); await sleep(350); },
        login: async (u, p) => { await waitFor("!!document.querySelector('#lf')"); await ev(`document.querySelector('#u').value=${JSON.stringify(u)};document.querySelector('#p').value=${JSON.stringify(p)};document.querySelector('#lf').requestSubmit();true`); },
      };
    };
    const who = (tab) => tab.ev("(document.querySelector('.who, .avatar')?.closest('div')?.innerText || '') + '|' + location.hash");

    const A = await openTab(), B = await openTab();
    await A.go('#/login'); await B.go('#/login');
    await A.login('adm', 'Adm1nPass!');
    await A.waitFor("location.hash.startsWith('#/admin') && document.body.innerText.includes('Administrator')");
    await B.login('cand', 'secret1');                       // logging in on tab B must NOT disturb tab A
    await B.waitFor("location.hash.startsWith('#/user') && document.body.innerText.includes('Casey')");

    // both tabs keep their own identity after a refresh
    await A.reload(); await B.reload();
    await A.waitFor("document.body.innerText.includes('Administrator') && location.hash.startsWith('#/admin')");
    await B.waitFor("document.body.innerText.includes('Casey') && location.hash.startsWith('#/user')");
    assert.ok(!(await A.ev('document.body.innerText')).includes('Casey'), 'admin tab did not turn into the candidate');
    assert.ok(!(await B.ev('document.body.innerText')).includes('Administrator'), 'candidate tab did not turn into the admin');

    // swipe between tabs: RIGHT = next tab, LEFT = previous tab (candidate dashboard)
    const activeTab = () => B.ev("document.querySelector('.utabs a.on')?.dataset.tab");
    assert.equal(await activeTab(), 'upcoming');
    await B.swipe(200, 520, 420, 525);                       // swipe right -> next tab (Completed)
    assert.equal(await activeTab(), 'completed', 'swipe right goes to the next tab');
    await B.swipe(420, 520, 200, 525);                       // swipe left -> previous tab (Upcoming & live)
    assert.equal(await activeTab(), 'upcoming', 'swipe left goes back to the previous tab');
    await B.swipe(420, 520, 200, 525);                       // already on the first tab: nothing happens
    assert.equal(await activeTab(), 'upcoming');
    await B.swipe(300, 400, 330, 700);                       // a mostly-vertical drag (scrolling) must not switch tabs
    assert.equal(await activeTab(), 'upcoming', 'scrolling is not a swipe');

    // the same on the admin's exam tabs
    const eid = (await (await fetch(BASE + '/api/admin/exams', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ name: 'Swipe', duration_min: 30, pass_percent: 40, start_at: new Date(Date.now() + 36e5).toISOString(), end_at: new Date(Date.now() + 72e5).toISOString() }) })).json()).id;
    await A.go(`#/admin/exam/${eid}/questions`);
    await A.waitFor("!!document.querySelector('.tabs a.on')");
    await A.swipe(200, 600, 420, 605);
    await A.waitFor("location.hash.endsWith('/results')");
    await A.waitFor("document.querySelector('.tabs a.on')?.getAttribute('href')?.endsWith('/results')");   // results page fully drawn
    const freeY = await A.ev("(() => { for (let y = 360; y < 690; y += 10) { const e = document.elementFromPoint(300, y); if (e && !e.closest('.tw, .tabs, input, textarea, select, .overlay, .modal, [data-noswipe]')) return y; } return 0; })()");
    assert.ok(freeY > 0, 'found a plain area of the page to swipe on');
    await A.swipe(200, freeY, 420, freeY + 5);                       // start on a plain area (tables are ignored on purpose so they can scroll sideways)
    await A.waitFor("location.hash.endsWith('/invite')");
    await A.swipe(420, freeY, 200, freeY + 5);
    await A.waitFor("location.hash.endsWith('/results')");

    // a brand-new tab is NOT signed in by the other tabs
    const C = await openTab(); await C.go('');
    await C.waitFor("!!document.querySelector('#lf')");
    assert.ok(await C.ev("location.hash.startsWith('#/login')"), 'a new tab starts at the sign-in page');

    // candidate tab cannot reach admin pages; admin tab opening a candidate link is sent to sign-in (never the admin dashboard)
    await B.go('#/admin');
    await B.waitFor("location.hash.startsWith('#/user')");
    await A.go('#/user/exam/1');
    await A.waitFor("!!document.querySelector('#lf')");

    // signing out in one tab leaves the other signed in
    await B.ev("document.querySelector('#out').click();true");
    await B.waitFor("!!document.querySelector('#lf')");
    const D = await openTab(); await D.go('#/login'); await D.login('adm', 'Adm1nPass!');
    await D.waitFor("location.hash.startsWith('#/admin')");
    await D.reload(); await D.waitFor("location.hash.startsWith('#/admin') && document.body.innerText.includes('Administrator')");
    console.log('TAB INDEPENDENCE TESTS PASSED');
  } catch (e) { console.error('TAB TEST FAILED:', e.message); process.exitCode = 1; }
  finally { try { chrome && chrome.kill(); } catch (_) { /* gone */ } srv.kill(); setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* in use */ } process.exit(); }, 600); }
})();
