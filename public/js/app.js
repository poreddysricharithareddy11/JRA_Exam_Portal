/* Core: helpers, API client, login, router, shell. Views live in admin.js and user.js */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const L = 'ABCDEFGH';
const JEP = { me: null, views: {}, guard: null };
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
  sget: (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
  sset: (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) {} },
  sdel: (k) => { try { sessionStorage.removeItem(k); } catch (_) {} },
};
// Theme: saved choice, else the device preference
document.documentElement.dataset.theme = store.get('jep_theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

async function api(method, url, body, isForm) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    if (isForm) opt.body = body;
    else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(url, opt); } catch (_) { throw new Error('Network problem. Please check your connection.'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => ({})) : {};
  if (res.status === 401 && JEP.me && !url.includes('/auth/login')) { JEP.me = null; location.hash = '#/login'; }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
  return data;
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}
const fail = (e) => toast(e.message || 'Something went wrong', 'err');

function modal(html, wide) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<div class="modal ${typeof wide === 'string' ? wide : wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(o);
  const close = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o || e.target.closest('[data-close]')) close(); });
  o.close = close;
  return o;
}
function confirmBox(msg, okLabel = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    const m = modal(`<h3>Please confirm</h3><p style="white-space:pre-line">${esc(msg)}</p><div class="row mt" style="justify-content:flex-end">
      <button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cfm">${esc(okLabel)}</button></div>`);
    m.addEventListener('click', (e) => { if (e.target.id === 'cfm') { m.close(); resolve(true); } else if (e.target === m || e.target.closest('[data-close]')) resolve(false); });
  });
}

const fmtDT = (iso) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
const toLocalInput = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => new Date(v).toISOString();
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + 'm' : ''}` : `${m} min`).trim();
function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}
const chip = (s) => `<span class="chip ${s}">${({ live: 'Live now', upcoming: 'Upcoming', ended: 'Ended', draft: 'Draft' }[s] || s)}</span>`;

/* Shared: question-by-question review */
function reviewHTML(qs) {
  return qs.map((q) => `<div class="rq ${q.result}">
    <div class="qt">Q${q.position}. ${esc(q.text)}</div>
    <ol>${q.options.map((o, i) => {
      const c = i === q.correct_index, s = i === q.selected_index;
      const cls = c ? 'c' : s ? 'w' : '';
      const note = c ? (s ? '✓ Your answer · Correct' : '✓ Correct answer') : s ? '✗ Your answer' : '';
      return `<li class="${cls}"><b>${L[i]}.</b><span>${esc(o)}</span>${note ? `<em style="color:var(--${c ? 'ok' : 'bad'})">${note}</em>` : ''}</li>`;
    }).join('')}</ol>
    <div class="small mute">${q.result === 'bonus' ? '<b style="color:var(--warn)">Full marks awarded to every candidate for this question</b>' : q.result === 'unanswered' ? 'Not answered' : q.result === 'correct' ? 'Correct' : 'Incorrect'} · ${q.marks} mark${q.marks === 1 ? '' : 's'}</div>
  </div>`).join('');
}
const reasonText = (r) => ({ manual: 'Submitted by candidate', time_up: 'Auto-submitted: time up', violation: 'Auto-submitted: proctoring violation' }[r] || r || '-');

/* ------------------------------- shell -------------------------------- */
function shell(active, inner) {
  document.body.classList.add('wm');
  const admin = JEP.me.role === 'admin';
  const links = admin
    ? [['#/admin', 'Exams', 'exams'], ['#/admin/users', 'User data', 'users']]
    : [['#/user', 'My exams', 'home']];
  const dark = document.documentElement.dataset.theme === 'dark';
  app.innerHTML = `<header class="topbar"><div class="in">
      <a class="logo" href="${admin ? '#/admin' : '#/user'}"><img class="brandlogo" src="/brand/logo" alt="Jayarama Associates"><span>Exam Portal</span></a>
      <nav class="nav">${links.map((l) => `<a href="${l[0]}" class="${l[2] === active ? 'on' : ''}">${l[1]}</a>`).join('')}</nav>
      <div class="right userbox"><button class="icon-btn" id="th" title="Switch light / dark theme" aria-label="Toggle theme">${dark ? '☀️' : '🌙'}</button>
        <div class="who"><b>${esc(JEP.me.full_name || JEP.me.username)}</b><span>${admin ? 'Administrator' : 'Candidate'}</span></div>
        <div class="avatar">${esc(initials(JEP.me.full_name || JEP.me.username))}</div>
        <button class="btn sm" id="pw">Password</button><button class="btn sm" id="out">Sign out</button></div>
    </div></header><main class="container" id="main">${inner || ''}</main><footer class="foot">© ${new Date().getFullYear()} Jayarama Exam Portal · Secure online examinations</footer>`;
  $('#out').onclick = async () => { await api('POST', '/api/auth/logout').catch(() => {}); JEP.me = null; location.hash = '#/login'; };
  $('#pw').onclick = changePassword;
  $('#th').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('jep_theme', next); $('#th').textContent = next === 'dark' ? '☀️' : '🌙';
  };
  return $('#main');
}
function changePassword() {
  const m = modal(`<h3>Change password</h3>
    <div class="field"><label class="f">Current password</label><input type="password" id="p1" autocomplete="current-password"></div>
    <div class="field"><label class="f">New password (min 8 characters)</label><input type="password" id="p2" autocomplete="new-password"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ps">Update</button></div>`);
  $('#ps', m).onclick = async () => {
    try { await api('POST', '/api/auth/change-password', { current: $('#p1', m).value, next: $('#p2', m).value }); toast('Password updated', 'ok'); m.close(); } catch (e) { fail(e); }
  };
}

