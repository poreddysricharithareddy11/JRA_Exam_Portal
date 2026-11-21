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
    ${!d.smtp_configured ? '<div class="alert warn">E-mail is not set up on the server. In Render > Environment add BREVO_API_KEY and MAIL_FROM, save, and wait for the redeploy.</div>' : ''}
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
      <p class="small mute" style="margin:0 0 10px">Choose who receives it: tick the top box to select everyone, or tick individual candidates. The e-mail contains the exam details and the portal link.</p>
      <div class="tw"><table><thead><tr><th><input type="checkbox" id="all" title="Select everyone"></th><th>Candidate</th><th>E-mail</th><th>Last e-mail</th></tr></thead><tbody id="at"></tbody></table></div>
      <div class="row mt"><button class="btn primary lg" id="send">Send</button></div>
    </div>`;

  const lastChip = (u) => (!u.last_kind ? '<span class="mute small">Not sent yet</span>'
    : `<span class="chip ${u.last_status === 'sent' ? 'sent' : u.last_status === 'failed' ? 'failed' : 'pending'}" title="${esc(u.last_error || '')}">${u.last_kind === 'reminder' ? 'Reminder' : 'Invitation'} · ${u.last_status}</span> <span class="small mute">${fmtDT(u.last_sent_at || u.last_at)}</span>`);
  const visible = () => d.users.filter((u) => (u.username + u.full_name + u.email).toLowerCase().includes(q));

  function draw() {
    const n = sel.size, b = $('#send', box);
    b.textContent = `Send ${kind === 'reminder' ? 'reminder' : 'invitation'} to ${n} candidate${n === 1 ? '' : 's'}`;
    b.disabled = !n || !d.smtp_configured || !e.published || ended || (kind === 'reminder' && started);
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
      toast(`${r.queued} e-mail(s) queued${r.skipped_no_email ? ` · ${r.skipped_no_email} skipped (no address)` : ''}`, 'ok');
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
  let d = null, off = 0;
  const paint = () => {
    if (!d) return;
    const t = Date.now() + off;
    const notStarted = Math.max(0, d.candidates - d.submitted - d.writing.length);
    box.innerHTML = `<div class="tiles">
      <div class="tile"><div class="ic g">✍️</div><div><b>${d.writing.length}</b><span>Writing now</span></div></div>
      <div class="tile"><div class="ic b">✅</div><div><b>${d.submitted}</b><span>Submitted</span></div></div>
      <div class="tile"><div class="ic y">⏳</div><div><b>${notStarted}</b><span>Not started</span></div></div>
      <div class="tile"><div class="ic r">⚠️</div><div><b>${d.writing.filter((w) => w.violations).length}</b><span>With warnings</span></div></div></div>
      <div class="card mt"><div class="row mb"><h3 style="margin:0"><span class="pulse"></span>Candidates writing now</h3><span class="small mute right">Updates automatically</span></div>
      <div class="tw"><table><thead><tr><th>Candidate</th><th>Progress</th><th>Time left</th><th>Warnings</th></tr></thead><tbody>
      ${d.writing.length ? d.writing.map((w) => {
        const left = Date.parse(w.deadline_at) - t, pct = w.total ? Math.round((w.answered / w.total) * 100) : 0;
        return `<tr><td><b>${esc(w.full_name || w.username)}</b><div class="small mute">${esc(w.username)}</div></td>
          <td style="min-width:170px"><div class="prog"><div style="width:${pct}%"></div></div><div class="small mute">${w.answered}${w.total ? ' / ' + w.total : ''} answered</div></td>
          <td class="mono" style="color:var(--${left < 300000 ? 'bad' : 'ink'})">${fmtCountdown(Math.max(0, left))}</td>
          <td>${w.violations ? `<span class="chip failed">${w.violations} warning${w.violations > 1 ? 's' : ''}</span>` : '<span class="chip sent">Clean</span>'}</td></tr>`;
      }).join('') : '<tr><td colspan="4" class="mute" style="text-align:center;padding:30px">Nobody is writing this exam right now.</td></tr>'}
      </tbody></table></div></div>`;
  };
  async function load() {
    try { d = await api('GET', `/api/admin/exams/${id}/live`); off = Date.parse(d.now) - Date.now(); paint(); } catch (_) { /* retry next tick */ }
  }
  await load();
  const a = setInterval(() => { if (!document.hidden) load(); }, 4000), b = setInterval(paint, 1000);
  JEP.cleanup = () => { clearInterval(a); clearInterval(b); };
}
