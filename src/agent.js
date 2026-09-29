// The agent loop: chat completions + tool calls against the user's OWN model API.
const db = require('./db');
const { decrypt } = require('./crypto');
const { toolDefs, runTool, MAX_FILES_PER_TURN } = require('./tools');
const { photoDataUrl } = require('./photos');
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
  const body = {
    model: apiCfg.model,
    messages,
    temperature: 0.7,
    max_tokens: 1500,
  };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Model API error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('Model returned no choices');
  return choice.message;
}

// Probe call for /testapi
async function probeApi(baseUrl, apiKey, model) {
  const base = baseUrl.replace(/\/+$/, '');
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

async function chat(tgId, userText, photoFile) {
  const apiCfg = db.getApiConfig(tgId);
  if (!apiCfg) return { error: 'noapi' };

  db.addMessage(tgId, 'user', userText, photoFile || null);
  const history = db.getRecentMessages(tgId, 20);
  // last row is the message we just added — build it as the current turn
  const cur = history.pop();
  const messages = buildChatMessages(config.dataDir, buildSystemPrompt(tgId), history, cur.content, cur.photo);

  let finalText = '';
  const files = [];
  try {
    for (let i = 0; i < 5; i++) {
      const msg = await callModel(apiCfg, messages, toolDefs);
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
  return { text: finalText, files };
}

module.exports = { chat, probeApi, buildChatMessages };
