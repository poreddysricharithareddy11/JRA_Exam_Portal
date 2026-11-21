// Result e-mails with PDF attachment. Sent from a background queue so submissions never wait on SMTP.
const nodemailer = require('nodemailer');
const cfg = require('./config');
const db = require('./db');
const { buildResultPdf } = require('./pdf');
const { review, setSubmitHook } = require('./service');
const { examNotice } = require('./templates');
const settings = require('./settings');
const branding = require('./branding');
const logoAttachment = () => { try { const f = branding.logoFile(); return { filename: 'logo' + require('path').extname(f), content: branding.logoBuffer(), cid: 'jep-logo', contentDisposition: 'inline' }; } catch (_) { return null; } };

const MAX_ATTEMPTS = 4;
let transport = null;

const smtp = () => settings.smtp();
function configured() { const c = smtp(); return !!(c.user && c.pass); }
const fromAddress = () => { const c = smtp(); return c.from || `"${cfg.PORTAL_NAME}" <${c.user}>`; };

function getTransport() {
  if (!transport) {
    const c = smtp();
    transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure,
      auth: { user: c.user, pass: c.pass },
      pool: true, maxConnections: 2, maxMessages: 100,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
  }
  return transport;
}
/** Forget the cached connection (after the admin changes the e-mail settings). */
function resetTransport() { try { if (transport) transport.close(); } catch (_) { /* ignore */ } transport = null; }

/** Plain-English reason for an SMTP failure. */
function explain(e) {
  const t = String((e && (e.response || e.message)) || e);
  if (/535|534|BadCredentials|Username and Password not accepted|Application-specific password/i.test(t))
    return 'Gmail rejected the login. Gmail does not accept the normal account password for apps: turn on 2-Step Verification for the account, create a 16-character App Password (Google Account > Security > App passwords) and enter that here.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(t)) return 'The mail server address could not be found. Check the server name and your internet connection.';
  if (/ECONNREFUSED|ETIMEDOUT|ESOCKET|ECONNRESET|timeout/i.test(t)) return 'Could not connect to the mail server. Check the server name, port and that outgoing e-mail is not blocked.';
  return String(e.message || e).slice(0, 300);
}

