// Rules for files teachers attach to learning materials.
//
// Files are stored in the database (as base64 text) rather than on disk, so
// they survive on hosts with no persistent disk (e.g. Render's free plan)
// and work the same with local SQLite or a hosted Turso database.
//
// Safety: only the file types below are accepted; the type is decided by
// the file extension AND checked against the file's real first bytes, so
// renaming something dangerous (e.g. an .html page) to .pdf is rejected.
// SVG and HTML are deliberately NOT allowed because they can carry scripts.
const path = require('path');

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 3;
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const isZip = buf => startsWith(buf, [0x50, 0x4b, 0x03, 0x04]);
const isOle = buf => startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0]);
const isText = buf => !buf.subarray(0, 4096).includes(0);

// ext -> { mime, inline (open in the browser), check (magic-byte test) }
const ALLOWED = {
  pdf:  { mime: 'application/pdf', inline: true,  check: b => startsWith(b, [0x25, 0x50, 0x44, 0x46]) },
  png:  { mime: 'image/png',       inline: true,  check: b => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  jpg:  { mime: 'image/jpeg',      inline: true,  check: b => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg',      inline: true,  check: b => startsWith(b, [0xff, 0xd8, 0xff]) },
  gif:  { mime: 'image/gif',       inline: true,  check: b => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  webp: { mime: 'image/webp',      inline: true,  check: b => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8) },
  doc:  { mime: 'application/msword', inline: false, check: isOle },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false, check: isZip },
  xls:  { mime: 'application/vnd.ms-excel', inline: false, check: isOle },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false, check: isZip },
  ppt:  { mime: 'application/vnd.ms-powerpoint', inline: false, check: isOle },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', inline: false, check: isZip },
  txt:  { mime: 'text/plain; charset=utf-8', inline: false, check: isText },
  csv:  { mime: 'text/csv; charset=utf-8',   inline: false, check: isText },
};

function cleanFileName(name) {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f"\\\/<>:*?|]/g, '_').trim();
  return base.slice(-120) || 'file';
}

// Validates an upload sent as { name, data } (data = base64, optionally a
// data: URL). Returns { fileName, mimeType, size, dataB64, inline } or
// throws an Error with a message that is safe to show to the teacher.
function validateUpload(file) {
  if (!file || typeof file !== 'object' || !file.name || !file.data) {
    throw new Error('The file could not be read. Please choose it again.');
  }
  const fileName = cleanFileName(file.name);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const rule = ALLOWED[ext];
  if (!rule) {
    throw new Error(`That file type isn't allowed. Allowed: ${Object.keys(ALLOWED).join(', ')}.`);
  }
  const b64 = String(file.data).replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error('The file could not be read. Please choose it again.');
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('That file is empty.');
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`That file is too large. The limit is ${MAX_UPLOAD_MB} MB.`);
  }
  if (!rule.check(buf)) {
    throw new Error(`That file doesn't look like a real .${ext} file.`);
  }
  return { fileName, mimeType: rule.mime, size: buf.length, dataB64: buf.toString('base64'), inline: rule.inline };
}

module.exports = { ALLOWED, MAX_UPLOAD_MB, MAX_UPLOAD_BYTES, validateUpload };
