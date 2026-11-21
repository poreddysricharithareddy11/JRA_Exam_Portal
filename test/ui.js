// Real-browser UI check using headless Chrome over the DevTools protocol (no extra packages).
// Usage: node test/ui.js [outputDir]    -> saves screenshots, fails on any JavaScript error.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('No Chrome/Edge found - skipping UI test'); process.exit(0); }

const PORT = 3995, DBG = 9333, BASE = `http://localhost:${PORT}`;
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'jep-shots-'));
fs.mkdirSync(OUT, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jep-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
const api = async (m, u, body) => {
  const r = await fetch(BASE + u, { method: m, headers: { ...(cookie ? { cookie } : {}), ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

(async () => {
  const srv = spawn(process.execPath, ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: dir, ADMIN_USERNAME: 'adm', ADMIN_PASSWORD: 'Adm1nPass!', SMTP_USER: '', SMTP_PASS: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let chrome;
  const errors = [];
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/healthz'); break; } catch (_) { await sleep(200); } }

    // ---- seed through the API ----
    await api('POST', '/api/auth/login', { username: 'adm', password: 'Adm1nPass!' });
    const now = Date.now();
    const eid = (await api('POST', '/api/admin/exams', { name: 'Aptitude Test 2026', duration_min: 45, pass_percent: 40, negative_marks: 0.25, questions_per_attempt: 5, num_sets: 3, instructions: 'Bring your photo ID.\nKeep rough paper ready.',
      start_at: new Date(now - 60e3).toISOString(), end_at: new Date(now + 6 * 3600e3).toISOString() })).data.id;
    const bank = Array.from({ length: 12 }, (_, i) => `${i + 1}. What is ${i + 1} + ${i + 1}?\nA) ${i}\nB) ${(i + 1) * 2}\nC) ${i + 5}\nD) ${i + 9}\nAnswer: B`).join('\n');
    const fd = new FormData(); fd.append('text', bank);
    await api('POST', `/api/admin/exams/${eid}/questions/upload`, fd);
    assert.equal((await api('POST', `/api/admin/exams/${eid}/publish`, { published: true })).status, 200);
    for (const [u, n] of [['priya', 'Priya Sharma'], ['rahul', 'Rahul Verma'], ['anita', 'Anita Rao']])
      await api('POST', '/api/admin/users', { username: u, password: 'secret1', email: `${u}@example.com`, full_name: n });
    await api('POST', `/api/admin/exams/${eid}/notify`, { mode: 'all', kind: 'invite' });   // only invited candidates see the exam
    // one finished attempt (for charts/results) and one still writing (for the live monitor)
    const login = async (u) => { const c = { cookie: '' }; const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'secret1' }) }); c.cookie = r.headers.get('set-cookie').split(';')[0]; return c; };
    const cr = await login('priya');
    const st = await (await fetch(`${BASE}/api/user/exams/${eid}/start`, { method: 'POST', headers: { cookie: cr.cookie } })).json();
    await fetch(`${BASE}/api/user/attempts/${st.attempt.id}/submit`, { method: 'POST', headers: { cookie: cr.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ answers: {} }) });
    const cw = await login('rahul');
    const sw = await (await fetch(`${BASE}/api/user/exams/${eid}/start`, { method: 'POST', headers: { cookie: cw.cookie } })).json();
    await fetch(`${BASE}/api/user/attempts/${sw.attempt.id}/answer`, { method: 'POST', headers: { cookie: cw.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ question_id: sw.questions[0].id, selected_index: 0 }) });

    // ---- start Chrome ----
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--window-size=1366,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    let tab; for (let i = 0; i < 60; i++) { try { tab = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json(); break; } catch (_) { await sleep(250); } }
    assert.ok(tab, 'Chrome started');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
      else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon|401|questions\/parse/.test(msg.params.entry.text + msg.params.entry.url)) errors.push('LOG: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error('eval failed: ' + expr + ' -> ' + JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
    const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch (_) {} await sleep(150); } throw new Error('timeout waiting for: ' + expr); };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    const go = async (hash) => { await send('Page.navigate', { url: BASE + '/' + hash }); await sleep(300); };
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    const doLogin = async (u, p) => { await waitFor("!!document.querySelector('#lf')"); await ev(`document.querySelector('#u').value=${JSON.stringify(u)};document.querySelector('#p').value=${JSON.stringify(p)};document.querySelector('#lf').requestSubmit();true`); };

    // 1) login page + wrong password
    await go('');
    await waitFor("!!document.querySelector('#lf')");
    assert.ok(!(await ev("document.body.innerText")).includes('Candidate\nAdmin'), 'no role tabs on login');
    await waitFor("[...document.querySelectorAll('.loginlogo, .logotile img')].length===2 && [...document.querySelectorAll('.loginlogo, .logotile img')].every((i) => i.complete && i.naturalWidth > 0)");
    await shot('01-login');
    await doLogin('priya', 'wrong');
    await waitFor("!document.querySelector('#lerr').classList.contains('hidden')");
    assert.match(await ev("document.querySelector('#lerr').textContent"), /Invalid username or password/);

    // 2) DEEP LINK: open the assessment link while signed out -> login -> lands on the instructions page
    await go(`#/user/exam/${eid}`);
    await waitFor("!!document.querySelector('#lf')");
    await doLogin('anita', 'secret1');
    await waitFor("document.querySelector('h1') && document.querySelector('h1').textContent.includes('Aptitude Test 2026')");
    assert.equal(await ev('location.hash'), `#/user/exam/${eid}`, 'deep link lands on the assessment page');
    await waitFor("!!document.querySelector('#agree')");
    const ins = await ev('document.body.innerText');
    assert.ok(ins.includes('Read each question and all its options carefully'), 'standard instructions shown');
    assert.ok(ins.includes('Instructions from Administration') && ins.includes('Bring your photo ID.') && ins.includes('Keep rough paper ready.'), 'administration instructions shown');
    assert.ok(ins.indexOf('Instructions from Administration') > ins.indexOf('Read each question and all its options carefully'), 'administration instructions come after the standard ones');
    assert.ok(ins.indexOf('Bring your photo ID.') > ins.indexOf('Instructions from Administration'));
    assert.equal(await ev("document.querySelector('#go').disabled"), true, 'start disabled until agreed');
    await ev("document.querySelector('#agree').click();true");
    await waitFor("document.querySelector('#go').disabled===false");
    await shot('02-instructions');

    // 3) candidate dashboard
    await go('#/user');
    await waitFor("document.body.innerText.includes('Upcoming & live')");
    assert.ok((await ev('document.body.innerText')).includes('Aptitude Test 2026'));
    await shot('03-candidate-dashboard');
    assert.equal(await ev("document.querySelectorAll('.utabs a').length"), 2, 'two tabs: upcoming and completed');
    await ev("document.querySelector('.utabs a[data-tab=completed]').click();true");
    assert.equal(await ev("document.querySelectorAll('#pane .ucard[data-s]').length"), 0, 'completed tab shows no upcoming exams');
    await ev("document.querySelector('.utabs a[data-tab=upcoming]').click();true");
    await waitFor("document.body.innerText.includes('Aptitude Test 2026')");
    await ev("document.querySelector('#th').click();true");   // dark mode
    await sleep(300); await shot('04-candidate-dark');
    await ev("document.querySelector('#th').click();true");
    await ev("document.querySelector('#out').click();true");
    await waitFor("!!document.querySelector('#lf')");

    // 4) a candidate who already finished it: dashboard shows report
    await doLogin('priya', 'secret1');
    await waitFor("document.body.innerText.includes('View report')");
    await shot('05-candidate-with-report');
    await ev("document.querySelector('#out').click();true");
    await waitFor("!!document.querySelector('#lf')");

    // 5) admin: exams list, invite tab, live monitor, results (with charts), settings
    await doLogin('adm', 'Adm1nPass!');
    await waitFor("document.body.innerText.includes('Aptitude Test 2026')");
    assert.equal(await ev("document.querySelector('.brandlogo').naturalWidth > 0"), true, 'logo shown in the header');
    assert.equal(await ev("document.body.classList.contains('wm')"), true, 'watermark enabled on signed-in pages');
    assert.equal(await ev("getComputedStyle(document.body, '::after').backgroundImage.includes('/brand/logo')"), true, 'watermark uses the logo');
    await shot('06-admin-exams');
    await go(`#/admin/exam/${eid}/invite`);
    await waitFor("!!document.querySelector('#send')");
    assert.ok((await ev('document.body.innerText')).includes('not set up'), 'warns that e-mail is not configured');
    assert.equal(await ev("document.querySelectorAll('#lnk, input[name=mode]').length"), 0, 'no extra link box or mode cards');
    await ev("document.querySelector('#all').click();true");
    assert.match(await ev("document.querySelector('#send').textContent"), /invitation to 3 candidates/);
    assert.equal(await ev("document.querySelector('#kinds [data-k=reminder]').disabled"), true, 'reminder not offered after the exam started');
    await shot('07-admin-invite');
    await go(`#/admin/exam/${eid}/live`);
    await waitFor("document.body.innerText.includes('Rahul Verma')");
    assert.ok((await ev('document.body.innerText')).includes('1 / 5 answered'), 'live progress shown');
    await shot('08-admin-live');
    // ONE real press on a tile must switch the list, even when the page refreshes while the button is held down
    // (the old code redrew the tiles every second, so the first click was often lost and a second click was needed)
    const rc = await ev("(() => { const r = document.querySelector('.tile.pick[data-f=submitted]').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc[0], y: rc[1], button: 'left', clickCount: 1 });
    await sleep(1300);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc[0], y: rc[1], button: 'left', clickCount: 1 });
    await waitFor("document.body.innerText.includes('Candidates who have submitted')");
    await ev("document.querySelector('.tile.pick[data-f=writing]').click();true");
    await waitFor("document.body.innerText.includes('Candidates writing now')");
    // the tiles are filters: each opens the list of candidates in that state
    assert.equal(await ev("document.querySelectorAll('.tile.pick').length"), 4, 'four clickable tiles');
    await ev("document.querySelector('.tile.pick[data-f=submitted]').click();true");
    await waitFor("document.body.innerText.includes('Candidates who have submitted')");
    const subTxt = await ev('document.body.innerText');
    assert.ok(subTxt.includes('Priya Sharma') && /Passed|Failed/.test(subTxt) && !subTxt.includes('Rahul Verma'), 'submitted list shows only submitted candidates with results');
    await ev("document.querySelector('.tile.pick[data-f=not_started]').click();true");
    await waitFor("document.body.innerText.includes('Candidates who have not started')");
    const nsTxt = await ev('document.body.innerText');
    assert.ok(nsTxt.includes('Anita Rao') && !nsTxt.includes('Priya Sharma') && !nsTxt.includes('Rahul Verma'), 'not-started list shows only those candidates');
    await shot('08b-live-not-started');
    await ev("document.querySelector('.tile.pick[data-f=writing]').click();true");
    await go(`#/admin/exam/${eid}/results`);
    await waitFor("!!document.querySelector('.hist')");
    await shot('09-admin-results');
    await go(`#/admin/exam/${eid}/settings`);
    await waitFor("!!document.querySelector('input[name=end_at]')");
    const settingsText = await ev('document.body.innerText');
    assert.ok(settingsText.includes('published') && settingsText.includes('Questions per candidate') && settingsText.includes('Number of sets'), 'summary tile shown');
    assert.equal(await ev("document.querySelectorAll('input[name=num_sets], textarea[name=instructions], input[name=start_at]').length"), 0, 'locked fields are not shown as inputs');
    assert.equal(await ev("document.querySelectorAll('#ef input').length"), 1, 'only the closing time is editable');
    // the closing time cannot be picked earlier than opening time + duration: it is corrected the moment it is picked, with the reason shown
    const pick = (v, ev2) => ev(`(() => { const i = document.querySelector('input[name=end_at]'); i.value = ${JSON.stringify(v)}; ${ev2.map((n) => `i.dispatchEvent(new Event('${n}', { bubbles: true }));`).join(' ')} })();true`);
    const minEnd = await ev("document.querySelector('input[name=end_at]').min");
    assert.ok(minEnd, 'the picker has a minimum (opening time + duration)');
    await pick('2020-01-01T00:00', ['input']);                       // while typing: Save is blocked and the reason is shown
    assert.equal(await ev("document.querySelector('input[name=end_at]').validity.customError"), true, 'too early blocks Save');
    assert.equal(await ev("document.querySelector('.closing-error').hidden"), false);
    await ev("document.querySelector('input[name=end_at]').scrollIntoView({block:'center'});true");
    await shot('21-closing-time-too-early');
    await pick('2020-01-01T00:00', ['input', 'change']);             // once picked: put back to the earliest allowed time
    assert.equal(await ev("document.querySelector('input[name=end_at]').value"), minEnd, 'an earlier time is put back to opening time + duration');
    assert.match(await ev("document.querySelector('.closing-error').textContent"), /cannot be earlier than/);
    await pick('2099-01-01T10:00', ['input', 'change']);             // a later time is left alone
    assert.equal(await ev("document.querySelector('input[name=end_at]').value"), '2099-01-01T10:00', 'a later time is accepted untouched');
    assert.equal(await ev("document.querySelector('.closing-error').hidden"), true);
    // the same on the create-exam form (the minimum follows the opening time and the duration)
    await go('#/admin/exam/new');
    await waitFor("!!document.querySelector('input[name=duration_min]')");
    await ev("(() => { const f = document.querySelector('#ef').elements; f.start_at.value = '2030-01-01T10:00'; f.duration_min.value = '60'; f.start_at.dispatchEvent(new Event('input', { bubbles: true })); })();true");
    assert.equal(await ev("document.querySelector('input[name=end_at]').min"), '2030-01-01T11:00', 'minimum = opening time + duration');
    await ev("(() => { const i = document.querySelector('input[name=end_at]'); i.value = '2030-01-01T10:30'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })();true");
    assert.equal(await ev("document.querySelector('input[name=end_at]').value"), '2030-01-01T11:00', 'create form: an earlier closing time is corrected too');
    await go(`#/admin/exam/${eid}/settings`);
    await waitFor("!!document.querySelector('input[name=end_at]')");
    await shot('20-exam-settings');
    await go(`#/admin/exam/${eid}/questions`);
    await waitFor("document.body.innerText.includes('12 questions')");
    const qt = await ev('document.body.innerText');
    assert.ok(qt.includes('3 sets × 5'), 'sets summary shown');
    assert.ok(qt.includes('Download PDF') && qt.includes('View question bank'), 'PDF and view buttons');
    assert.equal(await ev("document.querySelectorAll('.qedit').length"), 0, 'question list hidden until asked');
    assert.equal(await ev("!!document.querySelector('#uq')"), false, 'no upload form once published');
    await shot('10-admin-questions');
    // an exam nobody has started yet: the upload forms are visible, with no set pickers anywhere
    const e2 = (await api('POST', '/api/admin/exams', { name: 'Fresh Exam', duration_min: 30, pass_percent: 50, num_sets: 4, questions_per_attempt: 8,
      start_at: new Date(now + 86400e3).toISOString(), end_at: new Date(now + 2 * 86400e3).toISOString() })).data.id;
    await go(`#/admin/exam/${e2}/questions`);
    await waitFor("!!document.querySelector('#uq')");
    const ft = await ev('document.body.innerText');
    assert.ok(ft.includes('Read questions & answers') && !ft.includes('Apply answers') && !ft.includes('Upload answers'), 'upload form shown, no separate answers upload');
    assert.equal(await ev("document.querySelectorAll('#uq select, #ua select').length"), 0, 'no set picker in the upload or answer forms');
    assert.ok(!/Set number|Delete set/.test(ft));
    await shot('13-admin-questions-empty');

    // --- a written Q&A document is rejected with a clear explanation and what was read ---
    const upload = async (name, text) => {
      const fp = path.join(dir, name); fs.writeFileSync(fp, text);
      const doc = await send('DOM.getDocument'); const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#uq input[type=file]' });
      await send('DOM.setFileInputFiles', { files: [fp], nodeId: q.result.nodeId });
      await ev("document.querySelector('#uqb').click();true");
    };
    await upload('written.txt', '1. Explain polymorphism.\nAnswer: It means many forms.\n2. Define OOP.\nAnswer: Object oriented programming');
    await waitFor("document.body.innerText.includes(\"couldn't find multiple-choice\")");
    const failTxt = await ev('document.body.innerText');
    assert.ok(/written question-and-answer/.test(failTxt) && failTxt.includes('Explain polymorphism'), 'explains why, and shows what was read');
    await shot('14-parse-failure');
    await ev("document.querySelector('.overlay [data-close]').click();true");

    // --- a real bank: 2 answers in the file, 3 missing -> review, map the rest, save ---
    await upload('bank.txt', '1. Capital of India?\nA) Mumbai\nB) New Delhi\nC) Kolkata\nD) Chennai\nAnswer: B\n2. Largest planet?\nA) Earth\nB) Mars\nC) Jupiter\nD) Venus\nAns: C\n3. 2 + 2 = ?\nA) 3\nB) 4\nC) 5\nD) 6\n4. Sun rises in the?\nA) East\nB) West\nC) North\nD) South\n5. H2O is?\nA) Salt\nB) Water\nC) Gold\nD) Iron');
    await waitFor("!!document.querySelector('#svq')");
    assert.equal(await ev("document.querySelector('#pv_ok').textContent"), '2', 'two answers read from the file');
    assert.equal(await ev("document.querySelector('#pv_miss').textContent"), '3');
    assert.equal(await ev("document.querySelector('#svq').disabled"), true, 'cannot save until every question has an answer');
    assert.equal(await ev("document.querySelector('select[data-a=\"1\"]').value"), '2', 'Q2 mapped to C from "Ans: C"');
    await shot('15-review-mapping');
    await ev("document.querySelector('#pv_text').value='3-B, 4-A';document.querySelector('#pv_apply').click();true");
    await waitFor("document.querySelector('#pv_miss').textContent==='1'");
    assert.match(await ev("document.querySelector('#pv_msg').textContent"), /Applied 2 answers/);
    await ev("var s=document.querySelector('select[data-a=\"4\"]');s.value='1';s.dispatchEvent(new Event('change'));true");
    await waitFor("document.querySelector('#svq').disabled===false");
    assert.match(await ev("document.querySelector('#pv_strip').textContent"), /1→B.*2→C.*3→B.*4→A.*5→B/, 'final key shown as question → answer');
    await shot('16-review-complete');
    await ev("document.querySelector('#svq').click();true");
    await waitFor("!!document.querySelector('#viewbank')");
    assert.equal(await ev("document.querySelectorAll('.qedit').length"), 0, 'list hidden until asked');
    await ev("document.querySelector('#viewbank').click();true");
    assert.equal(await ev("document.querySelectorAll('.qedit').length"), 5);
    assert.equal(await ev("document.querySelectorAll('.qedit .chip.sent').length"), 5, 'all five show their answer');

    // --- corrections after candidates have taken an exam (the locked, live one) ---
    await go(`#/admin/exam/${eid}/questions`);
    await waitFor("!!document.querySelector('#viewbank')");
    await ev("document.querySelector('#viewbank').click();true");
    await waitFor("document.body.innerText.includes('Add marks')");
    assert.equal(await ev("document.querySelectorAll('.qedit [data-text], .qedit [data-marks], .qedit input[type=radio]').length"), 0, 'nothing is editable except Add marks');
    await ev("var c=document.querySelector('.qedit');c.querySelector('[data-grace]').click();c.querySelector('[data-score]').click();true");
    await waitFor("!!document.querySelector('#cfm')");
    assert.match(await ev("document.querySelector('.overlay').innerText"), /recalculated/);
    await shot('17-correction-confirm');
    await ev("document.querySelector('#cfm').click();true");
    await sleep(1200);
    if (await ev("!!document.querySelector('#cfm')")) await ev("document.querySelector('.overlay [data-close]').click();true");   // decline re-sending e-mails
    await waitFor("document.body.innerText.includes('Marks added after candidates started')");
    await ev("document.querySelector('#changesbox details').open = true;true");
    assert.ok((await ev('document.body.innerText')).includes('awarded to every candidate'), 'logged');
    await shot('18-question-corrections');

    await go('#/admin/users');
    await waitFor("document.body.innerText.includes('Priya Sharma')");
    await shot('11-admin-users');

    // 6) phone-sized candidate view
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
    await ev("document.querySelector('#out').click();true"); await waitFor("!!document.querySelector('#lf')");
    await shot('12-mobile-login');

    assert.deepEqual(errors, [], 'no browser errors:\n' + errors.join('\n'));
    console.log('UI TESTS PASSED  (screenshots in ' + OUT + ')');
  } catch (e) {
    console.error('UI TEST FAILED:', e.message); if (errors.length) console.error(errors.join('\n')); process.exitCode = 1;
  } finally {
    try { chrome && chrome.kill(); } catch (_) {} srv.kill();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} process.exit(); }, 800);
  }
})();
