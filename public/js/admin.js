'use strict';
/* Admin views */
JEP.views.admin = async (p) => {
  if (!p.length) return adminExams();
  if (p[0] === 'users') return adminUsers();
  if (p[0] === 'exam' && p[1] === 'new') return adminExamForm();
  if (p[0] === 'exam' && p[1]) return adminExam(p[1], p[2] || 'questions');
  if (p[0] === 'attempt' && p[1]) return adminAttempt(p[1]);
  location.hash = '#/admin';
};

/** Ask the admin to type their password. Resolves to the typed text, or null if cancelled. */
function askPassword(msg) {
  return new Promise((resolve) => {
    const m = modal(`<h3>Confirm with your password</h3><p style="white-space:pre-line">${esc(msg)}</p>
      <div class="field"><input type="password" id="pwc" autocomplete="current-password" placeholder="Admin password"></div>
      <div class="row mt" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn danger" id="pwok">Delete exam</button></div>`);
    const input = $('#pwc', m); input.focus();
    const done = () => { if (!input.value) { input.focus(); return; } m.close(); resolve(input.value); };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(); });
    m.addEventListener('click', (ev) => { if (ev.target.id === 'pwok') done(); else if (ev.target === m || ev.target.closest('[data-close]')) resolve(null); });
  });
}

/* ------------------------------ exam list ------------------------------ */
async function adminExams() {
  const [{ exams }, stats] = await Promise.all([api('GET', '/api/admin/exams'), api('GET', '/api/admin/stats')]);
  let filter = null, q = '';
  const main = shell('exams', `
    <div class="row mb"><h1 style="margin:0">Exams</h1><a class="btn primary right" href="#/admin/exam/new">+ Create exam</a></div>
    <div class="grid g4 mb">
      <div class="card stat"><b>${exams.length}</b><span>Total exams</span></div>
      <div class="card stat"><b>${stats.attempts}</b><span>Submissions</span></div>
      <div class="card stat"><b>${stats.live_now}</b><span>Candidates writing now</span></div>
      <div class="card stat"><b>${stats.users}</b><span>Registered users</span></div>
    </div>
    <div class="row mb"><div class="filters" id="flt"></div><input type="text" id="srch" placeholder="Search exams…" style="max-width:260px" class="right"></div>
    <div id="list"></div>`);
  const order = ['live', 'upcoming', 'draft', 'ended'];
  const titles = { live: 'Live now', upcoming: 'Upcoming', draft: 'Drafts (not published)', ended: 'Completed exams' };
  function draw() {
    const counts = {}; order.forEach((s) => counts[s] = exams.filter((e) => e.status === s).length);
    if (!filter) filter = order.find((s) => counts[s]) || order[0];
    $('#flt', main).innerHTML = order.map((s) => `<button class="pill ${filter === s ? 'on' : ''}" data-f="${s}">${titles[s].split(' (')[0]} (${counts[s]})</button>`).join('');
    $$('#flt .pill', main).forEach((b) => b.onclick = () => { filter = b.dataset.f; draw(); });
    const shown = exams.filter((e) => e.status === filter &&e.name.toLowerCase().includes(q));
    if (!shown.length) { $('#list', main).innerHTML = `<div class="card mute" style="text-align:center;padding:40px">No exams found. ${exams.length ? '' : 'Create your first exam to get started.'}</div>`; return; }
    $('#list', main).innerHTML = order.filter((s) => shown.some((e) => e.status === s)).map((s) => `
      <div class="sec-title"><h2>${titles[s]}</h2><span class="chip">${shown.filter((e) => e.status === s).length}</span></div>
      ${shown.filter((e) => e.status === s).map((e) => `<div class="card ecard">
        <div class="grow"><h3><a href="#/admin/exam/${e.id}/${s === 'ended' ? 'results' : 'questions'}" style="color:inherit;text-decoration:none">${esc(e.name)}</a> ${chip(e.status)}</h3>
          <div class="meta"><span>🗓 ${fmtDT(e.start_at)} → ${fmtDT(e.end_at)}</span><span>⏱ ${dur(e.duration_min)}</span><span>❓ ${e.question_count} questions</span><span>🎯 Pass ${e.pass_percent}%</span>${e.negative_marks ? `<span>➖ -${e.negative_marks}/wrong</span>` : ''}</div></div>
        <div class="meta"><span><b>${e.submitted_count}</b> submitted</span>${e.running_count ? `<span><b>${e.running_count}</b> writing</span>` : ''}<span><b>${e.passed_count}</b> passed</span></div>
        <div class="row"><a class="btn sm" href="#/admin/exam/${e.id}/results">Results</a><a class="btn sm" href="#/admin/exam/${e.id}/questions">Questions</a>
        <button class="btn sm danger" data-del="${e.id}" data-n="${esc(e.name)}">Delete</button></div></div>`).join('')}`).join('');
    $$('[data-del]', main).forEach((b) => b.onclick = async () => {
      const password = await askPassword(`Delete "${b.dataset.n}" together with all its questions and results? This cannot be undone.\nType your admin password to confirm.`);
      if (password === null) return;
      try { await api('DELETE', `/api/admin/exams/${b.dataset.del}`, { password }); toast('Exam deleted', 'ok'); adminExams(); } catch (e) { fail(e); }
    });
  }
  $('#srch', main).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  draw();
}

