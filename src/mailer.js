// E-mails: result PDFs (sent the moment a candidate submits) and exam reminders.
// Sending goes through a background queue with a few parallel workers, so submissions never wait on e-mail.
//
// Provider (first one configured wins):
//   BREVO_API_KEY   -> Brevo HTTPS API   (free: 300 e-mails/day, no domain needed, works on free hosts that block SMTP)
//   RESEND_API_KEY  -> Resend HTTPS API  (free tier; sending to other people needs a verified domain)
//   SMTP_USER/PASS  -> SMTP (Gmail App Password etc.) - fine on your own PC / a VPS, usually blocked on free web hosts
const path = require('path');
const nodemailer = require('nodemailer');
const cfg = require('./config');
const db = require('./db');
const { buildResultPdf } = require('./pdf');
const { review, setSubmitHook } = require('./service');
const { examNotice } = require('./templates');
const branding = require('./branding');

const MAX_ATTEMPTS = 4;
const NOTIFY_MAX = 3;
const CONCURRENCY = Math.max(1, parseInt(process.env.MAIL_CONCURRENCY || (process.env.BREVO_API_KEY || process.env.RESEND_API_KEY ? '4' : '2'), 10));

const provider = () => (process.env.BREVO_API_KEY ? 'brevo' : process.env.RESEND_API_KEY ? 'resend' : (cfg.SMTP.user && cfg.SMTP.pass ? 'smtp' : 'none'));
const configured = () => provider() !== 'none';

/** "Name <a@b.c>" or "a@b.c" -> { name, email } */
function parseFrom() {
  const raw = cfg.SMTP.from || process.env.MAIL_FROM || '';
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (m) return { name: m[1].trim() || cfg.PORTAL_NAME, email: m[2].trim() };
  return { name: cfg.PORTAL_NAME, email: raw.trim() || cfg.SMTP.user || cfg.ADMIN_EMAIL };
}

