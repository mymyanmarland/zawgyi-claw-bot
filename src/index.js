// Entry point: Express health endpoint + Telegram polling + reminder scheduler.
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const cronjobs = require('./cronjobs');
const { createBot } = require('./telegram');

async function main() {
  db.init(config.dataDir);

  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true, bot: 'zawgyi-claw-bot', time: new Date().toISOString() }));
  app.get('/', (req, res) => res.send('🧙‍♂️ Zaw Gyi Claw Bot is running'));
  app.listen(config.port, () => console.log(`HTTP on :${config.port}`));

  if (!config.botToken) {
    console.error('TELEGRAM_BOT_TOKEN not set — Telegram disabled, HTTP only.');
    return;
  }

  const bot = createBot();

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

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