/** Send one test message with the current settings. Throws a friendly Error on failure. */
async function sendTest(to) {
  if (!configured()) throw new Error('E-mail is not set up yet. Save the account details first.');
  try {
    await getTransport().sendMail({
      from: fromAddress(), to, subject: `${cfg.PORTAL_NAME} - test e-mail`,
      text: 'This is a test message from your exam portal. E-mail sending is working.',
      html: `<p>This is a test message from <b>${cfg.PORTAL_NAME}</b>.</p><p>E-mail sending is working - results, invitations and reminders will be delivered from this account.</p>`,
    });
  } catch (e) { resetTransport(); throw new Error(explain(e)); }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendOne(attemptId) {
  const data = review(attemptId);
  if (!data) return;
  const a = data.attempt;
  if (!a.email) {
    db.prepare("UPDATE attempts SET email_status='failed', email_error='User has no e-mail address' WHERE id=?").run(attemptId);
    return;
  }
  if (!configured()) {
    db.prepare("UPDATE attempts SET email_status='failed', email_error='SMTP is not configured' WHERE id=?").run(attemptId);
    return;
  }
  try {
    const pdf = await buildResultPdf(attemptId);
    await getTransport().sendMail({
      from: fromAddress(),
      to: a.email,
      subject: `Your result: ${a.exam_name} - ${a.score}/${a.total} (${a.passed ? 'Passed' : 'Failed'})`,
      text: `Hello ${a.full_name || a.username},\n\nThank you for taking "${a.exam_name}".\nScore: ${a.score} / ${a.total} (${a.percent}%) - ${a.passed ? 'PASSED' : 'FAILED'}\n\nYour detailed answer sheet with the correct answers is attached.\n\n${cfg.PORTAL_NAME}`,
      html: `<p><img src="cid:jep-logo" alt="${esc(cfg.PORTAL_NAME)}" height="60" style="height:60px"></p><p>Hello ${esc(a.full_name || a.username)},</p><p>Thank you for taking <b>${esc(a.exam_name)}</b>.</p>
        <p style="font-size:16px">Score: <b>${a.score} / ${a.total}</b> (${a.percent}%) &mdash; <b style="color:${a.passed ? '#15803d' : '#b91c1c'}">${a.passed ? 'PASSED' : 'FAILED'}</b></p>
        <p>Your detailed answer sheet with the correct answers is attached.</p><p>${esc(cfg.PORTAL_NAME)}</p>`,
      attachments: [logoAttachment(), { filename: `Result-${a.exam_name.replace(/[^\w\-]+/g, '_')}.pdf`, content: pdf, contentType: 'application/pdf' }].filter(Boolean),
    });
    db.prepare("UPDATE attempts SET email_status='sent', email_error=NULL WHERE id=?").run(attemptId);
  } catch (e) {
    const n = db.prepare('SELECT email_attempts n FROM attempts WHERE id=?').get(attemptId).n + 1;
    db.prepare("UPDATE attempts SET email_attempts=?, email_error=?, email_status=? WHERE id=?")
      .run(n, String(e.message).slice(0, 300), n >= MAX_ATTEMPTS ? 'failed' : 'pending', attemptId);
    console.error(`[mail] attempt ${attemptId} failed (${n}/${MAX_ATTEMPTS}):`, e.message);
  }
}

/* ---- assessment invitations / reminders ---- */
const NOTIFY_MAX = 3;
async function sendNotification(id) {
  const n = db.prepare('SELECT * FROM notifications WHERE id=?').get(id);
  if (!n || n.status !== 'pending') return;
  const user = db.prepare('SELECT username,full_name,email FROM users WHERE id=?').get(n.user_id);
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(n.exam_id);
  if (!user || !exam) return;
  const fail = (msg, final) => db.prepare('UPDATE notifications SET status=?, error=?, attempts=attempts+1 WHERE id=?').run(final ? 'failed' : 'pending', msg.slice(0, 300), id);
  if (!configured()) return fail('SMTP is not configured', true);
  if (!user.email) return fail('User has no e-mail address', true);
  try {
    const m = examNotice({ kind: n.kind, user, exam, link: n.link, message: n.message });
    await getTransport().sendMail({ from: fromAddress(), to: user.email, subject: m.subject, text: m.text, html: m.html, attachments: [logoAttachment()].filter(Boolean) });
    db.prepare("UPDATE notifications SET status='sent', error=NULL, attempts=attempts+1, sent_at=? WHERE id=?").run(new Date().toISOString(), id);
  } catch (e) {
    console.error(`[mail] notification ${id} failed:`, e.message);
    fail(e.message, n.attempts + 1 >= NOTIFY_MAX);
  }
}

// Simple serial queue for both kinds of mail ('r:<attemptId>' results, 'n:<notificationId>' notices)
const queue = new Set();
let running = false;
async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.size) {
      const key = queue.values().next().value;
      queue.delete(key);
      const id = Number(key.slice(2));
      if (key[0] === 'n') await sendNotification(id); else await sendOne(id);
    }
  } finally { running = false; }
}
function enqueue(id) { queue.add('r:' + id); pump(); }
function enqueueNotice(id) { queue.add('n:' + id); pump(); }

/** Create + queue invitation/reminder mails for the given users. Returns counts. */
function notifyUsers({ exam, users, kind, message, link, auto = false }) {
  const ins = db.prepare('INSERT INTO notifications (exam_id,user_id,kind,message,link,auto) VALUES (?,?,?,?,?,?)');
  let queued = 0, noEmail = 0;
  const ids = [];
  db.transaction(() => {
    for (const u of users) {
      if (!u.email) { noEmail++; continue; }
      ids.push(ins.run(exam.id, u.id, kind, message || '', link, auto ? 1 : 0).lastInsertRowid); queued++;
    }
  })();
  ids.forEach(enqueueNotice);
  return { queued, noEmail };
}

/** Re-queue everything still pending (startup + periodic retry). */
function retryPending() {
  db.prepare("SELECT id FROM attempts WHERE status='submitted' AND email_status='pending'").all().forEach((r) => queue.add('r:' + r.id));
  db.prepare("SELECT id FROM notifications WHERE status='pending'").all().forEach((r) => queue.add('n:' + r.id));
  pump();
}

function resend(id) {
  db.prepare("UPDATE attempts SET email_status='pending', email_attempts=0, email_error=NULL WHERE id=?").run(id);
  enqueue(id);
}

setSubmitHook(enqueue);

module.exports = { sendTest, resetTransport, explain, enqueue, enqueueNotice, notifyUsers, retryPending, resend, configured };
