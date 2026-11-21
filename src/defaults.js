// Used whenever the admin leaves an exam's instructions blank. One instruction per line.
const DEFAULT_INSTRUCTIONS = [
  'Read each question and all its options carefully.',
  'Move between questions with Next / Previous or the question numbers; you can change answers until you submit.',
  'Unanswered questions score no marks.',
  'Do not refresh or close the browser, and do not take outside help.',
].join('\n');

// Earlier versions saved their (longer) standard text into the field when it was left blank; treat those as blank too.
const OLDER = [
  ['Read every question and all of its options carefully before choosing your answer.',
    'Each question has exactly one correct option. Select the option you believe is correct.',
    'You can move between questions with the Next / Previous buttons or the question numbers, and you can change an answer at any time before you submit.',
    'Unanswered questions carry no marks. Keep an eye on the timer and manage your time across all questions.',
    'Do not refresh, close or go back in the browser while the exam is running.',
    'Do not take help from any person, website, notes or device. Your attempt is monitored.',
    'When you have finished, click "Submit exam". The exam is also submitted automatically when the time is over.'].join('\n'),
];
OLDER.push(OLDER[0] + '\nYour result and the answer key are shown after you submit, and a copy is sent to your e-mail.');

/** Only the text the admin actually wrote. */
const customOnly = (t) => { const x = String(t || '').trim(); return x === DEFAULT_INSTRUCTIONS.trim() || OLDER.some((o) => o.trim() === x) ? '' : x; };

module.exports = { DEFAULT_INSTRUCTIONS, customOnly };
