import fs from "node:fs";
import OpenAI from "openai";
import { FS_BRAND, GENERATION_MODEL, PATHS } from "./config.js";
import { applyComplianceFooter, hasBannedPhrases } from "./compliance.js";
import { retrieveSimilar } from "./rag.js";
import type { RecipeCandidate } from "./recipes.js";
import type { IgPost } from "./ig-scraper.js";
import { isDuplicate, recentTitles, record, normTitle, fingerprint, type SectionKind } from "./history.js";

const TEMPERATURE = 0.4;

export type SectionType = "recipe-blurb" | "news-blurb" | "weekly-recap" | "workout-tip";

// Map the generator's section types to the history table's section kinds.
const HISTORY_KIND: Record<SectionType, SectionKind> = {
  "recipe-blurb": "recipe",
  "news-blurb": "news-blurb",
  "weekly-recap": "weekly-recap",
  "workout-tip": "workout-tip",
};

// Which section types dedup on title+content (fully generated). Recipe/news
// have a legitimately fixed title (the recipe/article name) and are deduped at
// the SOURCE level instead, so they are excluded here.
const CONTENT_DEDUP: Record<SectionType, boolean> = {
  "recipe-blurb": false,
  "news-blurb": false,
  "weekly-recap": false, // each recap is about a specific week — never dedup it
  "workout-tip": true,
};

const MAX_DEDUP_ATTEMPTS = 3;

export interface RecipeSource { recipe: RecipeCandidate }
export interface NewsSource { news: { title: string; url: string; summary: string; sourceName?: string } }
export interface RecapSource { recap: { fridayDate?: string; posts: IgPost[]; manualNotes?: string } }
export interface TipSource { tip: { focus?: string; notes?: string } }

export interface GenerateSectionInput {
  type: SectionType;
  source: RecipeSource | NewsSource | RecapSource | TipSource;
}

export interface GeneratedSection {
  type: SectionType;
  title: string;
  markdown: string;
  wordCount: number;
}

const SPEC: Record<SectionType, { minWords: number; maxWords: number; needsFooter: boolean; titleHint: string }> = {
  "recipe-blurb": { minWords: 40, maxWords: 90, needsFooter: false, titleHint: "Use the recipe name" },
  "news-blurb": { minWords: 60, maxWords: 110, needsFooter: true, titleHint: "A short hook that frames why the crew should care" },
  "weekly-recap": { minWords: 120, maxWords: 220, needsFooter: true, titleHint: 'e.g. "Last Friday" or a date-stamped recap title' },
  "workout-tip": { minWords: 110, maxWords: 260, needsFooter: true, titleHint: "A punchy workout name" },
};

function loadStyleGuide(): string {
  if (!fs.existsSync(PATHS.styleGuide)) return "(style guide not built yet — using system prompt only)";
  return fs.readFileSync(PATHS.styleGuide, "utf8");
}

function loadSystemPrompt(): string {
  return fs.readFileSync(PATHS.systemPrompt, "utf8");
}

async function ragContext(client: OpenAI, query: string): Promise<string> {
  try {
    const chunks = await retrieveSimilar(client, query, 3);
    if (!chunks.length) return "";
    return chunks
      .map((c, i) => `### Voice Sample ${i + 1} (from "${c.postTitle}")\n${c.text.slice(0, 600)}`)
      .join("\n\n");
  } catch {
    return ""; // missing index → soft fail
  }
}

