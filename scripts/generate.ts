import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { PATHS } from "../src/config.js";
import { generateSection, type SectionType } from "../src/generate.js";
import { scrapeRecipeFromUrl } from "../src/recipes.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const type = (arg("type") ?? "workout-tip") as SectionType;
  const out = arg("output");

  let section;
  if (type === "recipe-blurb") {
    const url = arg("url");
    if (!url) throw new Error("--url required for recipe-blurb");
    const recipe = await scrapeRecipeFromUrl(url);
    if (!recipe) throw new Error(`Could not parse recipe from ${url}`);
    section = await generateSection(client, { type, source: { recipe } });
  } else if (type === "news-blurb") {
    const url = arg("url");
    const title = arg("title") ?? "Untitled";
    const summary = arg("summary") ?? "";
    if (!url) throw new Error("--url required");
    section = await generateSection(client, { type, source: { news: { url, title, summary } } });
  } else if (type === "weekly-recap") {
    const notes = arg("notes") ?? "";
    section = await generateSection(client, { type, source: { recap: { posts: [], manualNotes: notes } } });
  } else {
    const focus = arg("focus");
    section = await generateSection(client, { type, source: { tip: { focus } } });
  }

  console.log(`\n=== ${section.title} (${section.wordCount} words) ===\n`);
  console.log(section.markdown);

  if (out) {
    const full = path.resolve(out);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, section.markdown, "utf8");
    console.log(`\n→ saved to ${out}`);
  } else {
    fs.mkdirSync(PATHS.outputDir, { recursive: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
