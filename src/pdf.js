const PDFDocument = require('pdfkit');
const cfg = require('./config');
const { review, LETTERS } = require('./service');
const branding = require('./branding');

const GREEN = '#15803d', RED = '#b91c1c', INK = '#111827', MUTE = '#6b7280';

function fmt(d) { return d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : '-'; }

/** Builds the result PDF for a submitted attempt and resolves to a Buffer. */
async function buildResultPdf(attemptId, preloaded) {
  const data = preloaded || await review(attemptId);
  if (!data) throw new Error('Attempt not found');
  const { attempt: a, questions } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width, L = 40, R = W - 40, CW = R - L;

    // company logo: faint watermark behind every page, small logo top-left of the first page
    let logo = null; try { logo = branding.logoBuffer(); } catch (_) { /* no logo: skip */ }
    const watermark = () => { if (!logo) return; doc.save(); doc.opacity(0.07); doc.image(logo, (doc.page.width - 380) / 2, (doc.page.height - 380) / 2, { fit: [380, 380] }); doc.restore(); };
    doc.on('pageAdded', watermark);
    watermark();
    const HX = logo ? L + 64 : L;                 // header text starts after the logo
    if (logo) doc.image(logo, L, 36, { fit: [54, 54] });

    // Header (left) + marks box (top-right corner)
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(a.exam_name, HX, 40, { width: CW - 170 - (HX - L) });
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTE);
    doc.text(cfg.PORTAL_NAME, HX, doc.y + 2, { width: CW - 170 - (HX - L) });
    doc.fillColor(INK).text(`Candidate: ${a.full_name || a.username} (${a.username})`, { width: CW - 170 - (HX - L) });
    doc.text(`Submitted: ${fmt(a.submitted_at)}`, { width: CW - 170 - (HX - L) });
    doc.text(`Question set: ${a.set_name}   |   Submission: ${{ manual: 'By candidate', time_up: 'Time up (auto)', violation: 'Proctoring violation (auto)' }[a.submit_reason] || a.submit_reason}`, { width: CW - 170 - (HX - L) });
    const leftEnd = doc.y;

    const bx = R - 150, by = 40, bw = 150, bh = 78;
    doc.roundedRect(bx, by, bw, bh, 6).lineWidth(1.5).strokeColor(a.passed ? GREEN : RED).stroke();
    doc.fillColor(MUTE).font('Helvetica').fontSize(8).text('MARKS OBTAINED', bx, by + 8, { width: bw, align: 'center' });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(`${a.score} / ${a.total}`, bx, by + 21, { width: bw, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(`${a.percent}%  •  Pass mark ${a.pass_percent}%`, bx, by + 50, { width: bw, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(a.passed ? GREEN : RED).text(a.passed ? 'PASSED' : 'FAILED', bx, by + 63, { width: bw, align: 'center' });

    doc.y = Math.max(leftEnd, by + bh) + 10;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
      .text(`Correct: ${a.correct}    Wrong: ${a.wrong}    Unanswered: ${a.unanswered}` + (a.negative_marks ? `    Negative marking: -${a.negative_marks} per wrong answer` : ''), L, doc.y);
    doc.moveDown(0.4);
    doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.7).strokeColor('#d1d5db').stroke();
    doc.moveDown(0.8);

    for (const q of questions) {
      if (doc.y > doc.page.height - 150) doc.addPage();
      const tag = q.result === 'bonus' ? ['Marks awarded to all', '#b45309'] : q.result === 'correct' ? ['Correct', GREEN] : q.result === 'wrong' ? ['Wrong', RED] : ['Not answered', MUTE];
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(`Q${q.position}. ${q.text}`, L, doc.y, { width: CW - 90, continued: false });
      const qy = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(tag[1]).text(`${tag[0]}  (${q.marks} mark${q.marks === 1 ? '' : 's'})`, R - 90, qy - 13, { width: 90, align: 'right' });
      doc.y = qy + 3;
      q.options.forEach((opt, i) => {
        if (doc.y > doc.page.height - 70) doc.addPage();
        const isCorrect = i === q.correct_index, isSel = i === q.selected_index;
        let color = INK, note = '', font = 'Helvetica';
        if (isCorrect) { color = GREEN; font = 'Helvetica-Bold'; note = isSel ? '   (Your answer - correct)' : '   (Correct answer)'; }
        else if (isSel) { color = RED; font = 'Helvetica-Bold'; note = '   (Your answer)'; }
        doc.font(font).fontSize(10).fillColor(color).text(`${LETTERS[i]}.  ${opt}${note}`, L + 16, doc.y, { width: CW - 16 });
      });
      doc.moveDown(0.9);
    }

    // Footers are drawn in the bottom margin. pdfkit adds a new (blank) page whenever text is written below the
    // margin, so the margin is lifted while each footer is drawn and restored afterwards.
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor(MUTE)
        .text(`${cfg.PORTAL_NAME}  |  Page ${i + 1} of ${pages.count}`, L, doc.page.height - 30, { width: CW, align: 'center', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

module.exports = { buildResultPdf };
