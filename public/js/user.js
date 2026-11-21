'use strict';
/* Candidate views: dashboard, instructions, proctored exam, result */
JEP.views.user = async (p) => {
  if (!p.length) return userHome();
  if (p[0] === 'exam' && p[1]) return userInstructions(p[1]);
  if (p[0] === 'result' && p[1]) return userResult(p[1]);
  if (p[0] === 'take') { location.hash = '#/user'; return; }  // reload during exam → back to dashboard (can resume)
  location.hash = '#/user';
};

/* ------------------------------ dashboard ------------------------------ */
async function userHome() {
  const [{ exams, now }, { reports }] = await Promise.all([api('GET', '/api/user/exams'), api('GET', '/api/user/reports')]);
  const off = Date.parse(now) - Date.now();
  const name = esc(JEP.me.full_name || JEP.me.username);
  const avg = reports.length ? Math.round(reports.reduce((s, r) => s + r.percent, 0) / reports.length) : null;
  const passed = reports.filter((r) => r.passed).length;
  const TABKEY = 'jep_utab_' + JEP.me.id;
  let tab = store.sget(TABKEY);
  if (tab !== 'upcoming' && tab !== 'completed') tab = exams.length || !reports.length ? 'upcoming' : 'completed';
  const how = { time_up: 'Auto-submitted: time up', violation: 'Auto-submitted: warnings' };

  const main = shell('home', `
    <div class="hero"><div class="grow"><h1>Welcome, ${name} 👋</h1><p id="sub"></p></div><div class="next" id="next"></div></div>
    <div class="tiles">
      <div class="tile pick" data-go="upcoming" role="button" tabindex="0"><div class="ic g">🟢</div><div><b id="n-live">0</b><span>Open now</span></div></div>
      <div class="tile pick" data-go="upcoming" role="button" tabindex="0"><div class="ic c">📅</div><div><b id="n-up">0</b><span>Upcoming</span></div></div>
      <div class="tile pick" data-go="completed" role="button" tabindex="0"><div class="ic b">✅</div><div><b>${reports.length}</b><span>Completed${reports.length ? ` · ${passed} passed` : ''}</span></div></div>
      <div class="tile"><div class="ic y">🏆</div><div><b>${avg === null ? '–' : avg + '%'}</b><span>Average score</span></div></div></div>
    <div class="tabs utabs" role="tablist">
      <a href="#/user" data-tab="upcoming" role="tab">Upcoming &amp; live <span class="cnt" id="c-up">${exams.length}</span></a>
      <a href="#/user" data-tab="completed" role="tab">Completed <span class="cnt">${reports.length}</span></a></div>
    <div id="pane"></div>`);

  const upcomingHTML = () => (exams.length ? exams.map((e) => `<div class="ucard" data-s="${Date.parse(e.start_at)}" data-e="${Date.parse(e.end_at)}" data-ip="${e.attempt_status === 'in_progress' ? 1 : 0}" data-id="${e.id}" data-n="${esc(e.name)}">
      <span class="accent"></span>
      <div class="grow"><div class="row" style="gap:10px"><h3 style="margin:0">${esc(e.name)}</h3><span data-chip></span></div>
        <div class="pills"><span>🗓 ${fmtDT(e.start_at)} → ${fmtDT(e.end_at)}</span><span>⏱ ${dur(e.duration_min)}</span><span>❓ ${e.question_count} questions</span><span>🎯 Pass ${e.pass_percent}%</span>${e.negative_marks ? `<span>➖ -${e.negative_marks} per wrong</span>` : ''}</div>
        <div class="window hidden"><div class="prog"><div data-bar></div></div></div>
        <div class="cd" data-cd></div></div>
      <a class="btn lg" href="#/user/exam/${e.id}" data-btn>View instructions</a></div>`).join('')
    : `<div class="empty"><div class="big">📭</div><b>No upcoming exams</b><span>When an exam is scheduled for you it will appear here.</span></div>`);

  const completedHTML = () => (reports.length ? reports.map((r) => `<div class="ucard done">
      <span class="accent ${r.passed ? 'ok' : 'bad'}"></span>
      <div class="ring" style="--p:${Math.max(0, Math.min(100, r.percent))};--c:var(--${r.passed ? 'ok' : 'bad'})"><b>${Math.round(r.percent)}%</b></div>
      <div class="grow"><div class="row" style="gap:10px"><h3 style="margin:0">${esc(r.name)}</h3><span class="chip ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span></div>
        <div class="pills"><span>📝 Score ${r.score} / ${r.total}</span><span>🗓 ${fmtDT(r.submitted_at)}</span>${how[r.submit_reason] ? `<span>${how[r.submit_reason]}</span>` : ''}</div></div>
      <div class="row"><a class="btn" href="#/user/result/${r.id}">View report</a><a class="btn" href="/api/user/attempts/${r.id}/pdf">⬇ PDF</a></div></div>`).join('')
    : `<div class="empty"><div class="big">🗂️</div><b>No completed exams yet</b><span>Your results appear here right after you submit an exam.</span></div>`);

  function draw() {
    store.sset(TABKEY, tab);
    $$('.utabs a', main).forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    $('#pane', main).innerHTML = tab === 'upcoming' ? upcomingHTML() : completedHTML();
    tick();
  }
  const go = (t) => { tab = t; draw(); };
  $$('.utabs a', main).forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); go(a.dataset.tab); }; });
  $$('.tile.pick', main).forEach((el) => {
    el.onclick = () => go(el.dataset.go);
    el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(el.dataset.go); } };
  });

  // everything time-dependent (status chips, countdowns, buttons, the "next up" banner) is recomputed every second
  function tick() {
    const t = Date.now() + off;
    let live = 0, up = 0, next = null;
    for (const e of exams) {
      const s = Date.parse(e.start_at), en = Date.parse(e.end_at);
      if (t > en) continue;
      if (t >= s) { live++; if (!next || next.live === false || en < next.end) next = { e, live: true, end: en }; }
      else { up++; if (!next || (next.live === false && s < next.start)) next = { e, live: false, start: s }; }
    }
    $('#n-live', main).textContent = live; $('#n-up', main).textContent = up;
    $('#c-up', main).textContent = live + up;
    $('#sub', main).textContent = live ? 'You have an assessment open right now.' : up ? 'Your upcoming assessments are listed below.' : 'You have no pending assessments.';
    $('#next', main).innerHTML = next
      ? `<small>${next.live ? 'OPEN NOW' : 'NEXT UP'}</small><b>${esc(next.e.name)}</b><span>${next.live ? `Closes in ${fmtCountdown(next.end - t)}` : `Opens in ${fmtCountdown(next.start - t)}`}</span>
         <a class="btn" href="#/user/exam/${next.e.id}">${next.live ? (next.e.attempt_status === 'in_progress' ? 'Resume exam' : 'Start exam') : 'View instructions'}</a>`
      : '<small>NEXT UP</small><b>Nothing scheduled</b><span>Check back later</span>';
    $$('#pane .ucard[data-s]', main).forEach((c) => {
      const s = +c.dataset.s, en = +c.dataset.e, inProg = c.dataset.ip === '1';
      const st = t < s ? 'upcoming' : t <= en ? 'live' : 'ended';
      c.classList.toggle('is-live', st === 'live');
      $('[data-chip]', c).innerHTML = chip(st);
      $('[data-cd]', c).textContent = st === 'upcoming' ? `Opens in ${fmtCountdown(s - t)}` : st === 'live' ? `Open now · closes in ${fmtCountdown(en - t)}` : 'This exam has closed';
      const w = $('.window', c); w.classList.toggle('hidden', st !== 'live');
      if (st === 'live') $('[data-bar]', c).style.width = Math.min(100, Math.max(0, ((t - s) / (en - s)) * 100)) + '%';
      const b = $('[data-btn]', c);
      b.classList.toggle('hidden', st === 'ended');
      b.classList.toggle('primary', st === 'live');
      b.textContent = st === 'live' ? (inProg ? 'Resume exam' : 'Start exam') : 'View instructions';
    });
  }
  draw();
  const iv = setInterval(tick, 1000);
  JEP.cleanup = () => clearInterval(iv);
}

