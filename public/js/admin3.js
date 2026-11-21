'use strict';
/* Admin: question bank (upload -> review & map answers -> save), per-question scoring corrections, e-mail settings */

/* ------------------------------------------------------------------ */
/*  Questions tab                                                      */
/* ------------------------------------------------------------------ */
function questionsTab(box, id, d) {
  const { questions, locked, exam } = d;
  const published = !!exam.published;
  const pool = questions.length;
  const per = exam.questions_per_attempt && exam.questions_per_attempt < pool ? exam.questions_per_attempt : pool;
  const missing = questions.filter((q) => q.correct_index == null && !q.grace).length;
  const graceCount = questions.filter((q) => q.grace).length;
  let filter = 'all', search = '';
  let open = !published && missing > 0;     // the list stays hidden until the admin asks for it (or answers are missing)
  const info = pool ? `<span class="chip">${pool} question${pool === 1 ? '' : 's'}</span> <span class="mute small">${exam.num_sets} set${exam.num_sets === 1 ? '' : 's'} × ${per}</span>${graceCount ? ` <span class="chip" style="background:var(--warn-l);color:var(--warn)">${graceCount} awarded to all</span>` : ''}` : '';
  const pdfBtn = (primary) => (pool ? `<a class="btn ${primary ? 'primary' : ''}" href="#" data-dl="/api/admin/exams/${id}/questions.pdf" data-name="question-bank.pdf">⬇ Download PDF</a>` : '');

  box.innerHTML = published ? `
    <div class="card">
      <div class="row"><div><b>Question bank</b> ${info}</div>
        <div class="right row">${pool ? '<button class="btn" id="viewbank">View question bank</button>' : ''}${pdfBtn(true)}</div></div>
      <p class="small mute" style="margin:8px 0 0">This exam is published, so the questions and answers are locked. If a question was faulty, open the question bank and tick <b>Add marks</b> to give its marks to every candidate.</p>
    </div>
    <div id="changesbox"></div>
    <div id="qs" class="hidden"></div>` : `
    ${pool && missing ? `<div class="alert warn">${missing} of ${pool} questions have no answer — open the question bank and choose them to publish.</div>` : ''}
    ${locked ? `<div class="alert info">🔒 Candidates have already started, so the questions are locked.</div>` : `<div class="card"><h3>Upload question bank</h3>
      <p class="small mute">PDF, Word, text, or a scan/photo (PNG, JPG). Questions and any answers in the file are read; you review them before saving.</p>
      <form id="uq"><div class="row" style="align-items:flex-end">
        <div class="field grow" style="margin:0;min-width:260px"><label class="f">Question bank file</label><input type="file" name="file" accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg"></div>
        <button class="btn primary lg" id="uqb">Read questions &amp; answers →</button></div>
        <details class="mt"><summary class="small mute" style="cursor:pointer">…or paste the questions as text</summary>
          <textarea name="text" rows="5" placeholder="1. Capital of India?&#10;A) Mumbai&#10;B) New Delhi&#10;C) Kolkata&#10;D) Chennai&#10;Answer: B" style="margin-top:8px"></textarea></details>
        ${pool ? `<p class="small mute" style="margin:12px 0 0">Uploading replaces the current ${pool} questions.</p>` : ''}</form></div>`}
    <div id="setsbox"></div>
    <div id="changesbox"></div>
    ${pool ? `<div class="card mt"><div class="row"><div><b>Question bank</b> ${info}</div>
        <div class="right row"><button class="btn" id="viewbank">View question bank</button>${pdfBtn(false)}${!locked ? '<button class="btn sm" id="addq">+ Add question</button>' : ''}</div></div>
      <div class="row mt hidden" id="tools">${pool > 6 ? '<input type="text" id="qsearch" placeholder="Search questions…" style="width:210px">' : ''}${missing ? '<button class="pill" id="onlymiss">Only without answer</button>' : ''}</div></div>` : ''}
    <div id="qs" class="hidden"></div>`;

  /* ---- show / hide the question list ---- */
  const vb = $('#viewbank', box);
  function setOpen(v) {
    open = v;
    $('#qs', box).classList.toggle('hidden', !open);
    $('#tools', box)?.classList.toggle('hidden', !open);
    if (vb) vb.textContent = open ? 'Hide question bank' : 'View question bank';
    if (open) drawList();
  }
  if (vb) vb.onclick = () => setOpen(!open);


  /* ---- upload ---- */
  if (!locked && !published) {
    $('#uq', box).onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      if (!fd.get('file')?.size) fd.delete('file');
      const file = fd.get('file');
      const btn = $('#uqb', box); btn.disabled = true;
      btn.textContent = file && /\.(pdf|png|jpe?g)$/i.test(file.name) ? 'Reading… (scans can take a minute)' : 'Reading…';
      try { previewImport(id, await api('POST', `/api/admin/exams/${id}/questions/parse`, fd, true), pool); }
      catch (e) { if (e.data && e.data.preview) parseFailure(e); else fail(e); }
      finally { btn.disabled = false; btn.textContent = 'Read questions & answers →'; }
    };
    $('#addq', box)?.addEventListener('click', async () => {
      try { await api('POST', `/api/admin/exams/${id}/questions`, { text: 'New question', options: ['Option A', 'Option B', 'Option C', 'Option D'], marks: exam.default_marks }); adminExam(id, 'questions'); } catch (e) { fail(e); }
    });
  }

  /* ---- generated sets ---- */
  async function drawSets() {
    const sb = $('#setsbox', box);
    if (!sb) return;
    if (!pool || published) { sb.innerHTML = ''; return; }
    let s; try { s = await api('GET', `/api/admin/exams/${id}/sets`); } catch (_) { return; }
    sb.innerHTML = `<details class="card mt"><summary style="cursor:pointer"><b>Question sets</b> <span class="mute small">(view)</span></summary><div class="row mb mt">
        <span class="chip">${s.num_sets} set${s.num_sets === 1 ? '' : 's'} × ${s.per_candidate} questions</span>
        ${!locked ? `<button class="btn sm right" id="regen">${s.sets.length ? '🔀 Shuffle sets again' : 'Generate sets now'}</button>` : ''}</div>
      ${s.sets.length ? `<div class="tw"><table><thead><tr><th>Set</th><th>Questions</th><th>Which questions from the bank</th></tr></thead><tbody>
        ${s.sets.map((x) => `<tr><td><b>Set ${x.set_no}</b></td><td>${x.count}</td><td class="small mute" style="max-width:560px">${x.questions.map((n) => 'Q' + n).join(', ')}</td></tr>`).join('')}</tbody></table></div>
        <p class="small mute" style="margin:10px 0 0">Sets are given to candidates in rotation, each in their own order.</p>`
        : '<p class="mute small" style="margin:0">The sets are generated automatically when you publish the exam. Use “Generate sets now” to preview them.</p>'}</details>`;
    $('#regen', sb)?.addEventListener('click', async () => {
      try { await api('POST', `/api/admin/exams/${id}/sets/regenerate`); toast('Sets generated', 'ok'); drawSets(); } catch (e) { fail(e); }
    });
  }
  drawSets();

  /* ---- change log ---- */
  if (locked) {
    api('GET', `/api/admin/exams/${id}/changes`).then(({ changes }) => {
      if (!changes.length) return;
      $('#changesbox', box).innerHTML = `<details class="card mt"><summary style="cursor:pointer"><b>Marks added after candidates started</b> <span class="mute small">(view)</span></summary><div class="tw mt"><table>
        <thead><tr><th>When</th><th>By</th><th>Change</th><th>Results updated</th></tr></thead><tbody>
        ${changes.map((c) => `<tr><td class="small">${fmtDT(c.created_at)}</td><td>${esc(c.admin)}</td><td>${esc(c.summary)}</td><td>${c.rescored}</td></tr>`).join('')}</tbody></table></div></details>`;
    }).catch(() => {});
  }

  /* ---- question list ---- */
  function drawList() {
    const rows = questions.map((q, i) => ({ q, no: i + 1 })).filter(({ q, no }) =>
      (filter === 'all' || (q.correct_index == null && !q.grace)) && (!search || (`q${no} ${q.text} ${q.options.join(' ')}`).toLowerCase().includes(search)));
    $('#qs', box).innerHTML = pool
      ? (rows.length ? rows.map(({ q, no }) => (published ? qCardView(q, no) : qCard(q, locked, no))).join('') : '<div class="card mute" style="text-align:center;padding:28px">No questions match.</div>')
      : '<div class="card mute" style="text-align:center;padding:36px">No questions yet. Upload a question bank above.</div>';
    $$('.qedit', box).forEach((card) => wireCard(card));
  }
  function wireCard(card) {
    const qid = card.dataset.id;
    const q = questions.find((x) => String(x.id) === qid);
    $('[data-save]', card)?.addEventListener('click', async () => {
      const opts = $$('[data-opt]', card).map((i) => i.value);
      const sel = $('input[type=radio]:checked', card);
      try {
        await api('PUT', `/api/admin/questions/${qid}`, { text: $('[data-text]', card).value, options: opts, correct_index: sel ? Number(sel.value) : null, marks: $('[data-marks]', card).value });
        toast('Saved', 'ok'); adminExam(id, 'questions');
      } catch (e) { fail(e); }
    });
    $('[data-rm]', card)?.addEventListener('click', async () => {
      if (!await confirmBox('Delete this question?', 'Delete')) return;
      try { await api('DELETE', `/api/admin/questions/${qid}`); adminExam(id, 'questions'); } catch (e) { fail(e); }
    });
    $('[data-score]', card)?.addEventListener('click', async () => {
      const sel = $('input[type=radio]:checked', card);
      const body = { correct_index: sel ? Number(sel.value) : q.correct_index, marks: $('[data-marks]', card) ? Number($('[data-marks]', card).value) : q.marks, grace: $('[data-grace]', card)?.checked ? 1 : 0 };
      const lines = [];
      if (body.correct_index !== q.correct_index) lines.push(`Correct answer: ${q.correct_index == null ? 'none' : L[q.correct_index]} → ${L[body.correct_index]}`);
      if (body.marks !== q.marks) lines.push(`Marks: ${q.marks} → ${body.marks}`);
      if (body.grace !== (q.grace ? 1 : 0)) lines.push(body.grace ? 'Full marks will be awarded to every candidate who had this question' : 'Remove the “award to everyone” setting');
      if (!lines.length) { toast('Nothing changed'); return; }
      if (!await confirmBox(`${lines.join(' · ')}.\n\nThe results of ${d.submitted_count} submitted candidate${d.submitted_count === 1 ? '' : 's'} will be recalculated. This is recorded in the change log.`, 'Apply & recalculate', false)) return;
      try {
        const r = await api('PATCH', `/api/admin/questions/${qid}/scoring`, body);
        toast(r.rescored ? `Recalculated: ${r.rescored} result${r.rescored === 1 ? '' : 's'} updated${r.result_changes ? `, ${r.result_changes} pass/fail changed` : ''}` : 'Saved — no result changed', 'ok');
        if (r.rescored && await confirmBox(`${r.rescored} candidate${r.rescored === 1 ? '' : 's'} now have a different score. E-mail everyone their updated result PDF?`, 'Send updated results', false)) {
          try { const m = await api('POST', `/api/admin/exams/${id}/resend-all`); toast(`${m.queued} e-mail(s) queued`, 'ok'); } catch (e) { fail(e); }
        }
        adminExam(id, 'questions');
      } catch (e) { fail(e); }
    });
    // live highlight of the chosen answer
    $$('input[type=radio]', card).forEach((r) => r.addEventListener('change', () => $$('.opt', card).forEach((o) => o.classList.toggle('right-ans', $('input', o).checked))));
  }
  $('#qsearch', box)?.addEventListener('input', (e) => { search = e.target.value.toLowerCase(); drawList(); });
  $('#onlymiss', box)?.addEventListener('click', (e) => { filter = filter === 'all' ? 'missing' : 'all'; e.target.classList.toggle('on', filter === 'missing'); drawList(); });
  setOpen(open);
}

