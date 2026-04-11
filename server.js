require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');

const {
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
  claimBirthdayDrink,
  recordReferralReward,
  getInactiveCustomers,
  getNearRewardCustomers,
  getAllCustomersForExport,
  getActiveCampaign,
  setCampaign,
  savePushSubscription,
  deletePushSubscriptionByEndpoint,
  getPushSubscriptionsForCustomer,
  getAllPushSubscriptions,
  getPushSubscriptionsForCustomerIds,
} = require('./db');

const push = require('./push');

const apple = require('./wallet/apple');
const google = require('./wallet/google');
const { sendSms } = require('./sms');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
const SHOP_NAME = process.env.SHOP_NAME || 'Coffee Shop';
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Seed staff from env. Owners outrank baristas (and can also mark drinks).
//   BARISTA_PHONES="+96891234567:Ahmed,+96899887766:Sara"
//   OWNER_PHONES="+96890000000:The Boss"
(function seedStaff() {
  function parseList(raw, role) {
    if (!raw || !raw.trim()) return;
    for (const entry of raw.split(',')) {
      const [phoneRaw, ...nameParts] = entry.split(':');
      const phone = normalizeOmaniPhone((phoneRaw || '').trim());
      const name = nameParts.join(':').trim() || (role === 'owner' ? 'Owner' : 'Barista');
      if (!phone) {
        console.warn(`Skipping invalid ${role.toUpperCase()}_PHONES entry: ${entry}`);
        continue;
      }
      upsertBarista({ phone, name, role });
    }
  }
  // Seed baristas first, then owners, so that if a number appears in both
  // lists the owner role wins (upsert updates the role).
  parseList(process.env.BARISTA_PHONES, 'barista');
  parseList(process.env.OWNER_PHONES, 'owner');

  const all = listBaristas();
  if (all.length) {
    const owners = all.filter((b) => b.role === 'owner');
    const baristas = all.filter((b) => b.role !== 'owner');
    if (owners.length) {
      console.log(`👑 Owners:   ${owners.map((b) => `${b.name} (${b.phone})`).join(', ')}`);
    }
    if (baristas.length) {
      console.log(`👥 Baristas: ${baristas.map((b) => `${b.name} (${b.phone})`).join(', ')}`);
    }
  }
})();

const app = express();
// Behind a reverse proxy (Fly, Railway, Render, Cloudflare, nginx…). Trust
// one hop so req.ip reflects the real client and express-rate-limit keys
// limits per-user instead of per-proxy.
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

// Omani mobile phone: +968 followed by 8 digits, starting with 7 or 9.
// Accept input with or without +, spaces, dashes.
function normalizeOmaniPhone(input) {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');
  let local;
  if (digits.startsWith('968') && digits.length === 11) local = digits.slice(3);
  else if (digits.length === 8) local = digits;
  else return null;
  if (!/^[79]\d{7}$/.test(local)) return null;
  return '+968' + local;
}

function signCustomerToken(customerId) {
  // Long-lived token embedded in the customer's QR code.
  return jwt.sign({ sub: customerId, kind: 'customer' }, JWT_SECRET, { expiresIn: '10y' });
}

function verifyCustomerToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.kind !== 'customer') return null;
    return p.sub;
  } catch {
    return null;
  }
}

function signStaffToken(staff) {
  return jwt.sign(
    { kind: 'barista', sub: staff.id, name: staff.name, role: staff.role || 'barista' },
    JWT_SECRET,
    { expiresIn: '10y' }
  );
}

function requireStaff(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.kind !== 'barista') throw new Error();
    const row = getBaristaById(p.sub);
    if (!row) return res.status(401).json({ error: 'unauthorized' });
    req.staff = { id: row.id, name: row.name, role: row.role || 'barista' };
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

function requireOwner(req, res, next) {
  requireStaff(req, res, () => {
    if (req.staff.role !== 'owner') {
      return res.status(403).json({ error: 'owner access required' });
    }
    next();
  });
}

// ---------- public routes ----------

app.get('/api/config', (_req, res) => {
  res.json({
    shopName: SHOP_NAME,
    drinksRequired: DRINKS_REQUIRED,
    wallet: { apple: apple.isConfigured(), google: google.isConfigured() },
    push: { enabled: push.isConfigured() },
  });
});

