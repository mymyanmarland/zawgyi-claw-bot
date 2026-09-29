// SQLite storage: users, api configs, memories, messages, reminders.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let db;

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'zawgyi.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_configs (
      tg_id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      api_key_enc TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(tg_id, id);
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT NOT NULL,
      text TEXT NOT NULL,
      fire_at INTEGER NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      tg_id TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tg_id, day)
    );
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT NOT NULL,
      expr TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cron_user ON cron_jobs(tg_id);
    CREATE TABLE IF NOT EXISTS token_usage (
      tg_id TEXT NOT NULL,
      day TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tg_id, day)
    );
  `);
  // migration: photo support for vision messages
  try { db.exec('ALTER TABLE messages ADD COLUMN photo TEXT'); } catch (e) { /* already there */ }
  // migration: briefing cron jobs (AI-generated content, not plain reminders)
  try { db.exec(`ALTER TABLE cron_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'reminder'`); } catch (e) { /* already there */ }
  try { db.exec('ALTER TABLE cron_jobs ADD COLUMN prompt TEXT'); } catch (e) { /* already there */ }
  return db;
}

const now = () => Date.now();
const todayStr = () => new Date().toISOString().slice(0, 10);

function upsertUser(tgId, username, firstName) {
  const row = db.prepare('SELECT tg_id FROM users WHERE tg_id = ?').get(tgId);
  if (row) {
    db.prepare('UPDATE users SET username = ?, first_name = ?, last_seen = ? WHERE tg_id = ?')
      .run(username || null, firstName || null, now(), tgId);
  } else {
    db.prepare('INSERT INTO users (tg_id, username, first_name, created_at, last_seen) VALUES (?,?,?,?,?)')
      .run(tgId, username || null, firstName || null, now(), now());
  }
}

function setApiConfig(tgId, baseUrl, apiKeyEnc, model) {
  db.prepare(`INSERT INTO api_configs (tg_id, base_url, api_key_enc, model, updated_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(tg_id) DO UPDATE SET base_url=excluded.base_url,
                api_key_enc=excluded.api_key_enc, model=excluded.model, updated_at=excluded.updated_at`)
    .run(tgId, baseUrl, apiKeyEnc, model, now());
}

function getApiConfig(tgId) {
  return db.prepare('SELECT * FROM api_configs WHERE tg_id = ?').get(tgId) || null;
}

function deleteApiConfig(tgId) {
  db.prepare('DELETE FROM api_configs WHERE tg_id = ?').run(tgId);
}

function addMemory(tgId, fact) {
  const r = db.prepare('INSERT INTO memories (tg_id, fact, created_at) VALUES (?,?,?)')
    .run(tgId, fact, now());
  return r.lastInsertRowid;
}

function listMemories(tgId) {
  return db.prepare('SELECT id, fact FROM memories WHERE tg_id = ? ORDER BY id').all(tgId);
}

function deleteMemory(tgId, id) {
  const r = db.prepare('DELETE FROM memories WHERE tg_id = ? AND id = ?').run(tgId, id);
  return r.changes > 0;
}

function deleteMemoryByText(tgId, text) {
  const r = db.prepare('DELETE FROM memories WHERE tg_id = ? AND fact LIKE ?').run(tgId, `%${text}%`);
  return r.changes;
}

function addMessage(tgId, role, content, photo) {
  db.prepare('INSERT INTO messages (tg_id, role, content, photo, created_at) VALUES (?,?,?,?,?)')
    .run(tgId, role, content, photo || null, now());
  // keep last 60 per user
  db.prepare(`DELETE FROM messages WHERE tg_id = ? AND id NOT IN
              (SELECT id FROM messages WHERE tg_id = ? ORDER BY id DESC LIMIT 60)`)
    .run(tgId, tgId);
}

function getRecentMessages(tgId, limit = 20) {
  return db.prepare('SELECT role, content, photo FROM messages WHERE tg_id = ? ORDER BY id DESC LIMIT ?')
    .all(tgId, limit).reverse();
}

function clearMessages(tgId) {
  db.prepare('DELETE FROM messages WHERE tg_id = ?').run(tgId);
}

function addReminder(tgId, text, fireAt) {
  const r = db.prepare('INSERT INTO reminders (tg_id, text, fire_at, created_at) VALUES (?,?,?,?)')
    .run(tgId, text, fireAt, now());
  return r.lastInsertRowid;
}

function dueReminders() {
  return db.prepare('SELECT * FROM reminders WHERE sent = 0 AND fire_at <= ?').all(now());
}

function markReminderSent(id) {
  db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(id);
}

function listReminders(tgId) {
  return db.prepare('SELECT id, text, fire_at FROM reminders WHERE tg_id = ? AND sent = 0 ORDER BY fire_at').all(tgId);
}

function addCronJob(tgId, expr, text, kind = 'reminder', prompt = null) {
  const r = db.prepare('INSERT INTO cron_jobs (tg_id, expr, text, kind, prompt, created_at) VALUES (?,?,?,?,?,?)')
    .run(tgId, expr, text, kind, prompt, now());
  return r.lastInsertRowid;
}

function listCronJobs(tgId) {
  return db.prepare('SELECT id, expr, text, kind, prompt FROM cron_jobs WHERE tg_id = ? ORDER BY id').all(tgId);
}

function allCronJobs() {
  return db.prepare('SELECT id, tg_id, expr, text, kind, prompt FROM cron_jobs').all();
}

function deleteCronJob(tgId, id) {
  const r = db.prepare('DELETE FROM cron_jobs WHERE tg_id = ? AND id = ?').run(tgId, id);
  return r.changes > 0;
}

function bumpUsage(tgId) {
  const day = todayStr();
  db.prepare(`INSERT INTO usage (tg_id, day, count) VALUES (?,?,1)
              ON CONFLICT(tg_id, day) DO UPDATE SET count = count + 1`).run(tgId, day);
}

function getUsage(tgId) {
  const row = db.prepare('SELECT count FROM usage WHERE tg_id = ? AND day = ?').get(tgId, todayStr());
  return row ? row.count : 0;
}

function addTokenUsage(tgId, u) {
  if (!u) return;
  const p = u.prompt_tokens || 0, c = u.completion_tokens || 0, t = u.total_tokens || (p + c);
  if (!t && !p && !c) return;
  db.prepare(`INSERT INTO token_usage (tg_id, day, prompt_tokens, completion_tokens, total_tokens, calls)
              VALUES (?,?,?,?,?,1)
              ON CONFLICT(tg_id, day) DO UPDATE SET
                prompt_tokens = prompt_tokens + excluded.prompt_tokens,
                completion_tokens = completion_tokens + excluded.completion_tokens,
                total_tokens = total_tokens + excluded.total_tokens,
                calls = calls + 1`)
    .run(tgId, todayStr(), p, c, t);
}

function getTokenUsage(tgId) {
  const row = db.prepare('SELECT prompt_tokens, completion_tokens, total_tokens, calls FROM token_usage WHERE tg_id = ? AND day = ?')
    .get(tgId, todayStr());
  return row || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
}

function getAllMessages(tgId, limit = 200) {
  return db.prepare('SELECT role, content, created_at FROM messages WHERE tg_id = ? ORDER BY id ASC LIMIT ?')
    .all(tgId, limit);
}

function stats() {
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const withApi = db.prepare('SELECT COUNT(*) c FROM api_configs').get().c;
  const today = db.prepare('SELECT SUM(count) s FROM usage WHERE day = ?').get(todayStr()).s || 0;
  return { users, withApi, messagesToday: today };
}

function allUserIds() {
  return db.prepare('SELECT tg_id FROM users').all().map(r => r.tg_id);
}

module.exports = {
  init, upsertUser, setApiConfig, getApiConfig, deleteApiConfig,
  addMemory, listMemories, deleteMemory, deleteMemoryByText,
  addMessage, getRecentMessages, getAllMessages, clearMessages,
  addReminder, dueReminders, markReminderSent, listReminders,
  addCronJob, listCronJobs, allCronJobs, deleteCronJob,
  bumpUsage, getUsage, addTokenUsage, getTokenUsage, stats, allUserIds,
};
