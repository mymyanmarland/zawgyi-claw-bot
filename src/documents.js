// Document intake: user-sent PDF/DOCX/text files -> extracted text for the agent.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 10 * 1024 * 1024; // 10MB Telegram-side cap for docs
const MAX_TEXT_CHARS = 12000; // cap what we feed the model

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'log', 'json']);

function docDir(dataDir, tgId) {
  const d = path.join(dataDir, 'docs', String(tgId).replace(/[^0-9]/g, ''));
  fs.mkdirSync(d, { recursive: true });
  // prune older than 7 days
  try {
    const cutoff = Date.now() - 7 * 86400000;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
  return d;
}

function supportedExt(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return ext === 'pdf' || ext === 'docx' || TEXT_EXT.has(ext) ? ext : null;
}

async function saveTelegramDocument(botToken, dataDir, tgId, doc) {
  // doc: { file_id, file_name, mime_type, file_size }
  if ((doc.file_size || 0) > MAX_BYTES) throw new Error('too_big');
  const ext = supportedExt(doc.file_name);
  if (!ext) throw new Error('unsupported');
  const infoRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(doc.file_id)}`,
    { signal: AbortSignal.timeout(30000) }
  );
  const info = await infoRes.json();
  if (!info.ok || !info.result.file_path) throw new Error('getFile failed');
  const dl = await fetch(`https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`,
    { signal: AbortSignal.timeout(90000) });
  if (!dl.ok) throw new Error('download failed');
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too_big');
  const safeName = path.basename(doc.file_name).replace(/[^a-zA-Z0-9._\-\u1000-\u109F]/g, '_').slice(0, 80) || `file.${ext}`;
  const full = path.join(docDir(dataDir, tgId), `${Date.now()}_${safeName}`);
  fs.writeFileSync(full, buf);
  return { path: full, name: safeName, ext, bytes: buf.length };
}

async function extractText(file) {
  const buf = fs.readFileSync(file.path);
  let text = '';
  if (file.ext === 'pdf') {
    // pdfjs-dist directly: pdf-parse's bundled pdf.js fails on modern PDFs.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
    try {
      const pages = Math.min(doc.numPages, 50);
      const parts = [];
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        parts.push(tc.items.map((it) => it.str).join(' '));
        if (parts.join(' ').length > MAX_TEXT_CHARS + 2000) break;
      }
      text = parts.join('\n');
    } finally {
      try { await doc.destroy(); } catch (e) {}
    }
  } else if (file.ext === 'docx') {
    const mammoth = require('mammoth');
    const data = await mammoth.extractRawText({ buffer: buf });
    text = data.value || '';
  } else {
    text = buf.toString('utf8');
  }
  text = text.replace(/\r/g, '').trim();
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = text.slice(0, MAX_TEXT_CHARS);
  return { text, truncated };
}

module.exports = { saveTelegramDocument, extractText, supportedExt, MAX_BYTES };
