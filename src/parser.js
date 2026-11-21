// Reads question banks from PDF / DOCX / DOC / TXT / images (OCR) and turns them into MCQs with answers.
const path = require('path');

const LETTERS = 'ABCDEFGH';
const letterIdx = (c) => LETTERS.indexOf(String(c).toUpperCase());

/* ======================================================================
 *  1. TEXT EXTRACTION
 * ==================================================================== */

/** Text-layer extraction with pdf.js; lines are rebuilt from the position of every text fragment. */
async function pdfText(buf) {
  const { doc } = await require('./pdfjs').openPdf(buf);
  try {
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      let lastY = null, lastEnd = 0, line = '';
      for (const it of items) {
        if (typeof it.str !== 'string') continue;
        const x = it.transform[4], y = it.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 3) { out += line + '\n'; line = ''; lastEnd = 0; }
        if (it.str) {
          if (line && x - lastEnd > 1 && !line.endsWith(' ') && !it.str.startsWith(' ')) line += ' ';
          line += it.str; lastEnd = x + (it.width || 0);
        }
        lastY = y;
      }
      out += line + '\n';
    }
    return out;
  } finally { await doc.destroy(); }
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'" };
const decodeEntities = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp|apos);|&#(\d+);/g, (m, n) => (n ? String.fromCharCode(+n) : ENT[m]));

/**
 * Word stores automatic numbering ("1.", "A)") outside the text. mammoth exposes it as nested lists in HTML, so
 * rebuild the visible numbering: top-level list items become "1. ...", nested list items become "A) ...".
 * Tables (answer keys) become one line per row.
 */
function htmlToText(html) {
  const out = [];
  let line = '';
  const stack = [];                // { ordered, n, asOptions }
  let lastWasNumberedQuestion = false;
  const flush = () => { const t = line.replace(/[ \t]+/g, ' ').trim(); if (t) { out.push(t); lastWasNumberedQuestion = /^\s*(?:q(?:uestion)?\s*\.?\s*)?\d{1,4}\s*[.):]/i.test(t); } line = ''; };
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  let m, prefixPending = null, cells = 0;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      let t = decodeEntities(m[4]);
      if (prefixPending !== null) {
        // keep the author's own typed numbering if the item already has some
        if (!/^\s*(?:\d{1,4}\s*[.)]|[(\[]?[A-Ha-h][)\].])\s/.test(t)) line += prefixPending;
        prefixPending = null;
      }
      line += t; continue;
    }
    const close = m[1] === '/', tag = m[2].toLowerCase();
    if (tag === 'ol' || tag === 'ul') {
      if (!close) { flush(); stack.push({ ordered: tag === 'ol', n: 0, asOptions: stack.length > 0 || lastWasNumberedQuestion }); }
      else { flush(); stack.pop(); }
    } else if (tag === 'li') {
      if (!close) {
        flush();
        const top = stack[stack.length - 1];
        if (top) {
          top.n++;
          if (top.asOptions) prefixPending = `${LETTERS[(top.n - 1) % 8]}) `;
          else prefixPending = top.ordered ? `${top.n}. ` : '';
        }
      } else flush();
    } else if (tag === 'td' || tag === 'th') {
      if (close) { cells--; line += ' '; } else cells++;
    } else if (tag === 'p' || tag === 'br' || tag === 'div' || tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'tr') {
      if (cells > 0 && tag !== 'tr') { line += ' '; }          // paragraphs inside a table cell stay on the row's line
      else if (tag === 'p' && !close && prefixPending !== null) { /* paragraph inside an <li>: keep the pending prefix */ } else flush();
    }
  }
  flush();
  return out.join('\n');
}

async function extractDocument(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const buf = file.buffer;
  if (ext === '.pdf') {
    const text = await pdfText(buf);
    if (text.replace(/\s/g, '').length >= 10) return { text, ocr: false };     // it has a real text layer
    const { ocrPdf } = require('./ocr');                                       // scanned / image-only PDF
    const r = await ocrPdf(buf);
    if (!r.text.replace(/\s/g, '')) return { text, ocr: false };               // nothing to recognise either
    return { text: r.text, ocr: true, truncated: r.truncated };
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    return { text: htmlToText(value), ocr: false };
  }
  if (ext === '.doc') {
    const WordExtractor = require('word-extractor');
    return { text: (await new WordExtractor().extract(buf)).getBody(), ocr: false };
  }
  if (['.png', '.jpg', '.jpeg', '.bmp'].includes(ext)) {
    const { ocrImage } = require('./ocr');
    return { text: await ocrImage(buf), ocr: true };
  }
  if (['.txt', '.md', '.csv', ''].includes(ext)) return { text: buf.toString('utf8'), ocr: false };
  throw new Error('Unsupported file type. Upload a PDF, Word (DOC/DOCX), text file or a clear photo/scan (PNG/JPG).');
}
const extractText = async (file) => (await extractDocument(file)).text;

