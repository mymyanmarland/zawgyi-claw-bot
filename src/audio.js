// Voice messages: download Telegram audio and transcribe locally with faster-whisper.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { downloadTelegramFile } = require('./photos');

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const RETENTION_MS = 7 * 86400000;
const WHISPER_PYTHON = process.env.WHISPER_PYTHON || '/opt/whisper/venv/bin/python';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');

function audioDir(dataDir) {
  const d = path.join(dataDir, 'audio');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function whisperAvailable() {
  try {
    return fs.existsSync(WHISPER_PYTHON) && fs.existsSync(TRANSCRIBE_SCRIPT);
  } catch (e) {
    return false;
  }
}

function pruneOldAudio(dataDir) {
  try {
    const d = audioDir(dataDir);
    const cutoff = Date.now() - RETENTION_MS;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}

async function saveTelegramAudio(botToken, dataDir, tgId, fileId) {
  const { buffer, ext } = await downloadTelegramFile(botToken, fileId, MAX_AUDIO_BYTES);
  const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.ogg';
  const name = `${tgId}_${Date.now()}${safeExt}`;
  fs.writeFileSync(path.join(audioDir(dataDir), name), buffer);
  pruneOldAudio(dataDir);
  return name;
}

// Returns { text, language } — text may be '' when nothing was heard.
function transcribeAudio(dataDir, filename) {
  return new Promise((resolve, reject) => {
    const file = path.join(audioDir(dataDir), path.basename(filename));
    const env = { ...process.env, WHISPER_MODEL };
    const p = spawn(WHISPER_PYTHON, [TRANSCRIBE_SCRIPT, file], { env, timeout: 300000 });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error('whisper spawn failed: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('transcribe failed: ' + err.slice(-300)));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error('bad transcribe output'));
      }
    });
  });
}

module.exports = { saveTelegramAudio, transcribeAudio, whisperAvailable, audioDir };
