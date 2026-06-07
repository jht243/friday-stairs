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

    return res.json({ ok: true, beehiiv: body });
  } catch (err: any) {
    console.error('[subscribe] network/fetch failure', err);
    return res.status(502).json({ ok: false, error: 'Failed to reach newsletter provider.' });
  }
});

// Static files last so /api/* wins.
app.use(express.static(STATIC_ROOT, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`[serve-footwork] http://localhost:${PORT}  →  ${STATIC_ROOT}`);
});