/* ======================================================================
 *  2. ANSWER KEYS  ("1-B, 2-C" ...)
 * ==================================================================== */

/** Returns { questionNumber: optionIndex }. Understands "1. B", "1-B", "1) (b)", "Q1: B", "1 B 2 C", and two-row tables. */
function parseAnswerKey(raw) {
  const key = {};
  const text = String(raw).normalize('NFKC').replace(/\r/g, '\n').replace(/\*\*|__/g, '');
  const re = /(?:^|[\s,;|(\[])(?:Q(?:uestion)?\.?\s*)?(\d{1,4})\s*[.):\-–—=]*\s*[(\[]?\s*(?:option\s*)?([A-Ha-h])\s*[)\]]?(?=[\s,;|.)\]]|$)/gi;
  let m;
  while ((m = re.exec(text))) { const n = parseInt(m[1], 10); if (!(n in key)) key[n] = letterIdx(m[2]); }

  if (Object.keys(key).length < 2) {                     // table laid out as a row of numbers over a row of letters
    const rows = text.split('\n').map((l) => l.trim().split(/[\s,;|]+/).filter(Boolean)).filter((r) => r.length);
    for (let i = 0; i + 1 < rows.length; i++) {
      const nums = rows[i], lets = rows[i + 1];
      if (nums.length >= 2 && nums.length === lets.length && nums.every((x) => /^\d{1,4}$/.test(x)) && lets.every((x) => /^[(\[]?[A-Ha-h][)\]]?$/.test(x)))
        nums.forEach((n, j) => { key[parseInt(n, 10)] = letterIdx(lets[j].replace(/[()\[\]]/g, '')); });
    }
  }
  if (!Object.keys(key).length) {                        // bare list of letters in question order
    const letters = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (letters.length >= 2 && letters.every((l) => /^[(\[]?[A-Ha-h][)\]]?$/.test(l))) letters.forEach((l, i) => { key[i + 1] = letterIdx(l.replace(/[()\[\]]/g, '')); });
  }
  return key;
}

/* ======================================================================
 *  3. QUESTION PARSING
 * ==================================================================== */

const DECOR = /^[\s•‣▪●◦⁃∙✔✓✅☑☐❌➤➢►▶→➔❖★☆➜#>*]+/u;
const Q_PATTERNS = [
  /^q(?:uestion)?\s*\.?\s*(\d{1,4})\s*[.):\-–—]?\s*(.*)$/i,       // Q1. / Q.1 / Question 1: / Q1 text
  /^[(\[]?(\d{1,4})[)\]]\s*(.*)$/,                               // 1) / (1)
  /^(\d{1,4})\s*[.:\-–—](?!\d)\s*(.*)$/,                         // 1. / 1: / 1 -   (not decimals like 2.5)
];
const OPT_PATTERNS = [
  /^[(\[]?([A-Ha-h])[)\]]\s*(.*)$/,                              // A) / (A) / [A]
  /^([A-Ha-h])\s*[.:]\s*(.*)$/,                                  // A. / A:
  /^([A-Ha-h])\s*[-–—]\s+(.*)$/,                                 // A - text
];
const ANS_RE = /^(?:the\s+)?(?:correct\s+|right\s+)?(?:answer|ans|option|choice|key)\s*(?:is\b)?\s*[:=\-–—.]?\s*(.*)$/i;
const EXPL_RE = /^(?:explanation|solution|rationale|reason|hint|note|working|sol)\s*[:\-–—]/i;
const KEY_HDR = /^(?:the\s+)?(answer\s*key|answers?|ans\s*key|answer\s*sheet|key|solutions?)\s*[:\-–—]?\s*(.*)$/i;
const KEY_PAIRS = /^(?:(?:q\.?\s*)?\d{1,4}\s*[.):\-–—=]?\s*[(\[]?[A-Ha-h][)\]]?[\s,;|]*)+$/i;   // "1-B, 2-C"  /  "3 A"
const NOISE_LINE = /^(?:page\s*)?\d{1,3}\s*(?:\/|of)\s*\d{1,3}$|^[-–—\s]*\d{1,3}[-–—\s]*$/i;

