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
  const re = /(?:^|[\s,;|(\[])(?:Q(?:uestion)?\.?\s*)?(\d{1,4})\s*[.):\-–—=|]*\s*[(\[]?\s*(?:option\s*)?([A-Ha-h])\s*[)\]]?(?=[\s,;|.)\]]|$)/gi;
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
  /^[(\[]?([A-Ha-h])\s?[)\]]\s*(.*)$/,                           // A) / (A) / [A] / A )
  /^([A-Da-d]|[E-H])\s?[.:]\s*(.*)$/,                            // A. / A: / A .   (lowercase e-h never count, so "e.g." is not an option)
  /^([A-Da-d]|[E-H])\s*[-–—]\s+(.*)$/,                           // A - text
];
const ANS_RE = /^(?:the\s+)?(?:correct\s+|right\s+)?(?:answer|ans|option|choice|key)\s*(?:is\b)?\s*[:=\-–—.]?\s*(.*)$/i;
const EXPL_RE = /^(?:explanation|solution|rationale|reason|hint|note|working|sol)\s*[:\-–—]/i;
const KEY_HDR = /^(?:the\s+)?(answer\s*key|answers?|ans\s*key|answer\s*sheet|key|solutions?)\s*[:\-–—]?\s*(.*)$/i;
const KEY_PAIRS = /^(?:(?:q\.?\s*)?\d{1,4}\s*[.):\-–—=|]?\s*[(\[]?[A-Ha-h][)\]]?[\s,;|]*)+$/i;   // "1-B, 2-C"  /  "3 A"
const NOISE_LINE = /^(?:page\s*)?\d{1,3}\s*(?:\/|of)\s*\d{1,3}$|^[-–—\s]*\d{1,3}[-–—\s]*$/i;

const qMatch = (l) => { for (const re of Q_PATTERNS) { const m = re.exec(l); if (m) return { no: parseInt(m[1], 10), text: (m[2] || '').trim() }; } return null; };
// Every question has exactly 4 options: A, B, C, D. There is never an option E (or F-H): a stray "E:" inside an option is DATA,
// e.g. "D) N: 2012.388 m,  E: 994.000 m, Z: 100.500 m" (an Easting), so letters after D are never read as options.
const MAX_OPTIONS = 4;
const optMatch = (l) => {
  for (const re of OPT_PATTERNS) {
    const m = re.exec(l);
    if (m && letterIdx(m[1]) < MAX_OPTIONS) return { letter: m[1].toUpperCase(), text: (m[2] || '').trim() };
  }
  return null;
};

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
  // A question stem can legitimately repeat ("Which of the following is correct?"), so a repeated line is only a page header/footer
  // when it is NOT part of a question: not numbered, not an option, not an answer, not a question mark, and not the text right
  // before an "A)" option (a stem, possibly wrapped over up to three lines).
  const isStem = (i) => {
    if (i > 0 && qMatch(lines[i - 1]) && /\d+\s*(?:\/|of)\s*\d+|\bpage\s*\d+/i.test(lines[i])) return false;   // right after a numbered question, a page-number line ("Printed ... 3/9", "Page 3") is a footer
    if (/[?]\s*$/.test(lines[i])) return true;
    for (let d = 1; d <= 3; d++) {                       // walk down to the first option: the line is a stem only if "A)" comes before any numbered question
      const nx = lines[i + d];
      if (!nx || qMatch(nx)) return false;
      const o = optMatch(nx);
      if (o) return o.letter === 'A';
    }
    return false;
  };
  return lines.filter((l, i) => {
    if (!l) return false;
    if (NOISE_LINE.test(l)) return false;
    // option text that wraps onto a second line and happens to repeat ("E: 994.000 m, Z: 100.500 m", "of the above") is content, not a footer
    const content = (/^[A-Za-z]{1,3}\s*[:=]\s*\S/.test(l) || /^[a-z]/.test(l)) && !/www\.|https?:|@|\.com\b/i.test(l);
    if (l.length > 6 && freq.get(sig(l)) >= 3 && !qMatch(l) && !optMatch(l) && !ANS_RE.test(l) && !isStem(i) && !content) return false;
    return true;
  });
}

