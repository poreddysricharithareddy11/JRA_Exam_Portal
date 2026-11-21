// pdf.js is an ES module; load it once (from CommonJS) with safe defaults.
const path = require('path');
let loading = null;
const load = () => loading || (loading = import('pdfjs-dist/legacy/build/pdf.mjs'));
const { pathToFileURL } = require('url');
const fontsDir = pathToFileURL(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')).href.replace(/\/?$/, '/');

/** Open a PDF from a Buffer. isEvalSupported:false is the recommended hardening for untrusted files. */
async function openPdf(buffer) {
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false, verbosity: 0, standardFontDataUrl: fontsDir });
  const doc = await task.promise;
  if (typeof doc.destroy !== 'function') doc.destroy = () => task.destroy();   // releases the document + worker
  return { pdfjs, doc };
}
module.exports = { openPdf };
