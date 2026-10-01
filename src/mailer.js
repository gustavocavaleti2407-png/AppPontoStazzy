// Envio de e-mails pela API do Brevo (plano grátis: 300 e-mails/dia).
// A chave fica na variável de ambiente BREVO_API_KEY; destinatários e remetente ficam em Configurações.
const { getSettings } = require('./db');

function emailConfigured(s) {
  return !!(process.env.BREVO_API_KEY && s.email_from && s.notify_emails);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function sendEmail(subject, lines, settings) {
  const s = settings || await getSettings();
  if (!emailConfigured(s)) return { sent: false, reason: 'E-mail não configurado' };
  const to = s.notify_emails.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean).map(email => ({ email }));
  const html = `<div style="font-family:Arial,sans-serif;color:#2e2940">
    <h2 style="color:#6f55c9;margin:0 0 12px">${esc(s.company_name)} · Ponto</h2>
    ${lines.map(l => `<p style="margin:4px 0">${esc(l)}</p>`).join('')}
  </div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: s.email_from, name: `${s.company_name} Ponto` },
      to, subject, htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { sent: true };
}

// Envio em segundo plano: uma falha de e-mail nunca impede o registro do ponto.
function notify(subject, lines) {
  sendEmail(subject, lines).catch(e => console.error('Falha ao enviar e-mail:', e.message));
}

module.exports = { sendEmail, notify, emailConfigured };
