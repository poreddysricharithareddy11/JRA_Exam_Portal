// Parser tests: many real-world question-bank layouts, real PDFs (multi-page, footers) and Word files (auto-numbering).
const assert = require('assert');
const PDFDocument = require('pdfkit');
const JSZip = require('jszip');
const { extractDocument, parseQuestions, parseAnswerKey } = require('../src/parser');

const A = (...x) => x.map((i) => 'ABCDEFGH'[i]).join('');
const summary = (r) => r.questions.map((q) => `${q.options.length}:${q.correct_index == null ? '-' : 'ABCDEFGH'[q.correct_index]}`).join(' ');
let n = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { n++; }, (e) => { console.error('FAILED: ' + name + '\n', e.message); process.exitCode = 1; });

const CAPITAL = ['Mumbai', 'New Delhi', 'Kolkata', 'Chennai'];
const hasQ = (r, i, text, opts, ans) => {
  const q = r.questions[i];
  assert.ok(q, `question ${i + 1} exists (found ${r.questions.length})`);
  assert.ok(q.text.includes(text), `Q${i + 1} text "${q.text}" should include "${text}"`);
  if (opts) assert.deepEqual(q.options, opts, `Q${i + 1} options`);
  if (ans !== undefined) assert.equal(q.correct_index, ans, `Q${i + 1} answer`);
};

const pdfOf = (pages) => new Promise((res) => {
  const d = new PDFDocument({ margin: 50 }); const b = []; d.on('data', (c) => b.push(c)); d.on('end', () => res(Buffer.concat(b)));
  pages.forEach((lines, i) => { if (i) d.addPage(); lines.forEach((l) => d.text(l)); });
  d.end();
});

