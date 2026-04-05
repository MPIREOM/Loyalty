# ☕ Coffee Shop Loyalty System

A lightweight, self-contained loyalty system for a coffee shop.

- Customers scan a **shop QR code** on the counter → register with name + Omani mobile number (`+968 7/9XXXXXXX`).
- They get a personal loyalty card with a QR code they show on every visit.
- The **barista** logs in with their own mobile number (whitelisted by the owner once), receives a 6-digit code, then scans each customer's QR and taps **+ Add drink**. Their device stays signed in for 30 days.
- After **6 paid drinks**, the 7th is automatically awarded as **free** and the stamp card resets.
- Optional **Apple Wallet** (`.pkpass`) and **Google Wallet** "Save to Wallet" links so the card lives in the customer's phone.

Built with Node.js + Express + Node's built-in SQLite (`node:sqlite`). No native compilation, no external database, no build step. Works on a $5 VPS or a Raspberry Pi.

**Requires Node.js 22.5 or newer** (for the built-in `node:sqlite` module). The latest LTS is recommended.

---

## Quick start

```bash
cp .env.example .env
# edit .env — at minimum set JWT_SECRET, BARISTA_PIN, SHOP_NAME, BASE_URL
npm install
npm start
```

Open:

- `http://localhost:3000/register.html` — customer registration (this is what the shop QR points to).
- `http://localhost:3000/card.html#<token>` — customer's personal card (the registration flow redirects here automatically).
- `http://localhost:3000/barista.html` — staff scanner. Each barista signs in with their own mobile number (whitelisted via `BARISTA_PHONES`) and a one-time code.
- `http://localhost:3000/dashboard.html` — owner dashboard (totals, drinks today/week/month, top customers, activity feed, per-barista breakdown). Sign-in is the same phone + OTP flow, but only numbers in `OWNER_PHONES` can see it.
- `http://localhost:3000/shop-qr.png` — a printable PNG of your shop QR. Print it, laminate it, put it on the counter.

## How the flow works

1. **Print the shop QR** (`/shop-qr.png`). It encodes `BASE_URL/register.html`.
2. A customer scans it with their phone camera → registration page opens.
3. They enter name + Omani mobile number → the server creates a `customer` row and issues a long-lived signed JWT (10 years).
4. The browser redirects to `/card.html#<token>`. The token is in the URL **fragment** so it is never sent to logs or proxies. Tell the customer to bookmark the page or add it to Apple/Google Wallet.
5. At the counter, the barista opens `/barista.html` on their own phone, enters their mobile number, receives a 6-digit OTP, and is signed in for 30 days.
6. They scan the customer's QR and tap **+ Add drink**. The backend records a paid drink attributed to that barista; if the counter reaches `DRINKS_REQUIRED` (default 6), it also inserts a `free` row and resets the stamp card.

## Barista accounts

You (the owner) don't issue PINs or manage accounts. Just put the staff phone numbers in `.env`:

```
BARISTA_PHONES=+96891234567:Ahmed,+96899887766:Sara
OWNER_PHONES=+96890000000:The Boss
```

Owners can do everything a barista can **and** can sign in to `/dashboard.html` to see totals, top customers, and activity. A phone number appearing in both lists is automatically upgraded to owner.

On every server start, the list is upserted — so to add someone new, append them and restart. Numbers are matched against the Omani format (same validation as customers). Everything after the colon is the display name, attached to each purchase for your records.

### OTP delivery

When a barista taps **Send code**, the server generates a 6-digit code (valid 5 min, max 5 attempts) and calls `sms.js` to deliver it.

- **No config** → the code is printed to the server console. Perfect for your very first setup: read the log, tell the barista the code once, they log in, and their device is remembered for 30 days.
- **`SMS_WEBHOOK_URL` set** → the server POSTs `{phone, message}` as JSON (with an optional `Authorization: Bearer $SMS_WEBHOOK_SECRET` header) to any provider you like — Twilio, MessageBird, a WhatsApp Business API bot, or an in-house SMS gateway. No provider lock-in.

Example minimal webhook that forwards to Twilio:

```js
app.post('/sms', async (req, res) => {
  const { phone, message } = req.body;
  await twilio.messages.create({ from: TWILIO_NUMBER, to: phone, body: message });
  res.sendStatus(200);
});
```

## Omani phone number validation

Accepted formats (all normalized to `+968XXXXXXXX`):

- `+968 9123 4567`
- `968 91234567`
- `91234567`
- `71234567`

Only mobile prefixes (`7` and `9`) are allowed.

## Security model

