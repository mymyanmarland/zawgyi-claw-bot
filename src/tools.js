// Agent tools. Safe for SaaS: no shell, no arbitrary filesystem. Read-only web + memory + sandboxed file outbox.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');

// --- send_file: agent-created attachments (per-user sandboxed outbox) ---
const OUTBOX_TTL_MS = 7 * 86400000;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILES_PER_TURN = 3;
const ALLOWED_EXT = new Set(['txt', 'md', 'csv', 'json', 'html', 'log']);

function outboxDir(tgId) {
  const d = path.join(config.dataDir, 'outbox', String(tgId).replace(/[^0-9]/g, ''));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function pruneOutbox(tgId) {
  try {
    const dir = outboxDir(tgId);
    const cutoff = Date.now() - OUTBOX_TTL_MS;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}

function safeFilename(raw) {
  let n = String(raw || 'file.txt').trim().slice(0, 60) || 'file.txt';
  // allow letters, digits, Myanmar script, dot, dash, underscore; everything else -> _
  n = n.replace(/[^a-zA-Z0-9._\-\u1000-\u109F]/g, '_').replace(/_+/g, '_');
  n = n.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!n) n = 'file.txt';
  const ext = path.extname(n).slice(1).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) n = n.replace(/\.[^.]*$/, '') + '.txt';
  if (!path.extname(n)) n += '.txt';
  return n;
}

function createOutboxFile(tgId, filename, content) {
  const text = String(content || '');
  if (!text.trim()) return { error: 'empty' };
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { error: 'too_big' };
  const dir = outboxDir(tgId);
  pruneOutbox(tgId);
  const name = safeFilename(filename);
  // avoid collisions within the outbox
  let finalName = name, i = 1;
  while (fs.existsSync(path.join(dir, finalName)) && i < 100) {
    const ext = path.extname(name), base = path.basename(name, ext);
    finalName = `${base}_${i}${ext}`;
    i++;
  }
  const full = path.join(dir, finalName);
  fs.writeFileSync(full, text, 'utf8');
  return { path: full, name: finalName, bytes: Buffer.byteLength(text, 'utf8') };
}

const { validateBaseUrl } = require('./ssrf');

// --- web_search: DuckDuckGo HTML via the www subdomain ---
// NOTE: html.duckduckgo.com serves this server's IP a bot-check page (HTTP 202,
// "anomaly-modal"), while duckduckgo.com/html/ returns real results. Do not switch back.
const SEARCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_SEARCH_RESULTS = 8;