/* ----------------------------- instructions ---------------------------- */
async function userInstructions(id) {
  const d = await api('GET', `/api/user/exams/${id}/info`);
  const e = d.exam, off = Date.parse(d.now) - Date.now();
  if (d.already_submitted) { location.hash = '#/user'; return; }
  const main = shell('home', `
    <p><a href="#/user">← My exams</a></p>
    <div class="card"><h1>${esc(e.name)}</h1>
      <div class="grid g4 mb">
        <div class="stat"><b>${d.question_count}</b><span>Questions</span></div><div class="stat"><b>${d.marks_vary ? '≈ ' : ''}${d.total_marks}</b><span>Total marks</span></div>
        <div class="stat"><b>${dur(e.duration_min)}</b><span>Duration</span></div><div class="stat"><b>${e.pass_percent}%</b><span>Pass mark</span></div></div>
      <h3>Instructions — please read carefully</h3>
      <ol class="rules">
        <li>This is a <b>proctored</b> multiple-choice exam with one correct option per question.</li>
        <li>${e.negative_marks ? `<b>Negative marking:</b> ${e.negative_marks} mark(s) deducted for every wrong answer. Unanswered questions carry no penalty.` : 'There is no negative marking.'}</li>
        <li>Stay in <b>full-screen</b>. Do not press <b>Esc</b> or switch tabs/windows: the first time is a warning, the <b>second time submits your exam automatically</b>.</li>
        <li>The timer keeps running once you start. When time is up your answers are <b>submitted automatically</b>.</li>
        <li><b>One attempt only.</b> Your result and the answer key appear after you submit, and a PDF is e-mailed to <b>${esc(JEP.me.email || 'your registered address')}</b>.</li>
        ${(d.default_instructions || []).map((l) => `<li>${esc(l)}</li>`).join('')}
      </ol>
      ${String(e.instructions || '').trim() ? `<h3 class="mt">Instructions from Administration</h3>
      <ul class="rules admin-ins">${String(e.instructions).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
      <label class="row" style="cursor:pointer;gap:10px"><input type="checkbox" id="agree"><span>I have read and understood the instructions and agree to follow the exam rules.</span></label>
      <div class="row mt"><button class="btn primary lg" id="go" disabled>Start exam</button><span class="mute small" id="gostat"></span></div>
    </div>`);
  const agree = $('#agree', main), go = $('#go', main), st = $('#gostat', main);
  const s = Date.parse(e.start_at), en = Date.parse(e.end_at);
  const upd = () => {
    const t = Date.now() + off;
    const open = t >= s && t <= en;
    st.textContent = t < s ? `Opens in ${fmtCountdown(s - t)}` : t > en ? 'This exam has closed.' : '';
    go.disabled = !(agree.checked && open);
  };
  agree.onchange = upd; upd();
  const iv = setInterval(upd, 1000);
  JEP.cleanup = () => clearInterval(iv);
  go.onclick = async () => {
    go.disabled = true;
    try {
      const el = document.documentElement;
      if (!el.requestFullscreen) throw new Error('Your browser does not support full-screen mode. Please use the latest Chrome, Edge or Firefox on a laptop/desktop.');
      await el.requestFullscreen();             // must be inside this click (user gesture)
      const data = await api('POST', `/api/user/exams/${id}/start`);
      runExam(data);
    } catch (err) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (err.data && err.data.submitted) { toast(err.message, 'err'); location.hash = `#/user/result/${err.data.attempt_id}`; return; }
      fail(err.name === 'TypeError' ? new Error('Full-screen permission is required to start the exam.') : err); upd();
    }
  };
}

