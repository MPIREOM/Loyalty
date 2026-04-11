// Uses Node's built-in SQLite (node:sqlite, stable in Node 22.5+/24).
// No native compilation, no extra install step.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR lets hosts (e.g. Fly.io) mount a persistent volume at a fixed
// path like /data. Falls back to ./data for local development.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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

// Migration helpers — additive, idempotent. Each run on boot.
function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}
function addColumnIfMissing(table, column, def) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

// baristas.role — added in a previous release
if (!columnExists('baristas', 'role')) {
  db.exec("ALTER TABLE baristas ADD COLUMN role TEXT NOT NULL DEFAULT 'barista'");
}

// customers extensions for referrals + birthdays
addColumnIfMissing('customers', 'referred_by', 'TEXT');
addColumnIfMissing('customers', 'birthday', 'TEXT'); // "MM-DD"
addColumnIfMissing('customers', 'last_birthday_year', 'INTEGER');

// purchases.bonus — bonus free drinks (birthdays) that don't reset the stamp card
addColumnIfMissing('purchases', 'bonus', 'INTEGER NOT NULL DEFAULT 0');

// Key/value table for campaign banner and other small owner-editable config
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_push_customer ON push_subscriptions(customer_id);
`);

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

function createCustomer({ id, name, phone, birthday, referredBy }) {
  db.prepare(
    `INSERT INTO customers (id, name, phone, created_at, birthday, referred_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, phone, Date.now(), birthday || null, referredBy || null);
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
  // Only non-bonus free rows reset the stamp card. Bonus free rows
  // (birthday gifts) don't affect progress toward the 6-drink reward.
  const lastFree = db
    .prepare(
      "SELECT created_at FROM purchases WHERE customer_id = ? AND type = 'free' AND bonus = 0 ORDER BY created_at DESC LIMIT 1"
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

  // Birthday status (only informational — the barista decides when to claim)
  const customer = getCustomer(customerId);
  const isBirthday = customer ? isBirthdayToday(customer) : false;
  const thisYear = new Date().getFullYear();
  const birthdayClaimable = isBirthday && (Number(customer?.last_birthday_year || 0) < thisYear);

  return {
    progress: paidSince,
    required: DRINKS_REQUIRED,
    remaining: Math.max(0, DRINKS_REQUIRED - paidSince),
    totalPaid,
    totalFree,
    isBirthday,
    birthdayClaimable,
  };
}

// ---------- birthday helpers ----------

function isBirthdayToday(customer) {
  if (!customer || !customer.birthday) return false;
  const d = new Date();
  const mmdd =
    String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return customer.birthday === mmdd;
}

function claimBirthdayDrink(customerId, baristaName) {
  const customer = getCustomer(customerId);
  if (!customer) return { ok: false, reason: 'not_found' };
  if (!isBirthdayToday(customer)) return { ok: false, reason: 'not_birthday' };
  const thisYear = new Date().getFullYear();
  if (Number(customer.last_birthday_year || 0) >= thisYear) {
    return { ok: false, reason: 'already_claimed' };
  }
  return transaction(() => {
    db.prepare(
      `INSERT INTO purchases (customer_id, type, barista, created_at, bonus)
       VALUES (?, 'free', ?, ?, 1)`
    ).run(customerId, `🎂 Birthday (${baristaName || 'staff'})`, Date.now());
    db.prepare('UPDATE customers SET last_birthday_year = ? WHERE id = ?').run(thisYear, customerId);
    return { ok: true, stats: getStats(customerId) };
  });
}

// ---------- referral helpers ----------

function recordReferralReward(referrerId, newCustomerId) {
  return transaction(() => {
    const now = Date.now();
    // Referrer gets a paid stamp on their card; if this pushes them over the
    // threshold they also get their normal free drink.
    db.prepare(
      `INSERT INTO purchases (customer_id, type, barista, created_at, bonus)
       VALUES (?, 'paid', '🎁 Referral reward', ?, 0)`
    ).run(referrerId, now);
    const refStats = getStats(referrerId);
    if (refStats.progress >= DRINKS_REQUIRED) {
      db.prepare(
        `INSERT INTO purchases (customer_id, type, barista, created_at, bonus)
         VALUES (?, 'free', '🎁 Referral reward', ?, 0)`
      ).run(referrerId, now + 1);
    }
    // New customer gets a welcome paid stamp.
    db.prepare(
      `INSERT INTO purchases (customer_id, type, barista, created_at, bonus)
       VALUES (?, 'paid', '🎁 Welcome bonus', ?, 0)`
    ).run(newCustomerId, now + 2);
  });
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

  // Yesterday breakdown
  const startOfYesterday = new Date(startOfDay);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const yMs = startOfYesterday.getTime();
  const drinksYesterday = n(
    db
      .prepare(
        "SELECT COUNT(*) c FROM purchases WHERE type='paid' AND created_at >= ? AND created_at < ?"
      )
      .get(yMs, todayMs).c
  );
  const freeYesterday = n(
    db
      .prepare(
        "SELECT COUNT(*) c FROM purchases WHERE type='free' AND created_at >= ? AND created_at < ?"
      )
      .get(yMs, todayMs).c
  );
  const uniqCustomersYesterday = n(
    db
      .prepare(
        'SELECT COUNT(DISTINCT customer_id) c FROM purchases WHERE created_at >= ? AND created_at < ?'
      )
      .get(yMs, todayMs).c
  );
  const newCustomersYesterday = n(
    db
      .prepare('SELECT COUNT(*) c FROM customers WHERE created_at >= ? AND created_at < ?')
      .get(yMs, todayMs).c
  );

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
    yesterday: {
      drinks: drinksYesterday,
      freeDrinks: freeYesterday,
      uniqueCustomers: uniqCustomersYesterday,
      newCustomers: newCustomersYesterday,
    },
    topCustomers,
    recentActivity,
    perBarista,
  };
}

