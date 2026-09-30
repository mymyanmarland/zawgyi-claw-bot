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
  // Free trial for users WITHOUT their own /setapi key: LIFETIME quotas
  // (not per-day), funded by the owner's key. Once exhausted, they must
  // add their own API key via /setapi to continue.
  freeChatLimit: parseInt(process.env.FREE_CHAT_LIMIT || '50', 10),
  freeImagineLimit: parseInt(process.env.FREE_IMAGINE_LIMIT || '5', 10),
  braveSearchKey: process.env.BRAVE_SEARCH_API_KEY || '', // optional: Brave Search API (paid, $5/mo credits) as search backend
  serperKey: process.env.SERPER_API_KEY || '', // optional: Serper Google API (free 2500 queries, no card) as search backend
  botName: 'Zaw Gyi',
  botEmoji: '🧙‍♂️',
  // Hindsight long-term memory (optional, fail-open). Server runs on the VPS
  // at 127.0.0.1:8888; set HINDSIGHT_ENABLED=1 to turn recall/retain on.
  hindsightUrl: process.env.HINDSIGHT_URL || 'http://127.0.0.1:8888',
  hindsightEnabled: process.env.HINDSIGHT_ENABLED === '1',
  // AI image generation via relay (grok-imagine-image). Owner's key, per-user daily cap.
  imagineKey: process.env.RELAY_IMAGE_KEY || '',
  imagineBase: process.env.RELAY_IMAGE_BASE || 'https://sapi.zly168.cn/v1',
  imagineModel: process.env.RELAY_IMAGE_MODEL || 'grok-imagine-image-2.0',
  imagineDailyLimit: parseInt(process.env.IMAGINE_DAILY_LIMIT || '10', 10),
};