/* ------------------------------ exam form ------------------------------ */
function examFormHTML(e) {
  const now = new Date(); now.setMinutes(0, 0, 0);
  const start = e ? e.start_at : new Date(now.getTime() + 3600e3).toISOString();
  const end = e ? e.end_at : new Date(now.getTime() + 25 * 3600e3).toISOString();
  return `<form id="ef">
    <div class="field"><label class="f">Exam name *</label><input type="text" name="name" required maxlength="200" value="${esc(e?.name || '')}"></div>
    <div class="grid g4">
      <div class="field"><label class="f">Duration (minutes) *</label><input type="number" name="duration_min" min="1" max="600" required value="${e?.duration_min ?? 60}"></div>
      <div class="field"><label class="f">Pass percentage *</label><input type="number" name="pass_percent" min="0" max="100" step="0.01" required value="${e?.pass_percent ?? 40}"></div>
      <div class="field"><label class="f">Marks per question</label><input type="number" name="default_marks" min="0.01" step="0.01" value="${e?.default_marks ?? 1}"></div>
      <div class="field"><label class="f">Negative marks per wrong</label><input type="number" name="negative_marks" min="0" step="0.01" value="${e?.negative_marks ?? 0}"><div class="hint">0 = no negative marking</div></div>
    </div>
    <div class="grid g4"><div class="field"><label class="f">Questions per candidate</label><input type="number" name="questions_per_attempt" min="1" step="1" value="${e?.questions_per_attempt ?? ''}">
      <div class="hint">Leave blank to use every question.</div></div>
      <div class="field"><label class="f">Number of sets *</label><input type="number" name="num_sets" min="1" max="100" step="1" required value="${e?.num_sets ?? 1}">
      <div class="hint">Sets are built automatically from the bank.</div></div></div>
    <div class="grid g2">
      <div class="field"><label class="f">Opens at *</label><input type="datetime-local" name="start_at" required value="${toLocalInput(start)}"></div>
      <div class="field"><label class="f">Closes at *</label><input type="datetime-local" name="end_at" required value="${toLocalInput(end)}"><div class="hint">Candidates can start only between these times.</div></div>
    </div>
    <div class="field"><label class="f">Instructions from Administration (optional)</label><textarea name="instructions" rows="4" placeholder="One point per line">${esc(e?.instructions || '')}</textarea><div class="hint">Shown to candidates after the standard instructions.</div></div>
    <button class="btn primary">${e ? 'Save changes' : 'Create exam & add questions →'}</button>
  </form>`;
}
function readExamForm(form) {
  const f = Object.fromEntries(new FormData(form));
  f.questions_per_attempt = f.questions_per_attempt === '' ? null : f.questions_per_attempt;
  f.start_at = fromLocalInput(f.start_at); f.end_at = fromLocalInput(f.end_at);
  return f;
}
async function adminExamForm() {
  const main = shell('exams', `<p><a href="#/admin">← All exams</a></p><h1>Create exam</h1><div class="card">${examFormHTML()}</div>`);
  $('#ef', main).onsubmit = async (ev) => {
    ev.preventDefault();
    try { const r = await api('POST', '/api/admin/exams', readExamForm(ev.target)); toast('Exam created. Now add the questions.', 'ok'); location.hash = `#/admin/exam/${r.id}/questions`; } catch (e) { fail(e); }
  };
}

