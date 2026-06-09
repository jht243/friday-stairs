import fs from "node:fs";
import path from "node:path";
import express from "express";
import OpenAI from "openai";
import { PATHS } from "./config.js";
import { generateSection, generateTipOptions, type TipOption } from "./generate.js";
import { scanNews, type NewsItem } from "./news.js";
import { loadDismissed, dismissUrl, undismissUrl, clearDismissed } from "./dismiss.js";
import { parseRecipeFromHtml, scrapeRecipeFromUrl, scanRecipeSources, searchRecipesOnWeb, type RecipeCandidate } from "./recipes.js";
import { fetchArticle } from "./fetch-article.js";
import { approve, assembleIssue, listAllApproved, markUsed, removeApproved, type BucketItem, type BucketType } from "./bucket.js";
import { fetchIgPosts } from "./ig-scraper.js";
import { loadRsvpUrl, saveRsvpUrl, loadSettings, saveSettings } from "./rsvp.js";
import { playlistToMarkdown, suggestPlaylist, suggestNewGymSongs, newGymSongsToMarkdown } from "./playlist.js";

interface NewsIndex { scannedAt: string; items: NewsItem[] }
interface CandidatesFile { scannedAt: string; candidates: RecipeCandidate[] }

const SCAN_STALE_HOURS = 6;

function loadJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
function saveJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function saveRecipeCandidates(candidates: RecipeCandidate[]): void {
  saveJson(PATHS.recipeCandidates, { scannedAt: new Date().toISOString(), candidates });
}
function loadRecipeCandidates(): RecipeCandidate[] {
  return loadJson<CandidatesFile>(PATHS.recipeCandidates)?.candidates ?? [];
}

