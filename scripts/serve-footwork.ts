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
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

// ─────────────────────────────────────────────────────────────────────────────
// Partner-page stats micro-CMS
//
// The four stats on partnership.html live in Supabase (table:
// friday_stairs_partner_stats). The team edits them at /dashboard (gated by
// PARTNER_ADMIN_PASSWORD); the server injects the current values into the page
// HTML on every request.
// ─────────────────────────────────────────────────────────────────────────────
// Storage lives in Supabase via its REST API (PostgREST) — same approach as
// src/history.ts. The direct Postgres host (db.<ref>.supabase.co) is not
// reachable from every environment, so REST is the reliable path.
//   - Reads use the anon key (the table has a public SELECT policy).
//   - Writes use the service_role key (bypasses RLS); it is never sent to the
//     browser — the editor posts to our password-gated endpoint, and only the
//     server holds this key.
const STATS_URL = (process.env.PARTNER_STATS_SUPABASE_URL ?? '').replace(/\/$/, '');
const STATS_ANON_KEY = process.env.PARTNER_STATS_SUPABASE_ANON_KEY;
const STATS_SERVICE_KEY = process.env.PARTNER_STATS_SUPABASE_SERVICE_KEY;
const STATS_TABLE = 'friday_stairs_partner_stats';
const PARTNER_ADMIN_PASSWORD = process.env.PARTNER_ADMIN_PASSWORD;

// Prefer the service_role key for writes (bypasses RLS). Falls back to the anon
// key, which works because the table has an UPDATE-only policy for anon.
const STATS_WRITE_KEY = STATS_SERVICE_KEY || STATS_ANON_KEY;
const statsReadReady = Boolean(STATS_URL && (STATS_ANON_KEY || STATS_SERVICE_KEY));
const statsWriteReady = Boolean(STATS_URL && STATS_WRITE_KEY);

if (!statsReadReady) {
  console.error(
    '[serve-footwork] PARTNER_STATS_SUPABASE_URL/ANON_KEY not set — Partner stats fall back to the hard-coded HTML.'
  );
}
if (!statsWriteReady) {
  console.error(
    '[serve-footwork] No PARTNER_STATS_SUPABASE key set — the /dashboard editor cannot save until one is configured.'
  );
}
if (!PARTNER_ADMIN_PASSWORD) {
  console.error(
    '[serve-footwork] PARTNER_ADMIN_PASSWORD not set — the /dashboard editor will reject all saves until it is configured.'
  );
}

type PartnerStat = { position: number; value: string; label: string };

function statsHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function getPartnerStats(): Promise<PartnerStat[] | null> {
  const key = STATS_ANON_KEY || STATS_SERVICE_KEY;
  if (!STATS_URL || !key) return null;
  try {
    const res = await fetch(
      `${STATS_URL}/rest/v1/${STATS_TABLE}?select=position,value,label&order=position.asc`,
      { headers: statsHeaders(key) }
    );
    if (!res.ok) {
      console.error('[partner-stats] read failed', res.status, await res.text().catch(() => ''));
      return null;
    }
    return (await res.json()) as PartnerStat[];
  } catch (err) {
    console.error('[partner-stats] read failed', err);
    return null;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatItems(stats: PartnerStat[]): string {
  return stats
    .map(
      (s) =>
        `\n          <div class="stat-item">\n` +
        `            <div class="stat-number">${escapeHtml(s.value)}</div>\n` +
        `            <div class="stat-desc">${escapeHtml(s.label)}</div>\n` +
        `          </div>`
    )
    .join('');
}

// Constant-time password check that never throws on length mismatch.
function passwordOk(supplied: unknown): boolean {
  if (!PARTNER_ADMIN_PASSWORD || typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(PARTNER_ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Serve partnership.html with the live stats injected between the markers.
// Falls back to the file as-is (hard-coded stats) if the DB is unavailable.
async function servePartnerPage(_req: express.Request, res: express.Response) {
  const filePath = path.join(STATIC_ROOT, 'partnership.html');
  let html: string;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch {
    return res.status(404).send('Not found');
  }

  const stats = await getPartnerStats();
  if (stats && stats.length) {
    html = html.replace(
      /<!--PARTNER_STATS-->[\s\S]*?<!--\/PARTNER_STATS-->/,
      `<!--PARTNER_STATS-->${renderStatItems(stats)}\n        <!--/PARTNER_STATS-->`
    );
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  return res.send(html);
}

app.get(['/partnership', '/partnership.html'], servePartnerPage);

/**
 * POST /api/dashboard-login
 * Body: { password: string }
 * Password-only gate for the /dashboard editor. Returns { ok: true } on match.
 * The actual save is independently re-verified server-side, so this is just the
 * front-door check that reveals the editor.
 */
app.post('/api/dashboard-login', (req, res) => {
  const { password } = (req.body ?? {}) as { password?: string };
  if (!PARTNER_ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'The dashboard password is not configured yet.' });
  }
  if (!passwordOk(password)) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }
  return res.json({ ok: true });
});

/**
 * GET /api/partner-stats
 * Public read — returns the current four stats (used by the editor to populate
 * its form). No secrets exposed.
 */
app.get('/api/partner-stats', async (_req, res) => {
  const stats = await getPartnerStats();
  if (!stats) return res.status(503).json({ ok: false, error: 'Stats storage is unavailable.' });
  return res.json({ ok: true, stats });
});

/**
 * POST /api/partner-stats
 * Body: { password: string, stats: [{ position, value, label }, ...] }
 * Password-gated. Updates the four stats in place.
 */
app.post('/api/partner-stats', async (req, res) => {
  const { password, stats } = (req.body ?? {}) as { password?: string; stats?: PartnerStat[] };

  if (!passwordOk(password)) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }
  if (!statsWriteReady) {
    return res.status(503).json({ ok: false, error: 'Stats storage is not configured for saving.' });
  }
  if (!Array.isArray(stats) || stats.length === 0) {
    return res.status(400).json({ ok: false, error: 'No stats to save.' });
  }

  // Validate + bound-check before touching the DB.
  const clean: PartnerStat[] = [];
  for (const s of stats) {
    const position = Number(s?.position);
    const value = typeof s?.value === 'string' ? s.value.trim() : '';
    const label = typeof s?.label === 'string' ? s.label.trim() : '';
    if (!Number.isInteger(position) || position < 1 || position > 4) {
      return res.status(400).json({ ok: false, error: `Invalid position: ${s?.position}` });
    }
    if (!value || value.length > 40) {
      return res.status(400).json({ ok: false, error: 'Each value must be 1–40 characters.' });
    }
    if (!label || label.length > 200) {
      return res.status(400).json({ ok: false, error: 'Each label must be 1–200 characters.' });
    }
    clean.push({ position, value, label });
  }

  // Update each of the four rows by position (PATCH needs only UPDATE rights).
  const nowIso = new Date().toISOString();
  try {
    for (const s of clean) {
      const patchRes = await fetch(
        `${STATS_URL}/rest/v1/${STATS_TABLE}?position=eq.${s.position}`,
        {
          method: 'PATCH',
          headers: { ...statsHeaders(STATS_WRITE_KEY as string), Prefer: 'return=minimal' },
          body: JSON.stringify({ value: s.value, label: s.label, updated_at: nowIso }),
        }
      );
      if (!patchRes.ok) {
        console.error('[partner-stats] write failed', patchRes.status, await patchRes.text().catch(() => ''));
        return res.status(500).json({ ok: false, error: 'Failed to save. Try again.' });
      }
    }
  } catch (err) {
    console.error('[partner-stats] write failed', err);
    return res.status(500).json({ ok: false, error: 'Failed to save. Try again.' });
  }

  const updated = await getPartnerStats();
  return res.json({ ok: true, stats: updated ?? clean });
});

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
  // NOTE: send_welcome_email is TRUE so new subscribers get Beehiiv's welcome
  // email (the API payload overrides the platform toggle). reactivate_existing
  // stays FALSE so previously unsubscribed emails are not silently re-added.
  const payload = {
    email,
    reactivate_existing: false,
    send_welcome_email: true,
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
 * Body: { name, email, company, jobTitle, goals }
 * Sends a formatted email to fridaystairs@gmail.com via Resend.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? 'jonathan@layer3labs.io';
const PARTNER_TO_EMAIL = 'info@fridaystairs.co';

app.post('/api/partner-inquiry', async (req, res) => {
  const { name, company, email, jobTitle, goals } = (req.body ?? {}) as {
    name?: string; company?: string; email?: string; jobTitle?: string; goals?: string;
  };

  if (!name || !company || !email || !goals) {
    return res.status(400).json({ ok: false, error: 'Name, email, company, and sponsorship goals are required.' });
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
      <tr><td><strong>Email</strong></td><td><a href="mailto:${email}">${email}</a></td></tr>
      <tr><td><strong>Company/Brand</strong></td><td>${company}</td></tr>
      <tr><td><strong>Job Title</strong></td><td>${jobTitle || '—'}</td></tr>
      <tr><td><strong>Sponsorship Goal(s)</strong></td><td style="white-space:pre-wrap">${goals ?? '—'}</td></tr>
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
// acceptRanges:false → always 200 (not 206) so Meta crawlers get full HTML/OG tags.
app.use(express.static(STATIC_ROOT, { extensions: ['html'], acceptRanges: false }));

app.listen(PORT, () => {
  console.log(`[serve-footwork] http://localhost:${PORT}  →  ${STATIC_ROOT}`);
});
