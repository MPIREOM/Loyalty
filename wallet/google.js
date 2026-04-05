// Google Wallet "Save to Wallet" link generator using a signed JWT.
// Requires a Google Cloud service account with Wallet Objects API access
// and a pre-created Loyalty Class.

const fs = require('fs');
const jwt = require('jsonwebtoken');

function isConfigured() {
  return !!(
    process.env.GOOGLE_ISSUER_ID &&
    process.env.GOOGLE_CLASS_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
    fs.existsSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  );
}

function buildSaveUrl({ customer, stats, qrPayload }) {
  if (!isConfigured()) {
    const err = new Error('Google Wallet not configured on the server.');
    err.status = 501;
    throw err;
  }

  const sa = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'utf8'));
  const issuerId = process.env.GOOGLE_ISSUER_ID;
  const classId = `${issuerId}.${process.env.GOOGLE_CLASS_ID}`;
  const objectId = `${issuerId}.customer_${customer.id.replace(/-/g, '')}`;

  const loyaltyObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountName: customer.name,
    accountId: customer.phone,
    loyaltyPoints: {
      label: 'Drinks',
      balance: { string: `${stats.progress} / ${stats.required}` },
    },
    barcode: {
      type: 'QR_CODE',
      value: qrPayload,
    },
  };

  const payload = {
    iss: sa.client_email,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { loyaltyObjects: [loyaltyObject] },
  };

  const token = jwt.sign(payload, sa.private_key, { algorithm: 'RS256' });
  return `https://pay.google.com/gp/v/save/${token}`;
}

module.exports = { isConfigured, buildSaveUrl };
