// HTML + plain-text e-mail templates for assessment invitations and reminders.
const cfg = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST';
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);

/** kind: 'invite' | 'reminder'. */
function examNotice({ kind, user, exam, link, message }) {
  const name = user.full_name || user.username;
  const isRem = kind === 'reminder';
  const subject = isRem ? `Reminder: ${exam.name}` : `You are invited: ${exam.name}`;
  const lead = isRem
    ? `This is a friendly reminder about your upcoming assessment <b>${esc(exam.name)}</b>, which opens on <b>${esc(when(exam.start_at))}</b>.`
    : `You have been scheduled for the assessment <b>${esc(exam.name)}</b>.`;
  const rows = [
    ['Opens', when(exam.start_at)], ['Closes', when(exam.end_at)], ['Duration', dur(exam.duration_min)],
    ['Pass mark', `${exam.pass_percent}%`], ['Your username', user.username],
  ];
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="padding:20px 28px 14px;border-bottom:3px solid #4338ca"><img src="cid:jep-logo" alt="${esc(cfg.PORTAL_NAME)}" height="64" style="display:block;height:64px"></td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 14px;font-size:16px">Hello ${esc(name)},</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.55">${lead}</p>
${message ? `<div style="margin:0 0 18px;padding:12px 14px;background:#eef2ff;border-left:4px solid #4338ca;border-radius:6px;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(message)}</div>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;margin:0 0 24px">
${rows.map((r, i) => `<tr><td style="padding:10px 14px;color:#64748b;font-size:13px;${i ? 'border-top:1px solid #e2e8f0;' : ''}width:38%">${r[0]}</td><td style="padding:10px 14px;font-size:14px;font-weight:600;${i ? 'border-top:1px solid #e2e8f0;' : ''}">${esc(r[1])}</td></tr>`).join('')}
</table>
<table cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td style="background:#4338ca;border-radius:9px"><a href="${esc(link)}" style="display:inline-block;padding:13px 28px;color:#fff;text-decoration:none;font-weight:700;font-size:15px">Open assessment</a></td></tr></table>
<p style="margin:0 0 6px;font-size:13px;color:#475569;line-height:1.5">Sign in with the username and password provided to you. The assessment is <b>proctored</b>: it runs in full-screen and leaving the screen twice submits it automatically. Use a laptop/desktop with Chrome or Edge.</p>
<p style="margin:14px 0 0;font-size:12px;color:#94a3b8;word-break:break-all">If the button does not work, copy this link:<br>${esc(link)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `Hello ${name},\n\n${lead.replace(/<[^>]+>/g, '')}\n\n${message ? message + '\n\n' : ''}Opens: ${when(exam.start_at)}\nCloses: ${when(exam.end_at)}\nDuration: ${dur(exam.duration_min)}\nPass mark: ${exam.pass_percent}%\nYour username: ${user.username}\n\nOpen the assessment: ${link}\n\n${cfg.PORTAL_NAME}`;
  return { subject, html, text };
}

module.exports = { examNotice };