/* ------------------------------ the exam ------------------------------- */
function runExam(data) {
  if (JEP.cleanup) { JEP.cleanup(); JEP.cleanup = null; }
  const { exam, questions, attempt } = data;
  const off = Date.parse(data.now) - Date.now();
  const deadline = Date.parse(attempt.deadline_at);
  const limit = data.violation_limit;
  const S = { answers: { ...data.answers }, idx: 0, ended: false, violations: attempt.violations, lastV: 0, warning: false, finishing: false };
  const aid = attempt.id;
  const remaining = () => deadline - (Date.now() + off);

  document.body.classList.add('exam');
  JEP.guard = () => { if (S.ended) return true; if (location.hash !== '#/user/take') history.pushState(null, '', '#/user/take'); return false; };
  history.pushState(null, '', '#/user/take');
  app.innerHTML = `
    <div class="xbar"><div class="in"><b class="grow" style="font-size:1.05rem">${esc(exam.name)}</b>
      <span class="small mute" id="viol"></span><span class="save-ind mute" id="sv"></span><div class="timer" id="tm">--:--</div>
      <button class="btn primary" id="sub">Submit exam</button></div></div>
    <div class="xwrap"><div class="card" id="qa"></div>
      <aside class="card"><h3>Questions</h3><div class="palette" id="pal"></div>
        <div class="small mute mt"><span style="color:var(--ok)">■</span> answered &nbsp; □ not answered</div>
        <div class="small mt" id="cnt"></div></aside></div>`;

  /* ---- candidate watermark: their e-mail repeated diagonally over the whole paper ---- */
  const wmText = JEP.me.email || JEP.me.username;
  const wmStyle = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const fill = dark ? 'rgba(255,255,255,0.13)' : 'rgba(15,23,42,0.12)';
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='440' height='250'><g transform='rotate(-28 220 125)' font-family='Arial,Helvetica,sans-serif' fill='" + fill + "' text-anchor='middle'>" +
      "<text x='220' y='120' font-size='18' font-weight='700'>" + esc(wmText) + "</text><text x='220' y='144' font-size='12'>" + esc(JEP.me.username) + "</text></g></svg>";
    return 'position:fixed!important;inset:0!important;z-index:2147483000!important;pointer-events:none!important;display:block!important;visibility:visible!important;opacity:1!important;' +
      'background-image:url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")!important;background-repeat:repeat!important;';
  };
  let wmWant = wmStyle();
  const wmMount = () => {
    let el = document.getElementById('wm-user');
    if (!el || !document.body.contains(el)) { el = document.createElement('div'); el.id = 'wm-user'; el.setAttribute('aria-hidden', 'true'); document.body.append(el); }
    if (el.getAttribute('style') !== wmWant) el.setAttribute('style', wmWant);
  };
  // the watermark restores itself if it is removed or edited while the exam is running
  const wmWatch = new MutationObserver(() => { const el = document.getElementById('wm-user'); if (!el || el.getAttribute('style') !== wmWant || el.className) wmMount(); });
  const wmTick = setInterval(() => { wmWant = wmStyle(); wmMount(); }, 1000);
  wmMount();
  wmWatch.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  const wmStop = () => { wmWatch.disconnect(); clearInterval(wmTick); document.getElementById('wm-user')?.remove(); };

  const qa = $('#qa'), pal = $('#pal');
  function drawQ() {
    const q = questions[S.idx], sel = S.answers[q.id];
    qa.innerHTML = `<div class="small mute mb">Question ${S.idx + 1} of ${questions.length} · ${q.marks} mark${q.marks === 1 ? '' : 's'}</div>
      <div class="qtext">${esc(q.text)}</div>
      ${q.options.map((o, i) => `<div class="choice ${sel === i ? 'sel' : ''}" data-i="${i}" role="radio" aria-checked="${sel === i}" tabindex="0"><b>${L[i]}</b><span>${esc(o)}</span></div>`).join('')}
      <div class="row mt"><button class="btn" id="prev" ${S.idx === 0 ? 'disabled' : ''}>← Previous</button>
        <button class="btn" id="clr" ${sel == null ? 'disabled' : ''}>Clear answer</button>
        <button class="btn primary right" id="next">${S.idx === questions.length - 1 ? 'Review & submit' : 'Next →'}</button></div>`;
    $$('.choice', qa).forEach((c) => { c.onclick = () => choose(q, +c.dataset.i); c.onkeydown = (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); choose(q, +c.dataset.i); } }; });
    $('#prev').onclick = () => { S.idx--; drawQ(); drawPal(); };
    $('#next').onclick = () => { if (S.idx < questions.length - 1) { S.idx++; drawQ(); drawPal(); } else confirmSubmit(); };
    $('#clr').onclick = () => choose(q, null);
  }
  function drawPal() {
    pal.innerHTML = questions.map((q, i) => `<button class="${S.answers[q.id] != null ? 'ans' : ''} ${i === S.idx ? 'cur' : ''}" data-i="${i}">${i + 1}</button>`).join('');
    $$('button', pal).forEach((b) => b.onclick = () => { S.idx = +b.dataset.i; drawQ(); drawPal(); });
    const n = Object.values(S.answers).filter((v) => v != null).length;
    $('#cnt').innerHTML = `<b>${n}</b> of ${questions.length} answered`;
  }
  async function choose(q, i) {
    S.answers[q.id] = i; drawQ(); drawPal();
    $('#sv').textContent = 'Saving…';
    try { await api('POST', `/api/user/attempts/${aid}/answer`, { question_id: q.id, selected_index: i }); $('#sv').textContent = '✓ Saved'; }
    catch (e) { if (e.data?.submitted) return finish('time_up', true); $('#sv').textContent = '⚠ Not saved yet – will retry on submit'; }
  }

  function confirmSubmit() {
    const unans = questions.length - Object.values(S.answers).filter((v) => v != null).length;
    const m = modal(`<h3>Submit exam?</h3><p>${unans ? `You have <b>${unans}</b> unanswered question${unans > 1 ? 's' : ''}. ` : 'You have answered all questions. '}You cannot change your answers after submitting.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Go back</button><button class="btn primary" id="yes">Submit now</button></div>`);
    modalOpen = true;
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) modalOpen = false; if (e.target.id === 'yes') { m.close(); modalOpen = false; finish('manual'); } });
  }
  let modalOpen = false;
  $('#sub').onclick = confirmSubmit;

  /* ---- finishing ---- */
  async function finish(reason, alreadySubmitted) {
    if (S.finishing) return; S.finishing = true;
    clearInterval(timerIv);
    document.body.insertAdjacentHTML('beforeend', '<div class="overlay" id="fin"><div class="modal" style="text-align:center"><h3>Submitting your exam…</h3><p class="mute">Please wait. Do not close this window.</p></div></div>');
    if (!alreadySubmitted) {
      for (let i = 0; i < 4; i++) {
        try { await api('POST', `/api/user/attempts/${aid}/submit`, { reason, answers: S.answers }); break; }
        catch (e) { if (e.data?.submitted || e.status === 404) break; await new Promise((r) => setTimeout(r, 1500)); }
      }
    }
    teardown();
    $$('.overlay').forEach((o) => o.remove());
    location.hash = `#/user/result/${aid}?r=${reason}`;
  }
  function teardown() {
    S.ended = true;
    wmStop();
    document.body.classList.remove('exam');
    JEP.guard = null;
    window.onbeforeunload = null;
    ['fullscreenchange', 'visibilitychange'].forEach((ev) => document.removeEventListener(ev, onEvt));
    window.removeEventListener('blur', onBlur);
    ['contextmenu', 'copy', 'cut', 'paste', 'dragstart'].forEach((ev) => document.removeEventListener(ev, block, true));
    document.removeEventListener('keydown', onKey, true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try { navigator.keyboard?.unlock(); } catch (_) {}
  }

  /* ---- proctoring ---- */
  async function violation(type) {
    if (S.ended || S.finishing) return;
    const t = Date.now();
    if (t - S.lastV < 2000) return;       // one physical action can fire several events
    S.lastV = t;
    let r = null;
    try { r = await api('POST', `/api/user/attempts/${aid}/violation`, { type, answers: S.answers }); } catch (e) { if (e.data?.submitted) r = { submitted: true }; }
    if (r && r.submitted) return finish('violation', true);
    S.violations = r ? r.violations : S.violations + 1;
    if (S.violations >= limit) return finish('violation');
    showWarning(type);
    $('#viol').textContent = `Warnings: ${S.violations}/${limit - 1}`;
  }
  function showWarning(type) {
    if (S.warning) return;
    S.warning = true;
    const why = { fullscreen_exit: 'You exited full-screen mode', tab_switch: 'You switched to another tab or window', window_blur: 'The exam window lost focus' }[type] || 'A rule violation was detected';
    const o = document.createElement('div');
    o.className = 'overlay'; o.style.zIndex = 500; o.style.background = 'rgba(127,29,29,.96)';
    o.innerHTML = `<div class="modal" style="text-align:center"><div style="font-size:42px">⚠️</div><h2 style="color:var(--bad)">Warning ${S.violations} of ${limit - 1}</h2>
      <p><b>${why}.</b></p><p>This is your only warning. <b>If it happens again, your exam will be submitted automatically</b> with the answers you have marked so far.</p>
      <button class="btn primary lg" id="back">Return to exam (full screen)</button></div>`;
    document.body.append(o);
    $('#back', o).onclick = async () => {
      try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch (_) { toast('Press the button again to re-enter full screen', 'err'); return; }
      S.lastV = Date.now(); o.remove(); S.warning = false; lockEsc();
    };
  }
  const onEvt = () => {
    if (document.visibilityState === 'hidden') violation('tab_switch');
    else if (!document.fullscreenElement) violation('fullscreen_exit');
  };
  const onBlur = () => { setTimeout(() => { if (!S.ended && !document.hasFocus() && !S.warning) violation('window_blur'); }, 150); };
  const block = (e) => e.preventDefault();
  const onKey = (e) => {
    const k = e.key.toLowerCase();
    const bad = e.key === 'F12' || e.key === 'F11' || e.key === 'F5' || e.key === 'PrintScreen' || e.key === 'Escape' || e.key === 'Meta' || e.key === 'ContextMenu'
      || ((e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'a', 'p', 's', 'u', 'f', 'r', 'w', 't', 'n', 'l'].includes(k))
      || (e.ctrlKey && e.shiftKey && ['i', 'j', 'c', 'n'].includes(k)) || (e.altKey && ['arrowleft', 'arrowright', 'tab'].includes(k));
    if (bad) { e.preventDefault(); e.stopPropagation(); }
  };
  function lockEsc() { try { navigator.keyboard?.lock(['Escape']); } catch (_) {} }

  document.addEventListener('fullscreenchange', onEvt);
  document.addEventListener('visibilitychange', onEvt);
  window.addEventListener('blur', onBlur);
  ['contextmenu', 'copy', 'cut', 'paste', 'dragstart'].forEach((ev) => document.addEventListener(ev, block, true));
  document.addEventListener('keydown', onKey, true);
  window.onbeforeunload = (e) => { if (!S.ended) { e.preventDefault(); e.returnValue = ''; } };
  lockEsc();

  /* ---- timer ---- */
  const tm = $('#tm');
  const timerIv = setInterval(() => {
    const r = remaining();
    tm.textContent = fmtCountdown(Math.max(0, r));
    tm.classList.toggle('low', r < 5 * 60000);
    if (r <= 0 && !S.finishing) finish('time_up');
  }, 500);
  $('#viol').textContent = S.violations ? `Warnings: ${S.violations}/${limit - 1}` : '';
  drawQ(); drawPal();
  if (remaining() <= 0) finish('time_up');
}

