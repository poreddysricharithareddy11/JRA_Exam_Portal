'use strict';
/* Admin: charts, invitations/reminders, live monitor (loaded after admin.js) */

/* ------------------------------- charts -------------------------------- */
function chartsHTML(done, passPct) {
  const buckets = Array(10).fill(0);
  done.forEach((x) => { buckets[Math.min(9, Math.max(0, Math.floor(x.percent / 10)))]++; });
  const max = Math.max(1, ...buckets);
  const pass = done.filter((x) => x.passed).length, fail = done.length - pass;
  const deg = done.length ? Math.round((pass / done.length) * 360) : 0;
  return `<div class="charts"><div class="card"><h3>Score distribution</h3>
      <div class="hist">${buckets.map((n, i) => `<div class="col"><span class="n">${n || ''}</span><div class="bar ${(i + 1) * 10 <= passPct ? 'fail' : ''}" style="height:${Math.round((n / max) * 100)}%" title="${i * 10}–${(i + 1) * 10}%: ${n} candidate(s)"></div><small>${i * 10}</small></div>`).join('')}</div>
      <div class="small mute" style="text-align:center;margin-top:6px">Score % (red bars are below the ${passPct}% pass mark)</div></div>
    <div class="card"><h3>Pass / fail</h3><div class="donut" style="background:conic-gradient(var(--ok) 0 ${deg}deg,var(--bad) ${deg}deg 360deg)"><div><b>${done.length ? Math.round((pass / done.length) * 100) : 0}%</b><small class="mute">passed</small></div></div>
      <div class="legend"><span><i style="background:var(--ok)"></i>Pass ${pass}</span><span><i style="background:var(--bad)"></i>Fail ${fail}</span></div></div></div>`;
}

