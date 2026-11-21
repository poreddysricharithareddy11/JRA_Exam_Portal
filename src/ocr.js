// OCR for scanned PDFs and photographed question papers (English). Fully offline: the language data ships in
// node_modules (@tesseract.js-data/eng) and the engine is WebAssembly, so nothing is downloaded at run time.
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const MAX_PAGES = 30;
const MIN_IMAGE_AREA = 120000;   // ignore logos / icons

/* ---- minimal PNG encoder (8-bit greyscale) so raw pixels can be handed to Tesseract ---- */
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function pngGray(width, height, gray) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width + 1)] = 0; Buffer.from(gray.buffer, gray.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** pdf.js image object -> 8-bit greyscale bytes */
function toGray(img) {
  const { width: w, height: h, data, kind } = img;
  const out = new Uint8Array(w * h);
  if (kind === 1) {                                   // 1 bit per pixel, rows padded to bytes
    const stride = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
  } else {
    const bpp = kind === 2 ? 3 : 4;                   // RGB or RGBA
    for (let i = 0, p = 0; i < out.length; i++, p += bpp) out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return { w, h, gray: out };
}

let worker = null;
async function getWorker() {
  if (worker) return worker;
  const { createWorker } = require('tesseract.js');
  const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  worker = await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none', cachePath: os.tmpdir(), logger: () => {} });
  return worker;
}
async function closeWorker() { if (worker) { const w = worker; worker = null; try { await w.terminate(); } catch (_) { /* already gone */ } } }

let queue = Promise.resolve();            // OCR is CPU-heavy: one document at a time
const serial = (fn) => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };

/** Recognise text in an encoded image (PNG/JPEG/...) buffer. */
function ocrImage(buffer) {
  return serial(async () => {
    try { const w = await getWorker(); const { data } = await w.recognize(buffer); return data.text || ''; }
    finally { /* keep the worker warm for the next page; closed by closeWorkerSoon */ closeWorkerSoon(); }
  });
}
let idle = null;
function closeWorkerSoon() { clearTimeout(idle); idle = setTimeout(closeWorker, 60000); idle.unref(); }

/** OCR every page image of a PDF that has no text layer. Returns { text, pages }. */
async function ocrPdf(pdfBuffer) {
  const { pdfjs, doc } = await require('./pdfjs').openPdf(pdfBuffer);
  const texts = [];
  try {
    const n = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const name = ops.argsArray[i][0];
        const img = await new Promise((res) => (name.startsWith('g_') ? page.commonObjs : page.objs).get(name, res));
        if (!img || !img.data || img.width * img.height < MIN_IMAGE_AREA) continue;
        const { w, h, gray } = toGray(img);
        texts.push(await ocrImage(pngGray(w, h, gray)));
      }
    }
    return { text: texts.join('\n'), pages: Math.min(doc.numPages, MAX_PAGES), truncated: doc.numPages > MAX_PAGES };
  } finally { await doc.destroy(); }
}

module.exports = { ocrPdf, ocrImage, closeWorker };