const qMatch = (l) => { for (const re of Q_PATTERNS) { const m = re.exec(l); if (m) return { no: parseInt(m[1], 10), text: (m[2] || '').trim() }; } return null; };
const optMatch = (l) => { for (const re of OPT_PATTERNS) { const m = re.exec(l); if (m) return { letter: m[1].toUpperCase(), text: (m[2] || '').trim() }; } return null; };

const INVISIBLE = new RegExp('[' + String.fromCharCode(0xa0, 0x200b, 0xfeff, 0x2028, 0x2029) + ']', 'g');
function normalise(text) {
  return String(text).normalize('NFKC')
    .replace(/\r/g, '\n').replace(INVISIBLE, ' ').replace(/\*\*|__|`/g, '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(DECOR, '').trim());
}

/** Drop page numbers and headers/footers (a line repeating 3+ times once its digits are ignored). */
function stripNoise(lines) {
  const freq = new Map();
  const sig = (l) => l.replace(/\d+/g, '#').toLowerCase();
  lines.forEach((l) => { if (l.length > 6) freq.set(sig(l), (freq.get(sig(l)) || 0) + 1); });
  return lines.filter((l) => {
    if (!l) return false;
    if (NOISE_LINE.test(l)) return false;
    if (l.length > 6 && freq.get(sig(l)) >= 3 && !qMatch(l) && !optMatch(l) && !ANS_RE.test(l)) return false;
    return true;
  });
}

/** Split "A) x B) y C) z" (on one line) into options, keeping letter order. */
function splitInline(letter, rest) {
  const parts = [{ letter, text: rest }];
  let cur = parts[0];
  for (;;) {
    const next = LETTERS[letterIdx(cur.letter) + 1];
    if (!next) break;
    const re = new RegExp(`\\s+[(\\[]?${next}\\s*[)\\]]\\s*|\\s+${next}\\s*[.:]\\s+`, 'i');
    const mm = re.exec(cur.text);
    if (!mm) break;
    const nt = cur.text.slice(mm.index + mm[0].length);
    cur.text = cur.text.slice(0, mm.index).trim();
    cur = { letter: next, text: nt.trim() };
    parts.push(cur);
  }
  return parts;
}

/** "1. What is 2+2? A) 3 B) 4 C) 5" -> { stem, options } when all options sit on the question line. */
function inlineQuestion(text) {
  const re = /(?:^|\s)[(\[]?[Aa][)\]]\s*(?=\S)/g;
  let m;
  while ((m = re.exec(text))) {
    const stem = text.slice(0, m.index).trim();
    const opts = splitInline('A', text.slice(m.index + m[0].length));
    if (stem && opts.length >= 2) return { stem, options: opts };
  }
  return null;
}

// "... Neptune Correct option: B. Jupiter" / "... (Answer: B)" at the end of an option or question line
const TRAIL_ANS = /\s+[(\[]?(?:the\s+)?(?:correct\s+|right\s+)?(?:answer|ans|option|choice|key)\s*(?:is\b)?\s*[:=\-–—]\s*(\S.*?)[)\]]?\s*$/i;
function stripTrailingAnswer(text) {
  const m = TRAIL_ANS.exec(text);
  if (!m || m.index < 1) return { text, ans: null };
  return { text: text.slice(0, m.index).trim(), ans: m[1].trim() };
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Turn the text after "Answer:" into an option index (letter, or the option's own text). */
function answerIndex(value, options) {
  let v = String(value || '').trim().replace(/\.$/, '');
  if (!v) return null;
  let m = /^[(\[]?([A-Ha-h])[)\].:]?$/.exec(v);                          // B   (b)   B.
  if (!m) m = /^[(\[]?([A-Ha-h])[)\]]\s+\S/.exec(v);                     // B) New Delhi   (b) Paris
  if (!m) m = /^([A-Ha-h])\.\s+\S/.exec(v);                              // B. New Delhi
  if (m) { const i = letterIdx(m[1]); return i < options.length ? i : null; }
  const sv = squash(v.replace(/^[(\[]?[A-Ha-h][)\].]\s*/, ''));          // the option's text itself
  if (sv) {
    let i = options.findIndex((o) => squash(o) === sv);
    if (i < 0 && sv.length >= 3) i = options.findIndex((o) => { const so = squash(o); return so && (so.startsWith(sv) || sv.startsWith(so)); });
    if (i >= 0) return i;
  }
  return null;
}

function parseNumbered(lines) {
  const qs = [];
  let cur = null, lastNo = 0, skippedNoOptions = 0;
  const complete = (q) => q && q.options.length >= 2;

  const flush = () => {
    if (!cur) return;
    cur.text = cur.text.replace(/\s+/g, ' ').trim();
    cur.options = cur.options.map((o) => o.replace(/\s+/g, ' ').trim());
    if (cur.text && complete(cur)) qs.push(cur);
    else if (cur.text) skippedNoOptions++;
    cur = null;
  };
  const addOptions = (letter, text) => {
    // a trailing "... Ans: B" on the last option line
    const t = stripTrailingAnswer(text);
    text = t.text; if (t.ans) cur.pendingAns = t.ans;
    for (const p of splitInline(letter, text)) cur.options.push(p.text);
    cur.inOption = true;
  };

  for (const line of lines) {
    if (cur && cur.expectAnswer) {                                         // "Answer:" had nothing after it; value is on this line
      cur.expectAnswer = false;
      const idx = answerIndex(line, cur.options);
      if (idx !== null && !qMatch(line)) { cur.correct_index = idx; continue; }
    }

    const am = ANS_RE.exec(line);
    if (am && cur) {
      cur.answered = true;                                                 // this question is closed: a numbered line next starts a new one
      if (!complete(cur)) { cur.skip = true; continue; }                   // written answer to a question without options
      const val = am[1].trim();
      if (!val) cur.expectAnswer = true;
      else { const idx = answerIndex(val, cur.options); if (idx !== null) cur.correct_index = idx; else if (/^[(\[]?[A-Ha-h][)\]]?\s*[,/&]/.test(val)) cur.multi = true; }
      cur.inOption = false;
      continue;
    }
    if (cur && EXPL_RE.test(line)) { cur.skip = true; continue; }

    const qm = qMatch(line);
    if (qm) {
      const n = qm.no;
      const startsNew = !cur || n === lastNo + 1 || cur.answered || (complete(cur) && (n === 1 || (n > lastNo && n <= lastNo + 10)));
      if (startsNew) {
        flush();
        lastNo = n;
        const t0 = stripTrailingAnswer(qm.text);
        cur = { no: n, text: t0.text, options: [], correct_index: null, inOption: false };
        if (t0.ans) cur.pendingAns = t0.ans;
        const inl = inlineQuestion(t0.text);
        if (inl) { cur.text = inl.stem; for (const p of inl.options) cur.options.push(p.text); cur.inOption = true; }
        continue;
      }
    }

    const om = optMatch(line);
    if (cur && !cur.skip && om && om.letter === LETTERS[cur.options.length] && (cur.options.length > 0 || om.letter === 'A')) {
      addOptions(om.letter, om.text);
      continue;
    }

    if (cur && !cur.skip) {
      if (cur.inOption && cur.options.length) cur.options[cur.options.length - 1] += ' ' + line;
      else cur.text += ' ' + line;
    }
  }
  flush();
  qs.forEach((q) => { if (q.pendingAns != null && q.correct_index == null) { const idx = answerIndex(q.pendingAns, q.options); if (idx !== null) q.correct_index = idx; } delete q.pendingAns; });
  return { questions: qs, skippedNoOptions };
}

/** Questions with no numbers: a stem, then A) B) C) D) options; the next stem starts after the options. */
function parseUnnumbered(lines) {
  const qs = [];
  let stem = [], cur = null;
  const push = () => {
    if (cur && cur.options.length >= 2 && cur.text) {
      if (cur.pendingAns != null && cur.correct_index == null) { const idx = answerIndex(cur.pendingAns, cur.options); if (idx !== null) cur.correct_index = idx; }
      delete cur.pendingAns; qs.push(cur);
    }
    cur = null;
  };
  const optText = (o) => { const t = stripTrailingAnswer(o); if (t.ans && cur) cur.pendingAns = t.ans; return t.text; };
  for (const line of lines) {
    const om = optMatch(line);
    if (om && om.letter === 'A' && (stem.length || (cur && cur.options.length >= 2))) {
      push();
      const text = stem.join(' ').replace(/^(?:q(?:uestion)?\s*)?\d{1,4}\s*[.):]\s*/i, '').replace(/\s+/g, ' ').trim();
      stem = [];
      cur = { text, options: [], correct_index: null };
      for (const p of splitInline('A', optText(om.text))) cur.options.push(p.text);
      cur.lastOpt = true;
      continue;
    }
    if (cur && om && om.letter === LETTERS[cur.options.length]) { for (const p of splitInline(om.letter, optText(om.text))) cur.options.push(p.text); continue; }
    const am = ANS_RE.exec(line);
    if (cur && am && cur.options.length >= 2) { const idx = answerIndex(am[1], cur.options); if (idx !== null) cur.correct_index = idx; continue; }
    if (cur && EXPL_RE.test(line)) continue;
    if (cur && cur.options.length >= 2 && (cur.options.length >= 4 || /^[A-Z0-9"“(]/.test(line))) { push(); stem = [line]; continue; }
    if (cur && cur.options.length) { cur.options[cur.options.length - 1] += ' ' + line; continue; }
    stem.push(line);
  }
  push();
  qs.forEach((q) => { q.options = q.options.map((o) => o.replace(/\s+/g, ' ').trim()); delete q.lastOpt; });
  return qs;
}

/** Find an "Answer Key" block (with or without a heading) and cut it off the question lines. */
function splitKey(lines) {
  for (let i = lines.length - 1; i > 0; i--) {
    const m = KEY_HDR.exec(lines[i]);
    if (!m) continue;
    const plural = /^(answer\s*key|answers|ans\s*key|answer\s*sheet|solutions)$/i.test(m[1].trim());
    // a singular "Answer: B" line is only a key heading when what follows it is itself a list of "1-B" pairs
    if (!plural && !KEY_PAIRS.test(m[2])) continue;
    const key = parseAnswerKey([m[2], ...lines.slice(i + 1)].join('\n'));
    const tail = lines.length - i - 1;
    const entries = Object.keys(key).length;
    if (entries >= 2 && (plural || !m[2] || entries >= 2) && (plural || tail < 6 || entries >= tail / 2)) return { lines: lines.slice(0, i), key };
  }
  // headingless block at the very end made only of "1 B" style pairs
  let k = lines.length;
  while (k > 0 && KEY_PAIRS.test(lines[k - 1])) k--;
  if (lines.length - k >= 2) { const key = parseAnswerKey(lines.slice(k).join('\n')); if (Object.keys(key).length >= 2) return { lines: lines.slice(0, k), key }; }
  return { lines, key: {} };
}

/**
 * Parse a question bank. Returns { questions: [{text, options[], correct_index|null}], warnings[], stats }.
 * Supports numbered or unnumbered MCQs, inline options, answers after each question ("Answer: B", "✔ Answer: B",
 * "Ans: Paris"), explanations, trailing "Answer Key" sections, and strips page headers/footers.
 */
function parseQuestions(raw) {
  const warnings = [];
  const all = stripNoise(normalise(raw));
  const { lines, key } = splitKey(all);

  let { questions, skippedNoOptions } = parseNumbered(lines);
  const aStarts = lines.filter((l) => { const o = optMatch(l); return o && o.letter === 'A'; }).length;
  let usedUnnumbered = false;
  if (questions.length === 0 || aStarts > questions.length * 1.5 + 2) {
    const alt = parseUnnumbered(lines);
    if (alt.length > questions.length) { questions = alt.map((q, i) => ({ ...q, no: i + 1 })); usedUnnumbered = true; }
  }

  // answer key block -> questions (by the printed question number when those are unique, else by position)
  const nums = questions.map((q) => q.no);
  const byNumber = !usedUnnumbered && new Set(nums).size === nums.length;
  const keyCount = Object.keys(key).length;
  let mapped = 0;
  questions.forEach((q, i) => {
    const k = key[byNumber ? q.no : i + 1];
    if (q.correct_index == null && k != null) { if (k < q.options.length) { q.correct_index = k; mapped++; } else warnings.push(`Answer key gives option ${LETTERS[k]} for question ${q.no}, which has only ${q.options.length} options.`); }
  });
  if (keyCount && questions.length && mapped < Math.min(keyCount, questions.length) * 0.5)
    warnings.push(`The answer key lists ${keyCount} answers but only ${mapped} matched the ${questions.length} questions found — please check the numbering.`);
  const multi = questions.filter((q) => q.multi).length;
  if (multi) warnings.push(`${multi} question(s) show more than one correct answer; only single-answer questions are supported — please choose the answer for them.`);
  if (skippedNoOptions) warnings.push(`${skippedNoOptions} numbered item(s) had no A/B/C/D options (written / short-answer questions) and were skipped.`);

  questions.forEach((q) => { q.options = q.options.slice(0, 8); if (q.correct_index != null && q.correct_index >= q.options.length) q.correct_index = null; delete q.inOption; delete q.skip; delete q.answered; delete q.expectAnswer; delete q.multi; delete q.no; });
  return { questions, warnings, stats: { lines: all.length, skippedNoOptions, keyEntries: keyCount, unnumbered: usedUnnumbered } };
}

module.exports = { extractText, extractDocument, parseQuestions, parseAnswerKey, htmlToText };
