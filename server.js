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
} = require('./db');

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
  });
});

// Customer registration
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
app.post('/api/register', registerLimiter, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const phone = normalizeOmaniPhone(req.body.phone);

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

  const id = crypto.randomUUID();
  createCustomer({ id, name, phone });
  const token = signCustomerToken(id);
  res.json({ id, token, existing: false });
});

// Customer card info (authenticated by the token embedded in their QR/link)
app.get('/api/card/:token', (req, res) => {
  const id = verifyCustomerToken(req.params.token);
  if (!id) return res.status(404).json({ error: 'invalid token' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'not found' });
  res.json({
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
    stats: getStats(id),
    recent: getRecentPurchases(id, 10),
    qrPayload: req.params.token,
  });
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

app.post('/api/barista/scan', requireStaff, (req, res) => {
  const token = String(req.body.token || '');
  const id = verifyCustomerToken(token);
  if (!id) return res.status(404).json({ error: 'Invalid customer QR' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json({
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
    stats: getStats(id),
  });
});

app.post('/api/barista/purchase', requireStaff, (req, res) => {
  const token = String(req.body.token || '');
  const id = verifyCustomerToken(token);
  if (!id) return res.status(404).json({ error: 'Invalid customer QR' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const result = addPurchase(id, req.staff.name);
  res.json({
    customer: { id: customer.id, name: customer.name },
    barista: req.staff.name,
    ...result,
  });
});

// ---------- owner dashboard ----------

app.get('/api/owner/stats', requireOwner, (_req, res) => {
  res.json(getOwnerStats());
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
