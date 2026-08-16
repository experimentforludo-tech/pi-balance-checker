// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { getAccountsDetails } = require('./lib/piExplorer');
const { sendResultsEmail } = require('./lib/mailer');
const { sendResultsToTelegram } = require('./lib/telegram');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_ADDRESSES_PER_REQUEST = Number(process.env.MAX_ADDRESSES_PER_REQUEST) || 100;

// This is a pure API server — it does NOT serve a frontend. Deploy the
// frontend/ folder separately (Netlify, Vercel, GitHub Pages, S3, anywhere
// that serves static files) and point it at this server's URL.
//
// CORS: set ALLOWED_ORIGIN to your frontend's origin(s). Comma-separate
// multiple origins if the frontend is hosted in more than one place.
// Use "*" only for local testing.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin:
      allowedOrigins.includes('*')
        ? '*'
        : (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            callback(new Error(`Origin ${origin} not allowed by CORS`));
          },
  })
);
app.use(express.json({ limit: '1mb' }));

// Personal tool: recipients are fixed via env vars, not supplied by whoever
// hits the API. See RECIPIENT_EMAILS and TELEGRAM_TARGETS in .env.example.
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /api/check-balances
 * Body: { addresses: string[] }
 *
 * For each address, looks up:
 *   - unlocked (available) Pi balance
 *   - locked Pi balance + next unlock date (+ full lockup breakdown)
 *   - every other asset held in the wallet
 * via the Pi Blockchain (Horizon-compatible) API. Emails the report to the
 * addresses configured in RECIPIENT_EMAILS and pushes it to every Telegram
 * target configured in TELEGRAM_TARGETS. Also returns the results directly
 * in the response for the frontend to render.
 */
app.post('/api/check-balances', limiter, async (req, res) => {
  const { addresses } = req.body || {};

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: 'addresses must be a non-empty array of strings' });
  }
  if (addresses.length > MAX_ADDRESSES_PER_REQUEST) {
    return res
      .status(400)
      .json({ error: `Too many addresses. Max ${MAX_ADDRESSES_PER_REQUEST} per request.` });
  }
  if (!addresses.every((a) => typeof a === 'string')) {
    return res.status(400).json({ error: 'Every address must be a string' });
  }

  try {
    const results = await getAccountsDetails(addresses);

    // Don't let an email or Telegram delivery failure hide the balance
    // results from the caller — the frontend should still get the data.
    let email = { attempted: false, sentTo: [], error: null };
    try {
      email = await sendResultsEmail(results);
    } catch (mailErr) {
      console.error('Failed to send results email:', mailErr);
      email = { attempted: true, sentTo: [], error: mailErr.message };
    }

    let telegram = { attempted: false, deliveries: [] };
    try {
      telegram = await sendResultsToTelegram(results);
    } catch (tgErr) {
      console.error('Failed to send Telegram notifications:', tgErr);
    }

    return res.json({ results, email, telegram });
  } catch (err) {
    console.error('Unexpected error checking balances:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Pi balance checker listening on port ${PORT}`);
});
