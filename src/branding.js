// Company logo: a built-in default (public/img/logo.png) that the admin can replace with the exact original file.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DIR = path.join(cfg.DATA_DIR, 'branding');
const DEFAULT = path.join(__dirname, '..', 'public', 'img', 'logo.png');
const EXTS = ['png', 'jpg'];

function customFile() {
  for (const e of EXTS) { const p = path.join(DIR, `logo.${e}`); if (fs.existsSync(p)) return p; }
  return null;
}
const logoFile = () => customFile() || DEFAULT;
const logoBuffer = () => fs.readFileSync(logoFile());
const isCustom = () => !!customFile();
const mime = (f) => (path.extname(f).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');

/** Save an uploaded PNG/JPEG as the company logo. Throws a friendly Error if it is not a usable image. */
function saveLogo(buf) {
  if (!buf || !buf.length) throw new Error('Choose a logo image to upload.');
  if (buf.length > 3 * 1024 * 1024) throw new Error('The logo is too large (maximum 3 MB).');
  const png = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpg) throw new Error('Please upload a PNG or JPG image (a PNG with a transparent background works best).');
  fs.mkdirSync(DIR, { recursive: true });
  resetLogo();
  fs.writeFileSync(path.join(DIR, `logo.${png ? 'png' : 'jpg'}`), buf);
}
function resetLogo() { for (const e of EXTS) { try { fs.unlinkSync(path.join(DIR, `logo.${e}`)); } catch (_) { /* not there */ } } }

module.exports = { logoFile, logoBuffer, isCustom, mime, saveLogo, resetLogo };