function pickBestRecipe(candidates: RecipeCandidate[]): RecipeCandidate | undefined {
  const scored = candidates
    .map((c) => ({
      c,
      score:
        (c.ingredients.length >= 5 ? 3 : 0) +
        (c.image ? 2 : 0) +
        (c.totalTime ? 1 : 0) +
        (c.steps.length >= 3 ? 1 : 0) +
        (c.calories ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || (a.c.addedAt < b.c.addedAt ? 1 : -1));
  return scored[0]?.c;
}

const PREFERRED_NEWS_FEEDS = new Set(["nyt-well", "runners-world", "mens-health", "womens-health", "ace-fitness"]);

function pickBestNews(items: NewsItem[]): NewsItem | undefined {
  const scored = items
    .map((n) => ({
      n,
      score:
        (PREFERRED_NEWS_FEEDS.has(n.feedId) ? 3 : 0) +
        (n.summary.length > 120 ? 1 : 0) +
        (Date.now() - new Date(n.date).getTime() < 7 * 86400000 ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score || (a.n.date < b.n.date ? 1 : -1));
  return scored[0]?.n;
}

const TIP_ROTATION = [
  "mid-foot strike on the descent",
  "breathing pattern for the long set",
  "ankle mobility before the first climb",
  "pacing the first vs. the last set",
  "hydration before a 7am workout",
  "glute activation between sets",
  "scanning posture at the top of the stairs",
  "recovery between Friday and Saturday",
];

function rotatingTipFocus(): string {
  const week = Math.floor(Date.now() / (7 * 86400000));
  return TIP_ROTATION[week % TIP_ROTATION.length]!;
}

function isStale(scannedAt: string | null | undefined): boolean {
  if (!scannedAt) return true;
  const ms = Date.now() - new Date(scannedAt).getTime();
  return ms > SCAN_STALE_HOURS * 3600 * 1000;
}

interface BootStatus {
  newsScanning: boolean;
  recipesScanning: boolean;
  newsScannedAt: string | null;
  recipesScannedAt: string | null;
  newsCount: number;
  recipesCount: number;
}

const status: BootStatus = {
  newsScanning: false,
  recipesScanning: false,
  newsScannedAt: loadJson<NewsIndex>(PATHS.news)?.scannedAt ?? null,
  recipesScannedAt: loadJson<CandidatesFile>(PATHS.recipeCandidates)?.scannedAt ?? null,
  newsCount: loadJson<NewsIndex>(PATHS.news)?.items.length ?? 0,
  recipesCount: loadRecipeCandidates().length,
};

async function bootScans(): Promise<void> {
  const newsIndex = loadJson<NewsIndex>(PATHS.news);
  if (!newsIndex || isStale(newsIndex.scannedAt)) {
    status.newsScanning = true;
    scanNews(15)
      .then((items) => {
        saveJson(PATHS.news, { scannedAt: new Date().toISOString(), items });
        status.newsScannedAt = new Date().toISOString();
        status.newsCount = items.length;
      })
      .catch((err) => console.warn("boot news scan failed:", err))
      .finally(() => { status.newsScanning = false; });
  }
  const recIndex = loadJson<CandidatesFile>(PATHS.recipeCandidates);
  if (!recIndex || isStale(recIndex.scannedAt)) {
    status.recipesScanning = true;
    scanRecipeSources(4)
      .then((fresh) => {
        const existing = loadRecipeCandidates();
        const seen = new Set(existing.map((c) => c.url));
        const merged = [...fresh.filter((c) => !seen.has(c.url)), ...existing].slice(0, 200);
        saveRecipeCandidates(merged);
        status.recipesScannedAt = new Date().toISOString();
        status.recipesCount = merged.length;
      })
      .catch((err) => console.warn("boot recipe scan failed:", err))
      .finally(() => { status.recipesScanning = false; });
  }
}

const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
const BEEHIIV_PUB_ID = process.env.BEEHIIV_PUB_ID;

if (!BEEHIIV_API_KEY || !BEEHIIV_PUB_ID) {
  console.warn("[server] Missing BEEHIIV_API_KEY or BEEHIIV_PUB_ID — /api/subscribe and /api/profile will return 500 until set.");
}

export function createServer(client: OpenAI) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const staticOptions = {
    etag: false,
    lastModified: false,
    cacheControl: false,
    extensions: ["html"] as string[],
    setHeaders: (res: express.Response) => res.setHeader("Cache-Control", "no-store"),
  };
  const publicDir = path.join(PATHS.root, "public");
  const homepageDir = path.join(PATHS.root, "footwork");

  app.get(["/admin", "/admin/"], (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
  app.use(express.static(homepageDir, staticOptions));

  // ---------- Newsletter: Beehiiv subscribe ----------
  app.post("/api/subscribe", async (req, res) => {
    const { email, source } = (req.body ?? {}) as { email?: string; source?: string };
    if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email." });
    }
    if (!BEEHIIV_API_KEY || !BEEHIIV_PUB_ID) {
      return res.status(500).json({ ok: false, error: "Server is not configured." });
    }
    const url = `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUB_ID}/subscriptions`;
    const payload = {
      email,
      reactivate_existing: false,
      send_welcome_email: false,
      utm_source: source ?? "fridaystairs.com",
      utm_medium: "website",
      referring_site: "fridaystairs.com",
    };
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${BEEHIIV_API_KEY}` },
        body: JSON.stringify(payload),
      });
      const text = await resp.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* leave as text */ }
      if (!resp.ok) {
        console.error("[subscribe] Beehiiv error", resp.status, body);
        return res.status(502).json({ ok: false, error: "Newsletter provider rejected the request.", detail: body });
      }
      const subscriberId = (body as { data?: { id?: string } })?.data?.id ?? null;
      return res.json({ ok: true, subscriber_id: subscriberId, email, beehiiv: body });
    } catch (err: unknown) {
      console.error("[subscribe] network/fetch failure", err);
      return res.status(502).json({ ok: false, error: "Failed to reach newsletter provider." });
    }
  });

  // ---------- Partnership inquiry: Resend email ----------
  app.post("/api/partner-inquiry", async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: string;
      company?: string;
      email?: string;
      interest?: string;
      message?: string;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const company = typeof body.company === "string" ? body.company.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const interest = typeof body.interest === "string" ? body.interest.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!name || !company || !email || !interest) {
      return res.status(400).json({ ok: false, error: "Missing required fields (name, company, email, interest)." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Invalid email." });
    }
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL || "jonathan@layer3labs.io";
    if (!apiKey) {
      console.error("[partner-inquiry] Missing RESEND_API_KEY");
      return res.status(500).json({ ok: false, error: "Server is not configured." });
    }
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const messageHtml = message ? esc(message).replace(/\n/g, "<br />") : "<em>(none)</em>";
    const html = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#282424; line-height:1.5;">
        <h2 style="margin:0 0 12px;">New partnership inquiry</h2>
        <p style="margin:0 0 16px; color:#555;">Submitted via fridaystairs.com partner form.</p>
        <table style="border-collapse:collapse; font-size:15px;">
          <tr><td style="padding:6px 12px 6px 0; color:#888;">Name</td><td style="padding:6px 0;"><strong>${esc(name)}</strong></td></tr>
          <tr><td style="padding:6px 12px 6px 0; color:#888;">Company</td><td style="padding:6px 0;"><strong>${esc(company)}</strong></td></tr>
          <tr><td style="padding:6px 12px 6px 0; color:#888;">Email</td><td style="padding:6px 0;"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
          <tr><td style="padding:6px 12px 6px 0; color:#888;">Interest</td><td style="padding:6px 0;">${esc(interest)}</td></tr>
        </table>
        <h3 style="margin:20px 0 8px;">Message</h3>
        <div style="padding:12px 14px; background:#FFF9DE; border:1px solid #eadf95;">${messageHtml}</div>
        <p style="margin-top:24px; font-size:12px; color:#888;">Reply directly to this email to respond to ${esc(name)}.</p>
      </div>
    `.trim();
    const text = [
      "New partnership inquiry",
      "",
      `Name:     ${name}`,
      `Company:  ${company}`,
      `Email:    ${email}`,
      `Interest: ${interest}`,
      "",
      "Message:",
      message || "(none)",
    ].join("\n");
    // Recipient is intentionally hardcoded to the Friday Stairs inbox and is
    // NOT configurable via env. Partnership inquiries must always go to
    // fridaystairs@gmail.com and nowhere else.
    const partnerInquiryRecipients = ["fridaystairs@gmail.com"];
    const payload = {
      from: fromEmail,
      to: partnerInquiryRecipients,
      reply_to: email,
      subject: `New partnership inquiry — ${company}`,
      html,
      text,
    };
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });
      const raw = await resp.text();
      let parsed: unknown = raw;
      try { parsed = JSON.parse(raw); } catch { /* leave as text */ }
      if (!resp.ok) {
        console.error("[partner-inquiry] Resend error", resp.status, parsed);
        return res.status(502).json({ ok: false, error: "Email provider rejected the request.", detail: parsed });
      }
      console.log("[partner-inquiry] Resend accepted", parsed);
      return res.json({ ok: true });
    } catch (err: unknown) {
      console.error("[partner-inquiry] network/fetch failure", err);
      return res.status(502).json({ ok: false, error: "Failed to reach email provider." });
    }
  });

  // ---------- Newsletter: Beehiiv profile (post-signup survey) ----------
  const ALLOWED_PROFILE_FIELDS: Record<string, string> = {
    birthday: "Birthday",
    gender: "Gender",
    city_state: "City/State",
    workouts_attended: "Workouts Attended",
    focus_area: "Focus Area",
    investing_in: "Investing In",
    monthly_spend: "Monthly Spend",
    brands_used: "Brands Used",
    coming_back_for: "Coming Back For",
  };
  app.post("/api/profile", async (req, res) => {
    const { subscriber_id, answers } = (req.body ?? {}) as {
      subscriber_id?: string;
      answers?: Record<string, string | string[] | undefined>;
    };
    if (!subscriber_id || typeof subscriber_id !== "string") {
      return res.status(400).json({ ok: false, error: "Missing subscriber_id." });
    }
    if (!answers || typeof answers !== "object") {
      return res.status(400).json({ ok: false, error: "Missing answers." });
    }
    if (!BEEHIIV_API_KEY || !BEEHIIV_PUB_ID) {
      return res.status(500).json({ ok: false, error: "Server is not configured." });
    }
    const customFields = Object.entries(ALLOWED_PROFILE_FIELDS)
      .map(([key, display]) => {
        const raw = answers[key];
        if (raw === undefined || raw === null || raw === "") return null;
        const value = Array.isArray(raw) ? raw.join(", ") : String(raw);
        if (!value.trim()) return null;
        return { name: display, value };
      })
      .filter(Boolean);
    if (customFields.length === 0) {
      return res.status(400).json({ ok: false, error: "No answers to save." });
    }
    const url = `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUB_ID}/subscriptions/${subscriber_id}`;
    try {
      const resp = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${BEEHIIV_API_KEY}` },
        body: JSON.stringify({ custom_fields: customFields }),
      });
      const text = await resp.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* leave as text */ }
      if (!resp.ok) {
        console.error("[profile] Beehiiv error", resp.status, body);
        return res.status(502).json({ ok: false, error: "Newsletter provider rejected the profile update.", detail: body });
      }
      return res.json({ ok: true, beehiiv: body });
    } catch (err: unknown) {
      console.error("[profile] network/fetch failure", err);
      return res.status(502).json({ ok: false, error: "Failed to reach newsletter provider." });
    }
  });

  // Kick off background scans immediately
  bootScans();

  // Pre-warm workout tips so the Tips tab is populated on first open
  const tipsCachePath = path.join(PATHS.root, "data/options/tips.json");
  if (!loadJson<{ tips: TipOption[] }>(tipsCachePath)) {
    generateTipOptions(client, 10)
      .then((tips) => saveJson(tipsCachePath, { generatedAt: new Date().toISOString(), tips }))
      .catch((err) => console.warn("boot tip pre-warm failed:", err));
  }

  app.get("/api/status", (_req, res) => {
    const approved = listAllApproved();
    const totals = Object.fromEntries(
      Object.entries(approved).map(([k, v]) => [k, { total: v.length, unused: v.filter((i) => !i.used).length }]),
    );
    res.json({ ...status, bucket: totals });
  });

  // ---------- News ----------
  app.get("/api/news", (_req, res) => {
    const index = loadJson<NewsIndex>(PATHS.news);
    const dismissed = loadDismissed();
    if (!index) return res.json({ scannedAt: null, items: [] });
    res.json({ scannedAt: index.scannedAt, items: index.items.filter((i) => !dismissed.has(i.url)) });
  });
  app.post("/api/scan-news", async (_req, res) => {
    try {
      const items = await scanNews(15);
      saveJson(PATHS.news, { scannedAt: new Date().toISOString(), items });
      status.newsScannedAt = new Date().toISOString();
      status.newsCount = items.length;
      const dismissed = loadDismissed();
      res.json({ scannedAt: new Date().toISOString(), items: items.filter((i) => !dismissed.has(i.url)) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Dismiss ----------
  app.post("/api/dismiss", (req, res) => {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: "url required" });
    dismissUrl(url); res.json({ ok: true });
  });
  app.post("/api/undismiss", (req, res) => {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: "url required" });
    undismissUrl(url); res.json({ ok: true });
  });
  app.post("/api/dismissed/clear", (_req, res) => { clearDismissed(); res.json({ ok: true }); });

  // ---------- Issue settings: RSVP link, quote, quote link ----------
  const SETTINGS_KEYS = [
    "rsvpUrl", "recapImageUrl", "icalUrl", "gcalUrl",
    "welHeader", "welBody",
    "motwTitle", "motwBody", "motwSig",
    "cuHeader", "cuSub", "cuBody",
    "annHeader", "annSub", "annBody",
  ];
  const settingsView = () => {
    const s = loadSettings() as Record<string, unknown>;
    const out: Record<string, string> = { rsvpUrl: loadRsvpUrl() ?? "" };
    for (const k of SETTINGS_KEYS) out[k] = (typeof s[k] === "string" ? (s[k] as string) : "");
    return out;
  };
  app.get("/api/settings", (_req, res) => res.json(settingsView()));
  app.post("/api/settings", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const patch: Record<string, string> = {};
    for (const k of SETTINGS_KEYS) {
      if (typeof b[k] === "string") patch[k] = (b[k] as string).trim();
    }
    saveSettings(patch);
    res.json({ ok: true, ...settingsView() });
  });
  // Back-compat
  app.get("/api/rsvp", (_req, res) => res.json({ url: loadRsvpUrl() }));
  app.post("/api/rsvp", (req, res) => {
    const { url } = req.body as { url?: string };
    if (typeof url !== "string") return res.status(400).json({ error: "url required" });
    saveRsvpUrl(url);
    res.json({ ok: true, url: loadRsvpUrl() });
  });

  // ---------- New gym songs: 3 per week, cached weekly ----------
  const newSongsCache = path.join(PATHS.root, "data/options/new-songs.json");
  app.get("/api/new-songs", async (req, res) => {
    const refresh = req.query.refresh === "1";
    const weekKey = Math.floor(Date.now() / (7 * 86400000)); // increments once per week
    try {
      let cached = loadJson<{ weekKey: number; tracks: unknown[]; markdown: string }>(newSongsCache);
      if (refresh || !cached || cached.weekKey !== weekKey) {
        const tracks = await suggestNewGymSongs(client, 3);
        cached = { weekKey, tracks, markdown: newGymSongsToMarkdown(tracks) };
        saveJson(newSongsCache, cached);
      }
      res.json(cached);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Recipes ----------
  app.get("/api/recipes", (_req, res) => {
    const candidates = loadRecipeCandidates();
    const dismissed = loadDismissed();
    res.json({
      scannedAt: status.recipesScannedAt,
      candidates: candidates.filter((c) => !dismissed.has(c.url)),
    });
  });
  app.post("/api/recipes/scan", async (_req, res) => {
    try {
      const fresh = await scanRecipeSources(4);
      const existing = loadRecipeCandidates();
      const seen = new Set(existing.map((c) => c.url));
      const merged = [...fresh.filter((c) => !seen.has(c.url)), ...existing].slice(0, 200);
      saveRecipeCandidates(merged);
      status.recipesScannedAt = new Date().toISOString();
      status.recipesCount = merged.length;
      const dismissed = loadDismissed();
      res.json({ added: fresh.length, candidates: merged.filter((c) => !dismissed.has(c.url)) });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.post("/api/recipes/paste", async (req, res) => {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      const recipe = await scrapeRecipeFromUrl(url);
      if (!recipe) return res.status(422).json({ error: "Could not parse recipe (no JSON-LD or OG meta)." });
      const existing = loadRecipeCandidates();
      if (!existing.some((c) => c.url === recipe.url)) {
        saveRecipeCandidates([recipe, ...existing].slice(0, 200));
      }
      res.json({ recipe });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.post("/api/recipes/search", async (req, res) => {
    const { query } = req.body as { query?: string };
    if (!query) return res.status(400).json({ error: "query required" });
    try {
      const urls = await searchRecipesOnWeb(query, 5);
      if (urls.length === 0) {
        return res.json({ added: 0, candidates: loadRecipeCandidates(), message: "Open-web search needs SERPAPI_KEY. Use Paste URL instead." });
      }
      const existing = loadRecipeCandidates();
      const seen = new Set(existing.map((c) => c.url));
      const added: RecipeCandidate[] = [];
      for (const u of urls) {
        if (seen.has(u)) continue;
        try { const r = await scrapeRecipeFromUrl(u); if (r) added.push(r); } catch {}
      }
      const merged = [...added, ...existing].slice(0, 200);
      saveRecipeCandidates(merged);
      res.json({ added: added.length, candidates: merged });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Generate sections ----------
  app.post("/api/generate/recipe-blurb", async (req, res) => {
    const { url } = req.body as { url?: string };
    if (!url) return res.status(400).json({ error: "url required" });
    try {
      const recipe = loadRecipeCandidates().find((c) => c.url === url) ?? (await scrapeRecipeFromUrl(url));
      if (!recipe) return res.status(404).json({ error: "recipe not found" });
      const section = await generateSection(client, { type: "recipe-blurb", source: { recipe } });
      res.json({ section, recipe });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.post("/api/generate/news-blurb", async (req, res) => {
    const { url, title, summary, sourceName } = req.body as { url?: string; title?: string; summary?: string; sourceName?: string };
    if (!url || !title) return res.status(400).json({ error: "url and title required" });
    try {
      const section = await generateSection(client, { type: "news-blurb", source: { news: { url, title, summary: summary ?? "", sourceName } } });
      res.json({ section });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.post("/api/generate/workout-tip", async (req, res) => {
    const { focus, notes } = req.body as { focus?: string; notes?: string };
    try {
      const section = await generateSection(client, { type: "workout-tip", source: { tip: { focus, notes } } });
      res.json({ section });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Wow #1: weekly recap from IG ----------
  app.post("/api/recap", async (req, res) => {
    const { urls, fridayDate, notes } = req.body as { urls?: string[]; fridayDate?: string; notes?: string };
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "urls[] required" });
    }
    try {
      const posts = await fetchIgPosts(urls);
      const section = await generateSection(client, { type: "weekly-recap", source: { recap: { fridayDate, posts, manualNotes: notes } } });
      res.json({ section, sourcedPosts: posts.length });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Wow #2: DJ playlist ----------
  app.post("/api/playlist", async (req, res) => {
    const { durationMinutes, shape, genres, avoid } = req.body as { durationMinutes?: number; shape?: string; genres?: string[]; avoid?: string[] };
    try {
      const tracks = await suggestPlaylist(client, { durationMinutes: durationMinutes ?? 30, shape, genres, avoid });
      const markdown = playlistToMarkdown({ durationMinutes: durationMinutes ?? 30, shape, genres, avoid }, tracks);
      res.json({ tracks, markdown });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Option grids: pre-populated, ready to add to newsletter ----------
  const tipsCache = path.join(PATHS.root, "data/options/tips.json");
  const playlistsCache = path.join(PATHS.root, "data/options/playlists.json");

  app.get("/api/options/tips", async (req, res) => {
    const refresh = req.query.refresh === "1";
    try {
      let cached = loadJson<{ generatedAt: string; tips: TipOption[] }>(tipsCache);
      if (refresh || !cached || cached.tips.length < 8) {
        const tips = await generateTipOptions(client, 10);
        cached = { generatedAt: new Date().toISOString(), tips };
        saveJson(tipsCache, cached);
      }
      res.json(cached);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  const PLAYLIST_VARIANTS = [
    { durationMinutes: 30, shape: "warmup → build → 2 peaks → cool", label: "Classic 30 — two peaks" },
    { durationMinutes: 30, shape: "fast warmup → sustained high energy → quick cool", label: "High-energy 30" },
    { durationMinutes: 25, shape: "steady build → one big peak → long cool", label: "Quick 25 — one peak" },
    { durationMinutes: 40, shape: "long warmup → wave intervals → cool", label: "Endurance 40 — waves" },
  ];

  app.get("/api/options/playlists", async (req, res) => {
    const refresh = req.query.refresh === "1";
    try {
      let cached = loadJson<{ generatedAt: string; playlists: Array<{ label: string; markdown: string; trackCount: number }> }>(playlistsCache);
      if (refresh || !cached || cached.playlists.length < 3) {
        const built = await Promise.all(
          PLAYLIST_VARIANTS.map(async (v) => {
            const tracks = await suggestPlaylist(client, { durationMinutes: v.durationMinutes, shape: v.shape });
            return { label: v.label, markdown: playlistToMarkdown({ durationMinutes: v.durationMinutes, shape: v.shape }, tracks), trackCount: tracks.length };
          }),
        );
        cached = { generatedAt: new Date().toISOString(), playlists: built };
        saveJson(playlistsCache, cached);
      }
      res.json(cached);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Auto-generate: pick best candidates and draft all sections ----------
  app.post("/api/auto-generate", async (req, res) => {
    const { include } = req.body as { include?: string[] };
    // Settings (RSVP, quote, sections) are saved via /api/settings on input change.
    const want = new Set(include ?? ["recipe", "news", "tip", "playlist"]);
    try {
      const dismissed = loadDismissed();
      const recipes = loadRecipeCandidates().filter((c) => !dismissed.has(c.url));
      const newsIndex = loadJson<NewsIndex>(PATHS.news);
      const news = (newsIndex?.items ?? []).filter((i) => !dismissed.has(i.url));

      const pickedRecipe = pickBestRecipe(recipes);
      const pickedNews = pickBestNews(news);
      const tipFocus = rotatingTipFocus();

      const tasks: Array<Promise<unknown>> = [];
      const out: Record<string, unknown> = { picks: { recipe: pickedRecipe, news: pickedNews, tipFocus } };

      if (want.has("recipe") && pickedRecipe) {
        tasks.push(
          generateSection(client, { type: "recipe-blurb", source: { recipe: pickedRecipe } })
            .then((section) => { out.recipe = { section, recipe: pickedRecipe }; })
            .catch((e) => { out.recipe = { error: String(e) }; }),
        );
      }
      if (want.has("news") && pickedNews) {
        tasks.push(
          generateSection(client, { type: "news-blurb", source: { news: { url: pickedNews.url, title: pickedNews.title, summary: pickedNews.summary, sourceName: pickedNews.feedName } } })
            .then((section) => { out.news = { section, source: pickedNews }; })
            .catch((e) => { out.news = { error: String(e) }; }),
        );
      }
      if (want.has("tip")) {
        tasks.push(
          generateSection(client, { type: "workout-tip", source: { tip: { focus: tipFocus } } })
            .then((section) => { out.tip = { section, focus: tipFocus }; })
            .catch((e) => { out.tip = { error: String(e) }; }),
        );
      }
      if (want.has("playlist")) {
        tasks.push(
          suggestNewGymSongs(client, 3)
            .then((tracks) => {
              const markdown = newGymSongsToMarkdown(tracks);
              out.playlist = { section: { type: "playlist", title: "New gym songs this week", markdown, wordCount: tracks.length }, tracks };
            })
            .catch((e) => { out.playlist = { error: String(e) }; }),
        );
      }
      await Promise.all(tasks);
      res.json(out);
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // ---------- Bucket / approval ----------
  app.get("/api/bucket", (_req, res) => {
    res.json({ approved: listAllApproved() });
  });
  app.post("/api/bucket/approve", (req, res) => {
    const item = req.body as Omit<BucketItem, "approvedAt">;
    if (!item.type || !item.id || !item.markdown) return res.status(400).json({ error: "type, id, markdown required" });
    // Guarantee the RSVP paragraph is present on anything that enters the issue.
    res.json({ item: approve(item) });
  });
  app.post("/api/bucket/remove", (req, res) => {
    const { type, id } = req.body as { type?: BucketType; id?: string };
    if (!type || !id) return res.status(400).json({ error: "type and id required" });
    removeApproved(type, id); res.json({ ok: true });
  });
  // Full reset — wipe all generated sections AND the saved inputs (RSVP, quote, recap link).
  app.post("/api/reset", (_req, res) => {
    try {
      if (fs.existsSync(PATHS.approvedDir)) {
        for (const f of fs.readdirSync(PATHS.approvedDir)) {
          if (f.endsWith(".json")) fs.unlinkSync(path.join(PATHS.approvedDir, f));
        }
      }
      if (fs.existsSync(PATHS.rsvp)) fs.unlinkSync(PATHS.rsvp);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
  app.get("/api/bucket/assemble", (_req, res) => {
    res.json(assembleIssue());
  });
  app.post("/api/bucket/assemble/commit", (_req, res) => {
    const { used } = assembleIssue();
    used.forEach((u) => markUsed(u.type, u.id));
    res.json({ ok: true, committed: used.length });
  });

  return app;
}
