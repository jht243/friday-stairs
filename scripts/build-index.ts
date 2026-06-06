import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { chunkMarkdown } from "../src/chunker.js";
import { EMBEDDING_MODEL, PATHS } from "../src/config.js";
import { embedTexts, type EmbeddingIndex } from "../src/rag.js";
import type { CorpusPost } from "../src/config.js";

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required. Copy .env.example to .env and add your key.");
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const posts = JSON.parse(fs.readFileSync(PATHS.corpus, "utf8")) as CorpusPost[];

  console.log(`Building embedding index from ${posts.length} posts...`);

  const allChunks = posts.flatMap((post) => chunkMarkdown(post.slug, post.title, post.body));
  console.log(`Created ${allChunks.length} chunks`);

  const BATCH = 50;
  const indexed: EmbeddingIndex["chunks"] = [];

  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH);
    const embeddings = await embedTexts(
      client,
      batch.map((c) => `${c.postTitle}\n${c.heading}\n${c.text}`),
    );

    batch.forEach((chunk, j) => {
      indexed.push({ ...chunk, embedding: embeddings[j]! });
    });

    console.log(`Embedded ${Math.min(i + BATCH, allChunks.length)}/${allChunks.length}`);
  }

  const index: EmbeddingIndex = {
    model: EMBEDDING_MODEL,
    createdAt: new Date().toISOString(),
    chunks: indexed,
  };

  fs.mkdirSync(path.dirname(PATHS.embeddings), { recursive: true });
  fs.writeFileSync(PATHS.embeddings, JSON.stringify(index), "utf8");

  console.log(`Index saved → ${PATHS.embeddings}`);
  console.log(`Corpus: ${posts.length} posts, ${indexed.length} chunks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