function decodeEntities(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function unwrapDdg(href) {
  // DDG wraps result links: //duckduckgo.com/l/?uddg=<encoded> or /l/?uddg=<encoded>
  const w = href.match(/(?:^|\/)l\/\?uddg=([^&]+)/);
  if (w) { try { return decodeURIComponent(w[1]); } catch { /* keep original */ } }
  return href;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Serper: Google results via API, free 2500 queries on signup (no card) ---
async function serperSearch(query) {
  const key = config.serperKey;
  if (!key) return null;
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: MAX_SEARCH_RESULTS }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('serper ' + res.status);
  const j = await res.json();
  const items = (j && j.organic) || [];
  const out = [];
  for (const r of items) {
    const title = String(r.title || '').slice(0, 150);
    const link = String(r.link || '');
    const snippet = String(r.snippet || '').slice(0, 250);
    if (title && /^https?:\/\//i.test(link)) out.push({ title, url: link, snippet });
    if (out.length >= MAX_SEARCH_RESULTS) break;
  }
  return out;
}

// --- Brave Search API: independent index, used when BRAVE_SEARCH_API_KEY is set ---
async function braveSearch(query) {
  const key = config.braveSearchKey;
  if (!key) return null;
  const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) +
    '&count=' + MAX_SEARCH_RESULTS + '&safesearch=moderate&text_decorations=false';
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('brave ' + res.status);
  const j = await res.json();
  const items = (j && j.web && j.web.results) || [];
  const out = [];
  for (const r of items) {
    const title = String(r.title || '').slice(0, 150);
    const link = String(r.url || '');
    const snippet = String(r.description || '').slice(0, 250);
    if (title && /^https?:\/\//i.test(link)) out.push({ title, url: link, snippet });
    if (out.length >= MAX_SEARCH_RESULTS) break;
  }
  return out;
}

function formatResults(results) {
  return results.map((r, n) => `${n + 1}. ${r.title}\n   ${r.snippet || ''}\n   ${r.url}`).join('\n\n');
}

async function ddgHtmlFetch(q) {
  const url = 'https://duckduckgo.com/html/?q=' + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { 'User-Agent': SEARCH_UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('search failed: ' + res.status);
  return res.text();
}

async function webSearch(query) {
  const q = (query || '').trim();
  if (!q) return '❌ ရှာမယ့် စကားလုံး မပါဘူး။';
  // Backend 1: Serper (Google results, free 2500 queries) when a key is configured.
  try {
    const s = await serperSearch(q);
    if (s && s.length) return formatResults(s);
  } catch (e) { /* fall through */ }
  // Backend 2: Brave Search API (own index) when a key is configured.
  try {
    const b = await braveSearch(q);
    if (b && b.length) return formatResults(b);
  } catch (e) { /* fall through to DuckDuckGo */ }
  // Backend 2: DuckDuckGo HTML (free, no key).
  // DDG sometimes serves a bot-check page (anomaly-modal) to server IPs.
  // It is transient — retry with backoff instead of giving up.
  let html = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      html = await ddgHtmlFetch(q);
    } catch (e) {
      html = null;
      if (attempt < 2) { await sleep(3000 * (attempt + 1)); continue; }
      return '❌ ရှာဖွေမှု ချိတ်ဆက်မရပါ။ web_search ကို စကားလုံးပြောင်းပြီး ထပ်ခေါ်ကြည့်ပါ။';
    }
    if (/anomaly-modal/i.test(html)) {
      html = null;
      if (attempt < 2) { await sleep(4000 * (attempt + 1)); continue; }
      return '❌ ရှာဖွေမှု ခဏတာ အဆင်မပြေပါ (rate limit)။ web_search ကို စကားလုံးပြောင်းပြီး ထပ်ခေါ်ကြည့်ပါ။';
    }
    break;
  }
  if (!html) return '❌ ရှာဖွေမှု ခဏတာ အဆင်မပြေပါ။ web_search ကို ထပ်ခေါ်ကြည့်ပါ။';
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < MAX_SEARCH_RESULTS) {
    const href = unwrapDdg(m[1].replace(/&amp;/g, '&'));
    const title = decodeEntities(m[2]).slice(0, 150);
    if (/^https?:\/\//i.test(href) && title) results.push({ title, url: href });
  }
  const re2 = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  while ((m = re2.exec(html)) && i < results.length) {
    results[i].snippet = decodeEntities(m[1]).slice(0, 250);
    i++;
  }
  if (!results.length) return 'ရှာမတွေ့ပါ။ (စကားလုံးပြောင်းပြီး ထပ်စမ်းကြည့်ပါ)';
  return formatResults(results);
}

// --- open_link: fetch a search result page as readable text ---
const MAX_PAGE_BYTES = 300 * 1024;
const MAX_PAGE_TEXT = 6000;

function htmlToText(html) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  const title = (t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1].trim();
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t).replace(/\s+/g, ' ').trim();
  return { title: title ? decodeEntities(title).slice(0, 150) : '', text: t };
}

