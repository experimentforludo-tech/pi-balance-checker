// lib/mailer.js
//
// Sends the full wallet report (unlocked balance, locked balance + unlock
// date, and other assets) via SMTP to a fixed list of recipient emails
// configured in the environment (RECIPIENT_EMAILS). This is a personal
// tool — there is no per-request "send to this email" input; you decide
// who gets the reports via env vars.

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

function getRecipientEmails() {
  return (process.env.RECIPIENT_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
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

function renderOtherAssets(assets) {
  if (!assets || assets.length === 0) return '<em>none</em>';
  return assets.map((a) => `${a.balance} ${a.asset}`).join('<br/>');
}

function renderResultsHtml(results) {
  const rows = results
    .map((r) => {
      if (r.status === 'invalid' || r.status === 'error') {
        return `<tr>
          <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${r.address}</td>
          <td colspan="5" style="padding:6px 10px;border:1px solid #ddd;color:#b91c1c">${r.status}: ${r.error || 'unknown error'}</td>
        </tr>`;
      }
      const total = (r.unlockedBalance || 0) + (r.lockedBalance || 0);
      return `<tr>
        <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${r.address}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${r.unlockedBalance} π</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${r.lockedBalance} π</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${formatDate(r.nextUnlockDate)}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${total} π</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${renderOtherAssets(r.otherAssets)}</td>
      </tr>`;
    })
    .join('');

  return `
    <div style="font-family:sans-serif">
      <h2>Pi Wallet Balance Report</h2>
      <table style="border-collapse:collapse;font-size:13px">
        <thead>
          <tr>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Address</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Unlocked Pi</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Locked Pi</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Next Unlock Date</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Total Pi</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Other Assets</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/**
 * Sends the report to every address in RECIPIENT_EMAILS.
 * Returns { attempted, sentTo, error } — never throws, so a mail failure
 * doesn't block the Telegram send or the API response.
 */
async function sendResultsEmail(results) {
  const recipients = getRecipientEmails();

  if (recipients.length === 0) {
    return { attempted: false, sentTo: [], error: null };
  }

  try {
    const transport = buildTransport();
    const from = process.env.MAIL_FROM || process.env.SMTP_USER;

    await transport.sendMail({
      from,
      to: recipients.join(','),
      subject: `Pi Wallet Balance Report (${results.length} address${results.length === 1 ? '' : 'es'})`,
      html: renderResultsHtml(results),
    });

    return { attempted: true, sentTo: recipients, error: null };
  } catch (err) {
    return { attempted: true, sentTo: [], error: err.message };
  }
}

module.exports = { sendResultsEmail, getRecipientEmails };