function buildUserPrompt(input: GenerateSectionInput, styleGuide: string, voice: string): { prompt: string; ragQuery: string; titleSeed: string } {
  const spec = SPEC[input.type];
  const brand = `Brand context: ${FS_BRAND.name}, ${FS_BRAND.cadence}, ${FS_BRAND.location}.`;

  if (input.type === "recipe-blurb") {
    const r = (input.source as RecipeSource).recipe;
    const ingredients = r.ingredients.slice(0, 8).join("; ");
    return {
      ragQuery: `${r.title} recipe food`,
      titleSeed: r.title,
      prompt: `Write a ${spec.minWords}-${spec.maxWords} word **recipe blurb** for the Friday Stairs newsletter introducing this week's recipe pick. Frame why the FS crew would care (fueling a Friday workout, post-run protein, easy weeknight, etc).

${brand}

RECIPE:
- Title: ${r.title}
- Source: ${r.sourceName} (${r.url})
- Servings: ${r.servings ?? "n/a"}
- Time: ${r.totalTime ?? "n/a"}
- Calories: ${r.calories ?? "n/a"}
- Ingredients (partial): ${ingredients}
- Description: ${r.description ?? ""}

STYLE GUIDE:
${styleGuide}

VOICE SAMPLES:
${voice}

Output ONLY the blurb as plain markdown — no heading, no preamble. Don't restate the full ingredient list (that comes after the blurb). End with a link line like "Recipe: [${r.sourceName}](${r.url})".`,
    };
  }

  if (input.type === "news-blurb") {
    const n = (input.source as NewsSource).news;
    return {
      ragQuery: n.title,
      titleSeed: n.title,
      prompt: `Write a ${spec.minWords}-${spec.maxWords} word **news blurb** for the Friday Stairs newsletter. Summarize the article in our voice and connect it to what the crew is doing on the Riverwalk.

${brand}

ARTICLE:
- Title: ${n.title}
- Source: ${n.sourceName ?? n.url}
- URL: ${n.url}
- Summary: ${n.summary}

STYLE GUIDE:
${styleGuide}

VOICE SAMPLES:
${voice}

Output ONLY the blurb as plain markdown — no heading, no preamble. End with "Read it: [${n.sourceName ?? "source"}](${n.url})".`,
    };
  }

  if (input.type === "weekly-recap") {
    const r = (input.source as RecapSource).recap;
    const captions = r.posts.map((p, i) => `[${i + 1}] @${p.authorName ?? "fridaystairs"}: ${p.caption.slice(0, 400)}`).join("\n");
    return {
      ragQuery: "weekly recap stairs riverwalk crew",
      titleSeed: r.fridayDate ?? "Last Friday",
      prompt: `Write a ${spec.minWords}-${spec.maxWords} word **weekly recap** for the newsletter. Reference SPECIFIC moments from the captions below — names, weather, the DJ, the climb count, anything concrete. No generic "great vibes" filler.

${brand}
Friday date: ${r.fridayDate ?? "(most recent Friday)"}

IG CAPTIONS FROM THE SESSION:
${captions || "(none provided)"}

EXTRA NOTES:
${r.manualNotes ?? "(none)"}

STYLE GUIDE:
${styleGuide}

VOICE SAMPLES:
${voice}

Output ONLY the recap as plain markdown. No heading, no preamble. End with a one-line callout for next Friday (date implied).`,
    };
  }

  // workout-tip → a full structured P90X-style stair workout
  const t = (input.source as TipSource).tip;
  return {
    ragQuery: t.focus ?? "stair workout circuit",
    titleSeed: t.focus ?? "Workout of the Week",
    prompt: `Write a complete **stair workout** for the Friday Stairs newsletter, in a P90X / structured-circuit style. Doable outdoors on the Riverwalk stairs with NO equipment (just stairs + bodyweight).

${brand}
${t.focus ? `Theme / focus: ${t.focus}` : "Pick a clear theme (e.g. legs & lungs, core + climb, speed intervals, full-body burner)."}
${t.notes ? `Notes: ${t.notes}` : ""}

Format as markdown EXACTLY like this:

## [Punchy workout name]
[One line on what it targets and roughly how long.]

**Warm-Up** _(~5 min)_
- [move — reps or time]
- [move — reps or time]

**The Circuit** _(repeat X rounds)_
1. [Move name] — [reps or time]
2. [Move name] — [reps or time]
3. [Move name] — [reps or time]
4. [Move name] — [reps or time]
5. [Move name] — [reps or time]

**Finisher** _(~3 min)_
- [one all-out burnout move]

**Cool-Down**
- [stretch or easy walk]

Rules:
- 5–7 named moves in the circuit. Use stair-friendly moves: stair sprints, step-ups, incline push-ups (hands on a step), tricep dips on a step, calf raises on the edge, mountain climbers, split squats, bear crawls up the steps, etc.
- Give concrete reps or a time for EVERY move (e.g. "12 each leg", "30 sec", "2 flights").
- State the number of rounds.
- Keep it in Friday Stairs voice — hype but clear. Short lines.

STYLE GUIDE:
${styleGuide}

VOICE SAMPLES:
${voice}

Output ONLY the workout as plain markdown. No preamble, no code fences.`,
  };
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function extractTitle(markdown: string, fallback: string): string {
  // Prefer a markdown heading (workouts lead with "## Name"); fall back to the
  // first bold span, then the first non-empty line. Heading-first avoids picking
  // up "**Warm-Up**" as the title of a workout.
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m);
  if (heading && heading[1]) return heading[1].replace(/[*_`]/g, "").trim().slice(0, 80);
  const bold = markdown.match(/^\*\*(.+?)\*\*/m);
  if (bold && bold[1]) return bold[1].trim().slice(0, 80);
  const first = markdown.split("\n").find((l) => l.trim().length > 0);
  return (first ?? fallback).replace(/^[*_#-]+\s*/, "").slice(0, 80);
}

export async function generateSection(client: OpenAI, input: GenerateSectionInput): Promise<GeneratedSection> {
  const spec = SPEC[input.type];
  const kind = HISTORY_KIND[input.type];
  const contentDedup = CONTENT_DEDUP[input.type];
  const styleGuide = loadStyleGuide();
  const system = loadSystemPrompt();
  const built = buildUserPrompt(input, styleGuide, "");
  const voice = await ragContext(client, built.ragQuery);
  const finalPrompt = buildUserPrompt(input, styleGuide, voice);

  // Soft, BOUNDED nudge: a handful of recent titles to steer away from — never
  // the full history (keeps the prompt from growing without bound over years).
  const avoid = contentDedup ? await recentTitles(kind, 15) : [];
  const avoidBlock = avoid.length
    ? `\n\nAlready used recently — do NOT repeat these titles or rehash them:\n${avoid.map((t) => `- ${t}`).join("\n")}`
    : "";

  let markdown = "";
  let title = "";
  let words = 0;

  // Generate, then guarantee uniqueness via a DB check. On collision, regenerate
  // with a stronger nudge (up to MAX_DEDUP_ATTEMPTS). The DB check — not the
  // prompt — is what actually guarantees no repeated title or identical body.
  for (let attempt = 0; attempt < MAX_DEDUP_ATTEMPTS; attempt++) {
    const nudge = attempt === 0
      ? avoidBlock
      : `${avoidBlock}\n\nThe previous attempt collided with something already used. Produce a COMPLETELY DIFFERENT one — new title, new structure, new content.`;

    const res = await client.chat.completions.create({
      model: GENERATION_MODEL,
      temperature: attempt === 0 ? TEMPERATURE : Math.min(TEMPERATURE + 0.25 * attempt, 0.9),
      messages: [
        { role: "system", content: system },
        { role: "user", content: finalPrompt.prompt + nudge },
      ],
    });

    markdown = res.choices[0]?.message?.content?.trim() ?? "";

    // Length retry — one shot. If wildly out of bounds, ask the model to trim/expand.
    words = countWords(markdown);
    if (words > spec.maxWords * 1.4 || words < Math.floor(spec.minWords * 0.6)) {
      const fix = await client.chat.completions.create({
        model: GENERATION_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Rewrite this to ${spec.minWords}-${spec.maxWords} words. Preserve voice and any links. Output markdown only.\n\n${markdown}` },
        ],
      });
      const next = fix.choices[0]?.message?.content?.trim();
      if (next) {
        markdown = next;
        words = countWords(markdown);
      }
    }

    markdown = applyComplianceFooter(markdown, spec.needsFooter);
    title = extractTitle(markdown, finalPrompt.titleSeed);

    if (!contentDedup) break;
    if (!(await isDuplicate(kind, title, markdown))) break;
    // else loop and regenerate
  }

  const banned = hasBannedPhrases(markdown);
  if (banned.length) {
    console.warn(`⚠ Section contains flagged phrases: ${banned.join(", ")}`);
  }

  // Record every generated item so skip/submit can later flag it, and so future
  // generations can dedup against it.
  const sourceUrl =
    input.type === "recipe-blurb" ? (input.source as RecipeSource).recipe.url
    : input.type === "news-blurb" ? (input.source as NewsSource).news.url
    : null;
  await record({ sectionType: kind, title, markdown, sourceUrl, status: "generated" });

  return {
    type: input.type,
    title,
    markdown,
    wordCount: words,
  };
}

