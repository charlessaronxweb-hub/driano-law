require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Config (set these as Environment Variables on Render) ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY;       // from resend.com
const FROM_EMAIL = process.env.FROM_EMAIL;                // e.g. "Website <onboarding@resend.dev>" or your verified domain sender
const TO_EMAIL = process.env.TO_EMAIL;                     // Atty. Adriano's real inbox

// ---------- Startup debug (safe — never logs the full key) ----------
function maskKey(key) {
  if (!key) return '(not set)';
  const trimmed = key.trim();
  const hasWhitespace = trimmed !== key;
  return `len=${key.length} starts="${key.slice(0, 5)}" ends="${key.slice(-3)}" trimMismatch=${hasWhitespace}`;
}
console.log('RESEND_API_KEY check:', maskKey(RESEND_API_KEY));
console.log('FROM_EMAIL:', FROM_EMAIL || '(not set)');
console.log('TO_EMAIL:', TO_EMAIL || '(not set)');

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

// Very small rate limiter: max 5 submissions per IP per 10 minutes
const submissionLog = new Map(); // ip -> [timestamps]
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = 5;
  const timestamps = (submissionLog.get(ip) || []).filter(t => now - t < windowMs);
  timestamps.push(now);
  submissionLog.set(ip, timestamps);
  return timestamps.length > max;
}

// ---------- Email sending via Resend ----------
async function sendEmail({ name, email, matter, message }) {
  if (!RESEND_API_KEY || !FROM_EMAIL || !TO_EMAIL) {
    console.warn('Email not sent: RESEND_API_KEY, FROM_EMAIL, or TO_EMAIL is not configured.');
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [TO_EMAIL],
      reply_to: email,
      subject: `New website inquiry — ${matter}`,
      html: `
        <div style="font-family:Georgia,'Times New Roman',serif;max-width:600px;margin:0 auto;background:#F2ECD9;">
          <div style="background:#211D14;padding:28px 32px;text-align:center;">
            <p style="margin:0;color:#C9A24E;font-family:Consolas,Menlo,monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;">New Website Inquiry</p>
            <h1 style="margin:8px 0 0;color:#F2ECD9;font-size:22px;font-weight:500;">Adriano Law Office</h1>
          </div>
          <div style="padding:32px;background:#FBF8EE;">
            <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;">
              <tr>
                <td style="padding:12px 0;border-bottom:1px dashed rgba(33,29,20,0.25);width:110px;vertical-align:top;">
                  <span style="font-family:Consolas,Menlo,monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#7A2430;font-weight:bold;">Name</span>
                </td>
                <td style="padding:12px 0;border-bottom:1px dashed rgba(33,29,20,0.25);color:#211D14;font-size:15px;">${escapeHtml(name)}</td>
              </tr>
              <tr>
                <td style="padding:12px 0;border-bottom:1px dashed rgba(33,29,20,0.25);vertical-align:top;">
                  <span style="font-family:Consolas,Menlo,monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#7A2430;font-weight:bold;">Email</span>
                </td>
                <td style="padding:12px 0;border-bottom:1px dashed rgba(33,29,20,0.25);font-size:15px;"><a href="mailto:${escapeHtml(email)}" style="color:#211D14;">${escapeHtml(email)}</a></td>
              </tr>
              <tr>
                <td style="padding:12px 0;border-bottom:1px dashed rgba(33,29,20,0.25);vertical-align:top;">
                  <span style="font-family:Consolas,Menlo,monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#7A2430;font-weight:bold;">Matter</span>
                </td>
                <td style="padding:12px 0;border-bottom:1px dashed rgba(33,29,20,0.25);font-size:15px;color:#211D14;">${escapeHtml(matter)}</td>
              </tr>
            </table>
            <div style="margin-top:24px;">
              <span style="font-family:Consolas,Menlo,monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#7A2430;font-weight:bold;">Message</span>
              <p style="margin:10px 0 0;padding:16px 18px;background:#F2ECD9;border-left:3px solid #C9A24E;border-radius:6px;color:#211D14;font-size:14.5px;line-height:1.6;font-family:Arial,sans-serif;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>
            </div>
          </div>
          <div style="padding:18px 32px;background:#E9E0C6;text-align:center;">
            <p style="margin:0;font-family:Consolas,Menlo,monospace;font-size:11px;color:#5C5442;">Reply directly to this email to respond to ${escapeHtml(name.split(' ')[0] || 'the sender')}.</p>
          </div>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errText}`);
  }
  return res.json();
}

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------- Routes ----------

// Health check (useful for Render)
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Submit contact form
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, matter, message, website } = req.body || {};

    // Honeypot field — real users never fill this in; bots often do
    if (website) {
      return res.status(200).json({ ok: true }); // pretend success, drop silently
    }

    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: 'Name, email, and message are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please provide a valid email address.' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (isRateLimited(ip)) {
      return res.status(429).json({ ok: false, error: 'Too many submissions. Please try again later.' });
    }

    const entry = {
      name: String(name).slice(0, 200),
      email: String(email).slice(0, 200),
      matter: String(matter || 'Other').slice(0, 200),
      message: String(message).slice(0, 5000),
    };

    try {
      await sendEmail(entry);
    } catch (emailErr) {
      console.error('Failed to send notification email:', emailErr.message);
      return res.status(500).json({ ok: false, error: 'Could not send your message right now. Please try again or contact directly.' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error handling contact submission:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong. Please try again later.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

