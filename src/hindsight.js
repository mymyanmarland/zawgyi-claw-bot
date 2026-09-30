// Hindsight long-term memory integration.
//
// Adds a learning memory layer on top of the bot's existing short-term
// (last-20 messages) and explicit-fact (remember_fact) memory:
//   - recall: before each turn, fetch semantically relevant memories for this
//     user's bank and inject them into the system prompt (only what's relevant,
//     instead of dumping every fact every time).
//   - retain: after each turn, store the exchange asynchronously; Hindsight
//     extracts facts/entities itself, so the agent no longer has to remember
//     to call remember_fact.
//
// Everything here is fail-open: any Hindsight error (server down, timeout,
// missing npm package) is logged once and the bot continues without it.
// Toggle with HINDSIGHT_ENABLED=1.
const config = require('./config');

let client = null;
let promptStringFn = null;
let warned = false;

function enabled() {
  return config.hindsightEnabled === true && !!config.hindsightUrl;
}

function getClient() {
  if (!enabled()) return null;
  if (!client) {
    try {
      const mod = require('@vectorize-io/hindsight-client');
      client = new mod.HindsightClient({ baseUrl: config.hindsightUrl });
      promptStringFn = mod.recallResponseToPromptString;
    } catch (e) {
      warnOnce(e, 'load client');
      return null;
    }
  }
  return client;
}

// One isolated memory bank per Telegram user.
function bankId(tgId) {
  return `tg-${tgId}`;
}

function warnOnce(e, what) {
  if (!warned) {
    warned = true;
    console.error(`[hindsight] ${what} — continuing without Hindsight:`, e && e.message);
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms)),
  ]);
}

// Recall memories relevant to the current user message.
// Returns a prompt-ready string ('' when disabled/empty/failed).
async function recallForPrompt(tgId, query) {
  const c = getClient();
  if (!c) return '';
  const text = (query || '').trim();
  if (text.length < 4) return ''; // skip greetings / stickers / noise
  try {
    const res = await withTimeout(
      c.recall(bankId(tgId), text, { budget: 'low', maxTokens: 1200 }),
      9000,
      'recall'
    );
    const s = promptStringFn ? promptStringFn(res) : '';
    return s && s.trim() ? s.trim() : '';
  } catch (e) {
    warnOnce(e, 'recall');
    return '';
  }
}

// Fire-and-forget: retain this turn's exchange for future recall.
// Never throws; never blocks the reply path.
function retainTurn(tgId, userText, assistantText) {
  const c = getClient();
  if (!c) return;
  const u = (userText || '').trim();
  const a = (assistantText || '').trim().slice(0, 2000);
  if ((u + a).length < 8) return;
  // async:true — the server queues extraction in the background.
  c.retain(bankId(tgId), `user: ${u}\nassistant: ${a}`, {
    async: true,
    context: 'telegram chat',
    metadata: { source: 'zawgyi-claw-bot' },
  }).catch((e) => warnOnce(e, 'retain'));
}

// Delete a user's whole Hindsight memory bank (user data removal).
// Returns true on success, false when disabled or failed.
async function forgetAll(tgId) {
  const c = getClient();
  if (!c) return false;
  try {
    await withTimeout(c.deleteBank(bankId(tgId)), 15000, 'deleteBank');
    return true;
  } catch (e) {
    warnOnce(e, 'deleteBank');
    return false;
  }
}

module.exports = { enabled, bankId, recallForPrompt, retainTurn, forgetAll };