async function openLink(rawUrl) {
  const u = (rawUrl || '').trim();
  if (!u) return '❌ link မပါဘူး။';
  const err = await validateBaseUrl(u);
  if (err) return '❌ ' + err;
  try {
    const res = await fetch(u, {
      headers: { 'User-Agent': SEARCH_UA, 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return `❌ စာမျက်နှာ ဖွင့်မရပါ (HTTP ${res.status})။`;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|application\/xhtml/.test(ct)) {
      return `❌ HTML စာမျက်နှာ မဟုတ်ပါ (${ct || 'unknown type'})။`;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const html = buf.slice(0, MAX_PAGE_BYTES).toString('utf8');
    const { title, text } = htmlToText(html);
    if (!text) return '❌ စာမျက်နှာမှာ ဖတ်စရာ စာသား မတွေ့ပါ။';
    const clipped = text.length > MAX_PAGE_TEXT ? text.slice(0, MAX_PAGE_TEXT) + '…' : text;
    return (title ? `📄 ${title}\n` : '') + clipped;
  } catch (e) {
    return '❌ စာမျက်နှာ ဖွင့်မရပါ: ' + (e.name === 'TimeoutError' ? 'အချိန်ကုန်' : e.message);
  }
}

function getTime() {
  const fmt = new Intl.DateTimeFormat('my-MM', {
    timeZone: 'Asia/Yangon', dateStyle: 'full', timeStyle: 'short',
  });
  return fmt.format(new Date()) + ' (Asia/Yangon)';
}

// OpenAI function-calling schemas
const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web across multiple search sources for current/news information. Returns up to 8 results with title, snippet and URL. Use when the user asks about recent events, prices, weather, links, or anything you might not know. If results are thin, retry with different query wording. If you get a rate-limit/connection error, call web_search again with a reworded query — never tell the user search is unavailable without retrying first.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_link',
      description: 'Open a URL from web_search results and read its page content as text (up to ~6000 characters). Use to get real details from the most promising 2-3 search results before answering. Only http(s) public pages; internal/private addresses are blocked.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s) URL to open' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'Get the current date and time in Myanmar (Asia/Yangon).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save a durable fact about the user for future conversations (name, preferences, etc.). Only for clear, lasting facts.',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'The fact in Burmese or English' } },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_fact',
      description: 'Remove a saved fact matching the given text.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to match against saved facts' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_cron',
      description: 'Create a RECURRING scheduled reminder (cron job) that fires repeatedly. Convert the user\'s natural-language schedule into a cron expression "minute hour day month weekday" (Asia/Yangon timezone). Examples: daily 8am -> "0 8 * * *", every Monday 9am -> "0 9 * * 1", every 30 minutes -> "*/30 * * *", daily 10pm -> "0 22 * * *", 1st of month -> "0 9 1 * *". Use for "every day", "weekly", "remind me regularly" requests.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Cron expression, e.g. "0 8 * * *"' },
          text: { type: 'string', description: 'Reminder message to send each time' },
        },
        required: ['expression', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_crons',
      description: 'List the user\'s recurring scheduled reminders (cron jobs).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_cron',
      description: 'Delete a recurring scheduled reminder by its id (see list_crons).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'number', description: 'Cron job id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_file',
      description: 'Create a TEXT file and send it to the user as a Telegram document attachment. Use when the user asks for a file ("file လုပ်ပေး", "txt အဖြစ်ပို့", "စာရင်းကို file နဲ့ပို့"). The file content must be plain text (notes, lists, tables as CSV, reports in Markdown). Max ~200KB per file.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File name, e.g. "shopping-list.txt" or "report.md"' },
          content: { type: 'string', description: 'Full text content of the file' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an AI image from a text prompt and send it to the user as a photo. Use when the user asks for a picture/image ("ပုံထုတ်ပေး", "ပုံဆွဲပေး", "draw...", "image of..."). Write the prompt in English (translate the user\'s Burmese description yourself). Aspect: square (default), portrait, landscape, wide.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Image description in English, e.g. "Shwedagon Pagoda at sunset, golden light, photorealistic"' },
          aspect: { type: 'string', description: 'square, portrait, landscape or wide', enum: ['square', 'portrait', 'landscape', 'wide'] },
        },
        required: ['prompt'],
      },
    },
  },
];

