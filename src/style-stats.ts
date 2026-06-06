import type { CorpusPost } from "./config.js";

export interface StyleStats {
  postCount: number;
  avgSentenceLength: number;
  avgParagraphLength: number;
  emDashesPerPost: number;
  semicolonsPerPost: number;
  firstPersonRate: number;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function paragraphs(body: string): string[] {
  return stripMarkdown(body)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"));
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z“"])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

export function computeStyleStats(posts: CorpusPost[]): StyleStats {
  let sentenceLens: number[] = [];
  let paragraphLens: number[] = [];
  let emDash = 0;
  let semi = 0;
  let firstPersonSentences = 0;
  let totalSentences = 0;

  for (const post of posts) {
    const paras = paragraphs(post.body);
    for (const para of paras) {
      paragraphLens.push(para.split(/\s+/).length);
      for (const s of sentences(para)) {
        const words = s.split(/\s+/).filter(Boolean);
        sentenceLens.push(words.length);
        totalSentences++;
        if (/\b(I|my|we|our|us)\b/.test(s)) firstPersonSentences++;
      }
    }
    emDash += (post.body.match(/—|--/g) ?? []).length;
    semi += (post.body.match(/;/g) ?? []).length;
  }

  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  return {
    postCount: posts.length,
    avgSentenceLength: Math.round(avg(sentenceLens) * 10) / 10,
    avgParagraphLength: Math.round(avg(paragraphLens) * 10) / 10,
    emDashesPerPost: Math.round((emDash / posts.length) * 10) / 10,
    semicolonsPerPost: Math.round((semi / posts.length) * 10) / 10,
    firstPersonRate:
      Math.round((firstPersonSentences / Math.max(1, totalSentences)) * 1000) /
      1000,
  };
}

export function extractHeadlines(posts: CorpusPost[]): string[] {
  return posts.map((p) => p.title);
}

export function extractOpeners(posts: CorpusPost[], maxChars = 280): string[] {
  const openers: string[] = [];
  for (const post of posts) {
    const paras = paragraphs(post.body);
    const first = paras.find((p) => p.length > 60);
    if (!first) continue;
    const sentence = sentences(first)[0] ?? first;
    openers.push(sentence.slice(0, maxChars).trim());
  }
  return openers;
}

export function extractClosers(posts: CorpusPost[], maxChars = 400): string[] {
  const closers: string[] = [];
  for (const post of posts) {
    const paras = paragraphs(post.body);
    if (!paras.length) continue;
    const last = paras[paras.length - 1]!;
    closers.push(last.slice(0, maxChars).trim());
  }
  return closers;
}

export function buildQuantifiedSection(posts: CorpusPost[]): string {
  const stats = computeStyleStats(posts);
  const headlines = extractHeadlines(posts);
  const openers = extractOpeners(posts).slice(0, 15);
  const closers = extractClosers(posts).slice(0, 8);

  return `## Quantified Voice Signals (computed from ${stats.postCount} posts)

- Avg sentence length: **${stats.avgSentenceLength} words**
- Avg paragraph length: **${stats.avgParagraphLength} words**
- Em-dashes per post: **${stats.emDashesPerPost}**
- Semicolons per post: **${stats.semicolonsPerPost}**
- First-person sentence rate: **${(stats.firstPersonRate * 100).toFixed(1)}%** (Jeff occasionally uses "in my experience")

## Real Headlines (match this distribution; do NOT default to "What X Means for Investors")

${headlines.map((h) => `- ${h}`).join("\n")}

## Verbatim Opening Sentences (match cadence and information density)

${openers.map((o) => `> ${o}`).join("\n\n")}

## Verbatim Closing Paragraphs (CTA voice — match this register)

${closers.map((c) => `> ${c}`).join("\n\n")}
`;
}
