# Pi Wallet Balance Checker

Node.js/Express backend that:
1. Accepts a list of Pi wallet public addresses + an email from your frontend
2. Looks up each address's Pi balance via the Pi Blockchain API (same data source as blockexplorer.minepi.com)
3. Emails a report of the results to the given address
4. Also returns the results directly in the HTTP response

## How the balance lookup works

Pi Mainnet is a fork of Stellar and exposes a Horizon-compatible REST API at
`https://api.mainnet.minepi.com`. This is the same API the public Pi Block
Explorer reads from. For each address, the server calls:

```
GET https://api.mainnet.minepi.com/accounts/{address}
```

and reads the `native` entry from the returned `balances` array. Addresses
that are well-formed but have never been activated on-chain return a 404
from Horizon, which is treated as a balance of `0`.

## Project structure

```
pi-balance-checker/
├── server.js           # Express app + API route
├── lib/
│   ├── piExplorer.js    # Pi Blockchain API client (balance lookups)
│   └── mailer.js         # Nodemailer wrapper for sending the report
├── package.json
├── .env.example
└── .gitignore
```

## Local setup

```bash
npm install
cp .env.example .env   # fill in your SMTP credentials
npm start
```

Server runs on `http://localhost:3000` by default.

## API

### `POST /api/check-balances`

**Request body:**
```json
{
  "addresses": [
    "GABC...ADDRESS1",
    "GXYZ...ADDRESS2"
  ],
  "email": "someone@example.com"
}
```

**Response:**
```json
{
  "results": [
    { "address": "GABC...ADDRESS1", "status": "ok", "balance": 3.14, "error": null },
    { "address": "GXYZ...ADDRESS2", "status": "not_found", "balance": 0, "error": null }
  ],
  "emailStatus": "sent",
  "sentTo": "someone@example.com"
}
```

`status` is one of:
- `ok` — balance retrieved successfully
- `not_found` — well-formed address, never activated on-chain (balance treated as 0)
- `invalid` — malformed address, never queried
- `error` — the explorer API call failed (see `error` field)

Rate limited to 10 requests/hour per IP by default (adjust in `server.js`).
Max addresses per request defaults to 100 (`MAX_ADDRESSES_PER_REQUEST` env var).

### Example frontend call

```js
const res = await fetch('https://your-backend.up.railway.app/api/check-balances', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    addresses: ['GABC...', 'GXYZ...'],
    email: 'someone@example.com',
  }),
});
const data = await res.json();
```

## Deploying to Railway

1. Push this project to a GitHub repo (or use `railway init` + `railway up` from the CLI).
2. In the Railway dashboard: **New Project → Deploy from GitHub repo**, select the repo.
3. Railway auto-detects Node.js and runs `npm install && npm start`. No changes needed —
   the server already binds to `process.env.PORT`, which Railway sets automatically.
4. Under your service's **Variables** tab, add the environment variables from `.env.example`:
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
   - `ALLOWED_ORIGIN` (your frontend's URL, for CORS)
   - Optionally `PI_HORIZON_BASE_URL`, `MAX_ADDRESSES_PER_REQUEST`
5. Deploy. Railway gives you a public URL like `https://your-service.up.railway.app`.
6. Point your frontend's `fetch` calls at that URL + `/api/check-balances`.

### SMTP provider notes
- **Gmail**: enable 2FA and create an [App Password](https://myaccount.google.com/apppasswords) — regular Gmail passwords won't work with SMTP.
- **SendGrid / Mailgun / Postmark**: use their SMTP relay credentials; these are more reliable for production/transactional email than Gmail.

## Notes / things to consider before production use

- The Pi Horizon API is public and unauthenticated — no API key needed, but it may
  rate-limit heavy traffic. Address lookups are batched with limited concurrency (5 at a time) to be considerate.
- Consider adding a CAPTCHA or auth check in front of `/api/check-balances` if it's public-facing, since it sends email on demand.
- Consider a job queue (e.g. BullMQ + Redis) if you expect large batches or want async processing instead of holding the HTTP request open until the email sends.
