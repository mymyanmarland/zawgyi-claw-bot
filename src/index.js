// Entry point: Express health endpoint + Telegram polling + reminder scheduler.
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const cronjobs = require('./cronjobs');
const { createBot } = require('./telegram');

const LANDING_HTML = `<!DOCTYPE html>
<html lang="my"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ဇော်ဂျီ 🧙‍♂️ — ကိုယ်ပိုင် AI လက်ထောက်</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI','Noto Sans Myanmar',sans-serif;background:#0f1420;color:#eef2ff;line-height:1.7}
.hero{max-width:720px;margin:0 auto;padding:72px 24px 40px;text-align:center}
.hero .wiz{font-size:72px}
h1{font-size:2.2rem;margin:16px 0 8px;background:linear-gradient(90deg,#a78bfa,#60a5fa);-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{color:#9aa7c7;font-size:1.1rem;margin-bottom:28px}
.btn{display:inline-block;background:linear-gradient(90deg,#7c3aed,#2563eb);color:#fff;text-decoration:none;
padding:14px 38px;border-radius:999px;font-size:1.15rem;font-weight:700;box-shadow:0 8px 30px rgba(124,58,237,.45)}
.btn:hover{transform:translateY(-2px)}
.grid{max-width:720px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.card{background:#182038;border:1px solid #26314f;border-radius:16px;padding:20px}
.card .e{font-size:28px}.card h3{margin:8px 0 4px;font-size:1.05rem}.card p{color:#9aa7c7;font-size:.92rem}
.steps{max-width:720px;margin:0 auto;padding:24px}
.step{display:flex;gap:14px;margin:14px 0;align-items:flex-start}
.step .n{background:#7c3aed;color:#fff;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0}
.step code{background:#182038;padding:2px 8px;border-radius:6px;color:#a78bfa;font-size:.9rem}
footer{text-align:center;color:#5b6a8f;padding:32px 16px;font-size:.85rem}
</style></head><body>
<div class="hero">
<div class="wiz">🧙‍♂️</div>
<h1>ဇော်ဂျီ</h1>
<p class="tag">မင်းရဲ့ ကိုယ်ပိုင် AI လက်ထောက် — မြန်မာလိုပြောမယ်,<br>ကိုယ့်စိတ်ကြိုက် AI model နဲ့ ချိတ်သုံးလို့ရတယ်</p>
<a class="btn" href="https://t.me/zawgyiclawbot">💬 Telegram မှာ စတင်ရန်</a>
</div>
<div class="grid">
<div class="card"><div class="e">💬</div><h3>စကားပြောမယ်</h3><p>မြန်မာလို တိုက်ရိုက်ဖြေတယ်, စာလုံးတစ်လုံးချင်း တိုက်ရိုက်ပေါ်လာတယ်</p></div>
<div class="card"><div class="e">🔌</div><h3>ကိုယ့် API</h3><p>ကိုယ်ကြိုက် OpenAI-compatible model API နဲ့ ချိတ်သုံး, key ကို AES-256 နဲ့ လျှို့ဝှက်သိမ်းတယ်</p></div>
<div class="card"><div class="e">🖼️</div><h3>ပုံ + အသံ + ဖိုင်</h3><p>ပုံကြည့်ပေးတယ်, voice နားထောင်ပေးတယ်, PDF/Word ဖိုင်ဖတ်ပေးတယ်</p></div>
<div class="card"><div class="e">⏰</div><h3>သတိပေးချက်များ</h3><p>တစ်ကြိမ်သတိပေးချက်, ထပ်တလဲလဲ cron, AI သတင်းအကျဉ်း</p></div>
<div class="card"><div class="e">🧠</div><h3>မှတ်ဉာဏ်</h3><p>အရေးကြီးတာတွေ မှတ်ထားပေးတယ်, စကားဝိုင်း မှတ်တမ်း export လုပ်လို့ရတယ်</p></div>
<div class="card"><div class="e">📎</div><h3>File ထုတ်ပေးတယ်</h3><p>စာရင်း, အစီရင်ခံစာတွေကို file အဖြစ် တိုက်ရိုက်ပို့ပေးတယ်</p></div>
</div>
<div class="steps">
<h2 style="margin-bottom:8px">🚀 စတင်ရန် (၃ ဆင့်)</h2>
<div class="step"><div class="n">1</div><div>Telegram မှာ <b>@zawgyiclawbot</b> ကို ရှာပြီး Start နှိပ်ပါ</div></div>
<div class="step"><div class="n">2</div><div><code>/setapi</code> နဲ့ ကိုယ့် Model API ချိတ်ပါ<br><code>/setapi https://.../v1 sk-xxxx model-name</code></div></div>
<div class="step"><div class="n">3</div><div><code>/testapi</code> နဲ့ စမ်းပြီး စကားစပြောလိုက်ပါ 💬</div></div>
</div>
<footer>🧙‍♂️ Zaw Gyi Claw Bot — Made with care in Myanmar 🇲🇲</footer>
</body></html>`;

async function main() {
  db.init(config.dataDir);

  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true, bot: 'zawgyi-claw-bot', time: new Date().toISOString() }));
  app.get('/', (req, res) => res.send(LANDING_HTML));
  app.listen(config.port, () => console.log(`HTTP on :${config.port}`));

  // Graceful shutdown, registered BEFORE launch: wait for the long-poll to
  // fully stop before exiting, so a restart doesn't collide (409) with the
  // dying process's still-open getUpdates connection.
  let bot = null;
  async function shutdown(sig) {
    console.log(`received ${sig}, stopping Telegram polling...`);
    try { if (bot) await bot.stop(sig); } catch (e) {}
    process.exit(0);
  }
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  if (!config.botToken) {
    console.error('TELEGRAM_BOT_TOKEN not set — Telegram disabled, HTTP only.');
    return;
  }

  bot = createBot();

  // Reminder scheduler: every 30s
  cron.schedule('*/30 * * * * *', async () => {
    for (const r of db.dueReminders()) {
      try {
        await bot.telegram.sendMessage(r.tg_id, `⏰ **သတိပေးချက်**\n\n📝 ${r.text}`);
        db.markReminderSent(r.id);
      } catch (e) {
        console.error('reminder send failed:', r.id, e.message);
        db.markReminderSent(r.id); // don't retry forever (e.g. blocked bot)
      }
    }
  });

  // Launch with retry: a 409 means a previous long-poll is still registered
  // server-side (e.g. right after a restart). Wait and retry instead of crash-looping.
  let launched = false;
  for (let attempt = 1; attempt <= 12 && !launched; attempt++) {
    try {
      await bot.launch();
      launched = true;
    } catch (e) {
      console.error(`telegram launch attempt ${attempt} failed:`, e.message);
      if (attempt === 12) throw e;
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
  console.log('🧙‍♂️ Zaw Gyi Claw Bot launched (polling)');

  // Recurring cron-job reminders (persisted, Asia/Yangon)
  cronjobs.setSender((tgId, text) => bot.telegram.sendMessage(tgId, text));
  cronjobs.startAll();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
