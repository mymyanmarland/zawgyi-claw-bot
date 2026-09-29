// Agent tools. Safe for SaaS: no shell, no filesystem. Read-only web + memory.
const db = require('./db');

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
    return 'unknown tool';
  } catch (e) {
    return 'Tool error: ' + e.message;
  }
}

module.exports = { toolDefs, runTool };