const logoAttachment = () => { try { const f = branding.logoFile(); return { filename: 'logo' + path.extname(f), content: branding.logoBuffer(), cid: 'jep-logo', contentDisposition: 'inline' }; } catch (_) { return null; } };
const logoUrl = () => (cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/brand/logo` : '');

let transport = null;
function getTransport() {
  if (!transport) {
    const c = cfg.SMTP;
    transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass },
      pool: true, maxConnections: 2, maxMessages: 100,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
  }
  return transport;
}

/**
 * Send one message through whichever provider is configured.
 * mail = { to, subject, text, html, attachments: [{ filename, content: Buffer, contentType }] }  (html may use cid:jep-logo)
 */
async function deliver(mail) {
  const p = provider();
  const from = parseFrom();
  if (p === 'smtp') {
    const att = [logoAttachment(), ...(mail.attachments || [])].filter(Boolean);
    return getTransport().sendMail({ from: `"${from.name}" <${from.email}>`, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, attachments: att });
  }
  // HTTPS providers cannot embed the logo as an inline attachment: point at the hosted logo instead.
  const lu = logoUrl();
  const html = mail.html.replace(/<img[^>]*src="cid:jep-logo"[^>]*>/g, (tag) => (lu ? tag.replace('cid:jep-logo', lu) : ''));
  const files = (mail.attachments || []).map((a) => ({ name: a.filename, filename: a.filename, content: Buffer.from(a.content).toString('base64') }));
  let res;
  if (p === 'brevo') {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: from, to: [{ email: mail.to }], subject: mail.subject, htmlContent: html, textContent: mail.text, ...(files.length ? { attachment: files.map((f) => ({ name: f.name, content: f.content })) } : {}) }),
    });
  } else {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [mail.to], subject: mail.subject, html, text: mail.text, ...(files.length ? { attachments: files.map((f) => ({ filename: f.filename, content: f.content })) } : {}) }),
    });
  }
  if (!res.ok) throw new Error(`${p} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendOne(attemptId) {
  const data = await review(attemptId);
  if (!data) return;
  const a = data.attempt;
  if (!a.email) {
    await db.prepare("UPDATE attempts SET email_status='failed', email_error='User has no e-mail address' WHERE id=?").run(attemptId);
    return;
  }
  if (!configured()) {
    await db.prepare("UPDATE attempts SET email_status='failed', email_error='E-mail is not configured on the server' WHERE id=?").run(attemptId);
    return;
  }
  try {
    const pdf = await buildResultPdf(attemptId, data);
    await deliver({
      to: a.email,
      subject: `Your result: ${a.exam_name} - ${a.score}/${a.total} (${a.passed ? 'Passed' : 'Failed'})`,
      text: `Hello ${a.full_name || a.username},\n\nThank you for taking "${a.exam_name}".\nScore: ${a.score} / ${a.total} (${a.percent}%) - ${a.passed ? 'PASSED' : 'FAILED'}\n\nYour question paper with the correct answers and your answers marked is attached.\n\n${cfg.PORTAL_NAME}`,
      html: `<p><img src="cid:jep-logo" alt="${esc(cfg.PORTAL_NAME)}" height="60" style="height:60px"></p><p>Hello ${esc(a.full_name || a.username)},</p><p>Thank you for taking <b>${esc(a.exam_name)}</b>.</p>
        <p style="font-size:16px">Score: <b>${a.score} / ${a.total}</b> (${a.percent}%) &mdash; <b style="color:${a.passed ? '#15803d' : '#b91c1c'}">${a.passed ? 'PASSED' : 'FAILED'}</b></p>
        <p>Your question paper with the correct answers and your answers marked is attached.</p><p>${esc(cfg.PORTAL_NAME)}</p>`,
      attachments: [{ filename: `Result-${a.exam_name.replace(/[^\w\-]+/g, '_')}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
    await db.prepare("UPDATE attempts SET email_status='sent', email_error=NULL WHERE id=?").run(attemptId);
  } catch (e) {
    const n = (await db.prepare('SELECT email_attempts n FROM attempts WHERE id=?').get(attemptId)).n + 1;
    await db.prepare('UPDATE attempts SET email_attempts=?, email_error=?, email_status=? WHERE id=?')
      .run(n, String(e.message).slice(0, 300), n >= MAX_ATTEMPTS ? 'failed' : 'pending', attemptId);
    console.error(`[mail] attempt ${attemptId} failed (${n}/${MAX_ATTEMPTS}):`, e.message);
  }
}

/* ---- exam reminders ---- */
async function sendNotification(id) {
  const n = await db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
  if (!n || n.status !== 'pending') return;
  const user = await db.prepare('SELECT username,full_name,email FROM users WHERE id=?').get(n.user_id);
  const exam = await db.prepare('SELECT * FROM exams WHERE id=?').get(n.exam_id);
  if (!user || !exam) return;
  const fail = (msg, final) => db.prepare('UPDATE notifications SET status=?, error=?, attempts=attempts+1 WHERE id=?').run(final ? 'failed' : 'pending', msg.slice(0, 300), id);
  if (!configured()) return fail('E-mail is not configured on the server', true);
  if (!user.email) return fail('User has no e-mail address', true);
  try {
    const m = examNotice({ kind: n.kind, user, exam, link: n.link, message: n.message });
    await deliver({ to: user.email, subject: m.subject, text: m.text, html: m.html });
    await db.prepare("UPDATE notifications SET status='sent', error=NULL, attempts=attempts+1, sent_at=? WHERE id=?").run(new Date().toISOString(), id);
  } catch (e) {
    console.error(`[mail] notification ${id} failed:`, e.message);
    await fail(e.message, n.attempts + 1 >= NOTIFY_MAX);
  }
}

// Queue with parallel workers ('r:<attemptId>' results, 'n:<notificationId>' reminders).
const queue = new Set();
let active = 0;
function pump() {
  while (active < CONCURRENCY && queue.size) {
    const key = queue.values().next().value;
    queue.delete(key);
    active++;
    const id = Number(key.slice(2));
    (key[0] === 'n' ? sendNotification(id) : sendOne(id))
      .catch((e) => console.error('[mail] worker error:', e.message))
      .finally(() => { active--; pump(); });
  }
}
function enqueue(id) { queue.add('r:' + id); pump(); }
function enqueueNotice(id) { queue.add('n:' + id); pump(); }

/** Create + queue reminder mails for the given users. Returns counts. */
async function notifyUsers({ exam, users, kind, message, link, auto = false }) {
  const ins = db.prepare('INSERT INTO notifications (exam_id,user_id,kind,message,link,auto) VALUES (?,?,?,?,?,?)');
  let queued = 0, noEmail = 0;
  const ids = [];
  await db.transaction(async () => {
    for (const u of users) {
      if (!u.email) { noEmail++; continue; }
      ids.push((await ins.run(exam.id, u.id, kind, message || '', link, auto ? 1 : 0)).lastInsertRowid); queued++;
    }
  })();
  ids.forEach(enqueueNotice);
  return { queued, noEmail };
}

/** Re-queue everything still pending (startup + periodic retry). */
async function retryPending() {
  (await db.prepare("SELECT id FROM attempts WHERE status='submitted' AND email_status='pending'").all()).forEach((r) => queue.add('r:' + r.id));
  (await db.prepare("SELECT id FROM notifications WHERE status='pending'").all()).forEach((r) => queue.add('n:' + r.id));
  pump();
}

async function resend(id) {
  await db.prepare("UPDATE attempts SET email_status='pending', email_attempts=0, email_error=NULL WHERE id=?").run(id);
  enqueue(id);
}

setSubmitHook(enqueue);

module.exports = { enqueue, enqueueNotice, notifyUsers, retryPending, resend, configured, provider };
