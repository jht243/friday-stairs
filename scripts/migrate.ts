import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Runs every .sql file in scripts/sql in name order against SUPABASE_DB_URL.
// Idempotent — all migrations use "if not exists".

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(__dirname, "sql");

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error("✗ SUPABASE_DB_URL is not set in .env — add the Postgres connection URI (Supabase → Project Settings → Database → Connection string → URI).");
    process.exit(1);
  }

  const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) { console.log("No .sql files to run."); return; }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(SQL_DIR, f), "utf8");
      process.stdout.write(`→ ${f} … `);
      await client.query(sql);
      console.log("ok");
    }
    console.log("✓ Migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error("✗ Migration failed:", err.message); process.exit(1); });
