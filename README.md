# Pi Wallet Balance Checker

Node.js/Express backend + a small bundled frontend that, for each Pi wallet address given:
1. Looks up the **unlocked (available) Pi balance**
2. Looks up the **locked Pi balance** and its **unlock date(s)**
3. Looks up **every other asset** the wallet holds (any non-Pi tokens)
4. Emails the full report to a given address
5. Sends the same report to one or more **Telegram** chats/accounts
6. Displays the results live on the **frontend** (bundled at `/`, or call the API from your own frontend)

All data comes from the Pi Blockchain API (same data source as blockexplorer.minepi.com).

## How the balance lookup works

Pi Mainnet is a fork of Stellar and exposes a Horizon-compatible REST API at
`https://api.mainnet.minepi.com` — the same API the public Pi Block Explorer
reads from. For each address, the server makes two calls:

**1. Unlocked balance + other assets**
```
GET https://api.mainnet.minepi.com/accounts/{address}
```
The `balances[]` array in the response contains the `native` entry (unlocked/
available Pi) plus an entry for every other asset the wallet holds. Addresses
that are well-formed but never activated on-chain return a 404, treated as
all-zero balances.

**2. Locked balance + unlock date(s)**
```
GET https://api.mainnet.minepi.com/claimable_balances?claimant={address}
```
Pi's lockup mechanism represents locked Pi as Stellar-style "claimable
balances" made out to the wallet, each carrying a claim predicate with a
`not: { abs_before: <timestamp> }` — that timestamp is the unlock date. A
wallet can have multiple lockup batches unlocking on different dates, so the
server sums them into a total `lockedBalance`, keeps the full per-batch
`lockedBreakdown`, and surfaces the earliest one as `nextUnlockDate`.

> **Note:** this assumes Pi's API mirrors stock Stellar Horizon behavior for
> claimable balances. If a wallet's locked total or unlock date ever looks
> off, cross-check the raw response against what
> [blockexplorer.minepi.com](https://blockexplorer.minepi.com) shows for that
> address — Pi's implementation could diverge from stock Horizon here.

## Project structure

```
pi-balance-checker/
├── server.js             # Express app + API route
├── public/
│   └── index.html         # Bundled frontend (served at "/")
├── lib/
│   ├── piExplorer.js       # Pi Blockchain API client (balance lookups)
│   ├── mailer.js            # Nodemailer wrapper for sending the email report
│   └── telegram.js          # Sends the report to multiple Telegram chats
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
    {
      "address": "GABC...ADDRESS1",
      "status": "ok",
      "unlockedBalance": 12.5,
      "lockedBalance": 340.75,
      "nextUnlockDate": "2026-11-03T00:00:00Z",
      "lockedBreakdown": [
        { "balanceId": "00000000abc123...", "amount": 200.0, "unlockDate": "2026-11-03T00:00:00Z" },
        { "balanceId": "00000000def456...", "amount": 140.75, "unlockDate": "2027-02-11T00:00:00Z" }
      ],
      "otherAssets": [
        { "asset": "USDT", "issuer": "GISSUER...", "balance": 50.0 }
      ],
      "error": null
    },
    {
      "address": "GXYZ...ADDRESS2",
      "status": "not_found",
      "unlockedBalance": 0,
      "lockedBalance": 0,
      "nextUnlockDate": null,
      "lockedBreakdown": [],
      "otherAssets": [],
      "error": null
    }
  ],
  "emailStatus": "sent",
  "sentTo": "someone@example.com",
  "telegram": {
    "attempted": true,
    "deliveries": [
      { "chatId": "111111111", "status": "sent", "error": null },
      { "chatId": "-100333333333", "status": "sent", "error": null }
    ]
  }
}
```

`status` is one of:
- `ok` — account found, all balances retrieved successfully
- `not_found` — well-formed address, never activated on-chain (all balances treated as 0)
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

### Telegram setup
1. Message **@BotFather** on Telegram → `/newbot` → copy the token it gives you into `TELEGRAM_BOT_TOKEN`.
2. For each account/group that should get the report:
   - Have that account send any message to your bot (or add the bot to the group and send a message there).
   - Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser — you'll see a `chat.id` field for each chat.
   - Collect all the chat ids into `TELEGRAM_CHAT_IDS`, comma-separated (e.g. `111111111,222222222,-100333333333`). Group chat ids are usually negative.
3. If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_IDS` are left unset, Telegram sending is simply skipped — the API still returns balances and sends email normally.

### Frontend
- A ready-to-use frontend is served automatically at your backend's root URL (`/`) — open `https://your-service.up.railway.app/` after deploying and it's live, no separate hosting needed.
- It's plain HTML/JS (`public/index.html`) with no build step, so it's easy to reskin or drop into your own site — just point `API_URL` in the `<script>` at your backend's `/api/check-balances` endpoint if hosting it separately.

## Notes / things to consider before production use

- The Pi Horizon API is public and unauthenticated — no API key needed, but it may
  rate-limit heavy traffic. Address lookups are batched with limited concurrency (5 at a time) to be considerate.
- Consider adding a CAPTCHA or auth check in front of `/api/check-balances` if it's public-facing, since it sends email on demand.
- Consider a job queue (e.g. BullMQ + Redis) if you expect large batches or want async processing instead of holding the HTTP request open until the email sends.