// Birthday field is accepted as "MM-DD" (zero-padded, 01-01 .. 12-31).
function normalizeBirthday(input) {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(/^(\d{2})-(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Customer registration
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
app.post('/api/register', registerLimiter, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const phone = normalizeOmaniPhone(req.body.phone);
  const birthday = normalizeBirthday(req.body.birthday); // optional
  const referralCode =
    typeof req.body.referralCode === 'string' ? req.body.referralCode.trim() : '';

  if (name.length < 2 || name.length > 60) {
    return res.status(400).json({ error: 'Please enter a valid name.' });
  }
  if (!phone) {
    return res.status(400).json({ error: 'Please enter a valid Omani mobile number (+968).' });
  }

  const existing = getCustomerByPhone(phone);
  if (existing) {
    const token = signCustomerToken(existing.id);
    return res.json({ id: existing.id, token, existing: true });
  }

  // Validate referralCode (must map to an existing customer). Silently ignore
  // an invalid code instead of failing the signup — don't block registration.
  let referrer = null;
  if (referralCode) {
    referrer = getCustomer(referralCode);
  }

  const id = crypto.randomUUID();
  createCustomer({
    id,
    name,
    phone,
    birthday,
    referredBy: referrer ? referrer.id : null,
  });

  // If referred, credit both sides once the new customer is in the DB.
  if (referrer) {
    try {
      recordReferralReward(referrer.id, id);
    } catch (e) {
      console.error('Referral reward error:', e.message);
    }
  }

  const token = signCustomerToken(id);
  res.json({
    id,
    token,
    existing: false,
    referralApplied: !!referrer,
  });
});

// Customer card info (authenticated by the token embedded in their QR/link)
app.get('/api/card/:token', (req, res) => {
  const id = verifyCustomerToken(req.params.token);
  if (!id) return res.status(404).json({ error: 'invalid token' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'not found' });
  res.json({
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      birthday: customer.birthday || null,
    },
    stats: getStats(id),
    recent: getRecentPurchases(id, 10),
    qrPayload: req.params.token,
    referralUrl: `${BASE_URL}/register.html?ref=${encodeURIComponent(customer.id)}`,
    campaign: getActiveCampaign(),
  });
});

// Public: current campaign banner (no auth). Used by the card auto-refresh
// so the banner updates without re-requesting the full card payload.
app.get('/api/config/campaign', (_req, res) => {
  res.json({ campaign: getActiveCampaign() });
});

// QR code image for the customer's token
app.get('/api/qr/:token', async (req, res) => {
  const id = verifyCustomerToken(req.params.token);
  if (!id) return res.status(404).end();
  const buf = await QRCode.toBuffer(req.params.token, { width: 512, margin: 2 });
  res.type('png').send(buf);
});

// Static shop QR → the URL baristas print and hang in the shop
app.get('/shop-qr.png', async (_req, res) => {
  const buf = await QRCode.toBuffer(`${BASE_URL}/register.html`, { width: 512, margin: 2 });
  res.type('png').send(buf);
});

// ---------- wallet routes ----------

app.get('/api/wallet/apple/:token', async (req, res) => {
  const id = verifyCustomerToken(req.params.token);
  if (!id) return res.status(404).end();
  const customer = getCustomer(id);
  if (!customer) return res.status(404).end();
  try {
    const buf = await apple.buildPass({
      customer,
      stats: getStats(id),
      qrPayload: req.params.token,
    });
    res
      .type('application/vnd.apple.pkpass')
      .set('Content-Disposition', `attachment; filename="${SHOP_NAME}.pkpass"`)
      .send(buf);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/wallet/google/:token', (req, res) => {
  const id = verifyCustomerToken(req.params.token);
  if (!id) return res.status(404).end();
  const customer = getCustomer(id);
  if (!customer) return res.status(404).end();
  try {
    const url = google.buildSaveUrl({
      customer,
      stats: getStats(id),
      qrPayload: req.params.token,
    });
    res.json({ url });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------- barista routes ----------

const otpRequestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const otpVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

app.post('/api/barista/request-code', otpRequestLimiter, async (req, res) => {
  const phone = normalizeOmaniPhone(req.body.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Please enter a valid Omani mobile number.' });
  }
  const barista = getBaristaByPhone(phone);
  if (!barista) {
    return res
      .status(403)
      .json({ error: 'This number is not registered as staff. Ask the owner to add it.' });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  saveOtp(phone, code, OTP_TTL_MS);
  await sendSms(
    phone,
    `${SHOP_NAME}: your staff login code is ${code}. It expires in 5 minutes.`
  );
  res.json({ sent: true, name: barista.name, role: barista.role || 'barista' });
});

app.post('/api/barista/verify-code', otpVerifyLimiter, (req, res) => {
  const phone = normalizeOmaniPhone(req.body.phone);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!phone || code.length !== 6) {
    return res.status(400).json({ error: 'Invalid phone or code.' });
  }
  const barista = getBaristaByPhone(phone);
  if (!barista) return res.status(403).json({ error: 'Not authorized.' });
  const result = consumeOtp(phone, code);
  if (!result.ok) {
    const map = {
      no_code: 'Please request a code first.',
      expired: 'Code expired. Please request a new one.',
      wrong_code: 'Incorrect code.',
      too_many_attempts: 'Too many attempts. Please request a new code.',
    };
    return res.status(401).json({ error: map[result.reason] || 'Verification failed.' });
  }
  res.json({
    token: signStaffToken(barista),
    name: barista.name,
    role: barista.role || 'barista',
  });
});

// Accept either a QR token (from scanning) or a bare customerId (from the
// manual phone lookup fallback). Both endpoints already require staff auth.
function resolveCustomerId(body) {
  if (body.customerId && typeof body.customerId === 'string') return body.customerId;
  if (body.token && typeof body.token === 'string') return verifyCustomerToken(body.token);
  return null;
}

app.post('/api/barista/scan', requireStaff, (req, res) => {
  const id = resolveCustomerId(req.body);
  if (!id) return res.status(404).json({ error: 'Invalid customer QR' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json({
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
    stats: getStats(id),
  });
});

app.post('/api/barista/purchase', requireStaff, (req, res) => {
  const id = resolveCustomerId(req.body);
  if (!id) return res.status(404).json({ error: 'Invalid customer QR' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const result = addPurchase(id, req.staff.name);
  res.json({
    customer: { id: customer.id, name: customer.name },
    barista: req.staff.name,
    ...result,
  });

  // Fire-and-forget push notifications. Not awaited so the barista gets an
  // instant response even if the upstream push service is slow.
  if (push.isConfigured()) {
    if (result.freeAwarded) {
      notifyCustomer(id, {
        title: `🎁 Your free drink is ready at ${SHOP_NAME}!`,
        body: `Congrats ${customer.name}, your ${DRINKS_REQUIRED}-stamp card is full. Next drink is on us!`,
        url: '/card.html',
        tag: 'free-drink',
      }).catch(() => {});
    } else if (result.stats.remaining === 1) {
      notifyCustomer(id, {
        title: `☕ One more to go, ${customer.name}!`,
        body: `Just one more drink and your next one is free at ${SHOP_NAME}.`,
        url: '/card.html',
        tag: 'near-reward',
      }).catch(() => {});
    }
  }
});

// Claim today's birthday free drink for a customer. Idempotent per calendar
// year — the second attempt on the same day returns 409 so the barista can't
// accidentally give two birthday drinks.
app.post('/api/barista/birthday-drink', requireStaff, (req, res) => {
  const id = resolveCustomerId(req.body);
  if (!id) return res.status(404).json({ error: 'Invalid customer' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const result = claimBirthdayDrink(id, req.staff.name);
  if (!result.ok) {
    const map = {
      not_birthday: 'It is not this customer\'s birthday today.',
      already_claimed: 'Birthday drink already claimed this year.',
      not_found: 'Customer not found.',
    };
    return res.status(409).json({ error: map[result.reason] || 'Unable to claim.' });
  }
  res.json({
    customer: { id: customer.id, name: customer.name },
    stats: result.stats,
  });
});

// Manual phone number lookup — fallback when scanning the QR isn't working
// (scratched screen, dim phone, awkward angle, customer forgot their card).
app.post('/api/barista/lookup', requireStaff, (req, res) => {
  const phone = normalizeOmaniPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid Omani mobile number.' });
  const customer = getCustomerByPhone(phone);
  if (!customer) {
    return res.status(404).json({
      error: 'No loyalty card for that number. Ask them to scan the shop QR to join.',
    });
  }
  res.json({
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
    stats: getStats(customer.id),
  });
});

// ---------- web push ----------

// Helper: fire-and-forget notification to every device of a given customer,
// with automatic cleanup of expired subscriptions.
async function notifyCustomer(customerId, payload) {
  if (!push.isConfigured()) return;
  const subs = getPushSubscriptionsForCustomer(customerId);
  if (!subs.length) return;
  const result = await push.sendToMany(subs, payload);
  for (const ep of result.deadEndpoints) deletePushSubscriptionByEndpoint(ep);
}

// Public key (VAPID) so the browser can subscribe to this server specifically.
app.get('/api/push/public-key', (_req, res) => {
  if (!push.isConfigured()) return res.status(501).json({ error: 'Push not configured' });
  res.json({ publicKey: push.publicKey() });
});

// Customer subscribes from their device. Body: { token, subscription }
// where subscription is the PushSubscription.toJSON() from the browser.
app.post('/api/push/subscribe', (req, res) => {
  if (!push.isConfigured()) return res.status(501).json({ error: 'Push not configured' });
  const token = String(req.body.token || '');
  const customerId = verifyCustomerToken(token);
  if (!customerId) return res.status(404).json({ error: 'invalid token' });
  const sub = req.body.subscription;
  if (
    !sub ||
    typeof sub.endpoint !== 'string' ||
    !sub.keys ||
    typeof sub.keys.p256dh !== 'string' ||
    typeof sub.keys.auth !== 'string'
  ) {
    return res.status(400).json({ error: 'Invalid subscription payload' });
  }
  savePushSubscription(customerId, sub, req.get('user-agent') || null);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  if (!req.body || typeof req.body.endpoint !== 'string') {
    return res.status(400).json({ error: 'endpoint required' });
  }
  deletePushSubscriptionByEndpoint(req.body.endpoint);
  res.json({ ok: true });
});

// ---------- owner dashboard ----------

app.get('/api/owner/stats', requireOwner, (_req, res) => {
  res.json(getOwnerStats());
});

// Owner-triggered broadcast: send a custom notification to all customers
// or a specific segment. Body: { title, body, url?, segment? }
// where segment is one of: 'all' | 'near-reward' | 'inactive-N'
app.post('/api/owner/push/broadcast', requireOwner, async (req, res) => {
  if (!push.isConfigured()) return res.status(501).json({ error: 'Push not configured' });
  const title = (req.body.title || '').toString().trim();
  const body = (req.body.body || '').toString().trim();
  const url = typeof req.body.url === 'string' ? req.body.url : '/register.html';
  const segment = (req.body.segment || 'all').toString();
  if (!title && !body) return res.status(400).json({ error: 'Title or body required' });

  // Resolve target customerIds.
  let targetIds = null; // null = all
  if (segment === 'near-reward') {
    targetIds = getNearRewardCustomers().map((c) => c.id);
  } else if (segment.startsWith('inactive-')) {
    const days = parseInt(segment.slice('inactive-'.length), 10) || 30;
    targetIds = getInactiveCustomers(days).map((c) => c.id);
  }

  const subs = targetIds
    ? getPushSubscriptionsForCustomerIds(targetIds)
    : getAllPushSubscriptions();
  if (!subs.length) return res.json({ delivered: 0, total: 0 });

  const payload = { title: title || 'The Peak', body, url, tag: 'owner-broadcast' };
  const result = await push.sendToMany(subs, payload);
  for (const ep of result.deadEndpoints) deletePushSubscriptionByEndpoint(ep);
  res.json({ delivered: result.delivered, total: subs.length });
});

// Customer segments for targeted marketing.
app.get('/api/owner/segments/inactive', requireOwner, (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  res.json({ days, customers: getInactiveCustomers(days) });
});

app.get('/api/owner/segments/near-reward', requireOwner, (_req, res) => {
  res.json({ customers: getNearRewardCustomers() });
});

// CSV export of the full customer list. Own your data.
app.get('/api/owner/customers.csv', requireOwner, (_req, res) => {
  const rows = getAllCustomersForExport();
  const headers = [
    'id',
    'name',
    'phone',
    'created_at',
    'birthday',
    'referred_by',
    'total_paid',
    'total_free',
    'last_visit',
  ];
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(r[h])).join(','));
  }
  const filename = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="${filename}"`)
    .send(lines.join('\n') + '\n');
});

// Campaign banner — owner edits, all customer cards see it.
app.post('/api/owner/campaign', requireOwner, (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title : '';
  const body = typeof req.body.body === 'string' ? req.body.body : '';
  const expires_at = req.body.expires_at ? Number(req.body.expires_at) : null;
  const saved = setCampaign({ title, body, expires_at });
  res.json({ campaign: saved });
});

// ---------- PWA manifest ----------

// Dynamic web manifest so "Add to Home Screen" on iOS/Android gives a
// nicely-branded icon using the shop name from env. The icon itself is
// served as a static file from /public.
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').json({
    name: `${SHOP_NAME} Loyalty`,
    short_name: SHOP_NAME,
    description: `Buy ${DRINKS_REQUIRED} drinks, get the next one free.`,
    start_url: '/register.html',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#1a1410',
    theme_color: '#c89666',
    icons: [
      {
        src: '/thePeak_logo_color.png',
        sizes: 'any',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  });
});

// ---------- health + root ----------

// Liveness probe for Fly / any uptime monitor. Intentionally trivial.
app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/', (_req, res) => {
  res.redirect('/register.html');
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`☕ ${SHOP_NAME} loyalty server listening on ${BASE_URL}`);
  console.log(`   Shop registration QR: ${BASE_URL}/shop-qr.png`);
  console.log(`   Barista console:      ${BASE_URL}/barista.html`);
});

// Graceful shutdown: Fly sends SIGTERM before stopping a machine. Close the
// HTTP server (drain in-flight requests) and then close the SQLite handle
// so the WAL is checkpointed cleanly and the DB file is never left mid-write.
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  server.close(() => {
    try {
      require('./db').db.close();
    } catch (e) {
      console.error('DB close error:', e.message);
    }
    process.exit(0);
  });
  // Hard-exit backstop if something hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
