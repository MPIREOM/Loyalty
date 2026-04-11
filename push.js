// Web Push (VAPID) sender. Zero-config when VAPID keys aren't set — the
// subscribe endpoints return 501 and auto-notifications are skipped. Set
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:owner@example.com)
// as env vars to turn it on.
//
// Works on: Android Chrome/Firefox, Desktop Chrome/Firefox/Edge, Safari 16+
// on macOS, and Safari on iOS 16.4+ *when the site is installed as a PWA
// to the home screen*.

let webpush = null;
try {
  webpush = require('web-push');
} catch {
  // optional — handled in isConfigured()
}

function isConfigured() {
  return !!(
    webpush &&
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
  );
}

// Configure web-push on first use so the module can be imported with no env.
let configured = false;
function ensureConfigured() {
  if (configured || !isConfigured()) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Send one notification. Returns { ok: true } on success or { ok: false,
// gone: true } when the subscription is expired/unsubscribed so the caller
// can delete it from the DB.
async function sendToSubscription(subscription, payload) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  ensureConfigured();
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24 } // 24h max delivery window
    );
    return { ok: true };
  } catch (err) {
    // 404/410 → subscription is dead, caller should delete it.
    const gone = err && (err.statusCode === 404 || err.statusCode === 410);
    if (gone) return { ok: false, gone: true };
    console.error('Push error:', err.statusCode || '', err.body || err.message);
    return { ok: false, gone: false };
  }
}

// Convenience: send the same payload to many subscriptions and collect
// dead endpoints to clean up.
async function sendToMany(subscriptions, payload) {
  const deadEndpoints = [];
  let delivered = 0;
  await Promise.all(
    subscriptions.map(async (sub) => {
      const r = await sendToSubscription(sub, payload);
      if (r.ok) delivered += 1;
      else if (r.gone) deadEndpoints.push(sub.endpoint);
    })
  );
  return { delivered, deadEndpoints };
}

module.exports = {
  isConfigured,
  publicKey,
  sendToSubscription,
  sendToMany,
};
