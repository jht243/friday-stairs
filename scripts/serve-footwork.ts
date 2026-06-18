/**
 * Friday Stairs site server.
 *
 * - Serves the static site at footwork/ on PORT (default 8771).
 * - Exposes POST /api/subscribe that forwards an email to Beehiiv V2.
 *
 * Run: tsx scripts/serve-footwork.ts
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Resend } from 'resend';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 8771);
const STATIC_ROOT = path.resolve(__dirname, '..', 'footwork');

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const BEEHIIV_PUB_ID = process.env.BEEHIIV_PUB_ID;

if (!BEEHIIV_API_KEY || !BEEHIIV_PUB_ID) {
  console.error(
    '[serve-footwork] Missing BEEHIIV_API_KEY or BEEHIIV_PUB_ID in .env — /api/subscribe will return 500 until set.'
  );
}

const app = express();
app.use(express.json({ limit: '32kb' }));

/**
 * POST /api/subscribe
 * Body: { email: string, source?: string }
 * Forwards to Beehiiv V2 create-subscription endpoint.
 */
app.post('/api/subscribe', async (req, res) => {
  const { email, source } = (req.body ?? {}) as { email?: string; source?: string };

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email.' });
  }
  if (!BEEHIIV_API_KEY || !BEEHIIV_PUB_ID) {
    return res.status(500).json({ ok: false, error: 'Server is not configured.' });
  }

  const url = `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUB_ID}/subscriptions`;
  // NOTE: send_welcome_email + reactivate_existing are kept FALSE while we
  // verify the integration. Flip to true only when you're ready for real
  // subscribers to receive Beehiiv's welcome email.
  const payload = {
    email,
    reactivate_existing: false,
    send_welcome_email: false,
    utm_source: source ?? 'fridaystairs.com',
    utm_medium: 'website',
    referring_site: 'fridaystairs.com',
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BEEHIIV_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text */
    }

    if (!resp.ok) {
      console.error('[subscribe] Beehiiv error', resp.status, body);
      return res
        .status(502)
        .json({ ok: false, error: 'Newsletter provider rejected the request.', detail: body });
    }

    const subscriberId = body?.data?.id ?? null;
    return res.json({ ok: true, subscriber_id: subscriberId, email, beehiiv: body });
  } catch (err: any) {
    console.error('[subscribe] network/fetch failure', err);
    return res.status(502).json({ ok: false, error: 'Failed to reach newsletter provider.' });
  }
});

/**
 * POST /api/profile
 * Body: {
 *   subscriber_id: string,    // Beehiiv subscription id returned from /api/subscribe
 *   answers: Record<string, string | string[]>,
 * }
 *
 * Patches the Beehiiv subscription's custom fields. Multi-select arrays are
 * joined into a comma-separated string for storage in a single text field.
 *
 * Requires these custom fields to exist on the publication (Beehiiv UI →
 * Settings → Custom Fields): birthday, gender, city_state, workouts_attended,
 * focus_area, investing_in, monthly_spend, brands_used, coming_back_for,
 * heard_about.
 */
app.post('/api/profile', async (req, res) => {
  const { subscriber_id, answers } = (req.body ?? {}) as {
    subscriber_id?: string;
    answers?: Record<string, string | string[] | undefined>;
  };

  if (!subscriber_id || typeof subscriber_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing subscriber_id.' });
  }
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing answers.' });
  }
  if (!BEEHIIV_API_KEY || !BEEHIIV_PUB_ID) {
    return res.status(500).json({ ok: false, error: 'Server is not configured.' });
  }

  const allowedFields = [
    'birthday',
    'gender',
    'city_state',
    'workouts_attended',
    'focus_area',
    'investing_in',
    'monthly_spend',
    'brands_used',
    'coming_back_for',
    'heard_about',
  ];

  const customFieldValues = allowedFields
    .map((name) => {
      const raw = answers[name];
      if (raw === undefined || raw === null || raw === '') return null;
      const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
      if (!value.trim()) return null;
      return { name, value };
    })
    .filter(Boolean);

  if (customFieldValues.length === 0) {
    return res.status(400).json({ ok: false, error: 'No answers to save.' });
  }

  const url = `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUB_ID}/subscriptions/${subscriber_id}`;
  try {
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BEEHIIV_API_KEY}`,
      },
      body: JSON.stringify({ custom_field_values: customFieldValues }),
    });
    const text = await resp.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text */
    }
    if (!resp.ok) {
      console.error('[profile] Beehiiv error', resp.status, body);
      return res
        .status(502)
        .json({ ok: false, error: 'Newsletter provider rejected the profile update.', detail: body });
    }
    return res.json({ ok: true, beehiiv: body });
  } catch (err: any) {
    console.error('[profile] network/fetch failure', err);
    return res.status(502).json({ ok: false, error: 'Failed to reach newsletter provider.' });
  }
});

/**
 * POST /api/partner-inquiry
 * Body: { name, company, email, interest, message }
 * Sends a formatted email to fridaystairs@gmail.com via Resend.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? 'jonathan@layer3labs.io';
const PARTNER_TO_EMAIL = 'info@fridaystairs.co';

app.post('/api/partner-inquiry', async (req, res) => {
  const { name, company, email, interest, message } = (req.body ?? {}) as {
    name?: string; company?: string; email?: string; interest?: string; message?: string;
  };

  if (!name || !company || !email) {
    return res.status(400).json({ ok: false, error: 'Name, company, and email are required.' });
  }
  if (!RESEND_API_KEY) {
    console.error('[partner-inquiry] Missing RESEND_API_KEY');
    return res.status(500).json({ ok: false, error: 'Server is not configured for email.' });
  }

  const resend = new Resend(RESEND_API_KEY);

  const html = `
    <h2>New Partnership Inquiry</h2>
    <table cellpadding="6" cellspacing="0">
      <tr><td><strong>Name</strong></td><td>${name}</td></tr>
      <tr><td><strong>Company</strong></td><td>${company}</td></tr>
      <tr><td><strong>Email</strong></td><td><a href="mailto:${email}">${email}</a></td></tr>
      <tr><td><strong>Interest</strong></td><td>${interest ?? '—'}</td></tr>
      <tr><td><strong>Message</strong></td><td style="white-space:pre-wrap">${message ?? '—'}</td></tr>
    </table>
  `;

  try {
    const { error } = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: PARTNER_TO_EMAIL,
      replyTo: email,
      subject: `Partnership inquiry from ${name} at ${company}`,
      html,
    });

    if (error) {
      console.error('[partner-inquiry] Resend error', error);
      return res.status(502).json({ ok: false, error: 'Failed to send email.' });
    }

    return res.json({ ok: true });
  } catch (err: any) {
    console.error('[partner-inquiry] unexpected error', err);
    return res.status(502).json({ ok: false, error: 'Failed to send email.' });
  }
});

// Static files last so /api/* wins.
app.use(express.static(STATIC_ROOT, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`[serve-footwork] http://localhost:${PORT}  →  ${STATIC_ROOT}`);
});
