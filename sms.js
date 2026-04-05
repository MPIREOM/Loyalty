// Simple SMS sender abstraction.
//
// If SMS_WEBHOOK_URL is set, POSTs JSON {phone, message} to it so you can
// wire up any provider (Twilio, MessageBird, a WhatsApp bot, an in-house SMS
// gateway, etc.) without touching this code. If SMS_WEBHOOK_SECRET is set,
// it's sent as the Authorization: Bearer header.
//
// If no webhook is configured, the message is logged to the server console.
// That's fine for the very first barista setup — the owner can read the OTP
// from the logs and share it once. After that the barista's device stays
// signed in for 30 days.

async function sendSms(phone, message) {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) {
    console.log(`\n📱 [SMS -> ${phone}]\n${message}\n`);
    return { delivered: false, method: 'console' };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.SMS_WEBHOOK_SECRET) {
    headers.Authorization = `Bearer ${process.env.SMS_WEBHOOK_SECRET}`;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone, message }),
    });
    if (!res.ok) {
      console.error(`SMS webhook ${url} returned ${res.status}`);
      return { delivered: false, method: 'webhook', error: `HTTP ${res.status}` };
    }
    return { delivered: true, method: 'webhook' };
  } catch (e) {
    console.error('SMS webhook error:', e.message);
    return { delivered: false, method: 'webhook', error: e.message };
  }
}

module.exports = { sendSms };
