# Jayarama Exam Portal

Proctored multiple-choice exam portal with an Admin and Candidate login. Node.js (Express); SQLite locally, PostgreSQL in production; no build step.

## Run
    npm install
    copy .env.example .env      # then edit (admin password, public address)
    npm start                   # http://localhost:3000

Docker: `docker compose up -d --build` (data lives in a volume).
The admin account is created on first start from `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env`; change the password from
the header ("Password") after the first sign-in. Everyone signs in on the same page; the portal sends each person to
the right place (admin pages or candidate dashboard).

## E-mail (result PDFs and reminders)
The moment a candidate submits (or time runs out, or a violation auto-submits), the portal e-mails them a PDF of their own
question paper with the correct answers and their answers marked. Mail goes through a background queue with parallel
workers, retries automatically, and failures can be re-sent from the results page. The sender is configured on the
server (environment variables), not in the admin screens. Pick ONE provider:

| Provider | Variables | Notes |
|---|---|---|
| **Brevo** (recommended, free) | `BREVO_API_KEY`, `MAIL_FROM` | 300 e-mails/day, no domain needed (verify the sender address in Brevo), works on free hosts that block SMTP |
| Resend | `RESEND_API_KEY`, `MAIL_FROM` | free tier, but mailing other people needs a verified domain |
| SMTP (Gmail App Password) | `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST`, `SMTP_PORT` | fine on your own PC / a VPS; free web hosts usually block SMTP ports |

Gmail does **not** accept a normal account password for apps: turn on 2-Step Verification and create a 16-character
**App Password** (Google Account > Security > App passwords).

## Creating an exam
1. **Create exam**: name, duration, opening/closing time, pass %, marks, negative marking, optional instructions,
   **Number of sets** and (optional) **Questions per candidate**.
2. **Upload the question bank**: PDF, Word (DOC/DOCX), text, or a scan/photo (PNG/JPG; read with OCR). The portal reads
   the questions **and any answers in the file** and shows a review table (*question -> answer*). Answers that are
   missing can be chosen from a drop-down per question or typed/pasted in one box ("1-B, 2-C, 3-A"). The bank can be
   saved once every question has an answer. There is no separate answers upload.
3. **Publish.** The portal builds the sets at random and lists them on the Questions tab.

What the reader understands: numbered questions (`1.`, `1)`, `Q1.`, `Question 1:`), options `A)`, `(a)`, `a.`, `A -`
(also several on one line), answers after each question (`Answer: B`, `Ans: (b)`, `Correct Answer: Paris`, `✔ Answer: C`,
value on the next line), a trailing "Answer Key" in many layouts (`1-B, 2-C`, `1. B`, tables), explanations, repeated page
headers/footers, Word auto-numbering, unnumbered questions. Written (non-multiple-choice) questions are skipped and reported.
If nothing can be found, the portal shows what it read and an example of the expected format.

## Sets and unique papers
The admin only types the **number of sets**. The portal draws that many random sets from the one question bank (each a
random selection of "questions per candidate" questions, e.g. 30 of 50). Candidates get the sets in rotation, and within
their set every candidate gets their own question order and option order, so **no two candidates ever receive an
identical paper** (enforced by the server and a database unique index). The set number appears in results.

## Correcting a question after candidates took the exam (admin only)
Question text, options and sets lock once the first candidate starts. The admin can still, per question: change the
**correct answer**, change its **marks**, or **award its marks to every candidate** (for a faulty question). All submitted
results are recalculated at once, pass/fail updates, the change is written to an audit log, and the admin can e-mail
everyone their updated result PDF. Candidates cannot do any of this.

Negative marking can reduce a score but never below zero.

## Proctoring
Full-screen is required. Leaving full-screen (Esc), switching tab/window or losing focus: the first time is a warning, the
second submits the exam automatically with the answers saved so far. When time is up the exam is submitted automatically
(also on the server, even if the browser was closed). Browsers cannot technically block Esc or Alt-Tab; the portal
detects them. Use desktop Chrome or Edge.

## Reminders
On an exam's **Send email reminders** tab the admin e-mails the exam details and portal link to everyone / only those yet to submit /
selected people. The link opens the portal, asks for sign-in, then goes straight to that assessment's instructions.
Reminders are sent only when the admin clicks send and only **before the exam starts**. Set `PUBLIC_URL` in `.env` to
the real address of the site so e-mailed links are correct. The **Live monitor** tab shows who is writing right now.

## Deploy for free (works with your PC switched off)
Same stack as a typical free production setup: **GitHub** (code + tests), **Render** (web app), **Neon** (Postgres), **Brevo** (e-mail), **UptimeRobot** (keeps the free app awake).
All have free plans without a card.

1. **Neon** - https://neon.tech: create a project, copy the *connection string* (`postgres://...`) -> `DATABASE_URL`.
2. **Brevo** - https://brevo.com: sign up, *Senders & IP* > add and verify the sender address (e.g. the Gmail you send from),
   then *SMTP & API* > create an **API key** -> `BREVO_API_KEY`. `MAIL_FROM` = `Jayarama Exam Portal <that address>`.
3. **Render** - https://render.com > New > *Blueprint* > pick this GitHub repo (it reads `render.yaml`). Fill the
   prompted variables: `DATABASE_URL`, `BREVO_API_KEY`, `MAIL_FROM`, `ADMIN_PASSWORD` (a new strong one), `ADMIN_EMAIL`,
   and `PUBLIC_URL` (the `https://....onrender.com` address Render shows; set it, then redeploy once).
4. **UptimeRobot** - https://uptimerobot.com: add an HTTP monitor for `https://<your-site>/healthz` every 5 minutes. This stops
   the free app from sleeping and also keeps the Neon database awake, so candidates never wait for a cold start.
5. Optional: add the Render *Deploy Hook* URL as the GitHub secret `RENDER_DEPLOY_HOOK`; every push to `master` then runs
   the tests first and deploys only if they pass.

Notes: the free Render instance has 512 MB RAM and one shared CPU (fine for a few hundred candidates; scanned-PDF OCR
uploads are the heaviest feature - paste text or upload text PDFs/Word files on the free plan). Brevo's free plan sends up to
300 e-mails a day; for a bigger group split exams across days or upgrade the plan.

## Production checklist
- HTTPS, `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `PUBLIC_URL=https://your-domain`, a long random `JWT_SECRET`.
- With `DATABASE_URL` set the app uses Postgres (data survives restarts); without it, SQLite in `DATA_DIR` (single instance, back it up).
- Health check: `/healthz`. OCR works offline (language data ships with the app).

## Tests
    npm test                 # parser, API, random sets, import, admin corrections, e-mail delivery
    npm run test:ui          # real-browser UI check with headless Chrome (saves screenshots)
    node test/load.js 200    # concurrency test against a running server