/** One question of a published exam: read-only, with only "Add marks" (award to every candidate) available. */
function qCardView(q, no) {
  const status = q.grace ? '<span class="chip" style="background:var(--warn-l);color:var(--warn)">Awarded to all</span>'
    : q.correct_index == null ? '<span class="chip failed">No answer</span>' : `<span class="chip sent">Answer ${L[q.correct_index]}</span>`;
  return `<div class="qedit" data-id="${q.id}">
    <div class="row mb"><b>Q${no}</b>${status}<span class="right small mute">${q.marks} mark${q.marks === 1 ? '' : 's'}</span></div>
    <p style="margin:0 0 8px;white-space:pre-wrap">${esc(q.text)}</p>
    <div>${q.options.map((o, i) => `<div class="opt ${q.correct_index === i ? 'right-ans' : ''}"><span>${L[i]}</span><span>${esc(o)}</span></div>`).join('')}</div>
    <label class="row mt" style="cursor:pointer;gap:10px"><input type="checkbox" data-grace ${q.grace ? 'checked' : ''}><span><b>Add marks</b> <span class="small mute">— give this question's marks to every candidate (use it if the question was wrong or unclear)</span></span></label>
    <div class="row mt"><button class="btn sm primary" data-score>Save</button></div>
  </div>`;
}

