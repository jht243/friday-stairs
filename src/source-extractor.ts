import * as cheerio from "cheerio";

const SOURCE_DOMAIN_PRIORITY: Array<{ pattern: RegExp; tier: number }> = [
  { pattern: /(^|\.)nih\.gov$/i, tier: 1 },
  { pattern: /(^|\.)cdc\.gov$/i, tier: 1 },
  { pattern: /(^|\.)who\.int$/i, tier: 1 },
  { pattern: /(^|\.)mayoclinic\.org$/i, tier: 1 },
  { pattern: /(^|\.)acsm\.org$/i, tier: 1 },
  { pattern: /(^|\.)acefitness\.org$/i, tier: 1 },
  { pattern: /(^|\.)nsca\.com$/i, tier: 1 },
  { pattern: /(^|\.)harvard\.edu$/i, tier: 2 },
  { pattern: /(^|\.)stanford\.edu$/i, tier: 2 },
  { pattern: /(^|\.)nytimes\.com$/i, tier: 3 },
  { pattern: /(^|\.)washingtonpost\.com$/i, tier: 3 },
  { pattern: /(^|\.)outsideonline\.com$/i, tier: 3 },
  { pattern: /(^|\.)runnersworld\.com$/i, tier: 3 },
  { pattern: /(^|\.)menshealth\.com$/i, tier: 3 },
  { pattern: /(^|\.)womenshealthmag\.com$/i, tier: 3 },
  { pattern: /(^|\.)self\.com$/i, tier: 3 },
  { pattern: /(^|\.)tampabay\.com$/i, tier: 3 },
];

const BLOCK_HOSTS = new Set([
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
  "pinterest.com",
  "google.com",
  "googletagmanager.com",
]);

function classify(host: string): number | null {
  for (const { pattern, tier } of SOURCE_DOMAIN_PRIORITY) {
    if (pattern.test(host)) return tier;
  }
  return null;
}

export function extractSourceUrls(html: string, ownDomain: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Map<string, { url: string; tier: number; idx: number }>();
  let idx = 0;

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href")?.trim();
    if (!href) return;
    let parsed: URL;
    try { parsed = new URL(href); } catch { return; }
    const host = parsed.host.toLowerCase();
    if (BLOCK_HOSTS.has(host.replace(/^www\./, ""))) return;
    if (host.endsWith(ownDomain.toLowerCase())) return;
    const tier = classify(host);
    if (tier == null) return;
    const key = `${parsed.origin}${parsed.pathname}`;
    if (seen.has(key)) return;
    seen.set(key, { url: parsed.toString(), tier, idx: idx++ });
  });

  return Array.from(seen.values())
    .sort((a, b) => a.tier - b.tier || a.idx - b.idx)
    .map((v) => v.url);
}