/* ------------------------------- login -------------------------------- */
JEP.views.login = () => {
  document.body.classList.remove('wm');
  app.innerHTML = `<div class="login-split">
    <section class="brand-pane">
      <div class="logotile"><img src="/brand/logo" alt="Jayarama Associates"></div>
      <div><h1>Secure online assessments,<br>made simple.</h1><p>Proctored multiple-choice exams with instant results.</p>
        <div class="feat"><div><i>🛡️</i><span><b>Proctored exams</b><br><small>Full-screen monitoring</small></span></div>
          <div><i>⚡</i><span><b>Instant results</b><br><small>Score and answer key right after you submit</small></span></div>
          <div><i>🔀</i><span><b>Unique papers</b><br><small>Every candidate gets their own paper</small></span></div></div></div>
      <small style="opacity:.7">© Jayarama Exam Portal</small>
    </section>
    <section class="form-pane"><form class="login" id="lf" autocomplete="on">
      <img class="loginlogo" src="/brand/logo" alt="Jayarama Associates">
      <h2 style="margin-bottom:4px">Welcome back</h2>
      <p class="mute small" style="margin:0 0 18px">Sign in with the username and password you were given.</p>
      <div class="field"><label class="f" for="u">Username</label><input type="text" id="u" name="username" autocomplete="username" required autofocus></div>
      <div class="field"><label class="f" for="p">Password</label><div class="pwwrap"><input type="password" id="p" name="password" autocomplete="current-password" required><button type="button" id="eye">Show</button></div></div>
      <div id="lerr" class="alert bad hidden"></div>
      <button class="btn primary lg" style="width:100%;justify-content:center" id="lb">Sign in</button>
      <p class="small mute" style="margin:16px 0 0;text-align:center">Trouble signing in? Contact your exam administrator.</p>
    </form></section></div>`;
  $('#eye').onclick = () => { const p = $('#p'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; $('#eye').textContent = show ? 'Hide' : 'Show'; };
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#lerr'); err.classList.add('hidden');
    $('#lb').disabled = true; $('#lb').textContent = 'Signing in…';
    try {
      const r = await api('POST', '/api/auth/login', { username: $('#u').value, password: $('#p').value });
      JEP.me = r.user;
      // Open the page the person originally asked for (e.g. the assessment link from their e-mail)
      const next = store.sget('jep_next'); store.sdel('jep_next');
      location.hash = next && next.startsWith('#/' + r.user.role) ? next : (r.user.role === 'admin' ? '#/admin' : '#/user');
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); $('#lb').disabled = false; $('#lb').textContent = 'Sign in'; }
  };
};

/* ------------------------------- router ------------------------------- */
let barTimer = null;
const bar = (on) => {
  let b = document.getElementById('bar');
  if (!b) { b = document.createElement('div'); b.id = 'bar'; document.body.append(b); }
  clearTimeout(barTimer);
  if (on) { b.className = 'on'; } else { b.className = 'done'; barTimer = setTimeout(() => { b.className = ''; }, 350); }
};

async function route() {
  if (JEP.guard && !JEP.guard()) return;     // active exam locks navigation
  if (JEP.cleanup) { JEP.cleanup(); JEP.cleanup = null; }
  const path = location.hash.replace(/^#/, '') || '/';
  const parts = path.split('?')[0].split('/').filter(Boolean);

  if (!JEP.me) {
    try { JEP.me = (await api('GET', '/api/auth/me')).user; } catch (_) { JEP.me = null; }
  }
  if (!JEP.me) {
    if (parts[0] !== 'login') { if (parts.length) store.sset('jep_next', location.hash); location.hash = '#/login'; return; }
    return JEP.views.login();
  }
  // An e-mailed assessment link opened in a browser that is still signed in as admin: show the sign-in page
  // (the candidate signs in and lands on the exam), never the admin dashboard.
  if (parts[0] === 'user' && JEP.me.role === 'admin') {
    await api('POST', '/api/auth/logout').catch(() => {});
    JEP.me = null;
    if (parts.length > 1) store.sset('jep_next', location.hash);
    location.hash = '#/login';
    return;
  }
  if (parts[0] === 'login' || !parts[0]) { location.hash = JEP.me.role === 'admin' ? '#/admin' : '#/user'; return; }
  if (parts[0] !== JEP.me.role) { location.hash = JEP.me.role === 'admin' ? '#/admin' : '#/user'; return; }

  const v = JEP.views[JEP.me.role];
  bar(true);
  try { await v(parts.slice(1)); } catch (e) { fail(e); } finally { bar(false); }
}
window.addEventListener('hashchange', route);
window.addEventListener('load', route);
