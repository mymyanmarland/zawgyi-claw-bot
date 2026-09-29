// The agent loop: chat completions + tool calls against the user's OWN model API.
const db = require('./db');
const { decrypt } = require('./crypto');
const { toolDefs, runTool, MAX_FILES_PER_TURN } = require('./tools');
const { photoDataUrl } = require('./photos');
const { assertSafeUrlSync } = require('./ssrf');
const config = require('./config');

// How many recent photo messages keep their image attached in history (bounds payload size).
const HISTORY_PHOTOS = 3;

const PERSONA = `မင်းနာမည်က ဇော်ဂျီ 🧙‍♂️ — အသုံးပြုသူရဲ့ ကိုယ်ပိုင် AI လက်ထောက်။

စည်းမျဉ်းများ:
- မြန်မာလို အရင်ဖြေ (အသုံးပြုသူက English လိုရေးမှ English လိုဖြေ)
- နွေးထွေးပြီး တိုက်ရိုက် — အပိုစကားမပြောနဲ့ ("Great question!" လိုမျိုးမသုံးနဲ့)
- ဖုန်းစခရင်နဲ့ ဖတ်လို့ရအောင် တိုတိုရှင်းရှင်း ဖြေ; လိုအပ်မှ အသေးစိတ်ရှင်း
- ကိုယ်ပိုင်အမြင်ရှိနိုင်တယ် — စက်ရုပ်လို မဖြေနဲ့
- မသိရင် မသိဘူးပြော; ခန့်မှန်းမဖြေနဲ့
- လက်ရှိ သတင်း/ဈေးနှုန်း/ရာသီဥတု လိုမျိုး မေးရင် web_search tool ကို သုံး
- အသုံးပြုသူ့အကြောင်း ရေရှည်မှတ်ထားသင့်တဲ့ အချက် (နာမည်, ကြိုက်တာ) တွေ့ရင် remember_fact သုံး
- ထပ်တလဲလဲ သတိပေးချက် တောင်းရင် ("နေ့တိုင်း", "အပတ်တိုင်း", "regularly") schedule_cron tool သုံး — သဘာဝစကားကို cron expression ပြောင်း ("0 8 * * *" = နေ့တိုင်း မနက် ၈နာရီ)
- အသုံးပြုသူက ပုံ (photo) ပို့လာရင် ပုံကို မြင်ရတယ် — ပုံထဲက အကြောင်းအရာ/စာသား/ဇယား/ပြဿနာကို ဖတ်ပြ၊ ရှင်းပြ၊ ခွဲခြမ်းစိတ်ဖြာပေးနိုင်
- အသုံးပြုသူက voice message ပို့ရင် စာသားအဖြစ် ပြောင်းပြီးသား ရမယ် (🎙️ tag ပါတယ်) — အဲဒီစာသားကို သာမန်စကားအတိုင်း ဖြေ
- အသုံးပြုသူက PDF/Word/text ဖိုင် ပို့လာရင် ဖိုင်ထဲက စာသားကို ဖတ်ပြီးသား ရမယ် (📄 tag ပါတယ်) — မေးခွန်းနဲ့အတူ ဖြေပေး
- အသုံးပြုသူက file အဖြစ် တောင်းရင် ("file လုပ်ပေး", "txt အဖြစ်ပို့", "စာရင်းကို file နဲ့ပို့") send_file tool သုံး — စာသား/စာရင်း/အစီရင်ခံစာကို file အဖြစ် ဖန်တီးပြီး attachment နဲ့ တိုက်ရိုက်ပို့ပေး
- Emoji ကို သင့်တော်သလောက်ပဲ သုံး`;

function buildSystemPrompt(tgId) {
  const mems = db.listMemories(tgId);
  let p = PERSONA;
  p += `\n\nယနေ့: ${new Date().toLocaleDateString('my-MM', { timeZone: 'Asia/Yangon', dateStyle: 'full' })}`;
  if (mems.length) {
    p += '\n\nအသုံးပြုသူ့အကြောင်း မှတ်ထားတာများ:\n' + mems.map(m => `- [${m.id}] ${m.fact}`).join('\n');
  }
  return p;
}