/**
 * Section headings are NOT questions: "SECTION A", "Section B: Total Station Operations", "Part II - Levelling",
 * "Unit 3", "Questions 11 - 20", "General Instructions", or a stand-alone heading line sitting between two question blocks.
 * They are removed before the questions are read, so they can never become a question or stick to an option.
 */
const SECTION_KW = /^(?:section|sec\.?|part|module|unit|chapter|topic|category|group|subject|paper|segment|block|level|round)\s*[-:.]?\s*(?:[A-Za-z]|[IVXivx]{1,4}|\d{1,2})(?=\s|[-:.)–—(]|$)/i;
const RANGE_LINE = /^[(\[]?\s*(?:questions?|qns?\.?|q\.?)\s*\d{1,3}\s*(?:to|-|–|—|through)\s*(?:q\.?\s*)?\d{1,3}\b/i;     // "Questions 1 – 10", "Q11-Q20"
const INSTRUCTION_LINE = /^(?:general\s+)?(?:instructions?|directions?)\s*(?:to\s+candidates)?\s*[:\-–—]?\s*$/i;
/**
 * A heading can be glued onto the same line as a question (a PDF export often does this):
 *   "CALIBRATION (Q19 – Q32) 19. What is the angular accuracy ...?"      "SECTION C: Levelling 19. What is ...?"      "CALIBRATION 19. What is ...?"
 * or sit at the end of the previous line:  "D) Foresight Leveling CALIBRATION (Q19 – Q32)".
 * Cut the heading off and keep the question. A heading before a number is only cut when that number is the NEXT question number
 * (or the heading itself announces it with a range), so ordinary text like "ISO 9001. The standard ..." is never touched.
 */
const RANGE_TAG = '[(\\[]\\s*(?:[Qq]uestions?|QUESTIONS?|[Qq][Nn][Ss]?\\.?|[Qq]\\.?)\\s*(\\d{1,3})\\s*(?:to|TO|To|-|–|—|through)\\s*(?:[Qq]\\.?\\s*)?\\d{1,3}\\s*[)\\]]';
function stripHeadingMerges(lines) {
  let last = 0;
  const front = new RegExp('^[^0-9?]*?\\s*' + RANGE_TAG + '\\s*(\\S.*)$');                                          // "CALIBRATION (Q19 – Q32) 19. What ..."
  const sect = /^(?:section|sec\.?|part|module|unit|chapter|topic|category)\s*[-:.]?\s*(?:[A-Za-z]|[IVXivx]{1,4}|\d{1,2})\b[^0-9?]{0,70}?\s+(?=\d{1,4}\s*[.):]\s*\S)/i;   // "SECTION C: Levelling 19. What ..."
  const caps = /^(?:[A-Z][A-Z0-9&'’/\-]*\s+){1,6}(?=\d{1,4}\s*[.):]\s*\S)/;                                         // "CALIBRATION 19. What ..."
  const back = new RegExp('\\s+(?:[A-Z][A-Z0-9&\'’/\\-]{2,}\\s+)*[A-Z][A-Z0-9&\'’/\\-]{2,}\\s*' + RANGE_TAG + '\\s*$');   // "... D) Leveling CALIBRATION (Q19 – Q32)"  (heading words are ALL CAPS)
  return lines.map((l) => {
    let out = l, m;
    if ((m = front.exec(out)) && qMatch(m[2])) out = m[2];                                         // the range tag (m[1]) is the heading's own number range
    else if ((m = sect.exec(out)) && (q => q && q.no === last + 1)(qMatch(out.slice(m[0].length)))) out = out.slice(m[0].length);
    else if ((m = caps.exec(out)) && (q => q && q.no === last + 1)(qMatch(out.slice(m[0].length)))) out = out.slice(m[0].length);
    if (out.length > 12 && (m = back.exec(out)) && m.index > 8) out = out.slice(0, m.index).trim();   // heading stuck to the end of a line
    const q = qMatch(out);
    if (q) last = q.no;
    return out;
  });
}

function dropHeadings(lines) {
  let prevDropped = false;   // was the previous line a heading that we removed? (then an ALL-CAPS line right after it is the heading's second line)
  let blockDone = true;      // are we between two question blocks? (true after the last option D / an answer line, also across wrapped option text)
  const decide = (l, i) => {
    // the closing half of a heading whose range wraps onto a second line:  "SECTION A: ... (Q1 –"  /  "Q18)"  -- "Q18)" is not question 18
    if (l && i > 0 && /[(\[]\s*(?:Q|Questions?)\s*\.?\s*\d{1,3}\s*(?:–|—|-|to|TO)\s*$/.test(lines[i - 1]) && /^[(\[]?\s*(?:Q|Questions?)?\s*\.?\s*\d{1,3}\s*[)\]]\s*$/.test(l)) return false;
    if (!l || qMatch(l) || optMatch(l) || ANS_RE.test(l) || EXPL_RE.test(l)) return true;
    if (/[?]\s*$/.test(l)) return true;                                    // a question mark: it is a question
    if (/^[(\[]?[A-Ha-h][)\]]?\.?$/.test(l)) return true;                  // a bare option letter ("B")
    const next = lines[i + 1], prev = lines[i - 1];
    const pa = prev && ANS_RE.exec(prev);
    if (pa && !pa[1].trim()) return true;                                  // "Answer:" with the value on this line
    const nextOpt = next && optMatch(next);
    const words = l.split(/\s+/).length;
    // a heading that wraps onto a second line: "SECTION B: ... HARDWARE, SETUP &"  /  "CALIBRATION (Q19 – Q32)"
    const capsOnly = !/[a-z]/.test(l) && /[A-Z]{3}/.test(l);
    const headRange = /^[^a-z]*[(\[]\s*(?:Q|QUESTIONS?|Questions?)\s*\.?\s*\d+\s*(?:–|-|—|to|TO)\s*(?:Q\.?\s*)?\d+\s*[)\]]\s*$/.test(l);   // ALL-CAPS words + "(Q19 – Q32)"
    if (headRange || (prevDropped && capsOnly && words <= 14)) return false;
    if (words <= 14 && !(nextOpt && nextOpt.letter === 'A') && (SECTION_KW.test(l) || RANGE_LINE.test(l) || INSTRUCTION_LINE.test(l))) return false;
    // a short stand-alone line between two question blocks: "FUNDAMENTALS OF SURVEYING", "Levelling and Contouring"
    const endsBlock = i === 0 || blockDone;
    // (a heading has no digits and is not a "label: value" data line such as "E: 994.000 m, Z: 100.500 m")
    if (endsBlock && words <= 12 && !/[.?!;,]\s*$/.test(l) && /^[A-Z]/.test(l) && !/\d/.test(l) && !/^[A-Za-z]{1,3}\s*[:=]/.test(l) && !(nextOpt && nextOpt.letter === 'A')) {
      const caps = !/[a-z]/.test(l) && /[A-Z]{3}/.test(l);
      if ((next && qMatch(next)) || caps) return false;
    }
    return true;
  };
  // remember where we are in the question block, from the lines that were KEPT
  const track = (l) => {
    if (!l) return;
    if (qMatch(l)) blockDone = !!findChain(l);
    else { const o = optMatch(l); if (o) blockDone = !!(findChain(l) || o.letter >= 'D'); else if (ANS_RE.test(l) || EXPL_RE.test(l)) blockDone = true; }
  };
  return lines.filter((l, i) => { const keep = decide(l, i); if (keep) track(l); prevDropped = !keep; return keep; });
}

/** Split "A) x B) y C) z" (on one line) into options, keeping letter order. */
function splitInline(letter, rest) {
  const parts = [{ letter, text: rest }];
  let cur = parts[0];
  for (;;) {
    const next = LETTERS[letterIdx(cur.letter) + 1];
    if (!next || letterIdx(next) >= MAX_OPTIONS) break;
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

/**
 * The earliest marker for `letter` at or after `from`: "A)", "(A)", "[A]", "A )", "A.", "A:" (preceded by a space or the start,
 * and for the dot style followed by a space). Returns { start, end } where `end` is where the option's own text begins.
 */
function markerAt(line, letter, from) {
  const re = new RegExp('(^|\\s)(?:[(\\[]?' + letter + '\\s?[)\\]]|' + letter + '\\s?[.:](?=\\s))\\s*', 'gi');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(line))) {
    const marker = m[0].slice(m[1].length);
    const dotStyle = !/[)\]]/.test(marker);
    const ch = marker.replace(/^[(\[]/, '')[0];
    if (dotStyle && /[e-h]/.test(ch)) continue;                 // lowercase "e." / "f." are words, not options
    return { start: m.index + m[1].length, end: m.index + m[0].length };
  }
  return null;
}

/** Options A, B, C, D... that appear IN ORDER inside one line (>= 2 of them). Returns their markers, or null. */
function findChain(line) {
  for (let from = 0; from < line.length;) {
    const a = markerAt(line, 'A', from);
    if (!a) return null;
    const chain = [a];
    let cur = a;
    for (const L of 'BCD') { const n = markerAt(line, L, cur.end); if (!n) break; chain.push(n); cur = n; }
    if (chain.length >= 2) return chain;
    from = a.end;
  }
  return null;
}

/** "1. What is 2+2? A) 3 B) 4 C) 5 D) 6" -> { stem, options } when all the options sit on the question line. */
function inlineQuestion(text) {
  const chain = findChain(text);
  if (!chain) return null;
  const stem = text.slice(0, chain[0].start).trim();
  const options = chain.map((c, i) => ({ letter: LETTERS[i], text: text.slice(c.end, chain[i + 1] ? chain[i + 1].start : text.length).trim() }));
  return stem ? { stem, options } : null;
}

/**
 * A PDF/Word export can run several questions together on one line:  "1. Q A. a B. b C. c D. d 2. Q A. a ...".
 * Cut such a line where the NEXT question number (n+1) starts, provided that piece has its own run of options.
 */
function explode(lines) {
  const out = [], work = lines.slice();
  while (work.length) {
    let line = work.shift();
    const q = qMatch(line);
    const chain = q ? findChain(line) : null;
    if (q && chain) {
      const rest = line.slice(chain[chain.length - 1].end);
      const n = q.no + 1;
      const re = new RegExp('\\s([(\\[]?(?:Q(?:uestion)?\\s*\\.?\\s*)?' + n + '\\s*[.):\\-–—\\]])\\s+(?=\\S)');
      const m = re.exec(rest);
      if (m) {
        const cut = chain[chain.length - 1].end + m.index + 1;
        const tail = line.slice(cut).trim();
        if (findChain(tail)) { work.unshift(tail); line = line.slice(0, cut).trim(); }
      }
    }
    out.push(line);
  }
  return out;
}

/** Options written as "(1) (2) (3) (4)" or as bare "A text / B text / C text / D text" lines become "A) ..." so one reader handles them all. */
function prepOptionRuns(lines) {
  const out = lines.slice();
  // (1)..(k) groups that restart at (1) for every question
  const runs = [];
  for (let i = 0, cur = null; i < out.length; i++) {
    const m = /^[(\[]([1-8])[)\]]\s*(.*)$/.exec(out[i]);
    if (m && +m[1] === 1) { cur = { idx: [i] }; runs.push(cur); }
    else if (m && cur && +m[1] === cur.idx.length + 1) cur.idx.push(i);
  }
  const real = runs.filter((r) => r.idx.length >= 2);
  if (real.length >= 2) for (const r of real) r.idx.forEach((i, k) => { out[i] = out[i].replace(/^[(\[][1-8][)\]]\s*/, LETTERS[k] + ') '); });
  // exactly four consecutive lines "A text", "B text", "C text", "D text"
  for (let i = 0; i + 3 < out.length; i++) {
    if ([0, 1, 2, 3].every((k) => !optMatch(out[i + k]) && new RegExp('^' + LETTERS[k] + '\\s+\\S').test(out[i + k]))) {
      for (let k = 0; k < 4; k++) out[i + k] = out[i + k].replace(/^[A-D]\s+/, LETTERS[k] + ') ');
      i += 3;
    }
  }
  return out;
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

    // "d None of above" (the dot after the letter is missing): accepted only as exactly the NEXT expected option C or D of a question that already has two
    const loose = cur && !cur.skip && cur.options.length >= 2 && cur.options.length < 4 ? /^([A-Da-d])\s+(\S.*)$/.exec(line) : null;
    const om = optMatch(line) || (loose && loose[1].toUpperCase() === LETTERS[cur.options.length] ? { letter: loose[1].toUpperCase(), text: loose[2].trim() } : null);
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
    const ch = findChain(line);
    if (ch && ch[0].start > 0 && !optMatch(line)) {            // "stem A) x B) y C) z D) w" all on one line
      push();
      const before = line.slice(0, ch[0].start).trim();
      const text = [...stem, before].join(' ').replace(/^(?:q(?:uestion)?\s*)?\d{1,4}\s*[.):]\s*/i, '').replace(/\s+/g, ' ').trim();
      stem = [];
      cur = { text, options: [], correct_index: null };
      ch.forEach((c, i) => cur.options.push(optText(line.slice(c.end, ch[i + 1] ? ch[i + 1].start : line.length).trim())));
      cur.lastOpt = true;
      continue;
    }
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
    const dataLine = /^[A-Za-z]{1,3}\s*[:=]\s*\S/.test(line);      // "E: 994.000 m, Z: 100.500 m" continues the last option; it is not a new question
    if (cur && cur.options.length >= 2 && !dataLine && (cur.options.length >= 4 || /^[A-Z0-9"“(]/.test(line))) { push(); stem = [line]; continue; }
    if (cur && cur.options.length) { cur.options[cur.options.length - 1] += ' ' + line; continue; }
    stem.push(line);
  }
  push();
  qs.forEach((q) => { q.options = q.options.map((o) => o.replace(/\s+/g, ' ').trim()); delete q.lastOpt; });
  return qs;
}

/** No A/B/C/D labels at all: a numbered question followed by exactly four option lines (bullets, tabs or plain lines). Used only as a last resort. */
function parseUnlabeled(lines) {
  const groups = [];
  let g = null, expect = 1;
  for (const line of lines) {
    const q = qMatch(line);
    if (q && q.no === expect) { g = { no: q.no, stem: q.text, rest: [], ended: false }; groups.push(g); expect = q.no + 1; continue; }
    if (g) g.rest.push(line);
  }
  const qs = [];
  for (const q of groups) {
    let ans = null, skipping = false;
    const body = [];
    for (const l of q.rest) {
      const am = ANS_RE.exec(l);
      if (am) { ans = am[1].trim(); skipping = true; continue; }
      if (EXPL_RE.test(l)) { skipping = true; continue; }
      if (!skipping) body.push(l);
    }
    if (body.length < 4) continue;
    const options = body.slice(-4);
    const text = [q.stem, ...body.slice(0, -4)].join(' ').replace(/\s+/g, ' ').trim();
    const item = { text, options, correct_index: null, no: q.no };
    if (ans) { const i = answerIndex(ans, options); if (i !== null) item.correct_index = i; }
    if (text) qs.push(item);
  }
  return qs.length >= 2 ? qs : [];
}

// A line that belongs to an answer-key TABLE: only question numbers, option letters and header words ("Q. No.", "Ans", "|" ...).
// Descriptive sentences ("Reference key for the 50 A-level questions") are not key lines, so they can never produce a wrong answer.
const KEY_WORDS = new Set(['q', 'no', 's', 'sl', 'sr', 'sno', 'qno', 'que', 'question', 'questions', 'ans', 'answer', 'answers', 'key', 'correct', 'option', 'to']);
const keyish = (l) => { const t = l.split(/[\s,;|:()\[\]\-–—=.]+/).filter(Boolean); return t.length > 0 && t.every((x) => /^q?\d{1,4}$/i.test(x) || /^[A-Ha-h]$/.test(x) || KEY_WORDS.has(x.toLowerCase())); };

/** Find an "Answer Key" block (with or without a heading) and cut it off the question lines. */
function splitKey(lines) {
  for (let i = lines.length - 1; i > 0; i--) {
    const m = KEY_HDR.exec(lines[i]);
    if (!m) continue;
    const plural = /^(answer\s*key|answers|ans\s*key|answer\s*sheet|solutions)$/i.test(m[1].trim());
    // a singular "Answer: B" line is only a key heading when what follows it is itself a list of "1-B" pairs
    if (!plural && !KEY_PAIRS.test(m[2])) continue;
    const after = [m[2], ...lines.slice(i + 1)];
    let key = parseAnswerKey(after.filter((l) => l && keyish(l)).join('\n'));             // table lines only
    if (Object.keys(key).length < 2) {                                                    // otherwise read everything after the heading,
      const text = after.join('\n');                                                      // starting at the table's own header ("Q. No.") when there is one
      const hdr = /(?:^|[\s|])(?:q\.?\s*no\.?|que\.?\s*no\.?|s\.?\s*no\.?|sl\.?\s*no\.?)(?=[\s|:.]|$)/i.exec(text);
      key = parseAnswerKey(hdr && hdr.index > 0 ? text.slice(hdr.index) : text);
    }
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
  // The answer key is cut off FIRST (before page numbers / repeated headers are removed), because in a key table the question
  // numbers can sit alone on a line and would otherwise be thrown away as page numbers.
  const all = normalise(raw).filter(Boolean);
  const split = splitKey(all);
  const key = split.key;
  const lines = prepOptionRuns(explode(dropHeadings(stripHeadingMerges(stripNoise(split.lines)))));         // split runs-together lines into one line per question, unify option styles

  // Read the paper in two independent ways and keep the better result:
  //   numbered : question numbers mark where each question starts
  //   by options : each run of options A, B, C, D is one question; its stem is the text just before it
  // "Better" = more questions with a clean set of options, and no question that has swallowed the text of others.
  const goodness = (qs) => qs.reduce((s, q) => s + (q.options.length === 4 ? 3 : q.options.length >= 2 ? 1 : 0)
    - (q.text.length > 700 ? 3 : 0) - (q.options.some((o) => o.length > 400) ? 3 : 0), 0);
  let { questions, skippedNoOptions } = parseNumbered(lines);
  let usedUnnumbered = false;
  const alt = parseUnnumbered(lines);
  if (goodness(alt) > goodness(questions)) { questions = alt.map((q, i) => ({ ...q, no: i + 1 })); usedUnnumbered = true; }
  if (!questions.length) {                                      // last resort: options without letters (bare numbers can be options here, so keep them)
    const unl = parseUnlabeled(splitKey(normalise(raw).filter(Boolean)).lines);
    if (unl.length) questions = unl;
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
  const odd = questions.map((q, i) => ({ n: i + 1, c: q.options.length })).filter((x) => x.c !== 4);
  if (odd.length) warnings.push(`${odd.length} question(s) do not have exactly 4 options: ${odd.slice(0, 10).map((x) => `Q${x.n} (${x.c})`).join(', ')}${odd.length > 10 ? ' …' : ''}. Please check them in the review table.`);
  const long = questions.map((q, i) => ({ n: i + 1, q })).filter(({ q }) => q.text.length > 700 || q.options.some((o) => o.length > 400)).map((x) => x.n);
  if (long.length) warnings.push(`Question ${long.slice(0, 6).join(', ')} looks unusually long — it may have run into the next question. Please check it.`);

  // a stem never keeps its printed question number ("1. What is ..."): strip it when it is followed by the question's first word
  questions.forEach((q) => { q.text = q.text.replace(/^\s*(?:Q(?:uestion)?\s*\.?\s*)?\d{1,3}\s*[.)]\s+(?=["“(]?[A-Z])/, ''); });
  questions.forEach((q) => { q.options = q.options.slice(0, 8); if (q.correct_index != null && q.correct_index >= q.options.length) q.correct_index = null; delete q.inOption; delete q.skip; delete q.answered; delete q.expectAnswer; delete q.multi; delete q.no; });
  return { questions, warnings, stats: { lines: all.length, skippedNoOptions, keyEntries: keyCount, unnumbered: usedUnnumbered } };
}

module.exports = { extractText, extractDocument, parseQuestions, parseAnswerKey, htmlToText };
