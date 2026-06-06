import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../src/config.js";
import { scanNews } from "../src/news.js";

async function main() {
  const items = await scanNews(15);
  fs.mkdirSync(path.dirname(PATHS.news), { recursive: true });
  fs.writeFileSync(PATHS.news, JSON.stringify({ scannedAt: new Date().toISOString(), items }, null, 2), "utf8");
  console.log(`\n✅ Saved ${items.length} fitness news items → ${PATHS.news}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
