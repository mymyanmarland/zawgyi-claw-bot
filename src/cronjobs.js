// Recurring cron-job reminders. Persisted in SQLite, scheduled with node-cron.
// Timezone: Asia/Yangon for all jobs.
const cron = require('node-cron');
const db = require('./db');

const MAX_PER_USER = 20;
const tasks = new Map(); // jobId -> node-cron task
let sender = null; // async (tgId, text) => void — set at startup

function setSender(fn) { sender = fn; }

function humanize(expr) {
  // Friendly Burmese-ish description for common patterns
  const p = expr.trim().split(/\s+/);
  if (p.length < 5) return expr;
  const [min, hr, dom, mon, dow] = p;
  const mm = min === '*' ? 'မိနစ်တိုင်း' : `${min} မိနစ်`;
  if (hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    if (min.startsWith('*/')) return `${min.slice(2)} မိနစ်တစ်ကြိမ်`;
    return mm;
  }
  if (dom === '*' && mon === '*' && dow === '*') return `နေ့တိုင်း ${hr}:${min.padStart(2, '0')}`;
  const days = { 0: 'တနင်္ဂနွေ', 1: 'တနင်္လာ', 2: 'အင်္ဂါ', 3: 'ဗုဒ္ဓဟူး', 4: 'ကြာသပတေး', 5: 'သောကြာ', 6: 'စနေ', 7: 'တနင်္ဂနွေ' };
  if (dom === '*' && mon === '*' && days[dow]) return `${days[dow]}နေ့တိုင်း ${hr}:${min.padStart(2, '0')}`;
  return expr;
}

function scheduleOne(job) {
  stopOne(job.id);
  if (!sender || !cron.validate(job.expr)) return false;
  const task = cron.schedule(job.expr, async () => {
    try {
      await sender(job.tg_id, `⏰🔁 **ထပ်တလဲလဲ သတိပေးချက်**\n\n📝 ${job.text}`);
    } catch (e) {
      console.error('cron send failed:', job.id, e.message);
    }
  }, { timezone: 'Asia/Yangon' });
  tasks.set(job.id, task);
  return true;
}

function stopOne(id) {
  const t = tasks.get(id);
  if (t) { t.stop(); tasks.delete(id); }
}

function startAll() {
  let n = 0;
  for (const job of db.allCronJobs()) {
    if (scheduleOne(job)) n++;
    else console.error('invalid cron expr in db, skipping:', job.id, job.expr);
  }
  console.log(`⏰🔁 ${n} cron jobs scheduled`);
}

function addJob(tgId, expr, text) {
  expr = (expr || '').trim();
  text = (text || '').trim();
  if (!text) return { error: 'notext' };
  if (!cron.validate(expr)) return { error: 'invalid' };
  if (db.listCronJobs(tgId).length >= MAX_PER_USER) return { error: 'limit' };
  const id = db.addCronJob(tgId, expr, text);
  scheduleOne({ id, tg_id: tgId, expr, text });
  return { id };
}

function removeJob(tgId, id) {
  stopOne(id);
  return db.deleteCronJob(tgId, id);
}

function activeCount() { return tasks.size; }

module.exports = { setSender, startAll, scheduleOne, stopOne, addJob, removeJob, humanize, activeCount, MAX_PER_USER };