export interface MotwResult { subheader: string; body: string }

/**
 * Message of the Week — the founder's note. Author types the TITLE by hand;
 * this drafts a one-line subheader and a short body in Friday Stairs voice.
 */
export async function generateMessageOfWeek(client: OpenAI, title: string): Promise<MotwResult> {
  const styleGuide = loadStyleGuide();
  const system = loadSystemPrompt();
  const voice = await ragContext(client, `${title} founder note message of the week`);

  const basePrompt = `Write the **Message of the Week** (the founder's note) for the ${FS_BRAND.name} newsletter — the free Friday 7am stair workout on the ${FS_BRAND.location}.

The title is fixed (written by hand): "${title}". Do NOT change or restate the title.

Produce two things:
1. "subheader" — a single punchy line (≤ 12 words) that expands on the title. No period needed.
2. "body" — a short founder's note, MAXIMUM 3 sentences, that lands the message in Friday Stairs voice: hype but real, short lines, speaks to the crew. No greeting, no sign-off/signature (that's added separately).

STYLE GUIDE:
${styleGuide}

VOICE SAMPLES:
${voice}

Return JSON ONLY: {"subheader": "...", "body": "..."}`;

  let subheader = "";
  let body = "";

  // Dedup on the generated BODY (the title is user-supplied, so we don't dedup
  // on it — pass an empty title so only the content fingerprint is checked).
  for (let attempt = 0; attempt < MAX_DEDUP_ATTEMPTS; attempt++) {
    const nudge = attempt === 0
      ? ""
      : "\n\nThe previous attempt repeated a past message. Write a COMPLETELY DIFFERENT note — new angle, new wording.";

    const res = await client.chat.completions.create({
      model: GENERATION_MODEL,
      temperature: attempt === 0 ? TEMPERATURE : Math.min(TEMPERATURE + 0.25 * attempt, 0.9),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: basePrompt + nudge },
      ],
    });

    const raw = res.choices[0]?.message?.content ?? "{}";
    let parsed: { subheader?: string; body?: string } = {};
    try { parsed = JSON.parse(raw); } catch {}
    subheader = (parsed.subheader ?? "").trim();
    body = (parsed.body ?? "").trim();

    if (!body || !(await isDuplicate("message-of-week", "", body))) break;
  }

  // Record so the same note never goes out twice (skip/submit flip its status).
  if (body) await record({ sectionType: "message-of-week", title, markdown: body, status: "generated" });

  return { subheader, body };
}

