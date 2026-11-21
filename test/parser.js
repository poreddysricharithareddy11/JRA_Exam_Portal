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

  if (!process.exitCode) console.log(`PARSER TESTS PASSED (${n} checks)`);
  process.exit();
})();
