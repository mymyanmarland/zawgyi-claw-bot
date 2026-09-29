// Telegram bot: commands + message handling.
const { Telegraf } = require('telegraf');
const db = require('./db');
const { encrypt, maskKey, decrypt } = require('./crypto');
const { chat, probeApi } = require('./agent');
const config = require('./config');

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

function createBot() {
  const bot = new Telegraf(config.botToken);

  bot.start(async (ctx) => {
    const u = ctx.from;
    db.upsertUser(String(u.id), u.username, u.first_name);
    await ctx.reply(
      `🧙‍♂️ **မင်္ဂလာပါ! ကျွန်တော်က ဇော်ဂျီ**\n\n` +
      `မင်းရဲ့ ကိုယ်ပိုင် AI လက်ထောက် — မြန်မာလိုပြောမယ်၊ မှတ်ဉာဏ်ရှိတယ်၊ ` +
      `အင်တာနက်ရှာပေးနိုင်တယ်၊ သတိပေးချက်ထားပေးနိုင်တယ်။\n\n` +
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
      `💬 စာပို့လိုက်ရုံနဲ့ စကားပြောလို့ရတယ်\n` +
      `🆕 /new — စကားဝိုင်း အသစ်စ\n` +
      `🧠 /remember <အချက်> — မှတ်ထားရန်\n` +
      `📋 /memory — မှတ်ထားတာတွေ ကြည့်ရန်\n` +
      `❌ /forget <id> — မေ့ခိုင်းရန်\n` +
      `⏰ /remind <အချိန်> <စာ> — သတိပေးချက်\n` +
      `📝 /reminders — သတိပေးချက်များ ကြည့်ရန်`
    );
  });

  bot.command('setapi', async (ctx) => {
    const tgId = String(ctx.from.id);
    const parts = ctx.message.text.split(/\s+/);
    if (parts.length < 4) {
      return ctx.reply('သုံးပုံ: /setapi <base_url> <api_key> <model>\nဥပမာ: /setapi https://api.openai.com/v1 sk-xxxx gpt-4o-mini');
    }
    const [, baseUrl, apiKey, ...modelParts] = parts;
    const model = modelParts.join(' ');
    if (!/^https?:\/\//.test(baseUrl)) return ctx.reply('❌ base_url က http(s):// နဲ့ စရမယ်။');
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
    const cfg = db.getApiConfig(String(ctx.from.id));
    if (!cfg) return replyLong(ctx, NOAPI_MSG);
    const key = decrypt(cfg.api_key_enc, config.masterKey);
    await ctx.reply(`🔌 **ချိတ်ထားတဲ့ API**\n🔗 ${cfg.base_url}\n🤖 ${cfg.model}\n🔑 ${maskKey(key)}`);
  });

  bot.command('removeapi', async (ctx) => {
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
  bot.on('text', async (ctx) => {
    const tgId = String(ctx.from.id);
    const u = ctx.from;
    db.upsertUser(tgId, u.username, u.first_name);

    const used = db.getUsage(tgId);
    if (used >= config.dailyLimit) {
      return ctx.reply(`⏳ ဒီနေ့ limit (${config.dailyLimit}) ပြည့်သွားပြီ။ မနက်ဖြန် ပြန်လာပါ 🙏`);
    }

    try { await ctx.sendChatAction('typing'); } catch (e) {}
    const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
    try {
      const result = await chat(tgId, ctx.message.text);
      clearInterval(typing);
      if (result.error === 'noapi') return replyLong(ctx, NOAPI_MSG);
      await replyLong(ctx, result.text);
    } catch (e) {
      clearInterval(typing);
      console.error('chat error:', e.message);
      await ctx.reply('😵 တစ်ခုခု မှားသွားတယ်။ API key သက်တမ်းကုန်နေလား /testapi နဲ့ စစ်ကြည့်ပါ။');
    }
  });

  return bot;
}

module.exports = { createBot };