export interface TipOption { title: string; markdown: string }

/**
 * Batch-generate N distinct workout tips in a SINGLE LLM call.
 * Much cheaper than calling generateSection N times.
 */
export async function generateTipOptions(client: OpenAI, n = 10): Promise<TipOption[]> {
  const styleGuide = loadStyleGuide();
  const system = loadSystemPrompt();
  const voice = await ragContext(client, "stair workout circuit intervals legs core");

  const res = await client.chat.completions.create({
    model: GENERATION_MODEL,
    temperature: 0.85,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `Write ${n} DISTINCT complete stair workouts for the ${FS_BRAND.name} newsletter — the free Friday 7am stair workout on the ${FS_BRAND.location}. P90X / structured-circuit style. Each is doable outdoors on stairs with NO equipment.

Vary the theme across the ${n}: legs & lungs, core + climb, speed intervals, full-body burner, upper-body push, glutes, endurance grind, beginner-friendly, EMOM, descending ladder, etc. Don't repeat a theme.

Each workout's markdown MUST follow this structure:
## [Workout name]
[one line on what it targets]
**Warm-Up** _(~5 min)_
- move — reps/time
**The Circuit** _(repeat X rounds)_
1. Move — reps/time
2. Move — reps/time
3. Move — reps/time
4. Move — reps/time
5. Move — reps/time
**Finisher**
- one burnout move
**Cool-Down**
- stretch

Use stair-friendly moves (stair sprints, step-ups, incline push-ups, tricep dips on a step, calf raises, mountain climbers, split squats, bear crawls). Concrete reps or time for EVERY move. State rounds. Friday Stairs voice — hype but clear.

STYLE GUIDE:
${styleGuide}

VOICE SAMPLES:
${voice}

Return JSON ONLY: {"workouts": [{"title": "workout name", "markdown": "the full markdown workout above"}]}. Exactly ${n} workouts.`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{"workouts":[]}';
  let parsed: { workouts?: TipOption[]; tips?: TipOption[] } = {};
  try { parsed = JSON.parse(raw); } catch {}
  const list = (parsed.workouts ?? parsed.tips ?? [])
    .filter((t) => t.title && t.markdown)
    .map((t) => ({ title: t.title, markdown: applyComplianceFooter(t.markdown, true) }));

  // Drop options that repeat a past workout (by title or content) or each other,
  // then record the survivors so future batches dedup against them too.
  const out: TipOption[] = [];
  const seenTitle = new Set<string>();
  const seenFp = new Set<string>();
  for (const t of list) {
    const tn = normTitle(t.title);
    const fp = fingerprint("workout-tip", t.markdown);
    if (seenTitle.has(tn) || seenFp.has(fp)) continue;       // dupe within this batch
    if (await isDuplicate("workout-tip", t.title, t.markdown)) continue; // already in history
    seenTitle.add(tn); seenFp.add(fp);
    out.push(t);
    await record({ sectionType: "workout-tip", title: t.title, markdown: t.markdown, status: "generated" });
  }
  return out;
}
