const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'loyalty.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('paid','free')),
    barista TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_purchases_customer ON purchases(customer_id);

  CREATE TABLE IF NOT EXISTS baristas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS barista_otps (
    phone TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
`);

const DRINKS_REQUIRED = parseInt(process.env.DRINKS_REQUIRED || '6', 10);

function createCustomer({ id, name, phone }) {
  const stmt = db.prepare(
    'INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)'
  );
  stmt.run(id, name, phone, Date.now());
  return getCustomer(id);
}

function getCustomer(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function getCustomerByPhone(phone) {
  return db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
}

function addPurchase(customerId, barista) {
  // Count paid drinks since last reset (i.e. since the most recent free drink, if any).
  const insert = db.prepare(
    'INSERT INTO purchases (customer_id, type, barista, created_at) VALUES (?, ?, ?, ?)'
  );

  const txn = db.transaction(() => {
    insert.run(customerId, 'paid', barista || null, Date.now());
    const stats = getStats(customerId);
    let freeAwarded = false;
    if (stats.progress >= DRINKS_REQUIRED) {
      insert.run(customerId, 'free', barista || null, Date.now());
      freeAwarded = true;
    }
    return { freeAwarded, stats: getStats(customerId) };
  });

  return txn();
}

function getStats(customerId) {
  // progress = paid drinks since the most recent free drink
  const lastFree = db
    .prepare(
      "SELECT created_at FROM purchases WHERE customer_id = ? AND type = 'free' ORDER BY created_at DESC LIMIT 1"
    )
    .get(customerId);
  const since = lastFree ? lastFree.created_at : 0;

  const paidSince = db
    .prepare(
      "SELECT COUNT(*) as c FROM purchases WHERE customer_id = ? AND type = 'paid' AND created_at > ?"
    )
    .get(customerId, since).c;

  const totalPaid = db
    .prepare("SELECT COUNT(*) as c FROM purchases WHERE customer_id = ? AND type = 'paid'")
    .get(customerId).c;

  const totalFree = db
    .prepare("SELECT COUNT(*) as c FROM purchases WHERE customer_id = ? AND type = 'free'")
    .get(customerId).c;

  return {
    progress: paidSince,
    required: DRINKS_REQUIRED,
    remaining: Math.max(0, DRINKS_REQUIRED - paidSince),
    totalPaid,
    totalFree,
  };
}

function getRecentPurchases(customerId, limit = 10) {
  return db
    .prepare(
      'SELECT type, barista, created_at FROM purchases WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(customerId, limit);
}

// ---------- baristas ----------

const crypto = require('crypto');

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function upsertBarista({ name, phone }) {
  const existing = db.prepare('SELECT * FROM baristas WHERE phone = ?').get(phone);
  if (existing) {
    db.prepare('UPDATE baristas SET name = ?, active = 1 WHERE phone = ?').run(name, phone);
    return db.prepare('SELECT * FROM baristas WHERE phone = ?').get(phone);
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO baristas (id, name, phone, active, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(id, name, phone, Date.now());
  return db.prepare('SELECT * FROM baristas WHERE id = ?').get(id);
}

function getBaristaByPhone(phone) {
  return db.prepare('SELECT * FROM baristas WHERE phone = ? AND active = 1').get(phone);
}

function getBaristaById(id) {
  return db.prepare('SELECT * FROM baristas WHERE id = ? AND active = 1').get(id);
}

function listBaristas() {
  return db.prepare('SELECT id, name, phone, active FROM baristas ORDER BY created_at').all();
}

function saveOtp(phone, code, ttlMs) {
  const expires = Date.now() + ttlMs;
  db.prepare(
    `INSERT INTO barista_otps (phone, code_hash, expires_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash,
                                      expires_at = excluded.expires_at,
                                      attempts = 0`
  ).run(phone, hashCode(code), expires);
}

function consumeOtp(phone, code) {
  const row = db.prepare('SELECT * FROM barista_otps WHERE phone = ?').get(phone);
  if (!row) return { ok: false, reason: 'no_code' };
  if (row.attempts >= 5) {
    db.prepare('DELETE FROM barista_otps WHERE phone = ?').run(phone);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM barista_otps WHERE phone = ?').run(phone);
    return { ok: false, reason: 'expired' };
  }
  const expected = hashCode(code);
  const a = Buffer.from(expected);
  const b = Buffer.from(row.code_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    db.prepare('UPDATE barista_otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return { ok: false, reason: 'wrong_code' };
  }
  db.prepare('DELETE FROM barista_otps WHERE phone = ?').run(phone);
  return { ok: true };
}

module.exports = {
  db,
  createCustomer,
  getCustomer,
  getCustomerByPhone,
  addPurchase,
  getStats,
  getRecentPurchases,
  DRINKS_REQUIRED,
  upsertBarista,
  getBaristaByPhone,
  getBaristaById,
  listBaristas,
  saveOtp,
  consumeOtp,
};