// ---------- customer segments (marketing lists) ----------

function getInactiveCustomers(days) {
  const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.created_at,
              MAX(p.created_at) AS last_purchase_at
         FROM customers c
         LEFT JOIN purchases p ON p.customer_id = c.id
        GROUP BY c.id`
    )
    .all();
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      last_activity_at: Number(r.last_purchase_at || r.created_at),
    }))
    .filter((r) => r.last_activity_at < cutoff)
    .sort((a, b) => a.last_activity_at - b.last_activity_at)
    .slice(0, 100);
}

function getNearRewardCustomers() {
  // Customers with exactly one stamp to go before a free drink. Small shops
  // rarely have 10k rows so compute in JS — correct and simple.
  const all = db.prepare('SELECT id, name, phone FROM customers').all();
  return all
    .map((c) => {
      const s = getStats(c.id);
      return { id: c.id, name: c.name, phone: c.phone, progress: s.progress, required: s.required };
    })
    .filter((c) => c.required - c.progress === 1)
    .sort((a, b) => b.progress - a.progress);
}

function getAllCustomersForExport() {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.created_at, c.birthday, c.referred_by,
              SUM(CASE WHEN p.type='paid' THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN p.type='free' THEN 1 ELSE 0 END) AS free,
              MAX(p.created_at) AS last_purchase_at
         FROM customers c
         LEFT JOIN purchases p ON p.customer_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at ASC`
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    created_at: new Date(Number(r.created_at)).toISOString(),
    birthday: r.birthday || '',
    referred_by: r.referred_by || '',
    total_paid: Number(r.paid || 0),
    total_free: Number(r.free || 0),
    last_visit: r.last_purchase_at
      ? new Date(Number(r.last_purchase_at)).toISOString()
      : '',
  }));
}

// ---------- push subscriptions ----------

function savePushSubscription(customerId, subscription, userAgent) {
  db.prepare(
    `INSERT INTO push_subscriptions
       (customer_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       customer_id = excluded.customer_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent`
  ).run(
    customerId,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    userAgent || null,
    Date.now()
  );
}

function deletePushSubscriptionByEndpoint(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function getPushSubscriptionsForCustomer(customerId) {
  return db
    .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE customer_id = ?')
    .all(customerId);
}

function getAllPushSubscriptions() {
  return db
    .prepare('SELECT customer_id, endpoint, p256dh, auth FROM push_subscriptions')
    .all();
}

function getPushSubscriptionsForCustomerIds(customerIds) {
  if (!customerIds || !customerIds.length) return [];
  const placeholders = customerIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT customer_id, endpoint, p256dh, auth FROM push_subscriptions
        WHERE customer_id IN (${placeholders})`
    )
    .all(...customerIds);
}

// ---------- settings / campaign ----------

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value == null ? null : String(value));
}

function getActiveCampaign() {
  const json = getSetting('campaign');
  if (!json) return null;
  try {
    const c = JSON.parse(json);
    if (c.expires_at && Number(c.expires_at) < Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

function setCampaign({ title, body, expires_at }) {
  const trimmedTitle = (title || '').trim();
  const trimmedBody = (body || '').trim();
  if (!trimmedTitle && !trimmedBody) {
    setSetting('campaign', '');
    return null;
  }
  const c = {
    title: trimmedTitle,
    body: trimmedBody,
    expires_at: expires_at ? Number(expires_at) : null,
    updated_at: Date.now(),
  };
  setSetting('campaign', JSON.stringify(c));
  return c;
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
  // new
  isBirthdayToday,
  claimBirthdayDrink,
  recordReferralReward,
  getInactiveCustomers,
  getNearRewardCustomers,
  getAllCustomersForExport,
  getActiveCampaign,
  setCampaign,
  // push
  savePushSubscription,
  deletePushSubscriptionByEndpoint,
  getPushSubscriptionsForCustomer,
  getAllPushSubscriptions,
  getPushSubscriptionsForCustomerIds,
};