/* ---------------------------- invitations & reminders --------------------------- */
async function inviteTab(box, id) {
  let d = await api('GET', `/api/admin/exams/${id}/audience`);
  let kind = 'invite', q = '';
  const sel = new Set();
  const e = d.exam;
  const started = Date.now() >= Date.parse(e.start_at);
  const ended = Date.now() > Date.parse(e.end_at);

  box.innerHTML = `
    ${!d.smtp_configured ? '<div class="alert warn">E-mail is not set up on the server, so invitations cannot be e-mailed. In Render > Environment add BREVO_API_KEY and MAIL_FROM. Candidates you invite can still see the exam on their dashboard.</div>' : ''}
    ${!e.published ? '<div class="alert warn">Publish the exam first.</div>' : ''}
    ${ended ? '<div class="alert warn">This exam has ended.</div>' : ''}
    <div class="card">
      <div class="row mb">
        <h3 style="margin:0">Send e-mail</h3>
        <div class="filters" id="kinds">
          <button class="pill on" data-k="invite">Invitation</button>
          <button class="pill" data-k="reminder" ${started ? 'disabled title="Reminders can only be sent before the exam starts"' : ''}>Reminder</button>
        </div>
        <input type="text" id="aq" placeholder="Search candidates…" style="max-width:220px" class="right">
      </div>
      <p class="small mute" style="margin:0 0 10px"><b>Only invited candidates can see this exam</b> on their dashboard and open it. Tick the top box to invite everyone, or tick individual candidates. The e-mail contains the exam details and the portal link.</p>
      <div class="tw"><table><thead><tr><th><input type="checkbox" id="all" title="Select everyone"></th><th>Candidate</th><th>E-mail</th><th>Last e-mail</th></tr></thead><tbody id="at"></tbody></table></div>
      <div class="row mt"><button class="btn primary lg" id="send">Send</button></div>
    </div>`;

  const lastChip = (u) => (!u.last_kind ? '<span class="chip">Not invited</span>'
    : `<span class="chip ${u.last_status === 'sent' ? 'sent' : u.last_status === 'failed' ? 'failed' : 'pending'}" title="${esc(u.last_error || '')}">${u.last_kind === 'reminder' ? 'Reminder' : 'Invited'} · ${{ sent: 'e-mail sent', failed: 'e-mail not sent', pending: 'sending…' }[u.last_status] || u.last_status}</span> <span class="small mute">${fmtDT(u.last_sent_at || u.last_at)}</span>`);
  const visible = () => d.users.filter((u) => (u.username + u.full_name + u.email).toLowerCase().includes(q));

  function draw() {
    const n = sel.size, b = $('#send', box);
    b.textContent = `Send ${kind === 'reminder' ? 'reminder' : 'invitation'} to ${n} candidate${n === 1 ? '' : 's'}`;
    b.disabled = !n || !e.published || ended || (kind === 'reminder' && started);
    const rows = visible();
    $('#at', box).innerHTML = rows.length ? rows.map((u) => `<tr>
      <td><input type="checkbox" data-u="${u.id}" ${sel.has(u.id) ? 'checked' : ''} ${u.email ? '' : 'disabled'}></td>
      <td><b>${esc(u.full_name || u.username)}</b><div class="small mute">${esc(u.username)}</div></td>
      <td class="small">${u.email ? esc(u.email) : '<span class="chip failed">no e-mail</span>'}</td>
      <td>${lastChip(u)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="mute" style="text-align:center;padding:26px">No candidates yet. Add users under “User data”.</td></tr>';
    const withMail = rows.filter((u) => u.email);
    $('#all', box).checked = withMail.length > 0 && withMail.every((u) => sel.has(u.id));
    $$('[data-u]', box).forEach((c) => { c.onchange = () => { if (c.checked) sel.add(+c.dataset.u); else sel.delete(+c.dataset.u); draw(); }; });
  }

  $$('#kinds .pill', box).forEach((p) => { p.onclick = () => { if (p.disabled) return; kind = p.dataset.k; $$('#kinds .pill', box).forEach((x) => x.classList.toggle('on', x === p)); draw(); }; });
  $('#aq', box).oninput = (ev) => { q = ev.target.value.toLowerCase(); draw(); };
  $('#all', box).onchange = (ev) => { visible().filter((u) => u.email).forEach((u) => { if (ev.target.checked) sel.add(u.id); else sel.delete(u.id); }); draw(); };
  async function refresh() { try { d = await api('GET', `/api/admin/exams/${id}/audience`); draw(); } catch (_) { /* keep old view */ } }
  $('#send', box).onclick = async () => {
    const n = sel.size;
    if (!await confirmBox(`Send ${kind === 'reminder' ? 'a reminder' : 'an invitation'} e-mail with the portal link to ${n} candidate${n === 1 ? '' : 's'}?`, 'Send', false)) return;
    try {
      const r = await api('POST', `/api/admin/exams/${id}/notify`, { kind, mode: 'selected', user_ids: [...sel] });
      toast(`${r.queued} candidate${r.queued === 1 ? '' : 's'} invited${r.email_enabled ? ' · e-mail on its way' : ' · e-mail NOT sent (not set up)'}${r.skipped_no_email ? ` · ${r.skipped_no_email} skipped (no address)` : ''}`, r.email_enabled ? 'ok' : 'err');
      sel.clear(); refresh();
    } catch (err) { fail(err); }
  };
  draw();
  // keep delivery status fresh while e-mails are going out
  const iv = setInterval(() => { if (!document.hidden && d.users.some((u) => u.last_status === 'pending')) refresh(); }, 3000);
  JEP.cleanup = () => clearInterval(iv);
}

/* ------------------------------ live monitor ---------------------------- */
async function liveTab(box, id) {
  box.innerHTML = '<div class="card mute" style="text-align:center;padding:30px">Loading live data…</div>';
  let d = null, off = 0, filter = 'writing';
  const FILTERS = {
    writing: { ic: 'g', icon: '✍️', label: 'Writing now', title: 'Candidates writing now', pick: (p) => p.state === 'writing' },
    submitted: { ic: 'b', icon: '✅', label: 'Submitted', title: 'Candidates who have submitted', pick: (p) => p.state === 'submitted' },
    not_started: { ic: 'y', icon: '⏳', label: 'Not started', title: 'Candidates who have not started', pick: (p) => p.state === 'not_started' },
    warnings: { ic: 'r', icon: '⚠️', label: 'With warnings', title: 'Candidates with warnings', pick: (p) => p.violations > 0 },
  };
  const how = { manual: 'By candidate', time_up: 'Time up', violation: 'Too many warnings' };
  const warnChip = (p) => (p.violations ? `<span class="chip failed">${p.violations} warning${p.violations > 1 ? 's' : ''}</span>` : '<span class="chip sent">Clean</span>');
  const nameCell = (p) => `<td><b>${esc(p.full_name || p.username)}</b><div class="small mute">${esc(p.username)}</div></td>`;

  const COLS = {
    writing: { head: ['Candidate', 'Progress', 'Time left', 'Warnings'], row: (p, t) => {
      const left = Date.parse(p.deadline_at) - t, pct = p.total ? Math.round((p.answered / p.total) * 100) : 0;
      return `<tr>${nameCell(p)}<td style="min-width:170px"><div class="prog"><div style="width:${pct}%"></div></div><div class="small mute">${p.answered}${p.total ? ' / ' + p.total : ''} answered</div></td>
        <td class="mono" data-left="${Date.parse(p.deadline_at)}" style="color:var(--${left < 300000 ? 'bad' : 'ink'})">${fmtCountdown(Math.max(0, left))}</td><td>${warnChip(p)}</td></tr>`;
    } },
    submitted: { head: ['Candidate', 'Score', 'Result', 'Submitted', 'Warnings'], row: (p) => `<tr>${nameCell(p)}
      <td><b>${p.score ?? '-'} / ${p.max ?? '-'}</b> <span class="small mute">(${p.percent ?? 0}%)</span></td>
      <td>${p.passed ? '<span class="chip sent">Passed</span>' : '<span class="chip failed">Failed</span>'}</td>
      <td class="small">${fmtDT(p.submitted_at)}<div class="mute">${how[p.submit_reason] || ''}</div></td><td>${warnChip(p)}</td></tr>` },
    not_started: { head: ['Candidate', 'E-mail'], row: (p) => `<tr>${nameCell(p)}<td class="small">${p.email ? esc(p.email) : '<span class="chip failed">no e-mail</span>'}</td></tr>` },
    warnings: { head: ['Candidate', 'Status', 'Warnings'], row: (p) => `<tr>${nameCell(p)}
      <td>${p.state === 'submitted' ? '<span class="chip sent">Submitted</span>' : '<span class="chip live">Writing</span>'}</td><td>${warnChip(p)}</td></tr>` },
  };
  const EMPTY = { writing: 'Nobody is writing this exam right now.', submitted: 'Nobody has submitted yet.', not_started: 'Everyone has started.', warnings: 'No candidate has a warning.' };

  const paint = () => {
    if (!d) return;
    const t = Date.now() + off;
    const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, d.people.filter(f.pick).length]));
    const f = FILTERS[filter], list = d.people.filter(f.pick), c = COLS[filter];
    box.innerHTML = `<div class="tiles">${Object.entries(FILTERS).map(([k, x]) => `
      <div class="tile pick ${k === filter ? 'on' : ''}" data-f="${k}" role="button" tabindex="0" title="Show these candidates"><div class="ic ${x.ic}">${x.icon}</div><div><b>${counts[k]}</b><span>${x.label}</span></div></div>`).join('')}</div>
      <div class="card mt"><div class="row mb"><h3 style="margin:0">${filter === 'writing' ? '<span class="pulse"></span>' : ''}${f.title} <span class="chip">${list.length}</span></h3><span class="small mute right">Updates automatically</span></div>
      <div class="tw"><table><thead><tr>${c.head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>
      ${list.length ? list.map((p) => c.row(p, t)).join('') : `<tr><td colspan="${c.head.length}" class="mute" style="text-align:center;padding:30px">${EMPTY[filter]}</td></tr>`}
      </tbody></table></div></div>`;
  };
  // Only the countdown cells change every second, so update them in place. (Redrawing the whole page every second replaced
  // the tile under the pointer between press and release, which made the first click get lost.)
  const tickTimes = () => {
    const t = Date.now() + off;
    $$('[data-left]', box).forEach((c) => { const left = +c.dataset.left - t; c.textContent = fmtCountdown(Math.max(0, left)); c.style.color = left < 300000 ? 'var(--bad)' : 'var(--ink)'; });
  };
  // One handler on the stable container: it reacts on PRESS (so it never depends on the tile surviving until release),
  // and on click / keyboard as well.
  const pick = (ev) => {
    const el = ev.target.closest && ev.target.closest('.tile.pick');
    if (!el || el.dataset.f === filter) return;
    filter = el.dataset.f; paint();
  };
  box.onpointerdown = pick; box.onclick = pick;
  box.onkeydown = (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.closest && ev.target.closest('.tile.pick')) { ev.preventDefault(); pick(ev); } };
  let last = '';
  async function load() {
    try {
      d = await api('GET', `/api/admin/exams/${id}/live`); off = Date.parse(d.now) - Date.now();
      const sig = JSON.stringify(d.people);          // redraw only when something actually changed
      if (sig !== last) { last = sig; paint(); }
    } catch (_) { /* retry next tick */ }
  }
  await load();
  const a = setInterval(() => { if (!document.hidden) load(); }, 4000), b = setInterval(tickTimes, 1000);
  JEP.cleanup = () => { clearInterval(a); clearInterval(b); box.onpointerdown = box.onclick = box.onkeydown = null; };
}