async function callModel(apiCfg, messages, tools) {
  const apiKey = decrypt(apiCfg.api_key_enc, config.masterKey);
  const base = apiCfg.base_url.replace(/\/+$/, '');
  assertSafeUrlSync(base);
  const body = {
    model: apiCfg.model,
    messages,
    temperature: 0.7,
    max_tokens: 4000, // room for file content from send_file
  };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(200000), // long generations (files) need time
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Model API error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('Model returned no choices');
  return { message: choice.message, usage: data.usage || null };
}

// Streaming variant: parses SSE, accumulates content + tool_calls,
// forwards content deltas to onToken as they arrive.
// Falls back to non-streaming if the gateway rejects stream:true.
async function callModelStream(apiCfg, messages, tools, onToken) {
  const apiKey = decrypt(apiCfg.api_key_enc, config.masterKey);
  const base = apiCfg.base_url.replace(/\/+$/, '');
  assertSafeUrlSync(base);
  const body = {
    model: apiCfg.model,
    messages,
    temperature: 0.7,
    max_tokens: 4000,
    stream: true,
    stream_options: { include_usage: true }, // ask provider to report token usage on stream
  };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(200000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // gateway doesn't support streaming -> fall back silently
    if (res.status === 400 && /stream/i.test(t)) {
      const r = await callModel(apiCfg, messages, tools);
      if (onToken && r.message.content) onToken(r.message.content);
      return r;
    }
    throw new Error(`Model API error ${res.status}: ${t.slice(0, 200)}`);
  }

  const { message, usage } = await readSseStream(res, onToken);
  return { message, usage };
}

