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
} = require('./db');

const apple = require('./wallet/apple');
const google = require('./wallet/google');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret';
const BARISTA_PIN = process.env.BARISTA_PIN || '1234';
const SHOP_NAME = process.env.SHOP_NAME || 'Coffee Shop';

const app = express();
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

function signBaristaToken() {
  return jwt.sign({ kind: 'barista' }, JWT_SECRET, { expiresIn: '12h' });
}

function requireBarista(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.kind !== 'barista') throw new Error();
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
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

const pinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.post('/api/barista/login', pinLimiter, (req, res) => {
  const pin = String(req.body.pin || '');
  // Constant-time compare to avoid timing attacks on the PIN.
  const a = Buffer.from(pin.padEnd(16, '\0'));
  const b = Buffer.from(String(BARISTA_PIN).padEnd(16, '\0'));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  res.json({ token: signBaristaToken() });
});

app.post('/api/barista/scan', requireBarista, (req, res) => {
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

app.post('/api/barista/purchase', requireBarista, (req, res) => {
  const token = String(req.body.token || '');
  const id = verifyCustomerToken(token);
  if (!id) return res.status(404).json({ error: 'Invalid customer QR' });
  const customer = getCustomer(id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const result = addPurchase(id, req.body.barista || null);
  res.json({
    customer: { id: customer.id, name: customer.name },
    ...result,
  });
});

// ---------- root ----------

app.get('/', (_req, res) => {
  res.redirect('/register.html');
});

app.listen(PORT, () => {
  console.log(`☕ ${SHOP_NAME} loyalty server listening on ${BASE_URL}`);
  console.log(`   Shop registration QR: ${BASE_URL}/shop-qr.png`);
  console.log(`   Barista console:      ${BASE_URL}/barista.html`);
});
