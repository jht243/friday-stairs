import { extractArticleText } from "./html.js";

export async function fetchArticle(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "FridayStairsBrain/0.1 (research)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  const html = await res.text();
  const text = extractArticleText(html);

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "Untitled";

  if (text.length < 200) {
    throw new Error(`Extracted article text too short (${text.length} chars) from ${url}`);
  }

  return { title, text: text.slice(0, 12000) };
}
