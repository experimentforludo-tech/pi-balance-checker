// lib/mailer.js
//
// Sends the balance-check results via SMTP using nodemailer.
// Configure SMTP credentials through environment variables (see .env.example).
// Works with any SMTP provider (Gmail app password, SendGrid, Mailgun, Postmark, etc).

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
    secure: SMTP_SECURE === 'true', // true for port 465, false for 587/25
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function renderResultsHtml(results) {
  const rows = results
    .map((r) => {
      const balanceCell =
        r.status === 'ok' || r.status === 'not_found'
          ? `${r.balance} π`
          : `<span style="color:#b91c1c">${r.error || 'error'}</span>`;
      return `<tr>
        <td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;font-size:12px">${r.address}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${r.status}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${balanceCell}</td>
      </tr>`;
    })
    .join('');

  return `
    <div style="font-family:sans-serif">
      <h2>Pi Wallet Balance Report</h2>
      <table style="border-collapse:collapse">
        <thead>
          <tr>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Address</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Status</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Balance</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function sendResultsEmail(toEmail, results) {
  const transport = buildTransport();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  await transport.sendMail({
    from,
    to: toEmail,
    subject: `Pi Wallet Balance Report (${results.length} address${results.length === 1 ? '' : 'es'})`,
    html: renderResultsHtml(results),
  });
}

module.exports = { sendResultsEmail };
