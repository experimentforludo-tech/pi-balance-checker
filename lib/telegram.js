// lib/telegram.js
//
// Sends the full wallet report to one or more Telegram chats using the
// Telegram Bot API (https://core.telegram.org/bots/api#sendmessage).
//
// Setup:
//   1. Talk to @BotFather on Telegram, create a bot, get its token.
//   2. For each account/group that should receive reports, get the chat_id:
//      - For a personal DM: message your bot once, then visit
//        https://api.telegram.org/bot<TOKEN>/getUpdates to read the chat id.
//      - For a group: add the bot to the group, send a message, same getUpdates trick.
//   3. Put the token in TELEGRAM_BOT_TOKEN and a comma-separated list of chat
//      ids in TELEGRAM_CHAT_IDS (e.g. "111111111,-100222222222").

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function getConfiguredChatIds() {
  return (process.env.TELEGRAM_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN) && getConfiguredChatIds().length > 0;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function renderResultsText(results, requestedBy) {
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

  const header = `*Pi Wallet Balance Report*${requestedBy ? ` (for ${requestedBy})` : ''}`;
  return [header, '', ...lines].join('\n\n');
}

/**
 * Send the report to a single chat id. Never throws — returns a result object
 * so one bad/blocked chat doesn't stop delivery to the others.
 */
async function sendToChat(botToken, chatId, text) {
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
 * Broadcast the balance results to every configured Telegram chat id.
 * Telegram messages are capped at 4096 characters — for large batches this
 * chunks the report into multiple messages per chat.
 */
async function sendResultsToTelegram(results, { requestedBy } = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = getConfiguredChatIds();

  if (!botToken || chatIds.length === 0) {
    return { attempted: false, deliveries: [] };
  }

  const fullText = renderResultsText(results, requestedBy);
  const CHUNK_LIMIT = 3500;
  const chunks = [];
  for (let i = 0; i < fullText.length; i += CHUNK_LIMIT) {
    chunks.push(fullText.slice(i, i + CHUNK_LIMIT));
  }

  const deliveries = await Promise.all(
    chatIds.map(async (chatId) => {
      for (const chunk of chunks) {
        const result = await sendToChat(botToken, chatId, chunk);
        if (result.status === 'failed') return result;
      }
      return { chatId, status: 'sent', error: null };
    })
  );

  return { attempted: true, deliveries };
}

module.exports = { sendResultsToTelegram, isTelegramConfigured, getConfiguredChatIds };
