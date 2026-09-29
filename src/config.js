// Central config from environment.
const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env: ${name}`);
  return v;
};

module.exports = {
  port: parseInt(process.env.PORT || '3012', 10),
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  ownerId: process.env.TELEGRAM_OWNER_ID || '',
  masterKey: required('ZAWGYI_MASTER_KEY', undefined), // 64-hex chars (32 bytes)
  dataDir: process.env.DATA_DIR || './data',
  dailyLimit: parseInt(process.env.DAILY_LIMIT || '100', 10),
  botName: 'Zaw Gyi',
  botEmoji: '🧙‍♂️',
};
