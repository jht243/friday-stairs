import fs from "node:fs";
import OpenAI from "openai";
import { EMBEDDING_MODEL, PATHS } from "./config.js";
import type { Chunk } from "./chunker.js";
import type { CorpusPost } from "./config.js";

export interface IndexedChunk extends Chunk {
  embedding: number[];
}

export interface EmbeddingIndex {
  model: string;
  createdAt: string;
  chunks: IndexedChunk[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let cachedIndex: EmbeddingIndex | null = null;
export function loadIndex(): EmbeddingIndex {
  if (cachedIndex) return cachedIndex;
  const raw = fs.readFileSync(PATHS.embeddings, "utf8");
  cachedIndex = JSON.parse(raw) as EmbeddingIndex;
  return cachedIndex;
}

let cachedCorpus: CorpusPost[] | null = null;
export function loadCorpus(): CorpusPost[] {
  if (cachedCorpus) return cachedCorpus;
  cachedCorpus = JSON.parse(fs.readFileSync(PATHS.corpus, "utf8")) as CorpusPost[];
  return cachedCorpus;
}

export async function embedTexts(client: OpenAI, texts: string[]): Promise<number[][]> {
  const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return res.data.map((d) => d.embedding);
}

interface Scored {
  chunk: IndexedChunk;
  score: number;
}

function scoreAll(index: EmbeddingIndex, queryEmbedding: number[]): Scored[] {
  return index.chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score);
}

/** MMR: balance relevance to query against diversity among picks. */
function mmrSelect(candidates: Scored[], k: number, lambda = 0.65): IndexedChunk[] {
  const picked: Scored[] = [];
  const pool = candidates.slice(0, Math.min(candidates.length, k * 5));

  while (picked.length < k && pool.length) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]!;
      const maxSimToPicked = picked.length
        ? Math.max(
            ...picked.map((p) => cosineSimilarity(cand.chunk.embedding, p.chunk.embedding)),
          )
        : 0;
      const mmr = lambda * cand.score - (1 - lambda) * maxSimToPicked;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    picked.push(pool[bestIdx]!);
    pool.splice(bestIdx, 1);
  }

  return picked.map((p) => p.chunk);
}

export async function retrieveSimilar(
  client: OpenAI,
  query: string,
  topK = 5,
): Promise<IndexedChunk[]> {
  const index = loadIndex();
  const [queryEmbedding] = await embedTexts(client, [query]);
  const scored = scoreAll(index, queryEmbedding!);
  return mmrSelect(scored, topK);
}

/** Retrieve top distinct posts (full bodies) for use as few-shot exemplars. */
export async function retrieveFullPosts(
  client: OpenAI,
  query: string,
  topK = 2,
): Promise<CorpusPost[]> {
  const index = loadIndex();
  const corpus = loadCorpus();
  const [queryEmbedding] = await embedTexts(client, [query]);
  const scored = scoreAll(index, queryEmbedding!);

  const seen = new Set<string>();
  const picked: CorpusPost[] = [];
  for (const s of scored) {
    if (seen.has(s.chunk.postSlug)) continue;
    const post = corpus.find((p) => p.slug === s.chunk.postSlug);
    if (!post) continue;
    seen.add(s.chunk.postSlug);
    picked.push(post);
    if (picked.length >= topK) break;
  }
  return picked;
}
