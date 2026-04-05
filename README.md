# ☕ Coffee Shop Loyalty System

A lightweight, self-contained loyalty system for a coffee shop.

- Customers scan a **shop QR code** on the counter → register with name + Omani mobile number (`+968 7/9XXXXXXX`).
- They get a personal loyalty card with a QR code they show on every visit.
- The **barista** opens the barista console on a phone/tablet, scans the customer's QR, and taps **+ Add drink**.
- After **6 paid drinks**, the 7th is automatically awarded as **free** and the stamp card resets.
- Optional **Apple Wallet** (`.pkpass`) and **Google Wallet** "Save to Wallet" links so the card lives in the customer's phone.

Built with Node.js + Express + SQLite. No external database, no build step, works on a $5 VPS or a Raspberry Pi.

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
- `http://localhost:3000/barista.html` — staff scanner. Login with `BARISTA_PIN`.
- `http://localhost:3000/shop-qr.png` — a printable PNG of your shop QR. Print it, laminate it, put it on the counter.

## How the flow works

1. **Print the shop QR** (`/shop-qr.png`). It encodes `BASE_URL/register.html`.
2. A customer scans it with their phone camera → registration page opens.
3. They enter name + Omani mobile number → the server creates a `customer` row and issues a long-lived signed JWT (10 years).
4. The browser redirects to `/card.html#<token>`. The token is in the URL **fragment** so it is never sent to logs or proxies. Tell the customer to bookmark the page or add it to Apple/Google Wallet.
5. At the counter, the barista opens `/barista.html` on their device, enters the staff PIN once per 12 hours, then scans the customer's QR.
6. Tapping **+ Add drink** calls `/api/barista/purchase`. The backend records a paid drink; if the counter reaches `DRINKS_REQUIRED` (default 6), it also inserts a `free` row and resets the stamp card.

## Omani phone number validation

Accepted formats (all normalized to `+968XXXXXXXX`):

- `+968 9123 4567`
- `968 91234567`
- `91234567`
- `71234567`

Only mobile prefixes (`7` and `9`) are allowed.

## Security model

- **Customer token**: JWT signed with `JWT_SECRET`, embedded in QR code. Anyone with the token can view that customer's card — this is intentional so baristas can scan it. It cannot be used to make purchases (only the barista endpoints can, and those require staff auth).
- **Barista auth**: PIN-based. Successful login returns a 12h JWT that the browser keeps in `sessionStorage`. Rate-limited (10 attempts / 15 min). Use a non-trivial PIN in production.
- **Rate limits**: Registration is capped at 20 req/hour per IP.
- **Data stored**: only `name`, `phone`, and purchase timestamps. No payment info, no location, no tracking.

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
| `POST` | `/api/barista/login` | — | `{pin}` → `{token}` |
| `POST` | `/api/barista/scan` | barista | `{token}` → customer preview |
| `POST` | `/api/barista/purchase` | barista | `{token}` → records a drink, awards free when due |
| `GET` | `/api/wallet/apple/:token` | token | `.pkpass` download |
| `GET` | `/api/wallet/google/:token` | token | `{url}` to Google Wallet save page |

## Deploying

Any Node 20+ host works. Recommended:

- Put this behind HTTPS (Caddy, nginx + certbot, or a PaaS like Fly.io / Railway). Camera access in browsers **requires HTTPS**, otherwise the barista scanner will not work on a phone.
- Set `BASE_URL` to your public `https://…` URL before generating the shop QR.
- Back up `data/loyalty.db` regularly.
