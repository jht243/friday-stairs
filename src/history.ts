import crypto from "node:crypto";

// ───────────────────────────────────────────────────────────────────────────
// Generated-content memory, backed by Supabase (table: generated_content).
//
// Purpose: stop the newsletter from ever shipping the same title or the exact
// same generated body twice. Every generated item is recorded; "skip" and
// "submit" flip its status so it is never reused.
//
// Scaling: history is NEVER dumped into the LLM prompt (that would grow without
// bound). Uniqueness is guaranteed by a DB lookup on title_norm + fingerprint
// with a regenerate-on-collision retry. Only a small bounded set of recent
// titles is offered as a soft nudge to reduce retries.
//
// Degradation: if Supabase env/keys are missing or a request fails, every
// function fails soft (logs a warning, returns a permissive default) so the
// app keeps working without dedup rather than breaking.
// ───────────────────────────────────────────────────────────────────────────

export type SectionKind =
  | "recipe"
  | "news-blurb"
  | "workout-tip"
  | "playlist"
  | "weekly-recap"
  | "message-of-week";

export type HistoryStatus = "generated" | "skipped" | "submitted";

export interface HistoryRow {
  id: string;
  section_type: SectionKind;
  title: string;
  title_norm: string;
  markdown: string;
  fingerprint: string;
  source_url: string | null;
  status: HistoryStatus;
  created_at: string;
  updated_at: string;
}

const TABLE = "generated_content";

