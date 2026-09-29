// Photo handling: download Telegram photos, serve as data URLs for vision models.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;      // refuse downloads larger than this
const DATAURL_MAX = 4 * 1024 * 1024;    // skip re-attaching images bigger than this to history
const RETENTION_MS = 7 * 86400000;      // delete photos older than 7 days

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

function photoDir(dataDir) {
  const d = path.join(dataDir, 'photos');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function pruneOld(dataDir) {
  try {
    const d = photoDir(dataDir);
    const cutoff = Date.now() - RETENTION_MS;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}

// Low-level: resolve a Telegram file_id and download its bytes.
async function downloadTelegramFile(botToken, fileId, maxBytes) {
  const metaRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(20000) }
  );
  const meta = await metaRes.json().catch(() => ({}));
  if (!meta.ok || !meta.result || !meta.result.file_path) {
    throw new Error('Telegram getFile failed');
  }
  if (meta.result.file_size && meta.result.file_size > maxBytes) {
    throw new Error('too_big');
  }
  const ext = (path.extname(meta.result.file_path) || '.bin').toLowerCase();
  const dl = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${meta.result.file_path}`,
    { signal: AbortSignal.timeout(60000) }
  );
  if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status}`);
  const buffer = Buffer.from(await dl.arrayBuffer());
  if (buffer.length > maxBytes || buffer.length === 0) throw new Error('too_big');
  return { buffer, ext };
}

// Download a Telegram file_id into dataDir/photos, return the stored filename.
async function saveTelegramPhoto(botToken, dataDir, tgId, fileId) {
  const { buffer, ext } = await downloadTelegramFile(botToken, fileId, MAX_BYTES);
  const name = `${tgId}_${Date.now()}${MIME[ext] ? ext : '.jpg'}`;
  fs.writeFileSync(path.join(photoDir(dataDir), name), buffer);
  pruneOld(dataDir);
  return name;
}

// Read a stored photo back as a data: URL for the model. Null when missing/too big.
function photoDataUrl(dataDir, filename) {
  try {
    const p = path.join(photoDir(dataDir), path.basename(filename));
    const st = fs.statSync(p);
    if (st.size > DATAURL_MAX || st.size === 0) return null;
    const mime = MIME[path.extname(p).toLowerCase()] || 'image/jpeg';
    return `data:${mime};base64,` + fs.readFileSync(p).toString('base64');
  } catch (e) {
    return null;
  }
}

module.exports = { saveTelegramPhoto, photoDataUrl, photoDir, downloadTelegramFile, MAX_BYTES };
