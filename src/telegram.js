// Telegram bot: commands + message handling.
const { Telegraf } = require('telegraf');
const db = require('./db');
const cronjobs = require('./cronjobs');
const { encrypt, maskKey, decrypt } = require('./crypto');
const { chat, probeApi } = require('./agent');
const { saveTelegramPhoto } = require('./photos');
const { saveTelegramAudio, transcribeAudio, whisperAvailable } = require('./audio');
const { saveTelegramDocument, extractText, supportedExt } = require('./documents');
const { validateBaseUrl } = require('./ssrf');
const { createOutboxFile } = require('./tools');
const config = require('./config');
const hs = require('./hindsight');

const NOAPI_MSG = `🔌 **Model API မချိတ်ရသေးပါ**

ကိုယ့်စိတ်ကြိုက် Model API နဲ့ချိတ်မှ ဇော်ဂျီ အလုပ်လုပ်နိုင်မယ်:

/setapi <base_url> <api_key> <model>

ဥပမာ:
/setapi https://claude-n-codex.com:8443/v1 sk-xxxx claude-sonnet-5

API key ကို AES-256 နဲ့ လျှို့ဝှက်သိမ်းထားတယ် 🔒`;

function parseWhen(s) {
  // "10m", "2h", "30s", "1d", "9:30", "tomorrow 9am"
  s = s.trim().toLowerCase();
  const now = Date.now();
  let m = s.match(/^(\d+)\s*(s|sec|secs|second|seconds)$/);
  if (m) return now + parseInt(m[1]) * 1000;
  m = s.match(/^(\d+)\s*(m|min|mins|minute|minutes)$/);
  if (m) return now + parseInt(m[1]) * 60000;
  m = s.match(/^(\d+)\s*(h|hr|hrs|hour|hours)$/);
  if (m) return now + parseInt(m[1]) * 3600000;
  m = s.match(/^(\d+)\s*(d|day|days)$/);
  if (m) return now + parseInt(m[1]) * 86400000;
  // "tomorrow 9am" / "tomorrow 9:30pm"
  m = s.match(/^tomorrow\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1]); const min = parseInt(m[2] || '0');
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    const d = new Date(now + 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return new Date(`${parts}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+06:30`).getTime();
  }
  // "9:30" or "9pm" today (or tomorrow if passed)
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let h = parseInt(m[1]); const min = parseInt(m[2] || '0');
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yangon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
    let t = new Date(`${parts}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+06:30`).getTime();
    if (t <= now) t += 86400000;
    return t;
  }
  return null;
}

function fmtTime(ts) {
  return new Intl.DateTimeFormat('my-MM', { timeZone: 'Asia/Yangon', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ts));
}

function splitLong(text, max = 4000) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

async function replyLong(ctx, text) {
  for (const part of splitLong(text)) {
    await ctx.reply(part, { parse_mode: 'Markdown' }).catch(() => ctx.reply(part));
  }
}

function isOwner(tgId) {
  return config.ownerId && String(tgId) === String(config.ownerId);
}

// Group-chat helpers: in groups the bot only answers when addressed
// (mention or reply to its message). Sensitive commands are private-only.
function isPrivate(ctx) {
  return !ctx.chat || ctx.chat.type === 'private';
}
function addressedInGroup(ctx) {
  if (isPrivate(ctx)) return true;
  const username = ctx.botInfo && ctx.botInfo.username;
  const text = ctx.message.text || ctx.message.caption || '';
  if (username && text.includes('@' + username)) return true;
  const r = ctx.message.reply_to_message;
  if (r && r.from && username && r.from.username === username) return true;
  return false;
}
const PRIVATE_ONLY_MSG = '🔒 ဒီ command ကို bot နဲ့ private chat မှာပဲ သုံးပါ 🙏 (API key လုံခြုံရေးအတွက်)';