function cfg(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

async function rest(pathAndQuery: string, init: RequestInit = {}): Promise<Response | null> {
  const c = cfg();
  if (!c) {
    console.warn("⚠ history: SUPABASE_URL/SUPABASE_SECRET_KEY not set — dedup disabled.");
    return null;
  }
  const headers: Record<string, string> = {
    apikey: c.key,
    Authorization: `Bearer ${c.key}`,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  try {
    const res = await fetch(`${c.url}/rest/v1/${pathAndQuery}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`⚠ history: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
      return null;
    }
    return res;
  } catch (err) {
    console.warn(`⚠ history: request failed — ${String(err)}`);
    return null;
  }
}

// ── normalization ──────────────────────────────────────────────────────────

export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[*_#>`~]/g, "")        // strip markdown punctuation
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip remaining punctuation/emoji
    .replace(/\s+/g, " ")
    .trim();
}

// Fingerprint of the *content* — catches "the exact same workout" even if the
// title differs. Normalizes away whitespace/markdown/case so trivial
// re-formatting still collides.
export function fingerprint(sectionType: SectionKind, markdown: string): string {
  const body = markdown
    .toLowerCase()
    .replace(/[*_#>`~\-]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
  return crypto.createHash("sha256").update(`${sectionType}:${body}`).digest("hex");
}

// ── reads ──────────────────────────────────────────────────────────────────

/**
 * True if a row with the same normalized title OR the same content fingerprint
 * already exists for this section type (any status). On any error, returns
 * false (fail-open) so generation is never blocked by an outage.
 */
export async function isDuplicate(sectionType: SectionKind, title: string, markdown: string): Promise<boolean> {
  const tn = normTitle(title);
  const fp = fingerprint(sectionType, markdown);
  const orParts: string[] = [`fingerprint.eq.${encodeURIComponent(fp)}`];
  if (tn) orParts.push(`title_norm.eq.${encodeURIComponent(tn)}`);
  const q = `${TABLE}?select=id&section_type=eq.${encodeURIComponent(sectionType)}&or=(${orParts.join(",")})&limit=1`;
  const res = await rest(q);
  if (!res) return false;
  const rows = (await res.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Source URLs already used up for a section type — i.e. submitted (went out) or
 * skipped (rejected). Recipe/news candidate lists filter against this so the
 * same recipe/article is never offered twice. ('generated' is NOT included —
 * a draft you haven't acted on can still be offered.)
 */
export async function usedSourceUrls(sectionType: SectionKind): Promise<Set<string>> {
  const q = `${TABLE}?select=source_url&section_type=eq.${encodeURIComponent(sectionType)}&status=in.(submitted,skipped)&source_url=not.is.null`;
  const res = await rest(q);
  if (!res) return new Set();
  const rows = (await res.json().catch(() => [])) as Array<{ source_url?: string }>;
  return new Set(rows.map((r) => r.source_url ?? "").filter(Boolean));
}

/** Recent titles for a section type — a small bounded soft nudge for the prompt. */
export async function recentTitles(sectionType: SectionKind, limit = 15): Promise<string[]> {
  const q = `${TABLE}?select=title&section_type=eq.${encodeURIComponent(sectionType)}&order=created_at.desc&limit=${limit}`;
  const res = await rest(q);
  if (!res) return [];
  const rows = (await res.json().catch(() => [])) as Array<{ title?: string }>;
  return rows.map((r) => r.title ?? "").filter(Boolean);
}

// ── writes ─────────────────────────────────────────────────────────────────

export interface RecordInput {
  sectionType: SectionKind;
  title: string;
  markdown: string;
  sourceUrl?: string | null;
  status?: HistoryStatus;
}

/** Insert a generated item. Returns the new row id, or null if not persisted. */
export async function record(input: RecordInput): Promise<string | null> {
  const row = {
    section_type: input.sectionType,
    title: input.title,
    title_norm: normTitle(input.title),
    markdown: input.markdown,
    fingerprint: fingerprint(input.sectionType, input.markdown),
    source_url: input.sourceUrl ?? null,
    status: input.status ?? "generated",
  };
  const res = await rest(TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res) return null;
  const out = (await res.json().catch(() => [])) as HistoryRow[];
  return out[0]?.id ?? null;
}

async function patchStatus(filter: string, status: HistoryStatus): Promise<boolean> {
  const res = await rest(`${TABLE}?${filter}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
  return !!res;
}

/** Mark a single recorded item (by id) as skipped — never reuse. */
export async function markSkippedById(id: string): Promise<boolean> {
  return patchStatus(`id=eq.${encodeURIComponent(id)}`, "skipped");
}

/**
 * Mark by content — used when the UI only knows the section + title/markdown
 * (e.g. skipping a workout option that may not have a stored id yet). Matches
 * on title_norm OR fingerprint. Upserts a 'skipped' row if nothing matched, so
 * the skip still sticks for future dedup.
 */
export async function markSkippedByContent(sectionType: SectionKind, title: string, markdown: string): Promise<boolean> {
  const tn = normTitle(title);
  const fp = fingerprint(sectionType, markdown);
  const orParts: string[] = [`fingerprint.eq.${encodeURIComponent(fp)}`];
  if (tn) orParts.push(`title_norm.eq.${encodeURIComponent(tn)}`);
  const filter = `section_type=eq.${encodeURIComponent(sectionType)}&or=(${orParts.join(",")})`;
  const res = await rest(`${TABLE}?${filter}&select=id`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "skipped", updated_at: new Date().toISOString() }),
  });
  const updated = res ? ((await res.json().catch(() => [])) as unknown[]) : [];
  if (Array.isArray(updated) && updated.length > 0) return true;
  // Nothing existed → record it directly as skipped.
  return (await record({ sectionType, title, markdown, status: "skipped" })) !== null;
}

/**
 * Mark content as submitted (went out in an email) — never reuse. Matches on
 * title_norm OR fingerprint. Flip-only: submit always acts on an item that was
 * already recorded at generation time, so there is nothing to upsert.
 */
export async function markSubmittedByContent(sectionType: SectionKind, title: string, markdown: string): Promise<boolean> {
  const tn = normTitle(title);
  const fp = fingerprint(sectionType, markdown);
  const orParts: string[] = [`fingerprint.eq.${encodeURIComponent(fp)}`];
  if (tn) orParts.push(`title_norm.eq.${encodeURIComponent(tn)}`);
  const filter = `section_type=eq.${encodeURIComponent(sectionType)}&or=(${orParts.join(",")})`;
  return patchStatus(filter, "submitted");
}
