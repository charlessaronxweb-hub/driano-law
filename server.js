require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Config (set these as Environment Variables on Render) ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY;       // from resend.com
const FROM_EMAIL = process.env.FROM_EMAIL;                // e.g. "Website <onboarding@resend.dev>" or your verified domain sender
const TO_EMAIL = process.env.TO_EMAIL;                     // Atty. Adriano's real inbox

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
        <h2>New Inquiry from the Website</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Matter:</strong> ${escapeHtml(matter)}</p>
        <p><strong>Message:</strong></p>
        <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
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

