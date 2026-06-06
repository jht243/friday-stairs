import * as cheerio from "cheerio";

export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const blocks: string[] = [];
  $("h1, h2, h3, h4, p, li, blockquote").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;

    if (tag.startsWith("h")) {
      const level = tag[1];
      blocks.push(`${"#".repeat(Number(level))} ${text}`);
    } else if (tag === "li") {
      blocks.push(`- ${text}`);
    } else if (tag === "blockquote") {
      blocks.push(`> ${text}`);
    } else {
      blocks.push(text);
    }
  });

  return blocks.join("\n\n").trim();
}

export function extractArticleText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, header").remove();

  const selectors = ["article", "main", ".entry-content", ".post-content", "#content", "body"];
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
      return htmlToText(el.html() ?? "");
    }
  }

  return htmlToText($.root().html() ?? "");
}
