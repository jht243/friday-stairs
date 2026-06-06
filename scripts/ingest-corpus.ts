import fs from "node:fs";
import path from "node:path";
import { PATHS, type CorpusPost } from "../src/config.js";
import { fetchArticle } from "../src/fetch-article.js";
import { fetchIgPosts } from "../src/ig-scraper.js";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || `item-${Date.now()}`;
}

function readUrlList(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function readPasteDir(dir: string): CorpusPost[] {
  if (!fs.existsSync(dir)) return [];
  const out: CorpusPost[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") && !f.endsWith(".txt")) continue;
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    const body = fs.readFileSync(full, "utf8");
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? f;
    const title = firstLine.replace(/^#\s+/, "").trim().slice(0, 120);
    out.push({
      id: `paste-${f}`,
      date: stat.mtime.toISOString(),
      slug: slugify(f.replace(/\.[a-z]+$/, "")),
      link: `paste://${f}`,
      title,
      excerpt: body.slice(0, 280),
      body: body.trim(),
      categories: ["paste"],
    });
  }
  return out;
}

async function main() {
  const igUrls = readUrlList(PATHS.igUrlsFile);
  const siteUrls = readUrlList(PATHS.siteUrlsFile);

  console.log(`📷 IG posts to fetch: ${igUrls.length}`);
  const igPosts = await fetchIgPosts(igUrls);
  const igCorpus: CorpusPost[] = igPosts.map((p) => ({
    id: `ig-${slugify(p.url)}`,
    date: p.fetchedAt,
    slug: slugify(p.url),
    link: p.url,
    title: (p.caption.split("\n")[0] ?? "Instagram post").slice(0, 120),
    excerpt: p.caption.slice(0, 280),
    body: p.caption,
    categories: ["instagram"],
  }));

  console.log(`🌐 site URLs to fetch: ${siteUrls.length}`);
  const siteCorpus: CorpusPost[] = [];
  for (const url of siteUrls) {
    try {
      const { title, text } = await fetchArticle(url);
      siteCorpus.push({
        id: `site-${slugify(url)}`,
        date: new Date().toISOString(),
        slug: slugify(url),
        link: url,
        title: title.slice(0, 120),
        excerpt: text.slice(0, 280),
        body: text,
        categories: ["site"],
      });
      console.log(`✓ site: ${url}`);
    } catch (err) {
      console.warn(`✗ site ${url}:`, err);
    }
  }

  console.log(`📝 paste dir: ${PATHS.pasteDir}`);
  const pasteCorpus = readPasteDir(PATHS.pasteDir);
  console.log(`✓ paste: ${pasteCorpus.length} files`);

  const posts = [...igCorpus, ...siteCorpus, ...pasteCorpus];

  fs.mkdirSync(path.dirname(PATHS.corpus), { recursive: true });
  fs.mkdirSync(PATHS.corpusDir, { recursive: true });
  fs.writeFileSync(PATHS.corpus, JSON.stringify(posts, null, 2), "utf8");

  for (const post of posts) {
    const md = `# ${post.title}\n\nSource: ${post.link}\nDate: ${post.date}\nCategory: ${post.categories.join(", ")}\n\n${post.body}\n`;
    fs.writeFileSync(path.join(PATHS.corpusDir, `${post.slug}.md`), md, "utf8");
  }

  console.log(`\n✅ Ingested ${posts.length} voice samples → ${PATHS.corpus}`);
  if (posts.length < 10) {
    console.warn(`\n⚠ Only ${posts.length} samples. Voice quality will be thin.`);
    console.warn(`   Add IG post URLs to: ${PATHS.igUrlsFile}`);
    console.warn(`   Drop markdown into:   ${PATHS.pasteDir}/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
