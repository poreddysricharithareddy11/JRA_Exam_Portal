// Candidate exam screen in a REAL browser: instructions -> Start (full-screen) -> answer -> proctoring warning ->
// second violation auto-submits; and a normal manual submit. Uses headless Chrome over the DevTools protocol.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('No Chrome/Edge found - skipping exam UI test'); process.exit(0); }
const PORT = 3993, DBG = 9335, BASE = `http://localhost:${PORT}`;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'jep-exam-shots-'));
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-exam-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
const api = async (m, u, body) => {
  const r = await fetch(BASE + u, { method: m, headers: { ...(cookie ? { cookie } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!', SMTP_USER: '', SMTP_PASS: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let chrome; const errors = [];
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await sleep(200); } }
    await api('POST', '/api/auth/login', { username: 'adm', password: 'Adm1nPass!' });
    const now = Date.now();
    const eid = (await api('POST', '/api/admin/exams', { name: 'Proctored Test', duration_min: 20, pass_percent: 50, negative_marks: 0.5, num_sets: 2, questions_per_attempt: 4,
      start_at: new Date(now - 6e4).toISOString(), end_at: new Date(now + 36e5).toISOString() })).data.id;
    const bank = Array.from({ length: 6 }, (_, i) => `${i + 1}. What is ${i + 1} + ${i + 1}?\nA) ${i}\nB) ${(i + 1) * 2}\nC) ${i + 7}\nD) ${i + 9}\nAnswer: B`).join('\n');
    const fd = new FormData(); fd.append('text', bank);
    await api('POST', `/api/admin/exams/${eid}/questions/upload`, fd);
    assert.equal((await api('POST', `/api/admin/exams/${eid}/publish`, { published: true })).status, 200);
    for (const u of ['cand1', 'cand2']) await api('POST', '/api/admin/users', { username: u, password: 'secret1', email: `${u}@example.com`, full_name: u.toUpperCase() });
    await api('POST', `/api/admin/exams/${eid}/notify`, { mode: 'all', kind: 'invite' });   // only invited candidates see the exam;

    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--window-size=1366,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    let tab; for (let i = 0; i < 60; i++) { try { tab = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json(); break; } catch (_) { await sleep(250); } }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon|401/.test(msg.params.entry.text + msg.params.entry.url)) errors.push('LOG: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.result.exceptionDetails) throw new Error('eval failed: ' + expr + ' -> ' + JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
    const waitFor = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(150); } throw new Error('timeout waiting for: ' + expr); };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    // a real, trusted mouse click (needed for full-screen permission)
    const click = async (selector) => {
      const box = await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await sleep(120);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    // Headless Chrome never grants real full-screen, so emulate it faithfully: same property, same method names,
    // same 'fullscreenchange' event. (A real desktop browser grants it; the portal refuses to start without it.)
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      let fsEl = null;
      const set = (el) => { fsEl = el; document.dispatchEvent(new Event('fullscreenchange')); };
      Object.defineProperty(document, 'fullscreenElement', { get: () => fsEl, configurable: true });
      Object.defineProperty(document, 'fullscreenEnabled', { get: () => true, configurable: true });
      Element.prototype.requestFullscreen = function () { set(this); return Promise.resolve(); };
      document.exitFullscreen = function () { set(null); return Promise.resolve(); };
    })();` });
    await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    const login = async (u) => { await send('Page.navigate', { url: BASE + '/' }); await waitFor("!!document.querySelector('#lf')"); await ev(`document.querySelector('#u').value='${u}';document.querySelector('#p').value='secret1';document.querySelector('#lf').requestSubmit();true`); await waitFor("!!document.querySelector('#out')"); };
    const startExam = async () => {
      await ev(`location.hash='#/user/exam/${eid}';true`);
      await waitFor("!!document.querySelector('#agree')");
      await click('#agree'); await waitFor("document.querySelector('#go').disabled===false");
      await click('#go');
      await waitFor("!!document.querySelector('#tm')", 15000);
    };
    const inFullscreen = () => ev('!!document.fullscreenElement');

    /* ===== candidate 1: violations ===== */
    await login('cand1');
    await startExam();
    assert.equal(await inFullscreen(), true, 'exam runs in full-screen');
    assert.equal(await ev("document.querySelectorAll('#pal button').length"), 4, 'paper has 4 questions (questions per candidate)');
    await waitFor("/^[0-9]+:[0-9]{2}(:[0-9]{2})?$/.test(document.querySelector('#tm').textContent)");   // countdown is running
    assert.equal(await ev("document.querySelectorAll('.choice').length"), 4, 'four options shown for question 1');
    // candidate watermark: their own e-mail, repeated over the paper, that cannot be clicked, removed or hidden
    const wm = await ev(`(() => { const el = document.getElementById('wm-user'); if (!el) return null; const cs = getComputedStyle(el);
      return { img: decodeURIComponent(cs.backgroundImage), pe: cs.pointerEvents, pos: cs.position, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, vw: innerWidth, vh: innerHeight }; })()`);
    assert.ok(wm, 'watermark overlay is present during the exam');
    assert.ok(wm.img.includes('cand1@example.com'), 'watermark shows the candidate\'s e-mail address');
    assert.equal(wm.pe, 'none', 'watermark never blocks clicks'); assert.equal(wm.pos, 'fixed');
    assert.ok(wm.w >= wm.vw && wm.h >= wm.vh, 'watermark covers the whole screen');
    await ev("document.getElementById('wm-user').remove();true");                           // tamper: remove it
    await waitFor("!!document.getElementById('wm-user')", 3000);
    await ev("document.getElementById('wm-user').setAttribute('style','display:none');true");  // tamper: hide it
    await waitFor("getComputedStyle(document.getElementById('wm-user')).display==='block'", 3000);
    await ev("(()=>{const st=document.createElement('style');st.id='tamper';st.textContent='#wm-user{display:none!important;opacity:0!important}';document.head.append(st);return true})()");   // tamper: CSS rule
    await sleep(300);
    assert.equal(await ev("getComputedStyle(document.getElementById('wm-user')).display"), 'block', 'inline !important beats injected CSS');
    await ev("document.getElementById('tamper').remove();true");
    await shot('01-exam-question');
    await ev("document.querySelector('.choice').click();true");                       // answer Q1 (first displayed option)
    await waitFor("document.querySelector('#sv').textContent.includes('Saved')");
    await ev("document.querySelector('#next').click();true");
    await ev("document.querySelectorAll('.choice')[1].click();true");                 // answer Q2
    await waitFor("document.querySelector('#cnt').textContent.startsWith('2')");
    assert.equal(await ev("document.querySelectorAll('#pal button.ans').length"), 2, 'palette marks answered questions');
    // right-click / copy / paste are blocked while proctored
    assert.equal(await ev("(()=>{const e=new MouseEvent('contextmenu',{cancelable:true,bubbles:true});document.dispatchEvent(e);return e.defaultPrevented})()"), true, 'right-click blocked');
    assert.equal(await ev("(()=>{const e=new KeyboardEvent('keydown',{key:'c',ctrlKey:true,cancelable:true,bubbles:true});document.dispatchEvent(e);return e.defaultPrevented})()"), true, 'Ctrl+C blocked');

    // violation 1: leave full-screen (what pressing Esc does) -> one warning, exam continues
    await ev('document.exitFullscreen().then(()=>true)');
    await waitFor("document.body.innerText.includes('Warning 1 of 1')");
    assert.ok((await ev('document.body.innerText')).includes('exited full-screen'), 'tells the candidate what they did');
    assert.ok((await ev('document.body.innerText')).includes('submitted automatically'), 'explains the next violation auto-submits');
    await shot('02-warning');
    await click('#back');                                                              // "Return to exam (full screen)"
    await waitFor("!document.querySelector('#back')");
    assert.equal(await inFullscreen(), true, 'back in full-screen after the warning');
    assert.match(await ev("document.querySelector('#viol').textContent"), /Warnings: 1\/1/);
    // the answers survive: reload the paper from the server and see both saved
    const saved = await ev(`fetch('/api/user/exams/${eid}/start',{method:'POST',headers:authHeaders()}).then(r=>r.json()).then(d=>Object.values(d.answers).filter(v=>v!==null).length)`);
    assert.equal(saved, 2, 'both answers were saved on the server as they were chosen');

    // violation 2: auto-submit with the saved answers
    await sleep(2200);                                                                 // (violations within 2s count as one action)
    await ev('document.exitFullscreen().then(()=>true)');
    await waitFor("location.hash.startsWith('#/user/result/')", 15000);
    await waitFor("document.body.innerText.includes('Your answers & the answer key')");
    const res1 = await ev('document.body.innerText');
    assert.ok(res1.includes('submitted automatically because of repeated proctoring violations'), 'result page says why it was submitted');
    assert.ok(/PASSED|FAILED/.test(res1) && res1.includes('Correct') , 'score and the answer key are shown after submission');
    assert.equal(await inFullscreen(), false, 'full-screen released after submission');
    assert.equal(await ev("!!document.getElementById('wm-user')"), false, 'watermark removed once the exam is over');
    await shot('03-result-after-violations');
    await ev("document.querySelector('#out').click();true"); await waitFor("!!document.querySelector('#lf')");

    /* ===== candidate 2: normal flow, manual submit ===== */
    await login('cand2');
    await startExam();
    assert.ok(decodeURIComponent(await ev("getComputedStyle(document.getElementById('wm-user')).backgroundImage")).includes('cand2@example.com'), 'each candidate sees their own e-mail, not someone else\'s');
    for (let i = 0; i < 4; i++) { await ev("document.querySelector('.choice').click();true"); await sleep(120); if (i < 3) { await ev("document.querySelector('#next').click();true"); await sleep(120); } }
    await ev("document.querySelector('#sub').click();true");
    await waitFor("!!document.querySelector('#yes')");
    assert.match(await ev("document.querySelector('.overlay').innerText"), /Submit exam\?/);
    await shot('04-submit-confirm');
    await ev("document.querySelector('#yes').click();true");
    await waitFor("location.hash.startsWith('#/user/result/')", 15000);
    await waitFor("document.body.innerText.includes('Your answers & the answer key')");
    const res2 = await ev('document.body.innerText');
    assert.ok(!res2.includes('submitted automatically'), 'manual submission is not reported as automatic');
    assert.equal((res2.match(/Correct answer/g) || []).length >= 1 || res2.includes('Incorrect') || res2.includes('Correct'), true);
    await shot('05-result-manual');
    // the candidate's dashboard now lists the report
    await ev("location.hash='#/user';true");
    await waitFor("!!document.querySelector('.utabs a[data-tab=completed]')");
    await ev("document.querySelector('.utabs a[data-tab=completed]').click();true");
    await waitFor("document.body.innerText.includes('View report')");
    // one attempt only: the exam is no longer offered to start again
    assert.ok(!(await ev('document.body.innerText')).includes('View instructions'), 'a finished exam cannot be started again');

    // the admin sees both attempts, with the violation recorded
    const rs = (await api('GET', `/api/admin/exams/${eid}/results`)).data;
    assert.equal(rs.summary.submitted, 2);
    const c1 = rs.results.find((x) => x.username === 'cand1'); assert.equal(c1.submit_reason, 'violation'); assert.equal(c1.violations, 2);
    assert.equal(rs.results.find((x) => x.username === 'cand2').submit_reason, 'manual');

    assert.deepEqual(errors, [], 'no browser errors:\n' + errors.join('\n'));
    console.log('EXAM SCREEN TESTS PASSED  (screenshots in ' + OUT + ')');
  } catch (e) {
    console.error('EXAM SCREEN TEST FAILED:', e.message); if (errors.length) console.error(errors.join('\n')); process.exitCode = 1;
  } finally {
    try { chrome && chrome.kill(); } catch (_) {} srv.kill();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(); }, 800);
  }
})();