/* ------------------------------- result -------------------------------- */
async function userResult(aid) {
  let d;
  try { d = await api('GET', `/api/user/attempts/${aid}/result`); }
  catch (e) { toast(e.message, 'err'); location.hash = '#/user'; return; }
  const a = d.attempt;
  const why = new URLSearchParams((location.hash.split('?')[1] || '')).get('r');
  shell('home', `
    <p><a href="#/user">← My exams</a></p>
    ${why === 'violation' || a.submit_reason === 'violation' ? '<div class="alert bad">Your exam was submitted automatically because of repeated proctoring violations. Answers marked up to that point were saved and evaluated.</div>' : ''}
    ${a.submit_reason === 'time_up' ? '<div class="alert warn">Time was up, so your exam was submitted automatically with the answers you had marked.</div>' : ''}
    <div class="card"><div class="score-hero"><div class="score-ring ${a.passed ? '' : 'fail'}"><div><b>${a.score}/${a.total}</b>${a.percent}%</div></div>
      <div class="grow"><h1 style="margin-bottom:6px">${esc(a.exam_name)}</h1>
        <div class="meta"><span class="chip ${a.passed ? 'pass' : 'fail'}" style="font-size:.95rem">${a.passed ? 'PASSED' : 'FAILED'}</span><span>Pass mark ${a.pass_percent}%</span><span>✓ ${a.correct} correct</span><span>✗ ${a.wrong} wrong</span><span>– ${a.unanswered} unanswered</span><span>Set ${esc(a.set_name)}</span></div>
        <p class="small mute mt">${!a.email ? '' : a.email_status === 'sent' ? `A PDF copy of this result with the answer key was e-mailed to <b>${esc(a.email)}</b>.` : a.email_status === 'failed' ? 'We could not e-mail the PDF right now — you can download it with the button on the right.' : `A PDF copy of this result with the answer key is being e-mailed to <b>${esc(a.email)}</b>.`}</p></div>
      <a class="btn" href="/api/user/attempts/${a.id}/pdf">⬇ Download PDF</a></div></div>
    <h2 class="mt">Your answers &amp; the answer key</h2>${reviewHTML(d.questions)}`);
}