/** Build a .docx. items: [{ text, level|null }]  level 0 = auto-numbered "1.", level 1 = auto-lettered "A)"; null = plain paragraph */
async function docxOf(items, tableRows) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const para = (it) => `<w:p>${it.level == null ? '' : `<w:pPr><w:numPr><w:ilvl w:val="${it.level}"/><w:numId w:val="1"/></w:numPr></w:pPr>`}<w:r><w:t xml:space="preserve">${esc(it.text)}</w:t></w:r></w:p>`;
  const tbl = tableRows ? `<w:tbl>${tableRows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  zip.file('word/numbering.xml', '<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${items.map(para).join('')}${tbl}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

(async () => {
  /* ---------------- plain text layouts ---------------- */
  await t('classic: numbered, A) options, Answer: B', () => {
    const r = parseQuestions('1. Capital of India?\nA) Mumbai\nB) New Delhi\nC) Kolkata\nD) Chennai\nAnswer: B\n2. 2+2?\nA) 3\nB) 4\nAnswer: B');
    hasQ(r, 0, 'Capital of India', CAPITAL, 1); hasQ(r, 1, '2+2', ['3', '4'], 1); assert.equal(r.questions.length, 2);
  });
  await t('Q1. with (a) options and Ans: (b)', () => {
    const r = parseQuestions('Q1. Pick one\n(a) red\n(b) green\n(c) blue\nAns: (b)\nQ2. Another\n(a) x\n(b) y\nAns: (a)');
    assert.equal(summary(r), '3:B 2:A');
  });
  await t('1) stems with a. b. c. options and "Correct Answer: C"', () => {
    const r = parseQuestions('1) First?\na. one\nb. two\nc. three\nCorrect Answer: C\n2) Second?\na. p\nb. q\nCorrect Answer: A');
    assert.equal(summary(r), '3:C 2:A');
  });
  await t('all options inline on the question line + key at the end', () => {
    const r = parseQuestions('1. What is 2+2? A) 3 B) 4 C) 5 D) 6\n2. Capital of France? A) Berlin B) Paris C) Rome D) Madrid\n3. Prime? A) 4 B) 6 C) 7 D) 9\nAnswer Key\n1-B, 2-B, 3-C');
    assert.equal(summary(r), '4:B 4:B 4:C'); hasQ(r, 0, 'What is 2+2?', ['3', '4', '5', '6']);
  });
  await t('options inline on one line under the stem', () => {
    const r = parseQuestions('1. Capital of France?\nA) Berlin B) Paris C) Rome D) Madrid\nAnswer: B');
    hasQ(r, 0, 'France', ['Berlin', 'Paris', 'Rome', 'Madrid'], 1);
  });
  await t('tick marks, page footers, explanations and text answers (the real Capgemini layout)', () => {
    const lines = [];
    for (let i = 1; i <= 4; i++) lines.push(`${i}. Question number ${i}?`, `Printed using SomeTool to PDF. ${i}/9`, 'A) alpha', 'B) beta', 'C) gamma', 'D) delta', `✔ Answer: ${'ABCD'[i - 1]}`, 'Explanation: because reasons');
    lines.push('5. Which is the capital of France?', 'A) Berlin', 'B) Paris', 'C) Rome', '✔ Answer: Paris');
    const r = parseQuestions(lines.join('\n'));
    assert.equal(summary(r), '4:A 4:B 4:C 4:D 3:B');
    assert.ok(!r.questions.some((q) => /Printed using|because reasons/.test(JSON.stringify(q))), 'footers/explanations are not mixed into questions');
  });
  await t('answer value on the next line', () => {
    const r = parseQuestions('1. First?\nA) a\nB) b\nAnswer:\nB\n2. Second?\nA) a\nB) b\nAnswer:\nA');
    assert.equal(summary(r), '2:B 2:A');
  });
  await t('answer given as "B) text" and "B. text"', () => {
    const r = parseQuestions('1. First?\nA) red\nB) green\nAnswer: B) green\n2. Second?\nA) x\nB) y\nAnswer: A. x');
    assert.equal(summary(r), '2:B 2:A');
  });
  await t('answer words that start with A/B are NOT read as letters', () => {
    const r = parseQuestions('1. What is a variable?\nA) A name for a value\nB) A loop\nAnswer: A name for a value\n2. Next?\nA) x\nB) y\nAnswer: B');
    assert.equal(summary(r), '2:A 2:B');
  });
  await t('markdown bold from copied chat answers', () => {
    const r = parseQuestions('**1. Which one?**\nA) one\nB) two\n**Answer:** B\n**2. And?**\nA) x\nB) y\n**Answer:** A');
    assert.equal(summary(r), '2:B 2:A');
  });
  await t('numbering restarts per section and decimals are not question numbers', () => {
    const r = parseQuestions('1. What is 2.5 + 2.5?\nA) 4\nB) 5\nAnswer: B\n2. Second?\nA) x\nB) y\nAnswer: A\n1. New section first?\nA) p\nB) q\nAnswer: B\n2. New section second?\nA) r\nB) s\nAnswer: A');
    assert.equal(r.questions.length, 4); assert.equal(summary(r), '2:B 2:A 2:B 2:A'); assert.ok(r.questions[0].text.includes('2.5 + 2.5'));
  });
  await t('questions and options wrapped over several lines', () => {
    const r = parseQuestions('1. This is a very long question that\ncontinues on the next line?\nA) an option that is also\nlong and wraps\nB) short\nAnswer: A');
    hasQ(r, 0, 'continues on the next line', ['an option that is also long and wraps', 'short'], 0);
  });
  await t('trailing "Ans: D" on the last option line', () => {
    const r = parseQuestions('1. Pick?\nA) a\nB) b\nC) c\nD) None of these Ans: D');
    hasQ(r, 0, 'Pick', ['a', 'b', 'c', 'None of these'], 3);
  });
  await t('written (no-option) questions are skipped and reported', () => {
    const r = parseQuestions('1. Explain polymorphism.\nAnswer:\nIt means many forms.\n2. Real MCQ?\nA) x\nB) y\nAnswer: B\n3. Define OOP.\nAnswer: Object oriented programming');
    assert.equal(r.questions.length, 1); assert.equal(r.stats.skippedNoOptions, 2); assert.ok(r.warnings.some((w) => /no A\/B\/C\/D options/.test(w)));
  });
  await t('unnumbered questions', () => {
    const r = parseQuestions('What is the capital of India?\nA) Mumbai\nB) New Delhi\nC) Kolkata\nD) Chennai\nAnswer: B\nWhich planet is largest?\nA) Earth\nB) Mars\nC) Jupiter\nD) Venus\nAnswer: C');
    assert.equal(summary(r), '4:B 4:C'); hasQ(r, 1, 'largest');
  });

  await t('answer glued to the last option: "D) Neptune Correct option: B. Jupiter" (separate option lines)', () => {
    const r = parseQuestions('Q1. Which is the largest planet in our solar system?\nA) Earth\nB) Jupiter\nC) Saturn\nD) Neptune Correct option: B. Jupiter\nQ2. What is the capital of Australia?\nA) Sydney\nB) Melbourne\nC) Canberra\nD) Perth Correct option: C. Canberra\nQ3. Who wrote the national anthem?\nA) Bankim\nB) Rabindranath Tagore\nC) Sarojini Naidu\nD) Subramania Bharati Correct option: B. Rabindranath Tagore');
    assert.equal(summary(r), '4:B 4:C 4:B');
    assert.deepEqual(r.questions[0].options, ['Earth', 'Jupiter', 'Saturn', 'Neptune'], 'option D no longer contains the answer text');
    assert.deepEqual(r.questions[2].options[3], 'Subramania Bharati');
  });
  await t('answer glued to the end when all options sit on one line', () => {
    const r = parseQuestions('1. Largest planet?\nA) Earth B) Jupiter C) Saturn D) Neptune Correct option: B. Jupiter\n2. Gas absorbed by plants?\nA) Oxygen B) Nitrogen C) Carbon dioxide D) Hydrogen Correct Answer: C');
    assert.equal(summary(r), '4:B 4:C'); assert.equal(r.questions[0].options[3], 'Neptune');
  });
  await t('"Correct option: B. Jupiter" on its own line, and "(Answer: B)" glued on, and answer by text', () => {
    const r = parseQuestions('1. First?\nA) a\nB) b\nCorrect option: B. b\n2. Second?\nA) x\nB) y (Answer: A)\n3. Third?\nA) red\nB) green Correct option: green');
    assert.equal(summary(r), '2:B 2:A 2:B');
  });
  await t('unnumbered questions with the answer at the end of the last option', () => {
    const r = parseQuestions('Largest planet?\nA) Earth\nB) Jupiter\nC) Saturn\nD) Neptune Correct option: B. Jupiter\nCapital of Australia?\nA) Sydney\nB) Melbourne\nC) Canberra\nD) Perth Correct option: C. Canberra');
    assert.equal(summary(r), '4:B 4:C');
  });

  /* ---------------- answer-key layouts ---------------- */
  await t('key: one pair per line, "Answers:" heading', () => {
    const r = parseQuestions('1. A?\nA) a\nB) b\n2. B?\nA) a\nB) b\n3. C?\nA) a\nB) b\nAnswers\n1. B\n2. A\n3. B');
    assert.equal(summary(r), '2:B 2:A 2:B');
  });
  await t('key: header and pairs on the same line', () => {
    const r = parseQuestions('1. A?\nA) a\nB) b\n2. B?\nA) a\nB) b\nAnswer Key: 1-A, 2-B');
    assert.equal(summary(r), '2:A 2:B');
  });
  await t('key: heading-less block of pairs at the end', () => {
    const r = parseQuestions('1. A?\nA) a\nB) b\n2. B?\nA) a\nB) b\n3. C?\nA) a\nB) b\n1 B\n2 A\n3 B');
    assert.equal(summary(r), '2:B 2:A 2:B');
  });
  await t('key: "1. B 2. C 3. A" in a row, and Q1: style', () => {
    assert.deepEqual(parseAnswerKey('1. B 2. C 3. A'), { 1: 1, 2: 2, 3: 0 });
    assert.deepEqual(parseAnswerKey('Q1: B, Q2: C, Q3: (a)'), { 1: 1, 2: 2, 3: 0 });
    assert.deepEqual(parseAnswerKey('1-b,2-c;3.d 4) A'), { 1: 1, 2: 2, 3: 3, 4: 0 });
  });
  await t('key: table laid out as a row of numbers over a row of letters', () => {
    assert.deepEqual(parseAnswerKey('1 2 3 4\nB C A D'), { 1: 1, 2: 2, 3: 0, 4: 3 });
  });
  await t('key numbers are matched by the printed question number', () => {
    const r = parseQuestions('5. Fifth?\nA) a\nB) b\n6. Sixth?\nA) a\nB) b\nAnswer Key\n5-B 6-A');
    assert.equal(summary(r), '2:B 2:A');
  });

  /* ---------------- real PDFs ---------------- */
  await t('PDF: multi-page, repeated header/footer, answers per question', async () => {
    const pages = [];
    for (let p = 0; p < 3; p++) {
      const L = ['EXAM PAPER 2026 - CONFIDENTIAL'];
      for (let i = 1; i <= 5; i++) { const no = p * 5 + i; L.push(`${no}. Question ${no} text here?`, 'A) first option', 'B) second option', 'C) third option', 'D) fourth option', `Answer: ${'ABCD'[no % 4]}`); }
      L.push(`Page ${p + 1} of 3`); pages.push(L);
    }
    const r = parseQuestions((await extractDocument({ originalname: 'p.pdf', buffer: await pdfOf(pages) })).text);
    assert.equal(r.questions.length, 15); assert.ok(r.questions.every((q, i) => q.options.length === 4 && q.correct_index === (i + 1) % 4), 'every answer mapped');
    assert.ok(!r.questions.some((q) => /CONFIDENTIAL|Page \d/.test(JSON.stringify(q))), 'header/footer removed');
  });
  await t('PDF: questions with a key page at the end', async () => {
    const q = []; for (let i = 1; i <= 8; i++) q.push(`${i}. Item ${i}?`, 'A) one', 'B) two', 'C) three', 'D) four');
    const r = parseQuestions((await extractDocument({ originalname: 'k.pdf', buffer: await pdfOf([q.slice(0, 20), q.slice(20), ['ANSWER KEY', '1. A  2. B  3. C  4. D  5. A  6. B  7. C  8. D']]) })).text);
    assert.equal(r.questions.length, 8); assert.equal(summary(r), '4:A 4:B 4:C 4:D 4:A 4:B 4:C 4:D');
  });

  /* ---------------- Word files ---------------- */
  await t('DOCX: Word auto-numbering (1. / A)) is rebuilt, answers typed below', async () => {
    const items = [];
    [['Capital of India?', CAPITAL, 'B'], ['Largest planet?', ['Earth', 'Mars', 'Jupiter', 'Venus'], 'C']].forEach(([q, o, a]) => {
      items.push({ text: q, level: 0 }); o.forEach((x) => items.push({ text: x, level: 1 })); items.push({ text: `Answer: ${a}`, level: null });
    });
    const r = parseQuestions((await extractDocument({ originalname: 'a.docx', buffer: await docxOf(items) })).text);
    assert.equal(r.questions.length, 2); hasQ(r, 0, 'Capital of India', CAPITAL, 1); hasQ(r, 1, 'Largest planet', ['Earth', 'Mars', 'Jupiter', 'Venus'], 2);
  });
  await t('DOCX: typed numbering and an answer-key table', async () => {
    const items = [{ text: '1. First?', level: null }, { text: 'A) a', level: null }, { text: 'B) b', level: null }, { text: '2. Second?', level: null }, { text: 'A) p', level: null }, { text: 'B) q', level: null }];
    const r = parseQuestions((await extractDocument({ originalname: 'b.docx', buffer: await docxOf(items, [['1', 'B'], ['2', 'A']]) })).text);
    assert.equal(r.questions.length, 2); assert.equal(summary(r), '2:B 2:A');
  });

  /* ---------------- robustness ---------------- */
  await t('empty / junk input never throws', () => {
    for (const s of ['', '   \n\n', 'just some prose without any questions at all', '1.\n2.\n3.', 'A)\nB)']) {
      const r = parseQuestions(s); assert.equal(r.questions.length, 0);
    }
  });
  await t('very large bank parses quickly', () => {
    const L = []; for (let i = 1; i <= 2000; i++) L.push(`${i}. Question ${i}?`, 'A) a', 'B) b', 'C) c', 'D) d', `Answer: ${'ABCD'[i % 4]}`);
    const t0 = Date.now(); const r = parseQuestions(L.join('\n'));
    assert.equal(r.questions.length, 2000); assert.ok(Date.now() - t0 < 3000, 'under 3s');
  });

  /* ---------------- 4 options per question, questions never run into each other ---------------- */
  const SEVEN = [['What is the capital of India?', CAPITAL, 1], ['Which planet is the largest?', ['Earth', 'Mars', 'Jupiter', 'Venus'], 2], ['What is 12 + 15?', ['25', '26', '27', '28'], 2],
    ['The Sun rises in the?', ['East', 'West', 'North', 'South'], 0], ['Which gas do plants absorb?', ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Helium'], 1],
    ['Who wrote the national anthem?', ['Bankim Chandra', 'Rabindranath Tagore', 'Sarojini Naidu', 'Premchand'], 1], ['Days in a leap year?', ['364', '365', '366', '367'], 2]];
  const exactly7 = (r, label) => {
    assert.equal(r.questions.length, 7, `${label}: 7 questions (got ${r.questions.length})`);
    SEVEN.forEach(([stem, opts], i) => hasQ(r, i, stem, opts));
    assert.ok(r.questions.every((q) => q.options.length === 4), `${label}: every question has 4 options`);
    assert.ok(!r.warnings.some((w) => /exactly 4 options|unusually long/.test(w)), `${label}: no warnings`);
  };
  await t('a paper whose questions run together on ONE line is split into 7 separate questions', () => {
    exactly7(parseQuestions(SEVEN.map(([q, o], i) => `${i + 1}. ${q} ` + o.map((x, k) => `${'ABCD'[k]}. ${x}`).join(' ')).join(' ')), 'one line');
    exactly7(parseQuestions(SEVEN.map(([q, o], i) => `(${i + 1}) ${q} ` + o.map((x, k) => `(${'ABCD'[k]}) ${x}`).join(' ')).join(' ')), 'one line, (1) style');
  });
  await t('option styles: "A )", "(1) (2) (3) (4)", bare "A text", unnumbered, blank lines between', () => {
    exactly7(parseQuestions(SEVEN.map(([q, o], i) => `${i + 1} . ${q}\n` + o.map((x, k) => `${'ABCD'[k]} ) ${x}`).join('\n')).join('\n')), 'A )');
    exactly7(parseQuestions(SEVEN.map(([q, o], i) => `${i + 1}. ${q}\n` + o.map((x, k) => `(${k + 1}) ${x}`).join('\n')).join('\n')), '(1)-(4)');
    exactly7(parseQuestions(SEVEN.map(([q, o], i) => `${i + 1}. ${q}\n` + o.map((x, k) => `${'ABCD'[k]} ${x}`).join('\n')).join('\n')), 'bare letters');
    exactly7(parseQuestions(SEVEN.map(([q, o]) => `${q}\n` + o.map((x, k) => `(${'ABCD'[k]}) ${x}`).join('\n')).join('\n')), 'unnumbered');
    exactly7(parseQuestions(SEVEN.map(([q, o], i) => `${i + 1}. ${q}\n\n` + o.map((x, k) => `${'ABCD'[k]}) ${x}\n`).join('\n')).join('\n')), 'blank lines');
  });
  await t('the same stem repeated many times is NOT thrown away as a page header', () => {
    const r = parseQuestions(Array.from({ length: 6 }, (_, i) => `Which of the following is correct?\nA) option ${i}a\nB) option ${i}b\nC) option ${i}c\nD) option ${i}d`).join('\n'));
    assert.equal(r.questions.length, 6); assert.ok(r.questions.every((q) => /Which of the following is correct/.test(q.text) && q.options.length === 4));
  });
  await t('a question with fewer than 4 options is reported; there is never an option E', () => {
    const r = parseQuestions('1. One?\nA) a\nB) b\nC) c\nD) d\n2. Two?\nA) a\nB) b\nC) c\n3. Three?\nA) a\nB) b\nC) c\nD) d\nE) e');
    assert.ok(r.warnings.some((w) => /exactly 4 options/.test(w) && /Q2 \(3\)/.test(w)), r.warnings.join(' | '));
    assert.ok(r.questions.every((q) => q.options.length <= 4), 'no question ever has more than 4 options');
  });
  await t('"E:" data inside option D is part of option D, never a fifth option (all option styles, wrapped or not)', () => {
    const Q = 'In the recorded field coordinates table, what are the Northing (N), Easting (E), and Elevation (Z) of Point 1?';
    const opts = ['N: 2000.000 m, E: 1000.000 m, Z: 100.000 m', 'N: 2000.486 m, E: 987.762 m, Z: 101.912 m', 'N: 2007.435 m, E: 1004.678 m, Z: 101.647 m', 'N: 2012.388 m, E: 994.000 m, Z: 100.500 m'];
    const marks = { 'A)': (k) => 'ABCD'[k] + ')', 'A.': (k) => 'ABCD'[k] + '.', '(A)': (k) => '(' + 'ABCD'[k] + ')', 'A:': (k) => 'ABCD'[k] + ':' };
    for (const [name, mk] of Object.entries(marks)) for (const wrap of [false, true]) {
      const text = ['43. Which instrument measures angles?', ...['Chain', 'Theodolite', 'Tape', 'Level'].map((o, k) => `${mk(k)} ${o}`), '44. ' + Q,
        ...opts.map((o, k) => (wrap && k === 3 ? `${mk(k)} ${o.slice(0, o.indexOf(', E:') + 1)}\n${o.slice(o.indexOf(', E:') + 2)}` : `${mk(k)} ${o}`)),
        '45. Next question?', ...['a', 'b', 'c', 'd'].map((o, k) => `${mk(k)} ${o}`)].join('\n');
      const r = parseQuestions(text);
      assert.equal(r.questions.length, 3, `${name} wrap=${wrap}: 3 questions`);
      assert.ok(r.questions.every((q) => q.options.length === 4), `${name} wrap=${wrap}: 4 options each`);
      assert.equal(r.questions[1].options[3], opts[3], `${name} wrap=${wrap}: option D keeps its "E: ..." data`);
    }
  });

  /* ---------------- sections are not questions ---------------- */
  await t('section headings are ignored: only "1. question" + its options are read, then the key is mapped by number', () => {
    const paper = ['FUNDAMENTALS OF SURVEYING - MOCK TEST', 'General Instructions:', 'Each question carries one mark.',
      'SECTION A: Surveying Basics', 'Questions 1 - 2',
      '1. What is the capital of India?', 'A. Mumbai', 'B. New Delhi', 'C. Kolkata', 'D. Chennai',
      '2. Which planet is the largest?', 'A. Earth', 'B. Mars', 'C. Jupiter', 'D. Venus',
      'Section B - Total Station Operations (Q3-Q4)',
      '3. What is 12 + 15?', 'A. 25', 'B. 26', 'C. 27', 'D. 28',
      'Levelling and Contouring',
      '4. The Sun rises in the?', 'A. East', 'B. West', 'C. North', 'D. South',
      'PART II', '5. Which gas do plants absorb?', 'A. Oxygen', 'B. Carbon dioxide', 'C. Nitrogen', 'D. Helium',
      'ANSWER KEY', 'Q. No. Ans Q. No. Ans', '1 B 4 A', '2 C 5 B', '3 C'].join('\n');
    const r = parseQuestions(paper);
    assert.equal(r.questions.length, 5, 'exactly the 5 real questions');
    assert.ok(r.questions.every((q) => q.options.length === 4), 'each has 4 options');
    assert.ok(!r.questions.some((q) => /section|part ii|levelling|instructions|mock test|questions 1/i.test(q.text + ' ' + q.options.join(' '))), 'no heading text inside any question or option');
    assert.deepEqual(r.questions.map((q) => q.correct_index), [1, 2, 2, 0, 1], 'answers mapped by question number');
    assert.deepEqual(r.warnings, [], 'nothing to warn about');
  });
  await t('headings in other styles (unnumbered paper, Part/Unit/Module, wrapped option, answer on the next line) do not change the result', () => {
    const r = parseQuestions(['SECTION 1', 'Which gas is most abundant?', '(A) Oxygen', '(B) Nitrogen', '(C) Argon', '(D) Helium', 'Unit 3', 'Total station is used for', '(A) Angles', '(B) Colours', '(C) Weights', '(D) Time'].join('\n'));
    assert.equal(r.questions.length, 2); assert.ok(r.questions.every((q) => q.options.length === 4));
    assert.equal(r.questions[0].options[3], 'Helium'); assert.equal(r.questions[1].text, 'Total station is used for');
    const w = parseQuestions('1. Pick one\nA. red\nB. green\nC. blue\nD. Temporary Bench\nused for levelling\n2. Next\nA. a\nB. b\nC. c\nD. d');
    assert.equal(w.questions.length, 2); assert.equal(w.questions[0].options[3], 'Temporary Bench used for levelling', 'a wrapped option is still one option');
  });

  await t('a heading glued to a question line is cut off ("CALIBRATION (Q19 – Q32) 19. What ...")', () => {
    const r = parseQuestions(['18. What is the surveying method called when an unknown occupied station P is located by observing known points A, B, and C?', 'A) Triangulation', 'B) Resection', 'C) Traversing', 'D) Foresight Leveling',
      'CALIBRATION (Q19 – Q32) 19. What is the angular accuracy of the Kanq KQS-M65 Total Station used in training?', 'A) 1 second (1")', 'B) 2 seconds (2")', 'C) 5 seconds (5")', 'D) 10 seconds (10")',
      '20. What is checked in the two-peg test?', 'A) Level', 'B) Collimation', 'C) Plumb', 'D) Tape',
      'SECTION D: Traversing 21. What is a closed traverse?', 'A) a', 'B) b', 'C) c', 'D) d',
      'TRAVERSING 22. What is an open traverse?', 'A) a', 'B) b', 'C) c', 'D) Foresight Leveling CALIBRATION (Q23 – Q30)',
      '23. ISO 9001. The standard is for?', 'A) a', 'B) b', 'C) c', 'D) d'].join('\n'));
    assert.equal(r.questions.length, 6); assert.ok(r.questions.every((q) => q.options.length === 4));
    assert.equal(r.questions[1].text, 'What is the angular accuracy of the Kanq KQS-M65 Total Station used in training?');
    assert.equal(r.questions[3].text, 'What is a closed traverse?'); assert.equal(r.questions[4].text, 'What is an open traverse?');
    assert.equal(r.questions[4].options[3], 'Foresight Leveling', 'a heading stuck after the last option is removed');
    assert.equal(r.questions[5].text, 'ISO 9001. The standard is for?', 'ordinary text that merely contains a number is untouched');
    assert.ok(!r.questions.some((q) => /CALIBRATION|SECTION|TRAVERSING/.test(q.text + q.options.join(' '))), 'no heading text anywhere');
  });

  /* ---------------- all questions first, ANSWER KEY table at the end ---------------- */
  const KEY = ['A', 'A', 'B', 'D', 'B', 'A', 'B', 'B', 'A', 'B', 'C', 'B', 'A', 'B', 'C', 'B', 'A', 'B', 'B', 'B', 'B', 'B', 'B', 'C', 'B', 'B', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'A', 'C', 'A', 'A', 'B', 'A', 'B', 'B', 'B', 'B', 'B', 'A', 'A', 'B', 'B', 'B', 'B'];
  const PAPER50 = Array.from({ length: 50 }, (_, i) => `${i + 1}. Which statement number ${i + 1} about surveying is correct?\nA. Option A\nB. Option B\nC. Option C\nD. Option D`).join('\n');
  const rows10 = Array.from({ length: 10 }, (_, r) => [0, 1, 2, 3, 4].map((c) => c * 10 + r + 1));
  const DESC = 'Reference answer key for the 50 A questions on Fundamentals of Surveying & Kanq KQS-M65 Total Station Operations.';
  const keyCheck = (text, label) => {
    const r = parseQuestions(PAPER50 + '\n' + text);
    assert.equal(r.questions.length, 50, `${label}: 50 questions`);
    assert.ok(r.questions.every((q) => q.options.length === 4), `${label}: 4 options each`);
    const bad = r.questions.map((q, i) => (q.correct_index === 'ABCD'.indexOf(KEY[i]) ? 0 : i + 1)).filter(Boolean);
    assert.deepEqual(bad, [], `${label}: wrong/missing answers for Q${bad.join(',')}`);
  };
  await t('answer key table at the end: "Q. No. / Ans" in five column pairs (as in the screenshot)', () => {
    keyCheck(`ANSWER KEY (QUESTIONS 1 – 50)\n${DESC}\nQ. No. Ans Q. No. Ans Q. No. Ans Q. No. Ans Q. No. Ans\n` + rows10.map((r) => r.map((n) => `${n} ${KEY[n - 1]}`).join(' ')).join('\n'), 'picture');
  });
  await t('answer key table variants: one cell per line, one line, pipes, one pair per row, footer after', () => {
    keyCheck('ANSWER KEY (QUESTIONS 1 – 50)\n' + DESC + '\nQ. No.\nAns\n' + KEY.map((a, i) => `${i + 1}\n${a}`).join('\n'), 'cells');
    keyCheck('ANSWER KEY ' + DESC + ' Q. No. Ans ' + KEY.map((a, i) => `${i + 1} ${a}`).join(' '), 'one line');
    keyCheck('Answer Key\nQ.No | Answer\n' + KEY.map((a, i) => `${i + 1} | (${a.toLowerCase()})`).join('\n'), 'pipes');
    keyCheck('ANSWERS\n' + KEY.map((a, i) => (i % 2 ? `Q${i + 1} - ${a}` : `${i + 1}. ${a}`)).join('\n'), 'pairs');
    keyCheck('ANSWER KEY\n' + KEY.map((a, i) => `${i + 1} ${a}`).join('\n') + '\nPage 3 of 3\nwww.example.com', 'footer');
  });
  await t('PDF: 50 questions, then an ANSWER KEY page with a "Q. No. / Ans" grid', async () => {
    const buf = await new Promise((res) => {
      const d = new PDFDocument({ margin: 40 }); const b = []; d.on('data', (c) => b.push(c)); d.on('end', () => res(Buffer.concat(b)));
      for (let n = 1; n <= 50; n++) { if (d.y > 720) d.addPage(); d.text(`${n}. Which statement number ${n} about surveying is correct?`); ['A', 'B', 'C', 'D'].forEach((l) => d.text(`${l}. Option ${l}`, { indent: 14 })); d.moveDown(0.4); }
      d.addPage(); d.fontSize(14).text('ANSWER KEY (QUESTIONS 1 – 50)').moveDown(0.3); d.fontSize(10).text(DESC).moveDown();
      let y = d.y; const cell = (s, x, yy) => d.text(String(s), x, yy, { width: 46, lineBreak: false });
      for (let c = 0; c < 5; c++) { cell('Q. No.', 40 + c * 100, y); cell('Ans', 90 + c * 100, y); } y += 22;
      for (let r = 0; r < 10; r++) { for (let c = 0; c < 5; c++) { const q = c * 10 + r + 1; cell(q, 40 + c * 100, y); cell(KEY[q - 1], 90 + c * 100, y); } y += 22; }
      d.end();
    });
    const r = parseQuestions((await extractDocument({ originalname: 'bank.pdf', buffer: buf })).text);
    assert.equal(r.questions.length, 50); assert.ok(r.questions.every((q) => q.options.length === 4));
    assert.deepEqual(r.questions.map((q) => q.correct_index), KEY.map((a) => 'ABCD'.indexOf(a)), 'all 50 answers matched from the key table');
  });

  if (!process.exitCode) console.log(`PARSER TESTS PASSED (${n} checks)`);
  process.exit();
})();
