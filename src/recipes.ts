import * as cheerio from "cheerio";
import { fetchArticle } from "./fetch-article.js";

const UA = "Mozilla/5.0 (compatible; FridayStairsRecipeBot/0.1; +https://fridaystairs.com)";

export interface RecipeCandidate {
  id: string;
  source: string;
  sourceName: string;
  url: string;
  title: string;
  description?: string;
  image?: string;
  ingredients: string[];
  steps: string[];
  totalTime?: string;
  servings?: string;
  calories?: string;
  addedAt: string;
}

export interface RecipeSource {
  id: string;
  name: string;
  category: "curated" | "fitness";
  /** RSS/Atom feed — preferred. Most modern recipe blogs publish one. */
  feedUrl?: string;
  /** HTML index URL — fallback when no feed. */
  indexUrl?: string;
  /** Optional CSS selector for HTML mode. */
  linkSelector?: string;
}

// Recipe blogs with stable RSS feeds and JSON-LD-rich post pages.
export const RECIPE_SOURCES: RecipeSource[] = [
  { id: "minimalist-baker", name: "Minimalist Baker", category: "curated", feedUrl: "https://minimalistbaker.com/feed/" },
  { id: "budget-bytes", name: "Budget Bytes", category: "curated", feedUrl: "https://www.budgetbytes.com/feed/" },
  { id: "cookie-and-kate", name: "Cookie + Kate", category: "curated", feedUrl: "https://cookieandkate.com/feed/" },
  { id: "skinnytaste", name: "Skinnytaste", category: "curated", feedUrl: "https://www.skinnytaste.com/feed/" },
  { id: "eating-bird-food", name: "Eating Bird Food", category: "fitness", feedUrl: "https://www.eatingbirdfood.com/feed/" },
  { id: "sweet-peas-saffron", name: "Sweet Peas & Saffron", category: "fitness", feedUrl: "https://sweetpeasandsaffron.com/feed/" },
  { id: "fit-foodie-finds", name: "Fit Foodie Finds", category: "fitness", feedUrl: "https://fitfoodiefinds.com/feed/" },
  { id: "the-real-food-dietitians", name: "The Real Food Dietitians", category: "fitness", feedUrl: "https://therealfooddietitians.com/feed/" },
];

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function parseFeedLinks(xml: string, limit: number): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const links: string[] = [];
  $("item, entry").each((_, el) => {
    if (links.length >= limit) return;
    const $i = $(el);
    const link =
      $i.find("link").first().text().trim() ||
      $i.find("link").first().attr("href") ||
      $i.find("guid").first().text().trim();
    if (link && /^https?:/.test(link)) links.push(link);
  });
  return links;
}

export function parseRecipeFromHtml(html: string, url: string): RecipeCandidate | null {
  const $ = cheerio.load(html);
  const blocks = $('script[type="application/ld+json"]');
  for (let i = 0; i < blocks.length; i++) {
    const raw = $(blocks[i]!).text();
    if (!raw) continue;
    try {
      const json = JSON.parse(raw);
      const recipe = findRecipe(json);
      if (recipe) return recipeFromJsonLd(recipe, url);
    } catch {}
  }
  // OG fallback
  const ogTitle = $('meta[property="og:title"]').attr("content") ?? $("title").text();
  if (!ogTitle) return null;
  const cleaned = cleanUrl(url);
  return {
    id: `${Date.now()}-${slugify(ogTitle)}`,
    source: hostnameOf(cleaned),
    sourceName: hostnameOf(cleaned),
    url: cleaned,
    title: ogTitle.trim(),
    description: $('meta[property="og:description"]').attr("content"),
    image: $('meta[property="og:image"]').attr("content"),
    ingredients: [],
    steps: [],
    addedAt: new Date().toISOString(),
  };
}