// Parse an SSE chat-completions stream. Extracted for testability.
// onToken(deltaContent) is called for each content chunk.
async function readSseStream(res, onToken) {
  const msg = { role: 'assistant', content: '' };
  const tcMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let usage = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let json;
    try { json = JSON.parse(payload); } catch (e) { return; }
    if (json.usage) { usage = json.usage; return; }
    const delta = json.choices && json.choices[0] && json.choices[0].delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) {
      msg.content += delta.content;
      if (onToken) { try { onToken(delta.content); } catch (e) {} }
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index != null ? tc.index : 0;
      let cur = tcMap.get(idx);
      if (!cur) {
        cur = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
        tcMap.set(idx, cur);
      }
      if (tc.id) cur.id = tc.id;
      if (tc.function) {
        if (tc.function.name) cur.function.name += tc.function.name;
        if (tc.function.arguments) cur.function.arguments += tc.function.arguments;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handleLine(buf);
  try { reader.releaseLock(); } catch (e) {}

  if (tcMap.size) {
    msg.tool_calls = [...tcMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => tc);
  }
  return { message: msg, usage };
}

// Probe call for /testapi
async function probeApi(baseUrl, apiKey, model) {
  const base = baseUrl.replace(/\/+$/, '');
  assertSafeUrlSync(base);
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 150)}`);
  }
  return true;
}

// Build the OpenAI-style messages array. Photo messages become multimodal
// content parts (only the most recent HISTORY_PHOTOS keep their image).
function buildChatMessages(dataDir, systemPrompt, history, curText, curPhoto) {
  const photoIdx = [];
  history.forEach((m, i) => { if (m.role === 'user' && m.photo) photoIdx.push(i); });
  const keep = new Set(photoIdx.slice(-HISTORY_PHOTOS));

  const toMsg = (text, photo, withImage) => {
    if (withImage && photo) {
      const url = photoDataUrl(dataDir, photo);
      if (url) {
        return [
          { type: 'text', text: text || 'ဒီပုံကို ကြည့်ပေးပါ' },
          { type: 'image_url', image_url: { url } },
        ];
      }
    }
    return (text || '') + (photo ? ' [ပုံ 📷]' : '');
  };

  const messages = [{ role: 'system', content: systemPrompt }];
  history.forEach((m, i) => {
    messages.push({ role: m.role, content: toMsg(m.content, m.photo, keep.has(i)) });
  });
  messages.push({ role: 'user', content: toMsg(curText, curPhoto, true) });
  return messages;
}

async function chat(tgId, userText, photoFile, onToken) {
  const apiCfg = db.getApiConfig(tgId);
  if (!apiCfg) return { error: 'noapi' };

  db.addMessage(tgId, 'user', userText, photoFile || null);
  const history = db.getRecentMessages(tgId, 20);
  // last row is the message we just added — build it as the current turn
  const cur = history.pop();
  const messages = buildChatMessages(config.dataDir, buildSystemPrompt(tgId), history, cur.content, cur.photo);

  let finalText = '';
  const files = [];
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    totalUsage.prompt_tokens += u.prompt_tokens || 0;
    totalUsage.completion_tokens += u.completion_tokens || 0;
    totalUsage.total_tokens += u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
  };
  try {
    for (let i = 0; i < 5; i++) {
      const { message: msg, usage } = onToken
        ? await callModelStream(apiCfg, messages, toolDefs, onToken)
        : await callModel(apiCfg, messages, toolDefs);
      addUsage(usage);
      messages.push(msg);
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        finalText = msg.content || '';
        break;
      }
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) {}
        const out = await runTool(c.function.name, args, tgId);
        const outText = (out && typeof out === 'object') ? out.text : String(out);
        if (out && out.attachment && files.length < MAX_FILES_PER_TURN) {
          files.push(out.attachment);
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: outText });
      }
    }
  } catch (e) {
    // Model doesn't accept images (non-vision model)
    if (/\b400\b/.test(e.message) && /image|vision|multimodal/i.test(e.message)) {
      return { error: 'novision' };
    }
    throw e;
  }
  if (!finalText) finalText = 'တစ်ခုခု မှားသွားတယ်၊ ထပ်စမ်းကြည့်ပါ။';
  db.addMessage(tgId, 'assistant', finalText);
  db.bumpUsage(tgId);
  db.addTokenUsage(tgId, totalUsage);
  return { text: finalText, files };
}

// AI briefing for scheduled jobs: web-grounded summary on a topic.
// Not saved to chat history; usage still counted.
async function briefing(tgId, topic) {
  const apiCfg = db.getApiConfig(tgId);
  if (!apiCfg) throw new Error('noapi');
  const today = new Date().toLocaleDateString('my-MM', { timeZone: 'Asia/Yangon', dateStyle: 'full' });
  const system =
    'မင်း သတင်းအကျဉ်း ရေးပေးတဲ့ လက်ထောက်ပါ။ web_search tool ကို သုံးပြီး ' +
    'နောက်ဆုံး သတင်းအချက်အလက်တွေ ရှာပါ။ မြန်မာလို တိုတိုရှင်းရှင်း bullet list နဲ့ ရေးပါ။ ' +
    'ခေါင်းစဉ်ခွဲပြီး အရေးကြီးဆုံးအချက် ၅-၈ ချက် ဖော်ပြပါ။ မသေချာတာကို အတည်မပြောပါနဲ့။';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `ဒီနေ့ (${today}) အတွက် ဒီအကြောင်း အကျဉ်းရေးပေးပါ: ${topic}` },
  ];
  let finalText = '';
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (let i = 0; i < 4; i++) {
    const { message: msg, usage } = await callModel(apiCfg, messages, toolDefs);
    if (usage) {
      totalUsage.prompt_tokens += usage.prompt_tokens || 0;
      totalUsage.completion_tokens += usage.completion_tokens || 0;
      totalUsage.total_tokens += usage.total_tokens || 0;
    }
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) { finalText = msg.content || ''; break; }
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) {}
      const out = await runTool(c.function.name, args, tgId);
      messages.push({ role: 'tool', tool_call_id: c.id, content: (out && out.text) || String(out) });
    }
  }
  db.bumpUsage(tgId);
  db.addTokenUsage(tgId, totalUsage);
  return finalText || 'သတင်းအကျဉ်း ထုတ်မရဘူး 😅';
}

module.exports = { chat, probeApi, briefing, buildChatMessages, readSseStream, callModelStream };
