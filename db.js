// Uses Node's built-in SQLite (node:sqlite, stable in Node 22.5+/24).
// No native compilation, no extra install step.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'loyalty.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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

// Migration: add role column to existing baristas tables that predate it.
{
  const cols = db.prepare("PRAGMA table_info(baristas)").all();
  if (!cols.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE baristas ADD COLUMN role TEXT NOT NULL DEFAULT 'barista'");
  }
}

const DRINKS_REQUIRED = parseInt(process.env.DRINKS_REQUIRED || '6', 10);

// node:sqlite doesn't ship a transaction helper, so we wrap manually.
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function createCustomer({ id, name, phone }) {
  db.prepare(
    'INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, name, phone, Date.now());
  return getCustomer(id);
}

function getCustomer(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function getCustomerByPhone(phone) {
  return db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
}

function addPurchase(customerId, barista) {
  const insert = db.prepare(
    'INSERT INTO purchases (customer_id, type, barista, created_at) VALUES (?, ?, ?, ?)'
  );

  return transaction(() => {
    insert.run(customerId, 'paid', barista || null, Date.now());
    const stats = getStats(customerId);
    let freeAwarded = false;
    if (stats.progress >= DRINKS_REQUIRED) {
      insert.run(customerId, 'free', barista || null, Date.now());
      freeAwarded = true;
    }
    return { freeAwarded, stats: getStats(customerId) };
  });
}

function getStats(customerId) {
  const lastFree = db
    .prepare(
      "SELECT created_at FROM purchases WHERE customer_id = ? AND type = 'free' ORDER BY created_at DESC LIMIT 1"
    )
    .get(customerId);
  const since = lastFree ? Number(lastFree.created_at) : 0;

  const paidSince = Number(
    db
      .prepare(
        "SELECT COUNT(*) as c FROM purchases WHERE customer_id = ? AND type = 'paid' AND created_at > ?"
      )
      .get(customerId, since).c
  );

  const totalPaid = Number(
    db
      .prepare("SELECT COUNT(*) as c FROM purchases WHERE customer_id = ? AND type = 'paid'")
      .get(customerId).c
  );

  const totalFree = Number(
    db
      .prepare("SELECT COUNT(*) as c FROM purchases WHERE customer_id = ? AND type = 'free'")
      .get(customerId).c
  );

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

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function upsertBarista({ name, phone, role = 'barista' }) {
  const existing = db.prepare('SELECT * FROM baristas WHERE phone = ?').get(phone);
  if (existing) {
    db.prepare(
      'UPDATE baristas SET name = ?, role = ?, active = 1 WHERE phone = ?'
    ).run(name, role, phone);
    return db.prepare('SELECT * FROM baristas WHERE phone = ?').get(phone);
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO baristas (id, name, phone, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(id, name, phone, role, Date.now());
  return db.prepare('SELECT * FROM baristas WHERE id = ?').get(id);
}

function getBaristaByPhone(phone) {
  return db.prepare('SELECT * FROM baristas WHERE phone = ? AND active = 1').get(phone);
}

function getBaristaById(id) {
  return db.prepare('SELECT * FROM baristas WHERE id = ? AND active = 1').get(id);
}

function listBaristas() {
  return db
    .prepare('SELECT id, name, phone, role, active FROM baristas ORDER BY created_at')
    .all();
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

// ---------- owner dashboard stats ----------

function getOwnerStats() {
  const n = (v) => Number(v ?? 0);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayMs = startOfDay.getTime();
  const weekMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const monthMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const totalCustomers = n(
    db.prepare('SELECT COUNT(*) c FROM customers').get().c
  );
  const totalPaid = n(
    db.prepare("SELECT COUNT(*) c FROM purchases WHERE type='paid'").get().c
  );
  const totalFree = n(
    db.prepare("SELECT COUNT(*) c FROM purchases WHERE type='free'").get().c
  );
  const drinksToday = n(
    db
      .prepare("SELECT COUNT(*) c FROM purchases WHERE type='paid' AND created_at >= ?")
      .get(todayMs).c
  );
  const drinksThisWeek = n(
    db
      .prepare("SELECT COUNT(*) c FROM purchases WHERE type='paid' AND created_at >= ?")
      .get(weekMs).c
  );
  const drinksThisMonth = n(
    db
      .prepare("SELECT COUNT(*) c FROM purchases WHERE type='paid' AND created_at >= ?")
      .get(monthMs).c
  );
  const newCustomersThisWeek = n(
    db
      .prepare('SELECT COUNT(*) c FROM customers WHERE created_at >= ?')
      .get(weekMs).c
  );

  const topCustomers = db
    .prepare(
      `SELECT c.id, c.name, c.phone,
              SUM(CASE WHEN p.type='paid' THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN p.type='free' THEN 1 ELSE 0 END) AS free
         FROM customers c
         LEFT JOIN purchases p ON p.customer_id = c.id
        GROUP BY c.id
        ORDER BY paid DESC, c.created_at ASC
        LIMIT 10`
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      paid: n(r.paid),
      free: n(r.free),
    }));

  const recentActivity = db
    .prepare(
      `SELECT p.type, p.barista, p.created_at, c.name AS customer_name
         FROM purchases p
         JOIN customers c ON c.id = p.customer_id
        ORDER BY p.created_at DESC
        LIMIT 20`
    )
    .all();

  const perBarista = db
    .prepare(
      `SELECT COALESCE(barista, 'Unknown') AS barista, COUNT(*) AS drinks
         FROM purchases
        WHERE type = 'paid'
        GROUP BY barista
        ORDER BY drinks DESC`
    )
    .all()
    .map((r) => ({ barista: r.barista, drinks: n(r.drinks) }));

  return {
    totals: {
      customers: totalCustomers,
      newCustomersThisWeek,
      drinksAllTime: totalPaid,
      freeDrinksRedeemed: totalFree,
      drinksToday,
      drinksThisWeek,
      drinksThisMonth,
    },
    topCustomers,
    recentActivity,
    perBarista,
  };
}

function consumeOtp(phone, code) {
  const row = db.prepare('SELECT * FROM barista_otps WHERE phone = ?').get(phone);
  if (!row) return { ok: false, reason: 'no_code' };
  if (Number(row.attempts) >= 5) {
    db.prepare('DELETE FROM barista_otps WHERE phone = ?').run(phone);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (Number(row.expires_at) < Date.now()) {
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
  getOwnerStats,
};
