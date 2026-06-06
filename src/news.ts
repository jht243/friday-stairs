import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (compatible; FridayStairsNewsBot/0.1; +https://fridaystairs.com)";

export interface NewsFeed {
  id: string;
  name: string;
  url: string;
  filter?: (title: string, summary: string) => boolean;
}

export interface NewsItem {
  feedId: string;
  feedName: string;
  url: string;
  title: string;
  date: string;
  summary: string;
}

const FITNESS_KEYWORDS =
  /\b(hiit|zone[- ]?2|vo2|mobility|stretching|stair|stairs|run(ning)?|jog(ging)?|strength|hybrid (athlete|training)|recovery|sleep|cold plunge|sauna|hydration|protein|creatine|deload|cardio|breathwork|posture|hamstring|hip|glute|calves?|achilles|kettlebell|bodyweight|crossfit|peloton|marathon|5k|10k|half[- ]?marathon|tampa|riverwalk|park|trail|community fitness|group fitness|workout|sunrise (workout|run))/i;

const EXCLUDE_KEYWORDS =
  /\b(weight[- ]?loss drug|ozempic|wegovy|semaglutide|tirzepatide|anabolic|sarm|steroid|peptide stack|miracle|guaranteed (results|abs))\b/i;

const fitnessFilter = (t: string, s: string) => {
  const text = `${t} ${s}`;
  return FITNESS_KEYWORDS.test(text) && !EXCLUDE_KEYWORDS.test(text);
};

// Verified working feeds. Broken ones (Outside /rss/all.xml, SELF, Tampa Bay) removed.
export const NEWS_FEEDS: NewsFeed[] = [
  { id: "nyt-well", name: "NYT Well", url: "https://rss.nytimes.com/services/xml/rss/nyt/Well.xml" },
  { id: "mens-health", name: "Men's Health", url: "https://www.menshealth.com/rss/all.xml/", filter: fitnessFilter },
  { id: "womens-health", name: "Women's Health", url: "https://www.womenshealthmag.com/rss/all.xml/", filter: fitnessFilter },
  { id: "runners-world", name: "Runner's World", url: "https://www.runnersworld.com/rss/all.xml/" },
  { id: "reddit-fitness", name: "Reddit r/fitness", url: "https://www.reddit.com/r/fitness/top.rss?t=week" },
  { id: "reddit-running", name: "Reddit r/running", url: "https://www.reddit.com/r/running/top.rss?t=week" },
  { id: "reddit-xxfitness", name: "Reddit r/xxfitness", url: "https://www.reddit.com/r/xxfitness/top.rss?t=week" },
  { id: "ace-fitness", name: "ACE Fitness", url: "https://www.acefitness.org/feed/", filter: fitnessFilter },
];

async function fetchRss(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

function parseRss(feed: NewsFeed, xml: string, limit: number): NewsItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: NewsItem[] = [];
  $("item, entry").each((_, el) => {
    if (items.length >= limit) return;
    const $i = $(el);
    const title = $i.find("title").first().text().trim();
    const link =
      $i.find("link").first().text().trim() ||
      $i.find("link").first().attr("href") ||
      $i.find("guid").first().text().trim() ||
      "";
    const pubDate =
      $i.find("pubDate").first().text().trim() ||
      $i.find("published").first().text().trim() ||
      $i.find("updated").first().text().trim();
    const description = ($i.find("description").first().text() || $i.find("summary").first().text() || $i.find("content").first().text() || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!title || !link) return;
    if (feed.filter && !feed.filter(title, description)) return;

    let date: string;
    try { date = new Date(pubDate).toISOString(); } catch { date = new Date().toISOString(); }

    items.push({
      feedId: feed.id,
      feedName: feed.name,
      url: link,
      title,
      date,
      summary: description.slice(0, 400),
    });
  });
  return items;
}

export async function scanNews(perFeed = 10): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (f) => {
      const xml = await fetchRss(f.url);
      const items = parseRss(f, xml, perFeed);
      console.log(`✓ ${f.id}: ${items.length} items`);
      return items;
    }),
  );
  const all: NewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.warn(`✗ news feed failed: ${r.reason}`);
  }
  return all.sort((a, b) => (a.date < b.date ? 1 : -1));
}