- **Customer token**: JWT signed with `JWT_SECRET`, embedded in QR code. Anyone with the token can view that customer's card — this is intentional so baristas can scan it. It cannot be used to make purchases (only the barista endpoints can, and those require staff auth).
- **Barista auth**: phone + OTP. Only numbers in `BARISTA_PHONES` can request a code. Codes are 6 digits, SHA-256 hashed at rest, expire in 5 minutes, and lock after 5 wrong attempts. Successful verification returns a 30-day JWT bound to the barista's id; every protected request re-checks the barista is still active (so removing a staff member from `BARISTA_PHONES` + setting `active=0` in the DB revokes them immediately).
- **Rate limits**: registration 20/hr per IP, OTP requests 10/15min, OTP verifications 20/15min.
- **Data stored**: only `name`, `phone`, barista display names, and purchase timestamps. No payment info, no location, no tracking.

## Apple Wallet setup (optional)

Apple Wallet passes must be signed with a certificate issued by Apple.

1. Enroll in the Apple Developer Program.
2. Create a **Pass Type ID** at <https://developer.apple.com/account/resources/identifiers/list/passTypeId>.
3. Generate a Pass Type ID certificate and export it plus its private key as PEM:
   ```bash
   openssl pkcs12 -in Certificates.p12 -clcerts -nokeys -out signerCert.pem
   openssl pkcs12 -in Certificates.p12 -nocerts -out signerKey.pem
   ```
4. Download the [Apple WWDR certificate](https://www.apple.com/certificateauthority/) and convert to PEM.
5. Put all three files under `./certs/`.
6. Create a `./certs/pass.model/` directory containing your `pass.json` template (with `storeCard` style) and branding assets: `icon.png`, `icon@2x.png`, `logo.png`, `logo@2x.png`. See <https://developer.apple.com/documentation/walletpasses>.
7. Fill in the `APPLE_*` variables in `.env` and restart the server.

When configured, the customer's card page will show an **Add to Apple Wallet** button that downloads a freshly-signed `.pkpass` file.

## Google Wallet setup (optional)

1. Enable the **Google Wallet API** in a Google Cloud project.
2. Create a service account, download its JSON key into `./certs/google-service-account.json`, and grant it **Wallet Object Issuer** access in the [Google Pay & Wallet Console](https://pay.google.com/business/console).
3. Create a **Loyalty Class** once (via API or the REST playground) — e.g. `{issuerId}.coffee_loyalty_class` — with your branding.
4. Fill in `GOOGLE_ISSUER_ID` and `GOOGLE_CLASS_ID` in `.env`.

The card page will then show a **Save to Google Wallet** button which hits `/api/wallet/google/:token` and opens `https://pay.google.com/gp/v/save/<jwt>`.

> **Note on live updates**: refreshing the stamp count inside the wallet pass (so it updates automatically after a scan) requires Apple's APNs push for `.pkpass` and Google's Wallet Object `update` API. Both require additional registration endpoints; not wired up here. For now the in-wallet pass is a snapshot — but `/card.html` always shows live data and auto-refreshes every 30 s, which is usually good enough for a small shop.

## Project layout

```
.
├── server.js              # Express app — all routes
├── db.js                  # SQLite schema + data access
├── sms.js                 # OTP delivery: console or webhook
├── wallet/
│   ├── apple.js           # .pkpass generation (passkit-generator)
│   └── google.js          # Google Wallet save-link JWT
├── public/
│   ├── register.html      # Customer registration form
│   ├── card.html          # Customer loyalty card (QR + stamps + wallet buttons)
│   ├── barista.html       # Staff scanner console
│   └── styles.css
├── data/loyalty.db        # created at runtime
├── .env.example
├── package.json
└── README.md
```

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/config` | — | Shop name, drinks-required, wallet availability |
| `POST` | `/api/register` | — | `{name, phone}` → `{id, token}` |
| `GET` | `/api/card/:token` | token | Customer details + stats + recent purchases |
| `GET` | `/api/qr/:token` | token | PNG of the customer's QR |
| `GET` | `/shop-qr.png` | — | PNG of the shop registration QR |
| `POST` | `/api/barista/request-code` | — | `{phone}` → sends OTP to whitelisted staff phone |
| `POST` | `/api/barista/verify-code` | — | `{phone, code}` → `{token, name}` (30-day JWT) |
| `POST` | `/api/barista/scan` | barista | `{token}` → customer preview |
| `POST` | `/api/barista/purchase` | barista | `{token}` → records a drink, awards free when due |
| `GET` | `/api/wallet/apple/:token` | token | `.pkpass` download |
| `GET` | `/api/wallet/google/:token` | token | `{url}` to Google Wallet save page |

## Deploying

Any Node 20+ host works. Recommended:

- Put this behind HTTPS (Caddy, nginx + certbot, or a PaaS like Fly.io / Railway). Camera access in browsers **requires HTTPS**, otherwise the barista scanner will not work on a phone.
- Set `BASE_URL` to your public `https://…` URL before generating the shop QR.
- Back up `data/loyalty.db` regularly.
