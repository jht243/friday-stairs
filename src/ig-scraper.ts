const UA = "Mozilla/5.0 (compatible; FridayStairsBot/0.1; +https://fridaystairs.com)";

export interface IgPost {
  url: string;
  authorName?: string;
  caption: string;
  thumbnail?: string;
  fetchedAt: string;
}

/**
 * Public-only Instagram fetch via oEmbed. Works for public posts without auth.
 * For private accounts or Reels with restricted oEmbed, returns null and the
 * caller can fall back to manual paste.
 *
 * NOTE: Meta's oEmbed endpoint historically required an app token. For solo/dev
 * use, the public HTML fallback at `/p/<id>/embed/` still surfaces the caption.
 */
export async function fetchIgPost(url: string): Promise<IgPost | null> {
  const clean = url.split("?")[0]?.replace(/\/$/, "");
  if (!clean) return null;

  // Try the public embed page — works without an API token.
  try {
    const embedUrl = `${clean}/embed/`;
    const res = await fetch(embedUrl, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const html = await res.text();
      const caption = extractCaptionFromEmbed(html);
      const author = extractAuthorFromEmbed(html);
      const thumb = extractThumbFromEmbed(html);
      if (caption) {
        return {
          url: clean,
          authorName: author,
          caption,
          thumbnail: thumb,
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function extractCaptionFromEmbed(html: string): string {
  // Embed page surfaces the caption inside <div class="Caption"> ... or as og:description.
  const og = html.match(/<meta property="og:description" content="([^"]+)"/i);
  if (og && og[1]) return decodeHtml(og[1]).trim();
  const cap = html.match(/<div[^>]*class="[^"]*Caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (cap && cap[1]) return decodeHtml(cap[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
  return "";
}

function extractAuthorFromEmbed(html: string): string | undefined {
  const m = html.match(/<span[^>]*class="[^"]*UsernameText[^"]*"[^>]*>([^<]+)</i)
    ?? html.match(/"username":"([^"]+)"/i);
  return m ? m[1] : undefined;
}

function extractThumbFromEmbed(html: string): string | undefined {
  const m = html.match(/<meta property="og:image" content="([^"]+)"/i);
  return m ? decodeHtml(m[1]!) : undefined;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

export async function fetchIgPosts(urls: string[]): Promise<IgPost[]> {
  const out: IgPost[] = [];
  for (const url of urls) {
    try {
      const post = await fetchIgPost(url);
      if (post) {
        out.push(post);
        console.log(`✓ ig: ${url}`);
      } else {
        console.warn(`✗ ig (no caption): ${url}`);
      }
    } catch (err) {
      console.warn(`✗ ig error ${url}:`, err);
    }
  }
  return out;
}