/** One question in the saved bank. */
function qCard(q, locked, no) {
  const n = no || q.position;
  const status = q.grace ? '<span class="chip" style="background:var(--warn-l);color:var(--warn)">Awarded to all</span>'
    : q.correct_index == null ? '<span class="chip failed">No answer</span>' : `<span class="chip sent">Answer ${L[q.correct_index]}</span>`;
  return `<div class="qedit" data-id="${q.id}">
    <div class="row mb"><b>Q${n}</b>${status}
      <span class="right small mute">Marks</span><input type="number" data-marks step="0.01" min="0.01" value="${q.marks}" style="width:90px"></div>
    <textarea data-text rows="2" ${locked ? 'readonly' : ''}>${esc(q.text)}</textarea>
    <div class="mt">${q.options.map((o, i) => `<div class="opt ${q.correct_index === i ? 'right-ans' : ''}"><input type="radio" name="c${q.id}" value="${i}" ${q.correct_index === i ? 'checked' : ''} title="Mark as the correct answer"><span>${L[i]}</span><input type="text" data-opt value="${esc(o)}" ${locked ? 'readonly' : ''}></div>`).join('')}</div>

    ${locked ? `<label class="row mt" style="cursor:pointer;gap:10px"><input type="checkbox" data-grace ${q.grace ? 'checked' : ''}><span><b>Award full marks to every candidate</b> <span class="small mute">— use this if the question itself was wrong or unclear</span></span></label>
      <div class="row mt"><button class="btn sm primary" data-score>Save scoring change</button><span class="small mute">Question text and options are locked. Answer, marks and “award to all” can be corrected.</span></div>`
    : '<div class="row mt"><button class="btn sm primary" data-save>Save question</button><button class="btn sm danger" data-rm>Delete</button></div>'}
  </div>`;
}

