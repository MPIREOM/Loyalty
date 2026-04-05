// Apple Wallet (.pkpass) generation.
// Requires valid Apple Developer Pass Type ID certificate, signer key, and WWDR cert.
// If certs are not configured, endpoints will return 501.

const fs = require('fs');
const path = require('path');

let PKPass;
try {
  ({ PKPass } = require('passkit-generator'));
} catch (_) {
  // passkit-generator not installed yet — server still works without wallet.
}

function isConfigured() {
  return !!(
    PKPass &&
    process.env.APPLE_PASS_TYPE_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_CERT_PATH &&
    process.env.APPLE_KEY_PATH &&
    process.env.APPLE_WWDR_PATH &&
    fs.existsSync(process.env.APPLE_CERT_PATH) &&
    fs.existsSync(process.env.APPLE_KEY_PATH) &&
    fs.existsSync(process.env.APPLE_WWDR_PATH)
  );
}

async function buildPass({ customer, stats, qrPayload }) {
  if (!isConfigured()) {
    const err = new Error('Apple Wallet not configured on the server.');
    err.status = 501;
    throw err;
  }

  const modelDir = path.join(__dirname, '..', 'certs', 'pass.model');
  // The pass model directory must contain pass.json template + icon.png, logo.png, etc.
  // Users drop their branding here.

  const pass = await PKPass.from(
    {
      model: modelDir,
      certificates: {
        wwdr: fs.readFileSync(process.env.APPLE_WWDR_PATH),
        signerCert: fs.readFileSync(process.env.APPLE_CERT_PATH),
        signerKey: fs.readFileSync(process.env.APPLE_KEY_PATH),
        signerKeyPassphrase: process.env.APPLE_KEY_PASSPHRASE || undefined,
      },
    },
    {
      serialNumber: customer.id,
      description: `${process.env.SHOP_NAME || 'Coffee'} Loyalty Card`,
      organizationName: process.env.SHOP_NAME || 'Coffee Shop',
      passTypeIdentifier: process.env.APPLE_PASS_TYPE_ID,
      teamIdentifier: process.env.APPLE_TEAM_ID,
    }
  );

  pass.setBarcodes({
    message: qrPayload,
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
  });

  // Push fresh field values so the pass reflects current progress.
  pass.primaryFields.push({
    key: 'progress',
    label: 'DRINKS',
    value: `${stats.progress} / ${stats.required}`,
  });
  pass.secondaryFields.push(
    { key: 'name', label: 'MEMBER', value: customer.name },
    { key: 'reward', label: 'FREE DRINKS EARNED', value: String(stats.totalFree) }
  );

  return pass.getAsBuffer();
}

module.exports = { isConfigured, buildPass };
