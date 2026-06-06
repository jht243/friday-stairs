import path from "node:path";

const root = process.cwd();

export const PATHS = {
  root,
  corpus: path.join(root, "data/corpus/posts.json"),
  corpusDir: path.join(root, "data/corpus/posts"),
  pasteDir: path.join(root, "data/corpus/paste"),
  igUrlsFile: path.join(root, "data/corpus/ig-urls.txt"),
  siteUrlsFile: path.join(root, "data/corpus/site-urls.txt"),
  embeddings: path.join(root, "data/embeddings/index.json"),
  styleGuide: path.join(root, "prompts/fs-style.md"),
  systemPrompt: path.join(root, "prompts/system.md"),
  outputDir: path.join(root, "output"),
  news: path.join(root, "data/news/index.json"),
  recipeCandidates: path.join(root, "data/recipes/candidates.json"),
  recipeSources: path.join(root, "data/recipes/sources.json"),
  dismissed: path.join(root, "data/dismissed.json"),
  approvedDir: path.join(root, "data/approved"),
  rsvp: path.join(root, "data/rsvp.json"),
};

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const GENERATION_MODEL = "gpt-4o";

export const FS_BRAND = {
  name: "Friday Stairs",
  city: "Tampa",
  location: "Tampa Riverwalk / Convention Center",
  cadence: "every Friday, 7am",
  hashtags: ["#fridaystairs", "#tampafitness", "#riverwalkrun"],
  instagram: "@fridaystairs",
};

export interface CorpusPost {
  id: string;
  date: string;
  slug: string;
  link: string;
  title: string;
  excerpt: string;
  body: string;
  categories: string[];
}