/* ------------------------------------------------------------------ */
/*  When a file can't be read                                          */
/* ------------------------------------------------------------------ */
function parseFailure(e) {
  const pv = (e.data.preview || []);
  modal(`<h3>We couldn't find multiple-choice questions</h3>
    <div class="alert bad">${esc(e.message)}</div>
    ${e.data.ocr ? '<div class="alert warn small">This file was a scan, so its text was read with OCR.</div>' : ''}
    <p class="small mute" style="margin:0 0 6px"><b>What was read from your file:</b></p>
    <pre style="max-height:240px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:.8rem;white-space:pre-wrap;margin:0">${pv.length ? esc(pv.join('\n')) : '(nothing readable)'}</pre>
    <div class="small mt"><b>Questions should look like this:</b>
      <pre style="background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;margin:6px 0 0;font-size:.8rem">1. Capital of India?
A) Mumbai
B) New Delhi
C) Kolkata
D) Chennai
Answer: B</pre></div>
    <div class="row mt" style="justify-content:flex-end"><button class="btn primary" data-close>OK</button></div>`, true);
}

/* ------------------------------------------------------------------ */
/*  Review: question -> answer mapping before anything is saved        */
/* ------------------------------------------------------------------ */
function previewImport(id, r, existingCount) {
  const Q = r.questions;
  const ans = Q.map((q) => (q.correct_index == null ? null : q.correct_index));
  const done = () => ans.filter((a) => a !== null).length;

  const m = modal(`<div class="row mb"><h3 style="margin:0">Review questions &amp; answers</h3><span class="chip right" id="pv_chip"></span></div>
    <div class="tiles" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
      <div class="tile"><div class="ic b">📄</div><div><b>${Q.length}</b><span>Questions found</span></div></div>
      <div class="tile"><div class="ic g">✅</div><div><b id="pv_ok">0</b><span>With an answer</span></div></div>
      <div class="tile"><div class="ic y">⚠️</div><div><b id="pv_miss">0</b><span>Need an answer</span></div></div></div>
    ${r.warnings.length ? `<div class="alert warn small">${r.warnings.map(esc).join('<br>')}</div>` : ''}
    ${existingCount ? `<div class="alert info small">The exam already has a bank of ${existingCount} questions; saving will <b>replace</b> it.</div>` : ''}
    <div class="card" id="pv_paste" style="padding:14px;margin-bottom:12px">
      <div class="row"><b>Missing answers?</b><span class="small mute">Choose below or paste them all:</span></div>
      <div class="row mt" style="align-items:flex-start"><textarea id="pv_text" rows="2" class="grow" style="min-width:240px" placeholder="1-B, 2-C, 3-A, 4-D …   (or one per line: 1. B)"></textarea>
        <button class="btn" id="pv_apply">Apply answers</button></div><div class="small mt" id="pv_msg"></div></div>
    <div class="tw" style="max-height:44vh;overflow:auto;border:1px solid var(--line);border-radius:10px"><table class="rv"><thead><tr><th style="width:48px">#</th><th>Question &amp; options</th><th style="width:150px">Correct answer</th></tr></thead><tbody>
      ${Q.map((q, i) => `<tr data-i="${i}"><td><b>${i + 1}</b></td>
        <td><div style="font-weight:600">${esc(q.text)}</div><div class="rvopts">${q.options.map((o, j) => `<span data-o="${j}"><b>${L[j]}</b> ${esc(o)}</span>`).join('')}</div></td>
        <td><select data-a="${i}"><option value="">— Choose —</option>${q.options.map((o, j) => `<option value="${j}" ${ans[i] === j ? 'selected' : ''}>${L[j]}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>
    <details class="mt" id="pv_key"><summary class="small" style="cursor:pointer"><b>Final answer key</b> <span class="mute">(question → answer)</span></summary><div class="keystrip" id="pv_strip"></div></details>
    <div class="row mt" style="justify-content:flex-end"><span class="small mute" id="pv_hint"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="svq">Save question bank</button></div>`, 'xl');

  function refresh() {
    const ok = done(), miss = Q.length - ok;
    $('#pv_ok', m).textContent = ok; $('#pv_miss', m).textContent = miss;
    $('#pv_chip', m).textContent = miss ? `${miss} answer${miss === 1 ? '' : 's'} still needed` : 'All answers set';
    $('#pv_chip', m).className = 'chip right ' + (miss ? 'failed' : 'sent');
    $$('tr[data-i]', m).forEach((tr) => {
      const i = +tr.dataset.i;
      tr.classList.toggle('need', ans[i] === null);
      $$('[data-o]', tr).forEach((s) => s.classList.toggle('correct', ans[i] === +s.dataset.o));
      $('select', tr).value = ans[i] === null ? '' : String(ans[i]);
    });
    $('#pv_strip', m).innerHTML = Q.map((_, i) => `<span class="${ans[i] === null ? 'x' : ''}">${i + 1}<i>→</i><b>${ans[i] === null ? '?' : L[ans[i]]}</b></span>`).join('');
    const b = $('#svq', m);
    b.disabled = miss > 0; b.textContent = `Save ${Q.length} questions`;
    $('#pv_hint', m).textContent = miss ? `Choose the answer for ${miss} more question${miss === 1 ? '' : 's'} to continue` : '';
    if (!miss) $('#pv_paste', m).classList.add('hidden'); else $('#pv_paste', m).classList.remove('hidden');
  }
  $$('select[data-a]', m).forEach((s) => { s.onchange = () => { ans[+s.dataset.a] = s.value === '' ? null : +s.value; refresh(); }; });
  $('#pv_apply', m).onclick = async () => {
    const msg = $('#pv_msg', m);
    try {
      const o = await api('POST', '/api/admin/answers/map', { text: $('#pv_text', m).value, options: Q.map((q) => q.options.length) });
      Object.entries(o.answers).forEach(([i, a]) => { ans[+i] = a; });
      msg.className = 'small mt'; msg.style.color = 'var(--ok)';
      msg.textContent = `Applied ${o.applied} answer${o.applied === 1 ? '' : 's'}.` + (o.unmatched.length ? ` Ignored question number(s) not in the file: ${o.unmatched.slice(0, 8).join(', ')}.` : '') + (o.invalid.length ? ` Option doesn't exist for question(s): ${o.invalid.join(', ')}.` : '');
      refresh();
    } catch (e) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; }
  };
  $('#svq', m).onclick = async () => {
    $('#svq', m).disabled = true;
    try {
      const o = await api('POST', `/api/admin/exams/${id}/questions/import`, { questions: Q.map((q, i) => ({ ...q, correct_index: ans[i] })) });
      m.close();
      toast(`Question bank saved: ${o.added} questions with answers`, 'ok');
      adminExam(id, 'questions');
    } catch (e) { $('#svq', m).disabled = false; fail(e); }
  };
  refresh();
}