function createBot() {
  const bot = new Telegraf(config.botToken);

  bot.start(async (ctx) => {
    const u = ctx.from;
    db.upsertUser(String(u.id), u.username, u.first_name);
    await ctx.reply(
      `🧙‍♂️ **မင်္ဂလာပါ! ကျွန်တော်က ဇော်ဂျီ**\n\n` +
      `မင်းရဲ့ ကိုယ်ပိုင် AI လက်ထောက် — မြန်မာလိုပြောမယ်၊ မှတ်ဉာဏ်ရှိတယ်၊ ` +
      `အင်တာနက်ရှာပေးနိုင်တယ်၊ သတိပေးချက်ထားပေးနိုင်တယ်၊ ပုံတွေကို ကြည့်ပြီး ဖြေပေးနိုင်တယ်။\n\n` +
      `**စတင်ရန် (၃ ဆင့်):**\n` +
      `1️⃣ /setapi — ကိုယ့် Model API ချိတ်ပါ\n` +
      `2️⃣ /testapi — ချိတ်ဆက်မှု စမ်းပါ\n` +
      `3️⃣ စကားပြောလိုက်ပါ 💬\n\n` +
      `/help နဲ့ command အားလုံးကြည့်နိုင်တယ်။`
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      `🧙‍♂️ **ဇော်ဂျီ Commands**\n\n` +
      `🔌 /setapi <url> <key> <model> — Model API ချိတ်ရန်\n` +
      `✅ /testapi — API စမ်းသပ်ရန်\n` +
      `🔍 /myapi — ချိတ်ထားတာ ကြည့်ရန်\n` +
      `🗑 /removeapi — API ဖျက်ရန်\n\n` +
      `💬 စာပို့လိုက်ရုံနဲ့ စကားပြောလို့ရတယ် (စာလုံးတစ်လုံးချင်း ပေါ်လာမယ် ✨)\n` +
      `🖼 ပုံပို့လိုက်ရင် ပုံကို ကြည့်ပြီး ဖြေပေးနိုင်တယ်\n` +
      `📄 PDF / Word / text ဖိုင်ပို့ရင် ဖတ်ပြီး ရှင်းပြပေးတယ်\n` +
      `🎙️ voice message ပို့ရင် နားထောင်ပြီး ဖြေပေးတယ်\n` +
      `📎 file လုပ်ခိုင်းရင် attachment အဖြစ် တိုက်ရိုက်ပို့ပေးတယ်\n` +
      `🆕 /new — စကားဝိုင်း အသစ်စ\n` +
      `🧠 /remember <အချက်> — မှတ်ထားရန်\n` +
      `📋 /memory — မှတ်ထားတာတွေ ကြည့်ရန်\n` +
      `❌ /forget <id> — မေ့ခိုင်းရန်\n` +
      `🧹 /forgetall — အလိုအလျောက် မှတ်ဉာဏ်ထဲက အကုန်ဖျက်ရန်\n` +
      `⏰ /remind <အချိန်> <စာ> — သတိပေးချက်\n` +
      `📝 /reminders — သတိပေးချက်များ ကြည့်ရန်\n` +
      `🔁 /cron <expression> <စာ> — ထပ်တလဲလဲ သတိပေးချက်\n` +
      `📰 /briefing <expression> <အကြောင်း> — AI သတင်းအကျဉ်း\n` +
      `📋 /crons — cron/briefing များ ကြည့်ရန်\n` +
      `🗑 /uncron <id> — cron ဖျက်ရန်\n` +
      `📤 /export — စကားဝိုင်း မှတ်တမ်း ထုတ်ယူရန်\n` +
      `📊 /usage — ဒီနေ့ အသုံးပြုမှု ကြည့်ရန်`
    );
  });

  bot.command('setapi', async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply(PRIVATE_ONLY_MSG);
    const tgId = String(ctx.from.id);
    const parts = ctx.message.text.split(/\s+/);
    // Delete the command message ASAP: it contains the raw API key.
    const wipeCmd = () => ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    if (parts.length < 4) {
      await wipeCmd();
      return ctx.reply('သုံးပုံ: /setapi <base_url> <api_key> <model>\nဥပမာ: /setapi https://api.openai.com/v1 sk-xxxx gpt-4o-mini\n\n⚠️ key ပါတဲ့ command message ကို လုံခြုံရေးအတွက် ဖျက်လိုက်ပြီ။');
    }
    const [, baseUrl, apiKey, ...modelParts] = parts;
    const model = modelParts.join(' ');
    if (!/^https?:\/\//.test(baseUrl)) { await wipeCmd(); return ctx.reply('❌ base_url က http(s):// နဲ့ စရမယ်။'); }
    const ssrfErr = await validateBaseUrl(baseUrl);
    if (ssrfErr) { await wipeCmd(); return ctx.reply(`❌ URL မလုံခြုံပါ: ${ssrfErr}`); }
    await wipeCmd(); // key must not stay in chat history
    try { await ctx.sendChatAction('typing'); } catch (e) {}
    try {
      await probeApi(baseUrl, apiKey, model);
    } catch (e) {
      return ctx.reply(`❌ API ချိတ်မရပါ: ${e.message}\nURL, key, model မှန်မမှန် စစ်ပါ။`);
    }
    db.setApiConfig(tgId, baseUrl.replace(/\/+$/, ''), encrypt(apiKey, config.masterKey), model);
    await ctx.reply(`✅ ချိတ်ပြီးပြီ!\n🤖 Model: ${model}\n🔗 ${baseUrl}\n\nအခု စကားပြောလို့ရပြီ 💬`);
  });

  bot.command('testapi', async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply(PRIVATE_ONLY_MSG);
    const tgId = String(ctx.from.id);
    const cfg = db.getApiConfig(tgId);
    if (!cfg) return replyLong(ctx, NOAPI_MSG);
    try { await ctx.sendChatAction('typing'); } catch (e) {}
    try {
      const key = decrypt(cfg.api_key_enc, config.masterKey);
      await probeApi(cfg.base_url, key, cfg.model);
      await ctx.reply(`✅ API အလုပ်လုပ်တယ်!\n🤖 ${cfg.model}\n🔗 ${cfg.base_url}`);
    } catch (e) {
      await ctx.reply(`❌ မရပါ: ${e.message}`);
    }
  });

  bot.command('myapi', async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply(PRIVATE_ONLY_MSG);
    const cfg = db.getApiConfig(String(ctx.from.id));
    if (!cfg) return replyLong(ctx, NOAPI_MSG);
    const key = decrypt(cfg.api_key_enc, config.masterKey);
    await ctx.reply(`🔌 **ချိတ်ထားတဲ့ API**\n🔗 ${cfg.base_url}\n🤖 ${cfg.model}\n🔑 ${maskKey(key)}`);
  });

  bot.command('removeapi', async (ctx) => {
    if (!isPrivate(ctx)) return ctx.reply(PRIVATE_ONLY_MSG);
    db.deleteApiConfig(String(ctx.from.id));
    await ctx.reply('🗑 API config ဖျက်ပြီးပြီ။ /setapi နဲ့ အသစ်ချိတ်နိုင်တယ်။');
  });

  bot.command('new', async (ctx) => {
    db.clearMessages(String(ctx.from.id));
    await ctx.reply('🆕 စကားဝိုင်း အသစ်စပြီ။ ဘာကူညီရမလဲ?');
  });

  bot.command('remember', async (ctx) => {
    const fact = ctx.message.text.replace(/^\/remember\s+/, '').trim();
    if (!fact) return ctx.reply('သုံးပုံ: /remember <မှတ်ထားချင်တဲ့အချက်>');
    const id = db.addMemory(String(ctx.from.id), fact);
    await ctx.reply(`🧠 မှတ်ထားပြီးပြီ (id ${id}): ${fact}`);
  });

  bot.command('memory', async (ctx) => {
    const mems = db.listMemories(String(ctx.from.id));
    if (!mems.length) return ctx.reply('ဘာမှ မမှတ်ထားရသေးပါ။ /remember နဲ့ မှတ်ခိုင်းနိုင်တယ်။');
    await ctx.reply('🧠 **မှတ်ထားတာများ:**\n' + mems.map(m => `[${m.id}] ${m.fact}`).join('\n'));
  });

  bot.command('forget', async (ctx) => {
    const tgId = String(ctx.from.id);
    const arg = ctx.message.text.replace(/^\/forget\s+/, '').trim();
    if (!arg) return ctx.reply('သုံးပုံ: /forget <id> (သို့) /forget <စာသား>');
    if (/^\d+$/.test(arg)) {
      const ok = db.deleteMemory(tgId, parseInt(arg));
      return ctx.reply(ok ? `❌ [${arg}] မေ့လိုက်ပြီ။` : 'မတွေ့ပါ။ /memory နဲ့ စစ်ပါ။');
    }
    const n = db.deleteMemoryByText(tgId, arg);
    await ctx.reply(n ? `❌ ${n} ခု မေ့လိုက်ပြီ။` : 'မတွေ့ပါ။');
  });

  bot.command('forgetall', async (ctx) => {
    const tgId = String(ctx.from.id);
    if (!hs.enabled()) return ctx.reply('🧠 အလိုအလျောက် မှတ်ဉာဏ် (Hindsight) ပိတ်ထားပါတယ်။');
    const ok = await hs.forgetAll(tgId);
    await ctx.reply(ok ? '🧠 အလိုအလျောက် မှတ်ဉာဏ်ထဲက မှတ်ထားသမျှ အကုန် ဖျက်ပြီးပြီ။' : '⚠️ ဖျက်မရခဲ့ပါ။ နောက်မှ ထပ်စမ်းပါ။');
  });

  bot.command('remind', async (ctx) => {
    const tgId = String(ctx.from.id);
    const rest = ctx.message.text.replace(/^\/remind\s+/, '').trim();
    const sp = rest.indexOf(' ');
    if (sp < 0) return ctx.reply('သုံးပုံ: /remind <အချိန်> <စာ>\nဥပမာ: /remind 10m ဆေးသောက် | /remind tomorrow 9am အစည်းအဝေး');
    const fireAt = parseWhen(rest.slice(0, sp));
    const text = rest.slice(sp + 1).trim();
    if (!fireAt || !text) return ctx.reply('❌ အချိန် နားမလည်ပါ။ ဥပမာ: 10m, 2h, 9:30, tomorrow 9am');
    if (fireAt <= Date.now()) return ctx.reply('❌ အတိတ်အချိန် မရပါ 😅');
    const id = db.addReminder(tgId, text, fireAt);
    await ctx.reply(`⏰ သတိပေးမယ် (id ${id}):\n📝 ${text}\n🕐 ${fmtTime(fireAt)}`);
  });

  bot.command('reminders', async (ctx) => {
    const list = db.listReminders(String(ctx.from.id));
    if (!list.length) return ctx.reply('သတိပေးချက် မရှိပါ။');
    await ctx.reply('⏰ **သတိပေးချက်များ:**\n' + list.map(r => `[${r.id}] ${r.text} — ${fmtTime(r.fire_at)}`).join('\n'));
  });

  const CRON_HELP = `🔁 **ထပ်တလဲလဲ သတိပေးချက် (Cron)**

သုံးပုံ: /cron <expression> <စာ>

**Expression ပုံစံ:** မိနစ် နာရီ ရက် လ နေ့
\`0 8 * * *\` → နေ့တိုင်း မနက် ၈:၀၀
\`30 18 * * *\` → နေ့တိုင်း ညနေ ၆:၃၀
\`0 9 * * 1\` → တနင်္လာနေ့တိုင်း မနက် ၉:၀၀
\`*/30 * * * *\` → မိနစ် ၃၀ တိုင်း
\`0 0 1 * *\` → လတိုင်း ၁ ရက်နေ့

ဥပမာ:
/cron 0 8 * * * မနက်စာ စားဖို့
/cron 0 22 * * * ဖုန်းအားသွင်းဖို့ 🔋

အချိန်ဇုန်: Asia/Yangon 🇲🇲`;

  bot.command('cron', async (ctx) => {
    const tgId = String(ctx.from.id);
    const rest = ctx.message.text.replace(/^\/cron\s+/, '').trim();
    const m = rest.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/);
    if (!m) return replyLong(ctx, CRON_HELP);
    const [, expr, text] = m;
    const r = cronjobs.addJob(tgId, expr, text.trim());
    if (r.error === 'invalid') return ctx.reply('❌ expression မှားနေတယ်။\n\n' + CRON_HELP);
    if (r.error === 'limit') return ctx.reply(`❌ cron job ${cronjobs.MAX_PER_USER} ခု ပြည့်နေပြီ။ /uncron နဲ့ အဟောင်းဖျက်ပါ။`);
    if (r.error === 'notext') return ctx.reply('❌ သတိပေးမယ့် စာသားပါထည့်ပါ။');
    await ctx.reply(`⏰🔁 ဖန်တီးပြီးပြီ (id ${r.id}):\n📝 ${text.trim()}\n🕐 ${cronjobs.humanize(expr)}\n\`/crons\` နဲ့ ကြည့်နိုင်တယ်।`);
  });

  bot.command('crons', async (ctx) => {
    const list = db.listCronJobs(String(ctx.from.id));
    if (!list.length) return replyLong(ctx, '🔁 cron job မရှိသေးပါ။\n\n' + CRON_HELP);
    await ctx.reply('🔁 **ထပ်တလဲလဲ အလုပ်များ:**\n' +
      list.map(j => `[${j.id}] ${j.kind === 'briefing' ? '📰' : '🔁'} ${j.text}\n      🕐 ${cronjobs.humanize(j.expr)} \`${j.expr}\``).join('\n'));
  });

  bot.command('uncron', async (ctx) => {
    const tgId = String(ctx.from.id);
    const arg = ctx.message.text.replace(/^\/uncron\s+/, '').trim();
    if (!/^\d+$/.test(arg)) return ctx.reply('သုံးပုံ: /uncron <id>\n/crons နဲ့ id ကြည့်ပါ။');
    const ok = cronjobs.removeJob(tgId, parseInt(arg));
    await ctx.reply(ok ? `🗑 [${arg}] ဖျက်ပြီးပြီ။` : 'မတွေ့ပါ။ /crons နဲ့ စစ်ပါ။');
  });

  const BRIEFING_HELP = `📰 **AI သတင်းအကျဉ်း (Briefing)**

သုံးပုံ: /briefing <expression> <အကြောင်းအရာ>

AI က web ကနေ နောက်ဆုံးသတင်းတွေ ရှာပြီး အကျဉ်းရေးပေးမယ်။

ဥပမာ:
/briefing 0 7 * * * မြန်မာ့စီးပွားရေး သတင်း
/briefing 0 8 * * 1 နည်းပညာ သတင်းများ

/crons နဲ့ ကြည့်နိုင်၊ /uncron <id> နဲ့ ဖျက်နိုင်တယ်။`;

  bot.command('briefing', async (ctx) => {
    const tgId = String(ctx.from.id);
    const rest = ctx.message.text.replace(/^\/briefing\s+/, '').trim();
    const m = rest.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/);
    if (!m) return replyLong(ctx, BRIEFING_HELP);
    const [, expr, topic] = m;
    const r = cronjobs.addJob(tgId, expr, `📰 ${topic.trim()}`, 'briefing', topic.trim());
    if (r.error === 'invalid') return ctx.reply('❌ expression မှားနေတယ်။\n\n' + BRIEFING_HELP);
    if (r.error === 'limit') return ctx.reply(`❌ cron job ${cronjobs.MAX_PER_USER} ခု ပြည့်နေပြီ။ /uncron နဲ့ အဟောင်းဖျက်ပါ။`);
    if (r.error === 'notext') return ctx.reply('❌ အကြောင်းအရာ ထည့်ပါ။');
    await ctx.reply(`📰 ဖန်တီးပြီးပြီ (id ${r.id}):\n📝 ${topic.trim()}\n🕐 ${cronjobs.humanize(expr)}\n\n/crons နဲ့ ကြည့်နိုင်တယ်။`);
  });

  bot.command('export', async (ctx) => {
    const tgId = String(ctx.from.id);
    const msgs = db.getAllMessages(tgId, 200);
    if (!msgs.length) return ctx.reply('📤 export လုပ်စရာ စကားဝိုင်း မရှိသေးပါ။');
    const when = new Date().toLocaleString('my-MM', { timeZone: 'Asia/Yangon' });
    const lines = [`# 🧙‍♂️ Zaw Gyi — စကားဝိုင်း မှတ်တမ်း`, `_${when}_\n`];
    for (const m of msgs) {
      const who = m.role === 'user' ? '🧑 မင်း' : '🧙‍♂️ ဇော်ဂျီ';
      lines.push(`## ${who}\n${m.content}`);
    }
    const r = createOutboxFile(tgId, `zawgyi-chat-${new Date().toISOString().slice(0, 10)}.md`, lines.join('\n\n'));
    if (r.error) return ctx.reply('📤 export မရဘူး 😅');
    try {
      await ctx.replyWithDocument({ source: r.path, filename: r.name }, { caption: '📤 စကားဝိုင်း မှတ်တမ်း' });
    } catch (e) {
      await ctx.replyWithDocument({ source: r.path, filename: r.name });
    }
  });

  bot.command('usage', async (ctx) => {
    const tgId = String(ctx.from.id);
    const t = db.getTokenUsage(tgId);
    const msgs = db.getUsage(tgId);
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    await ctx.reply(
      `📊 **ဒီနေ့ အသုံးပြုမှု**\n\n` +
      `💬 Messages: ${msgs} / ${config.dailyLimit}\n` +
      `🔤 Tokens: ${fmt(t.total_tokens)} (in ${fmt(t.prompt_tokens)} / out ${fmt(t.completion_tokens)})\n` +
      `🤖 Model calls: ${t.calls}`
    );
  });

  // --- admin ---
  bot.command('stats', async (ctx) => {
    if (!isOwner(String(ctx.from.id))) return;
    const s = db.stats();
    await ctx.reply(`📊 **Stats**\n👥 Users: ${s.users}\n🔌 With API: ${s.withApi}\n💬 Messages today: ${s.messagesToday}`);
  });

  bot.command('broadcast', async (ctx) => {
    if (!isOwner(String(ctx.from.id))) return;
    const text = ctx.message.text.replace(/^\/broadcast\s+/, '').trim();
    if (!text) return ctx.reply('သုံးပုံ: /broadcast <စာ>');
    let sent = 0, failed = 0;
    for (const id of db.allUserIds()) {
      try { await ctx.telegram.sendMessage(id, `📢 **ဇော်ဂျီ ကြေညာချက်**\n\n${text}`); sent++; }
      catch (e) { failed++; }
      await new Promise(r => setTimeout(r, 50));
    }
    await ctx.reply(`📢 ပို့ပြီးပြီ: ${sent} ✅, ${failed} ❌`);
  });

  // --- chat ---
  // Streaming renderer: progressive message edits while tokens arrive.
  const STREAM_MAX = 3900; // Telegram hard cap is 4096
  const STREAM_EDIT_MS = 1200; // min ms between edits (rate-limit friendly)
  function createStreamRenderer(ctx) {
    const chatId = ctx.chat.id;
    let chain = Promise.resolve();
    let firstId = null;
    let curId = null;
    const extraIds = [];
    let buf = '';
    let lastEdit = 0;
    let closed = false;

    const editPlain = (id, text) =>
      ctx.telegram.editMessageText(chatId, id, undefined, text).catch(() => {});

    async function ensureMsg() {
      if (!curId) {
        const m = await ctx.reply('🧙‍♂️ စဉ်းစားနေတယ်...');
        curId = m.message_id;
        if (!firstId) firstId = curId;
      }
    }

    function push(tok) {
      if (closed || !tok) return;
      chain = chain.then(async () => {
        if (closed) return;
        await ensureMsg();
        if (buf.length + tok.length > STREAM_MAX) {
          await editPlain(curId, buf); // finalize without cursor
          extraIds.push(curId);
          const m = await ctx.reply('🧙‍♂️ ဆက်ရေးနေတယ်...');
          curId = m.message_id;
          buf = '';
        }
        buf += tok;
        const now = Date.now();
        if (now - lastEdit >= STREAM_EDIT_MS) {
          lastEdit = now;
          await editPlain(curId, buf + ' ▍');
        }
      }).catch(() => {});
    }

    async function renderFinal(id, text) {
      try {
        await ctx.telegram.editMessageText(chatId, id, undefined, text, { parse_mode: 'Markdown' });
      } catch (e) {
        await editPlain(id, text); // Markdown failed (unclosed formatting) -> plain
      }
    }

    async function finish(finalText) {
      closed = true;
      await chain;
      const text = finalText || buf;
      if (!firstId) return replyLong(ctx, text || '...'); // nothing streamed
      const parts = splitLong(text);
      await renderFinal(firstId, parts[0]);
      for (let i = 1; i < parts.length; i++) {
        await replyLong(ctx, parts[i]);
      }
      for (const id of extraIds) {
        await ctx.telegram.deleteMessage(chatId, id).catch(() => {});
      }
    }

    async function cancel() {
      closed = true;
      await chain;
      if (firstId) {
        if (!buf) await ctx.telegram.deleteMessage(chatId, firstId).catch(() => {});
        else await editPlain(firstId, buf);
      }
    }

    async function fail() {
      closed = true;
      await chain;
      if (firstId) {
        if (!buf) await ctx.telegram.deleteMessage(chatId, firstId).catch(() => {});
        else await editPlain(firstId, buf + '\n\n😵 တစ်ခုခု မှားသွားတယ်။');
      }
    }

    return { push, finish, cancel, fail };
  }

  async function handleChat(ctx, text, photoFile) {
    const tgId = String(ctx.from.id);
    const u = ctx.from;
    db.upsertUser(tgId, u.username, u.first_name);

    const used = db.getUsage(tgId);
    if (used >= config.dailyLimit) {
      return ctx.reply(`⏳ ဒီနေ့ limit (${config.dailyLimit}) ပြည့်သွားပြီ။ မနက်ဖြန် ပြန်လာပါ 🙏`);
    }

    try { await ctx.sendChatAction('typing'); } catch (e) {}
    const renderer = createStreamRenderer(ctx);
    try {
      const result = await chat(tgId, text, photoFile, (tok) => renderer.push(tok));
      if (result.error === 'noapi') { await renderer.cancel(); return replyLong(ctx, NOAPI_MSG); }
      if (result.error === 'novision') {
        await renderer.cancel();
        return ctx.reply(
          '😅 ဒီ model က ပုံမဖတ်နိုင်ဘူး။\n\n' +
          'Vision ရတဲ့ model သုံးပါ — ဥပမာ:\n' +
          '/setapi <url> <key> claude-sonnet-5'
        );
      }
      await renderer.finish(result.text);
      // agent-created file attachments -> send as Telegram documents
      if (result.files && result.files.length) {
        for (const f of result.files) {
          try {
            await ctx.replyWithDocument({ source: f.path, filename: f.name });
          } catch (e) {
            console.error('sendDocument failed:', e.message);
            await ctx.reply(`📎 ${f.name} ပို့မရဘူး 😅`).catch(() => {});
          }
        }
      }
    } catch (e) {
      await renderer.fail();
      console.error('chat error:', e.message);
      const em = e.message || '';
      if (/abort|timeout/i.test(em)) {
        await ctx.reply(
          '⏳ AI server က တုံ့ပြန်တာ ကြာလွန်းလို့ ရပ်လိုက်ရတယ် (စက္ကန့် ၂၀၀ ကျော်)။\n\n' +
          'ဖြစ်နိုင်တဲ့ အကြောင်းရင်းများ:\n' +
          '• တောင်းထားတဲ့ file/စာ ရှည်လွန်းနေတာ\n' +
          '• AI server အခု အားနည်းနေတာ\n\n' +
          'ခဏနေမှ ထပ်စမ်းကြည့်ပါ 🙏'
        );
      } else if (/\b401\b/.test(em)) {
        await ctx.reply('🔑 API key မမှန်ဘူး (သို့) သက်တမ်းကုန်နေပြီ။ /testapi နဲ့ စစ်ကြည့်ပါ။');
      } else {
        await ctx.reply('😵 တစ်ခုခု မှားသွားတယ်။ /testapi နဲ့ API စစ်ကြည့်ပါ။');
      }
    }
  }

  bot.on('text', async (ctx) => {
    if (!addressedInGroup(ctx)) return;
    await handleChat(ctx, ctx.message.text, null);
  });

  // --- photos: user sends an image, bot "sees" it via a vision model ---
  async function handleIncomingImage(ctx, fileId) {
    const tgId = String(ctx.from.id);
    if (!addressedInGroup(ctx)) return;
    if (!db.getApiConfig(tgId)) return replyLong(ctx, NOAPI_MSG);
    if (db.getUsage(tgId) >= config.dailyLimit) {
      return ctx.reply(`⏳ ဒီနေ့ limit (${config.dailyLimit}) ပြည့်သွားပြီ။ မနက်ဖြန် ပြန်လာပါ 🙏`);
    }
    const caption = (ctx.message.caption || '').trim() || 'ဒီပုံကို ကြည့်ပေးပါ 🙏';
    try { await ctx.sendChatAction('typing'); } catch (e) {}
    let file;
    try {
      file = await saveTelegramPhoto(config.botToken, config.dataDir, tgId, fileId);
    } catch (e) {
      console.error('photo download failed:', e.message);
      return ctx.reply(e.message === 'too_big'
        ? '😅 ပုံက အရမ်းကြီးနေတယ်။ အရွယ်အစား သေးတာလေး ပြန်ပို့ကြည့်ပါ။'
        : '😵 ပုံကို ယူမရဘူး။ ထပ်ပို့ကြည့်ပါ။');
    }
    await handleChat(ctx, caption, file);
  }

  bot.on('photo', async (ctx) => {
    const sizes = ctx.message.photo || [];
    if (!sizes.length) return;
    const best = sizes[sizes.length - 1]; // largest
    await handleIncomingImage(ctx, best.file_id);
  });

  // --- documents: PDF / Word / text files -> extract text, chat on it ---
  async function handleIncomingDocument(ctx, doc) {
    const tgId = String(ctx.from.id);
    if (!addressedInGroup(ctx)) return;
    if (!db.getApiConfig(tgId)) return replyLong(ctx, NOAPI_MSG);
    if (db.getUsage(tgId) >= config.dailyLimit) {
      return ctx.reply(`⏳ ဒီနေ့ limit (${config.dailyLimit}) ပြည့်သွားပြီ။ မနက်ဖြန် ပြန်လာပါ 🙏`);
    }
    if (!supportedExt(doc.file_name)) {
      return ctx.reply('📄 ဒီဖိုင်အမျိုးအစား မဖတ်နိုင်သေးဘူး 😅\nရတာတွေ: PDF, Word (.docx), txt, md, csv, json');
    }
    let statusMsg = null;
    try { statusMsg = await ctx.reply('📄 ဖိုင်ဖတ်နေပါတယ်၊ ခဏစောင့်...'); } catch (e) {}
    try {
      const file = await saveTelegramDocument(config.botToken, config.dataDir, tgId, doc);
      const { text, truncated } = await extractText(file);
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      if (!text) return ctx.reply('📄 ဖိုင်ထဲမှာ စာသားမတွေ့ဘူး 😅');
      const caption = (ctx.message.caption || '').trim();
      const prompt =
        `📄 [${file.name}] ဖိုင်ထဲက စာသား:\n"""\n${text}\n"""` +
        (truncated ? '\n(စာရှည်လို့ အစပိုင်းပဲ ဖတ်ထားတယ်)' : '') +
        (caption ? `\n\nအသုံးပြုသူရဲ့ မေးခွန်း: ${caption}` : '\n\nအထက်ပါဖိုင်ကို ရှင်းပြပေးပါ 🙏');
      await handleChat(ctx, prompt, null);
    } catch (e) {
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      console.error('document failed:', e.message);
      await ctx.reply(e.message === 'too_big'
        ? '📄 ဖိုင်အရမ်းကြီးနေတယ် (10MB အထိပဲ ရတယ်) 😅'
        : '😵 ဖိုင်ဖတ်မရဘူး။ ထပ်စမ်းကြည့်ပါ။');
    }
  }

  bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;
    if ((doc.mime_type || '').startsWith('image/')) {
      if (!addressedInGroup(ctx)) return;
      return handleIncomingImage(ctx, doc.file_id);
    }
    await handleIncomingDocument(ctx, doc);
  });

  // --- voice: transcribe locally, then chat on the transcript ---
  async function handleIncomingVoice(ctx, fileId) {
    const tgId = String(ctx.from.id);
    if (!addressedInGroup(ctx)) return;
    if (!db.getApiConfig(tgId)) return replyLong(ctx, NOAPI_MSG);
    if (db.getUsage(tgId) >= config.dailyLimit) {
      return ctx.reply(`⏳ ဒီနေ့ limit (${config.dailyLimit}) ပြည့်သွားပြီ။ မနက်ဖြန် ပြန်လာပါ 🙏`);
    }
    if (!whisperAvailable()) {
      return ctx.reply('🎙️ အသံနားထောင်တဲ့ စနစ် server မှာ မတင်ရသေးပါ။ ခဏနေမှ ပြန်စမ်းပါ 🙏');
    }
    let statusMsg = null;
    try { statusMsg = await ctx.reply('🎙️ အသံနားထောင်နေပါတယ်၊ ခဏစောင့်...'); } catch (e) {}
    const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
    try {
      const file = await saveTelegramAudio(config.botToken, config.dataDir, tgId, fileId);
      const { text } = await transcribeAudio(config.dataDir, file);
      clearInterval(typing);
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      if (!text) {
        return ctx.reply('🎙️ အသံမကြားရဘူး / နားမလည်ဘူး။ ထပ်ပြောကြည့်ပါလား?');
      }
      await handleChat(ctx, `🎙️ "${text}"`, null);
    } catch (e) {
      clearInterval(typing);
      console.error('voice failed:', e.message);
      if (statusMsg) await ctx.deleteMessage(statusMsg.message_id).catch(() => {});
      await ctx.reply(e.message === 'too_big'
        ? '🎙️ အသံဖိုင် အရမ်းကြီးနေတယ်။ တိုတိုလေး ပြန်ပို့ကြည့်ပါ။'
        : '😵 အသံကို နားမလည်ဘူး။ ထပ်စမ်းကြည့်ပါ။');
    }
  }

  bot.on('voice', async (ctx) => {
    if (ctx.message.voice) await handleIncomingVoice(ctx, ctx.message.voice.file_id);
  });

  bot.on('audio', async (ctx) => {
    if (ctx.message.audio) await handleIncomingVoice(ctx, ctx.message.audio.file_id);
  });

  // Menu button: register commands so Telegram clients show the "Menu"
  // button next to the message input. Owner gets extra admin commands
  // in their own chat scope.
  const USER_COMMANDS = [
    { command: 'start', description: 'စတင်ရန် / မိတ်ဆက်' },
    { command: 'new', description: 'စကားဝိုင်း အသစ်စ' },
    { command: 'setapi', description: 'AI Model API ချိတ်ဆက်ရန်' },
    { command: 'testapi', description: 'API စမ်းသပ်ရန်' },
    { command: 'myapi', description: 'ချိတ်ထားတဲ့ API ကြည့်ရန်' },
    { command: 'removeapi', description: 'API ဖျက်ရန်' },
    { command: 'remind', description: 'သတိပေးချက် မှတ်ရန်' },
    { command: 'reminders', description: 'သတိပေးချက်များ ကြည့်ရန်' },
    { command: 'cron', description: 'ထပ်တလဲလဲ သတိပေးချက် ဖန်တီးရန်' },
    { command: 'briefing', description: 'AI သတင်းအကျဉ်း ဖန်တီးရန်' },
    { command: 'crons', description: 'cron/briefing စာရင်း ကြည့်ရန်' },
    { command: 'uncron', description: 'cron ဖျက်ရန်' },
    { command: 'export', description: 'စကားဝိုင်း မှတ်တမ်း ထုတ်ယူရန်' },
    { command: 'usage', description: 'ဒီနေ့ အသုံးပြုမှု ကြည့်ရန်' },
    { command: 'remember', description: 'အချက် မှတ်ထားရန်' },
    { command: 'memory', description: 'မှတ်ထားတာများ ကြည့်ရန်' },
    { command: 'forget', description: 'မှတ်ထားတာ ဖျက်ရန်' },
    { command: 'forgetall', description: 'အလိုအလျောက်မှတ်ဉာဏ် အကုန်ဖျက်ရန်' },
    { command: 'help', description: 'အကူအညီ / command အားလုံး' },
  ];
  bot.telegram.setMyCommands(USER_COMMANDS).catch((e) =>
    console.error('setMyCommands failed:', e.message)
  );
  if (config.ownerId) {
    const ownerId = parseInt(config.ownerId, 10);
    if (ownerId) {
      const OWNER_COMMANDS = USER_COMMANDS.concat([
        { command: 'stats', description: '👑 အသုံးပြုသူ စာရင်းအင်း' },
        { command: 'broadcast', description: '👑 အားလုံးကို စာပို့ရန်' },
      ]);
      bot.telegram
        .setMyCommands(OWNER_COMMANDS, { type: 'chat', chat_id: ownerId })
        .catch((e) => console.error('setMyCommands (owner) failed:', e.message));
    }
  }

  return bot;
}

module.exports = { createBot };
