// lib/telegram.js
//
// Sends the full wallet report to one or more Telegram targets using the
// Telegram Bot API (https://core.telegram.org/bots/api#sendmessage).
//
// Configure via TELEGRAM_TARGETS — a comma-separated list of "botToken:chatId"
// pairs. Real bot tokens already contain a colon (e.g. "123456789:AAtoken"),
// so each full entry looks like "123456789:AAtoken:111111111" — we split on
// the LAST colon to correctly separate the token from the chat id.
//
// Use 2-3 different bots (different tokens) or the same bot for multiple
// chat ids — whatever fits. Example with two targets:
//   TELEGRAM_TARGETS=123456789:AAtoken1:111111111,987654321:BBtoken2:-100222222222
//
// Setup per bot:
//   1. Talk to @BotFather on Telegram, create a bot, get its token.
//   2. Message that bot once (or add it to a group + post there), then visit
//      https://api.telegram.org/bot<TOKEN>/getUpdates to read the chat_id.

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Parses TELEGRAM_TARGETS into [{ botToken, chatId }, ...].
 * Splits each entry on the LAST colon, since bot tokens themselves contain
 * a colon (e.g. "123456789:AAExampleTokenHere").
 */
function getConfiguredTargets() {
  return (process.env.TELEGRAM_TARGETS || '')
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

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function renderResultsText(results) {
  const lines = results.map((r) => {
    const short = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;

    if (r.status === 'invalid' || r.status === 'error') {
      return `• \`${short}\` — ⚠️ ${r.status}${r.error ? ` (${r.error})` : ''}`;
    }

    const total = (r.unlockedBalance || 0) + (r.lockedBalance || 0);
    const otherAssets =
      r.otherAssets && r.otherAssets.length > 0
        ? r.otherAssets.map((a) => `${a.balance} ${a.asset}`).join(', ')
        : 'none';

    return [
      `• \`${short}\``,
      `   Unlocked: ${r.unlockedBalance} π`,
      `   Locked: ${r.lockedBalance} π (unlocks ${formatDate(r.nextUnlockDate)})`,
      `   Total: ${total} π`,
      `   Other assets: ${otherAssets}`,
    ].join('\n');
  });

  return ['*Pi Wallet Balance Report*', '', ...lines].join('\n\n');
}

/**
 * Send a single message chunk to one target. Never throws — returns a
 * result object so one bad/blocked target doesn't stop the others.
 */
async function sendToTarget(botToken, chatId, text) {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.ok === false) {
      return { chatId, status: 'failed', error: data.description || `HTTP ${res.status}` };
    }
    return { chatId, status: 'sent', error: null };
  } catch (err) {
    return { chatId, status: 'failed', error: err.message };
  }
}

/**
 * Broadcasts the balance results to every configured (botToken, chatId)
 * target. Telegram caps messages at 4096 characters, so large reports are
 * chunked into multiple messages per target.
 */
async function sendResultsToTelegram(results) {
  const targets = getConfiguredTargets();

  if (targets.length === 0) {
    return { attempted: false, deliveries: [] };
  }

  const fullText = renderResultsText(results);
  const CHUNK_LIMIT = 3500;
  const chunks = [];
  for (let i = 0; i < fullText.length; i += CHUNK_LIMIT) {
    chunks.push(fullText.slice(i, i + CHUNK_LIMIT));
  }

  const deliveries = await Promise.all(
    targets.map(async ({ botToken, chatId }) => {
      for (const chunk of chunks) {
        const result = await sendToTarget(botToken, chatId, chunk);
        if (result.status === 'failed') return result;
      }
      return { chatId, status: 'sent', error: null };
    })
  );

  return { attempted: true, deliveries };
}

module.exports = { sendResultsToTelegram, getConfiguredTargets };