async function runTool(name, args, tgId) {
  console.log(`[tool] ${name} (tg ${tgId})`);
  try {
    if (name === 'web_search') return await webSearch(args.query || '');
    if (name === 'open_link') return await openLink(args.url || '');
    if (name === 'get_time') return getTime();
    if (name === 'remember_fact') {
      const id = db.addMemory(tgId, args.fact || '');
      return `မှတ်ထားပြီးပြီ (id ${id}): ${args.fact}`;
    }
    if (name === 'forget_fact') {
      const n = db.deleteMemoryByText(tgId, args.text || '');
      return n ? `${n} ခု ဖျက်ပြီးပြီ။` : 'မတွေ့ပါ။';
    }
    if (name === 'schedule_cron') {
      const cj = require('./cronjobs');
      const r = cj.addJob(tgId, args.expression || '', args.text || '');
      if (r.error === 'invalid') return '❌ cron expression မှားနေတယ်။ ပုံစံ: "မိနစ် နာရီ ရက် လ နေ့" ဥပမာ "0 8 * * *" (နေ့တိုင်း မနက် ၈နာရီ)';
      if (r.error === 'limit') return `❌ cron job ${cj.MAX_PER_USER} ခု ပြည့်နေပြီ။`;
      if (r.error === 'notext') return '❌ သတိပေးမယ့် စာသားလိုတယ်။';
      return `⏰🔁 ထပ်တလဲလဲ သတိပေးချက် ဖန်တီးပြီးပြီ (id ${r.id}): ${cj.humanize(args.expression)} — ${args.text}`;
    }
    if (name === 'list_crons') {
      const list = db.listCronJobs(tgId);
      if (!list.length) return '🔁 cron job မရှိသေးပါ။';
      const cj = require('./cronjobs');
      return '🔁 ထပ်တလဲလဲ သတိပေးချက်များ:\n' +
        list.map(j => `[${j.id}] ${j.text} — ${cj.humanize(j.expr)} (${j.expr})`).join('\n');
    }
    if (name === 'delete_cron') {
      const cj = require('./cronjobs');
      const ok = cj.removeJob(tgId, parseInt(args.id));
      return ok ? `🗑 [${args.id}] ဖျက်ပြီးပြီ။` : 'မတွေ့ပါ။';
    }
    if (name === 'send_file') {
      const r = createOutboxFile(tgId, args.filename, args.content);
      if (r.error === 'empty') return '❌ file content အလွတ်ဖြစ်နေတယ်။';
      if (r.error === 'too_big') return '❌ file အရမ်းကြီးနေတယ် (200KB အထိပဲ ရတယ်)။ အတိုချုံးပြီး ထပ်စမ်းပါ။';
      const kb = (r.bytes / 1024).toFixed(1);
      return {
        text: `📎 file အသင့်ဖြစ်ပြီ: ${r.name} (${kb}KB) — အသုံးပြုသူကို attachment အဖြစ် ပို့ပေးမယ်။`,
        attachment: { path: r.path, name: r.name },
      };
    }
    if (name === 'generate_image') {
      const imagine = require('./imagine');
      const owner = config.ownerId && String(tgId) === String(config.ownerId);
      // Imagine tiers: owner → unlimited; user with OWN approved-relay
      // key (/setapi sapi.zly168.cn/v1) → their key, 10/day; everyone else → free
      // trial on the server key, 5 images LIFETIME.
      // Key priority: the user's own approved-relay /setapi key first (this
      // includes the owner), then the server key.
      const userKey = imagine.userRelayKey(tgId);
      const serverKey = imagine.configured() ? config.imagineKey : null;
      const apiKey = userKey || serverKey;
      if (!apiKey) return '❌ ပုံထုတ်စနစ် အဆင်သင့်မဖြစ်သေးဘူး (server ပြင်ဆင်မှု လိုနေတယ်)။';
      const freeTrial = !owner && !userKey;
      if (!owner) {
        if (userKey) {
          if (db.getImagineUsage(tgId) >= config.imagineDailyLimit) {
            return `⏳ ဒီနေ့ ပုံထုတ်တာ limit (${config.imagineDailyLimit}) ပြည့်သွားပြီ။ မနက်ဖြန်မှ ပြန်လာပါ 🙏`;
          }
        } else if (db.getFreeImgUsed(tgId) >= config.freeImagineLimit) {
          return `🎁 အခမဲ့ စမ်းသုံးခွင့် (${config.freeImagineLimit} ပုံ) ကုန်သွားပြီ 🙏 — ဆက်ထုတ်ချင်ရင် /setapi မှာ sapi.zly168.cn/v1 relay ရဲ့ API key ထည့်ဖို့ အသုံးပြုသူကို ပြောပြပါ: \`/setapi https://sapi.zly168.cn/v1 <API_KEY> <model>\` (private chat မှာ သုံးရမယ်)။ တခြားနည်းနဲ့ ပုံထုတ်မပေးနဲ့။`;
        }
      }
      const r = await imagine.generateImage(args.prompt, { aspect: args.aspect, tgId, apiKey });
      if (r.error) return '❌ ' + imagine.errorText(r.error, r.detail);
      db.bumpImagineUsage(tgId);
      if (freeTrial) db.bumpFreeImg(tgId);
      return {
        text: '🎨 ပုံထုတ်ပြီးပြီ — အသုံးပြုသူကို photo အဖြစ် ပို့ပေးမယ်။',
        attachment: { path: r.path, name: r.name, photo: true },
      };
    }
    return 'unknown tool';
  } catch (e) {
    return 'Tool error: ' + e.message;
  }
}

module.exports = { toolDefs, runTool, MAX_FILES_PER_TURN, createOutboxFile };