/* ----------------------------- exam detail ----------------------------- */
async function adminExam(id, tab) {
  const [detail, results] = await Promise.all([api('GET', `/api/admin/exams/${id}`), api('GET', `/api/admin/exams/${id}/results`)]);
  const { exam, sets, locked } = detail;
  const main = shell('exams', `
    <p><a href="#/admin">← All exams</a></p>
    <div class="row mb"><h1 style="margin:0">${esc(exam.name)}</h1>${chip(exam.status)}
      <div class="right row"><button class="btn ${exam.published ? '' : 'ok'}" id="pub">${exam.published ? 'Unpublish' : 'Publish exam'}</button></div></div>
    <div class="meta mb"><span>🗓 ${fmtDT(exam.start_at)} → ${fmtDT(exam.end_at)}</span><span>⏱ ${dur(exam.duration_min)}</span><span>🎯 Pass ${exam.pass_percent}%</span><span>➖ ${exam.negative_marks ? '-' + exam.negative_marks + ' per wrong' : 'No negative marking'}</span></div>
    ${!exam.published ? '<div class="alert warn">Draft — not visible to candidates until you publish it.</div>' : ''}
    <div class="tabs"><a href="#/admin/exam/${id}/questions" class="${tab === 'questions' ? 'on' : ''}">Questions &amp; answers (${sets.reduce((s, x) => s + x.count, 0)})</a>
      <a href="#/admin/exam/${id}/results" class="${tab === 'results' ? 'on' : ''}">Results (${results.summary.submitted})</a>
      <a href="#/admin/exam/${id}/invite" class="${tab === 'invite' ? 'on' : ''}">✉️ Send email reminders</a>
      <a href="#/admin/exam/${id}/live" class="${tab === 'live' ? 'on' : ''}">${exam.status === 'live' || results.summary.in_progress ? '<span class="pulse"></span>' : ''}Live monitor</a>
      <a href="#/admin/exam/${id}/settings" class="${tab === 'settings' ? 'on' : ''}">Settings</a></div>
    <div id="tab"></div>`);
  $('#pub', main).onclick = async () => {
    try { await api('POST', `/api/admin/exams/${id}/publish`, { published: !exam.published }); toast(exam.published ? 'Exam unpublished' : 'Exam published', 'ok'); adminExam(id, tab); } catch (e) { fail(e); }
  };
  const box = $('#tab', main);
  if (tab === 'settings') {
    if (exam.published) {
      // Published: show the exam's details once (read-only) and allow only extending the closing time.
      const row = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
      box.innerHTML = `<div class="card">
        <h3 style="margin:0 0 12px">${esc(exam.name)}</h3>
        <div class="grid g3">
          ${row('Duration', dur(exam.duration_min))}
          ${row('Pass mark', exam.pass_percent + '%')}
          ${row('Marks per question', exam.default_marks)}
          ${row('Negative marking', exam.negative_marks ? '-' + exam.negative_marks + ' per wrong' : 'None')}
          ${row('Questions per candidate', exam.questions_per_attempt || 'All')}
          ${row('Number of sets', exam.num_sets || 1)}
          ${row('Opens', fmtDT(exam.start_at))}
          ${row('Closes', fmtDT(exam.end_at))}
        </div>
        <p class="small mute" style="margin:12px 0 0">This exam is published, so these settings are locked. You can only extend the closing time.</p>
      </div>
      <div class="card"><form id="ef">
        <div class="field" style="max-width:320px"><label class="f">Extend closing time</label><input type="datetime-local" name="end_at" required value="${toLocalInput(exam.end_at)}" min="${toLocalInput(exam.end_at)}"></div>
        <button class="btn primary">Save new closing time</button>
      </form></div>`;
      $('#ef', box).onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          await api('PUT', `/api/admin/exams/${id}`, { end_at: fromLocalInput(ev.target.elements.end_at.value) });
          toast('Closing time updated', 'ok'); adminExam(id, 'settings');
        } catch (e) { fail(e); }
      };
    } else {
      box.innerHTML = `<div class="card">${examFormHTML(exam)}</div>`;
      $('#ef', box).onsubmit = async (ev) => {
        ev.preventDefault();
        try { await api('PUT', `/api/admin/exams/${id}`, readExamForm(ev.target)); toast('Saved', 'ok'); adminExam(id, 'settings'); } catch (e) { fail(e); }
      };
    }
  } else if (tab === 'results') resultsTab(box, id, results);
  else if (tab === 'invite') inviteTab(box, id);
  else if (tab === 'live') liveTab(box, id);
  else questionsTab(box, id, detail);
}


