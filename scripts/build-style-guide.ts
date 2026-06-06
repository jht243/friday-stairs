import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { FS_BRAND, GENERATION_MODEL, PATHS, type CorpusPost } from "../src/config.js";
import { buildQuantifiedSection } from "../src/style-stats.js";

function samplePosts(posts: CorpusPost[], count: number): CorpusPost[] {
  if (posts.length <= count) return posts;
  const step = Math.max(1, Math.floor(posts.length / count));
  const sampled: CorpusPost[] = [];
  for (let i = 0; i < posts.length && sampled.length < count; i += step) {
    sampled.push(posts[i]!);
  }
  return sampled;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required. Copy .env.example to .env and add your key.");
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (!fs.existsSync(PATHS.corpus)) {
    throw new Error(`Corpus not found at ${PATHS.corpus}. Run \`npm run ingest\` first.`);
  }
  const posts = JSON.parse(fs.readFileSync(PATHS.corpus, "utf8")) as CorpusPost[];
  if (posts.length === 0) {
    throw new Error("Corpus is empty. Add IG URLs / paste files and re-run ingest.");
  }
  const sample = samplePosts(posts, Math.min(12, posts.length));

  const corpusSample = sample
    .map((p, i) => `## Sample ${i + 1}: ${p.title}\nDate: ${p.date}\nSource: ${p.link}\n\n${p.body.slice(0, 2000)}`)
    .join("\n\n---\n\n");

  console.log(`Analyzing ${sample.length} samples for ${FS_BRAND.name} voice...`);

  const res = await client.chat.completions.create({
    model: GENERATION_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "You produce concrete, distinctive style guides for community fitness brands. Focus on what makes THIS voice different, not generic copywriting advice.",
      },
      {
        role: "user",
        content: `Analyze these voice samples from ${FS_BRAND.name} — a free, donation-optional Friday 7am stair workout on the ${FS_BRAND.location}, with a live DJ. Audience is mixed-ability Tampa locals: runners, lifters, beginners, kids in strollers.

Produce a markdown style guide focused on SPECIFIC and DISTINCTIVE patterns. Include:

1. **Voice & Tone** — 2-3 distinguishing traits (not generic "energetic/friendly")
2. **Sentence rhythm** — typical sentence length, fragment use, em-dashes
3. **Vocabulary that's over-indexed** — words/phrases this voice uses more than average
4. **Vocabulary to avoid** — what would sound "off" coming from this account
5. **Community / Tampa references** — places, regulars, in-jokes that recur
6. **Emoji & formatting habits** — which emoji are on-brand vs off-brand; capitalization quirks
7. **Hype calibration** — how the voice expresses excitement without crossing into corporate marketing

If a section can't be supported by the samples, write "(insufficient samples — TBD)" instead of making it up.

SAMPLES:
${corpusSample}`,
      },
    ],
  });

  const qualitative = res.choices[0]?.message?.content?.trim();
  if (!qualitative) throw new Error("Style guide generation returned empty");

  const quantified = buildQuantifiedSection(posts);
  const guide = `# Style Guide — ${FS_BRAND.name}\n\n_Auto-generated from ${posts.length} voice samples (${sample.length} sampled for analysis)._\n\n${qualitative}\n\n---\n\n${quantified}`;

  fs.mkdirSync(path.dirname(PATHS.styleGuide), { recursive: true });
  fs.writeFileSync(PATHS.styleGuide, guide, "utf8");
  console.log(`✅ Style guide saved → ${PATHS.styleGuide}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