function findRecipe(json: unknown): Record<string, unknown> | null {
  if (!json) return null;
  if (Array.isArray(json)) {
    for (const item of json) { const r = findRecipe(item); if (r) return r; }
    return null;
  }
  if (typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const t = obj["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return obj;
  const graph = obj["@graph"];
  if (graph) return findRecipe(graph);
  return null;
}

function recipeFromJsonLd(r: Record<string, unknown>, rawUrl: string): RecipeCandidate {
  const name = String(r.name ?? "Untitled recipe");
  const url = cleanUrl(rawUrl);
  const nutrition = r.nutrition as Record<string, unknown> | undefined;
  return {
    id: `${Date.now()}-${slugify(name)}`,
    source: hostnameOf(url),
    sourceName: hostnameOf(url),
    url,
    title: name.trim(),
    description: typeof r.description === "string" ? r.description.trim() : undefined,
    image: pickImage(r.image),
    ingredients: toStringArray(r.recipeIngredient),
    steps: extractSteps(r.recipeInstructions),
    totalTime: typeof r.totalTime === "string" ? humanizeIso(r.totalTime) : undefined,
    servings: typeof r.recipeYield === "string" ? r.recipeYield : Array.isArray(r.recipeYield) ? String((r.recipeYield as unknown[])[0]) : undefined,
    calories: nutrition && typeof nutrition.calories === "string" ? nutrition.calories : undefined,
    addedAt: new Date().toISOString(),
  };
}

function humanizeIso(s: string): string {
  // PT30M → 30 min, PT1H15M → 1h 15m
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return s;
  const h = m[1] ? `${m[1]}h` : "";
  const min = m[2] ? `${m[2]}m` : "";
  return [h, min].filter(Boolean).join(" ") || s;
}

function pickImage(img: unknown): string | undefined {
  if (typeof img === "string") return img;
  if (Array.isArray(img) && img.length) return typeof img[0] === "string" ? img[0] : pickImage(img[0]);
  if (img && typeof img === "object") {
    const url = (img as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  return undefined;
}

function toStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : String(x))).filter(Boolean);
  if (typeof v === "string") return [v];
  return [];
}

function extractSteps(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) {
    return v.map((s) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object") {
        const text = (s as Record<string, unknown>).text;
        if (typeof text === "string") return text;
        const items = (s as Record<string, unknown>).itemListElement;
        if (items) return extractSteps(items).join(" ");
      }
      return "";
    }).filter(Boolean);
  }
  return [];
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "web"; }
}

// Strip tracking query strings / newsletter template tokens (e.g. ?adt_ei={{ subscriber.email_address }}).
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80) || "recipe";
}

export async function scrapeRecipeFromUrl(url: string): Promise<RecipeCandidate | null> {
  const html = await fetchText(url);
  return parseRecipeFromHtml(html, url);
}

export async function discoverRecipeLinks(source: RecipeSource, limit = 6): Promise<string[]> {
  if (source.feedUrl) {
    const xml = await fetchText(source.feedUrl);
    return parseFeedLinks(xml, limit);
  }
  if (!source.indexUrl) return [];
  const html = await fetchText(source.indexUrl);
  const $ = cheerio.load(html);
  const links = new Set<string>();
  const sel = source.linkSelector ?? "a[href]";
  $(sel).each((_, a) => {
    if (links.size >= limit) return;
    const href = $(a).attr("href"); if (!href) return;
    let abs: string;
    try { abs = new URL(href, source.indexUrl).toString(); } catch { return; }
    if (/\/(tag|category|topic|page)\//i.test(abs)) return;
    if (abs === source.indexUrl) return;
    links.add(abs);
  });
  return [...links];
}

export async function searchRecipesOnWeb(query: string, limit = 5): Promise<string[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    console.warn("SERPAPI_KEY not set — open-web recipe search disabled. Use paste-URL instead.");
    return [];
  }
  const params = new URLSearchParams({ q: `${query} recipe`, engine: "google", num: String(limit * 2), api_key: key });
  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) return [];
  const json = await res.json() as { organic_results?: Array<{ link?: string }> };
  const links: string[] = [];
  for (const r of json.organic_results ?? []) {
    if (r.link && links.length < limit) links.push(r.link);
  }
  return links;
}

export async function scanRecipeSources(perSource = 4): Promise<RecipeCandidate[]> {
  const tasks = RECIPE_SOURCES.map(async (source) => {
    try {
      const links = await discoverRecipeLinks(source, perSource);
      console.log(`${source.id}: ${links.length} candidate links`);
      const candidates: RecipeCandidate[] = [];
      for (const link of links) {
        try {
          const c = await scrapeRecipeFromUrl(link);
          if (c && c.ingredients.length > 0) {
            c.sourceName = source.name;
            c.source = source.id;
            candidates.push(c);
          }
        } catch (err) {
          console.warn(`  ✗ ${link}: ${err}`);
        }
      }
      return candidates;
    } catch (err) {
      console.warn(`✗ ${source.id} discovery failed: ${err}`);
      return [];
    }
  });
  const results = await Promise.all(tasks);
  return results.flat();
}

export { fetchArticle };
