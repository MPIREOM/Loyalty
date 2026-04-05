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

module.exports = {
  db,
  createCustomer,
  getCustomer,
  getCustomerByPhone,
  addPurchase,
  getStats,
  getRecentPurchases,
  DRINKS_REQUIRED,
};
