// AES-256-GCM encryption for user API keys. Key never leaves the server.
const crypto = require('crypto');

function getKey(masterHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(masterHex || '')) {
    throw new Error('ZAWGYI_MASTER_KEY must be 64 hex chars (32 bytes)');
  }
  return Buffer.from(masterHex, 'hex');
}

function encrypt(plaintext, masterHex) {
  const key = getKey(masterHex);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm$${iv.toString('hex')}$${tag.toString('hex')}$${enc.toString('hex')}`;
}

function decrypt(payload, masterHex) {
  const key = getKey(masterHex);
  const parts = (payload || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'gcm') throw new Error('bad payload');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const enc = Buffer.from(parts[3], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function maskKey(key) {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

module.exports = { encrypt, decrypt, maskKey };