/* ---- results tab ---- */
function resultsTab(box, id, r) {
  const s = r.summary;
  let q = '';
  box.innerHTML = `
    <div class="grid g4 mb">
      <div class="card stat"><b>${s.submitted}</b><span>Submitted${s.in_progress ? ` · ${s.in_progress} writing` : ''}</span></div>
      <div class="card stat"><b style="color:var(--ok)">${s.passed}</b><span>Passed</span></div>
      <div class="card stat"><b style="color:var(--bad)">${s.failed}</b><span>Failed</span></div>
      <div class="card stat"><b>${s.average_percent}%</b><span>Average · high ${s.highest}% · low ${s.lowest}%</span></div></div>
    ${s.submitted ? chartsHTML(r.results.filter((x) => x.status === 'submitted'), r.exam.pass_percent) : ''}
    <div class="card"><div class="row mb"><h3 style="margin:0">Candidate results</h3>
      <input type="text" id="rs" placeholder="Search name / username" style="max-width:240px" class="right">
      <a class="btn sm" href="#" data-dl="/api/admin/exams/${id}/results.csv" data-name="results.csv">⬇ Export CSV</a>
      <button class="btn sm" id="rsf">Resend failed e-mails</button></div>
      <div class="tw"><table><thead><tr><th>#</th><th>Candidate</th><th>Set</th><th>Score</th><th>%</th><th>Result</th><th>Violations</th><th>Submitted</th><th>E-mail</th><th></th></tr></thead><tbody id="rt"></tbody></table></div></div>
    ${r.not_attempted.length ? `<details class="card mt"><summary><b>Not attempted (${r.not_attempted.length})</b></summary><p class="small mute mt">${r.not_attempted.map((u) => esc(u.full_name || u.username)).join(', ')}</p></details>` : ''}`;
  function draw() {
    const rows = r.results.filter((x) => (x.username + ' ' + x.full_name).toLowerCase().includes(q));
    $('#rt', box).innerHTML = rows.length ? rows.map((x, i) => `<tr>
      <td>${i + 1}</td><td><b>${esc(x.full_name || x.username)}</b><div class="small mute">${esc(x.username)} · ${esc(x.email)}</div></td><td>${esc(x.set_name)}</td>
      ${x.status === 'submitted' ? `<td>${x.score} / ${x.total}</td><td>${x.percent}%</td><td><span class="chip ${x.passed ? 'pass' : 'fail'}">${x.passed ? 'PASS' : 'FAIL'}</span></td>` : '<td colspan="3"><span class="chip draft">In progress</span></td>'}
      <td>${x.violations || '-'}</td><td class="small">${x.status === 'submitted' ? `${fmtDT(x.submitted_at)}<div class="mute">${reasonText(x.submit_reason)}</div>` : '-'}</td>
      <td>${x.status === 'submitted' ? `<span class="chip ${x.email_status === 'sent' ? 'sent' : x.email_status === 'failed' ? 'failed' : 'pending'}" title="${esc(x.email_error || '')}">${x.email_status}</span>` : ''}</td>
      <td style="white-space:nowrap">${x.status === 'submitted' ? `<a class="btn sm" href="#/admin/attempt/${x.id}">View</a> <a class="btn sm" href="#" data-dl="/api/admin/attempts/${x.id}/pdf" data-name="result.pdf">PDF</a> <button class="btn sm" data-rs="${x.id}">Resend</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="10" class="mute" style="text-align:center;padding:30px">No results yet.</td></tr>';
    $$('[data-rs]', box).forEach((b) => b.onclick = async () => {
      try { const o = await api('POST', `/api/admin/attempts/${b.dataset.rs}/resend`); toast(o.smtp_configured ? 'E-mail queued' : 'Queued, but SMTP is not configured on the server', o.smtp_configured ? 'ok' : 'err'); } catch (e) { fail(e); }
    });
  }
  $('#rs', box).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  $('#rsf', box).onclick = async () => { try { const o = await api('POST', `/api/admin/exams/${id}/resend-failed`); toast(`${o.queued} e-mail(s) queued`, 'ok'); } catch (e) { fail(e); } };
  draw();
}

/* ------------------------------ attempt view ---------------------------- */
async function adminAttempt(aid) {
  const { attempt: a, questions } = await api('GET', `/api/admin/attempts/${aid}`);
  shell('exams', `<p><a href="#/admin/exam/${a.exam_id}/results">← Back to results</a></p>
    <div class="card"><div class="score-hero"><div class="score-ring ${a.passed ? '' : 'fail'}"><div><b>${a.score}/${a.total}</b>${a.percent}%</div></div>
      <div class="grow"><h2>${esc(a.exam_name)}</h2><p><b>${esc(a.full_name || a.username)}</b> (${esc(a.username)}) · ${esc(a.email)}</p>
        <div class="meta"><span class="chip ${a.passed ? 'pass' : 'fail'}">${a.passed ? 'PASS' : 'FAIL'}</span><span>✓ ${a.correct} correct</span><span>✗ ${a.wrong} wrong</span><span>– ${a.unanswered} unanswered</span><span>Set ${esc(a.set_name)}</span><span>Violations: ${a.violations}</span></div>
        <div class="small mute mt">${reasonText(a.submit_reason)} · Started ${fmtDT(a.started_at)} · Submitted ${fmtDT(a.submitted_at)}</div></div>
      <a class="btn" href="#" data-dl="/api/admin/attempts/${a.id}/pdf" data-name="result.pdf">⬇ PDF</a></div></div>
    <h2 class="mt">Answer sheet <span class="small mute">(as shown to this candidate — their own question and option order)</span></h2>${reviewHTML(questions)}`);
}

/* -------------------------------- users -------------------------------- */
async function adminUsers() {
  const { users } = await api('GET', '/api/admin/users');
  let q = '';
  const main = shell('users', `
    <div class="row mb"><h1 style="margin:0">User data</h1><span class="chip">${users.length}</span>
      <div class="right row"><button class="btn" id="bulk">Bulk add</button><button class="btn primary" id="add">+ Add user</button></div></div>
    <div class="card"><input type="text" id="us" placeholder="Search users…" style="max-width:280px;margin-bottom:12px">
      <div class="tw"><table><thead><tr><th>Username</th><th>Name</th><th>E-mail</th><th>Exams taken</th><th>Added</th><th></th></tr></thead><tbody id="ut"></tbody></table></div></div>`);
  function draw() {
    const rows = users.filter((u) => (u.username + u.full_name + u.email).toLowerCase().includes(q));
    $('#ut', main).innerHTML = rows.length ? rows.map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${u.exams_taken}</td><td class="small">${fmtDT(u.created_at)}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-e="${u.id}">Edit</button> <button class="btn sm danger" data-d="${u.id}">Delete</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="mute" style="text-align:center;padding:30px">No users yet. Click “Add user”.</td></tr>';
    $$('[data-e]', main).forEach((b) => b.onclick = () => userForm(users.find((u) => u.id == b.dataset.e)));
    $$('[data-d]', main).forEach((b) => b.onclick = async () => {
      const u = users.find((x) => x.id == b.dataset.d);
      if (!await confirmBox(`Delete user "${u.username}"? Their exam results will also be removed.`, 'Delete user')) return;
      try { await api('DELETE', `/api/admin/users/${u.id}`); toast('User deleted', 'ok'); adminUsers(); } catch (e) { fail(e); }
    });
  }
  $('#us', main).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  $('#add', main).onclick = () => userForm();
  $('#bulk', main).onclick = bulkForm;
  draw();
}
function userForm(u) {
  const m = modal(`<h3>${u ? 'Edit user' : 'Add user'}</h3><form id="uf">
    <div class="field"><label class="f">Username *</label><input type="text" name="username" required value="${esc(u?.username || '')}" autocomplete="off"></div>
    <div class="field"><label class="f">Password ${u ? '(leave blank to keep)' : '*'}</label><input type="text" name="password" ${u ? '' : 'required'} minlength="6" autocomplete="off"></div>
    <div class="field"><label class="f">Full name</label><input type="text" name="full_name" value="${esc(u?.full_name || '')}"></div>
    <div class="field"><label class="f">E-mail * <span class="mute">(results are sent here)</span></label><input type="email" name="email" required value="${esc(u?.email || '')}"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  $('#uf', m).onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    try { await api(u ? 'PUT' : 'POST', u ? `/api/admin/users/${u.id}` : '/api/admin/users', body); toast('Saved', 'ok'); m.close(); adminUsers(); } catch (e) { fail(e); }
  };
}
function bulkForm() {
  const m = modal(`<h3>Bulk add users</h3><p class="small mute">One user per line: <code>username, password, email, full name</code> (full name optional).</p>
    <textarea id="bt" rows="9" placeholder="rahul01, Pass@123, rahul@example.com, Rahul Kumar"></textarea>
    <div id="bres" class="small mt"></div><div class="row mt" style="justify-content:flex-end"><button class="btn" data-close>Close</button><button class="btn primary" id="bgo">Add users</button></div>`, true);
  $('#bgo', m).onclick = async () => {
    const users = $('#bt', m).value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [username, password, email, ...n] = l.split(',').map((x) => x.trim()); return { username, password, email, full_name: n.join(', ') };
    });
    try {
      const r = await api('POST', '/api/admin/users/bulk', { users });
      $('#bres', m).innerHTML = `<div class="alert ${r.errors.length ? 'warn' : 'ok'}">Added ${r.added} user(s).${r.errors.map((e) => `<br>Line ${e.row}: ${esc(e.error)}`).join('')}</div>`;
      if (r.added) adminUsers();
    } catch (e) { fail(e); }
  };
}
