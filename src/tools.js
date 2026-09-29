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

// --- web_search via DuckDuckGo html (free, no key) ---
async function webSearch(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('search failed: ' + res.status);
  const html = await res.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 5) {
    const href = m[1].replace(/&amp;/g, '&');
    const title = m[2].replace(/<[^>]+>/g, '').trim().slice(0, 120);
    results.push({ title, url: href });
  }
  const snip = [];
  const re2 = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  while ((m = re2.exec(html)) && i < results.length) {
    results[i].snippet = m[1].replace(/<[^>]+>/g, '').trim().slice(0, 200);
    i++;
  }
  if (!results.length) return 'ရှာမတွေ့ပါ။';
  return results.map((r, n) => `${n + 1}. ${r.title}\n   ${r.snippet || ''}\n   ${r.url}`).join('\n\n');
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
      description: 'Search the web for current/news information. Use when the user asks about recent events, prices, weather, or anything you might not know.',
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
];

async function runTool(name, args, tgId) {
  try {
    if (name === 'web_search') return await webSearch(args.query || '');
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
    return 'unknown tool';
  } catch (e) {
    return 'Tool error: ' + e.message;
  }
}

module.exports = { toolDefs, runTool, MAX_FILES_PER_TURN };
