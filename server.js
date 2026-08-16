// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const path = require('path');
const { getAccountsDetails } = require('./lib/piExplorer');
const { sendResultsEmail } = require('./lib/mailer');
const { sendResultsToTelegram } = require('./lib/telegram');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_ADDRESSES_PER_REQUEST = Number(process.env.MAX_ADDRESSES_PER_REQUEST) || 100;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

// Serves the bundled frontend (public/index.html) at "/"
app.use(express.static(path.join(__dirname, 'public')));

// Basic abuse protection: 10 requests/hour per IP for the email-sending route.
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /api/check-balances
 * Body: { addresses: string[], email: string }
 *
 * For each address, looks up:
 *   - unlocked (available) Pi balance
 *   - locked Pi balance + next unlock date (+ full lockup breakdown)
 *   - every other asset held in the wallet
 * via the Pi Blockchain (Horizon-compatible) API. Emails the full report to
 * `email`, pushes it to any configured Telegram chats, and also returns the
 * results directly in the response for the frontend to render.
 */
app.post('/api/check-balances', limiter, async (req, res) => {
  const { addresses, email } = req.body || {};

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
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  try {
    const results = await getAccountsDetails(addresses);

    // Don't let an email or Telegram delivery failure hide the balance
    // results from the caller — the frontend should still get the data.
    let emailStatus = 'sent';
    try {
      await sendResultsEmail(email.trim(), results);
    } catch (mailErr) {
      console.error('Failed to send results email:', mailErr);
      emailStatus = 'failed';
    }

    let telegram = { attempted: false, deliveries: [] };
    try {
      telegram = await sendResultsToTelegram(results, { requestedBy: email.trim() });
    } catch (tgErr) {
      console.error('Failed to send Telegram notifications:', tgErr);
    }

    return res.json({ results, emailStatus, sentTo: email.trim(), telegram });
  } catch (err) {
    console.error('Unexpected error checking balances:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Pi balance checker listening on port ${PORT}`);
});
