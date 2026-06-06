import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../src/config.js";
import { scanRecipeSources, type RecipeCandidate } from "../src/recipes.js";

interface CandidatesFile {
  scannedAt: string;
  candidates: RecipeCandidate[];
}

function loadExisting(): RecipeCandidate[] {
  if (!fs.existsSync(PATHS.recipeCandidates)) return [];
  try {
    return (JSON.parse(fs.readFileSync(PATHS.recipeCandidates, "utf8")) as CandidatesFile).candidates;
  } catch {
    return [];
  }
}

async function main() {
  const existing = loadExisting();
  const seen = new Set(existing.map((c) => c.url));
  const fresh = (await scanRecipeSources(4)).filter((c) => !seen.has(c.url));
  const merged: CandidatesFile = {
    scannedAt: new Date().toISOString(),
    candidates: [...fresh, ...existing].slice(0, 200),
  };
  fs.mkdirSync(path.dirname(PATHS.recipeCandidates), { recursive: true });
  fs.writeFileSync(PATHS.recipeCandidates, JSON.stringify(merged, null, 2), "utf8");
  console.log(`\n✅ ${fresh.length} new + ${existing.length} existing → ${PATHS.recipeCandidates}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
