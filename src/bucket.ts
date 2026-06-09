import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";
import { rsvpBlock, recapImageUrl, announcementMarkdown, welcomeMarkdown, messageOfTheWeekMarkdown, communityUpdateMarkdown } from "./rsvp.js";

export type BucketType = "recipe" | "news-blurb" | "weekly-recap" | "workout-tip" | "playlist";

export interface BucketItem {
  id: string;
  type: BucketType;
  title: string;
  /** Final markdown that will land in Beehiiv. */
  markdown: string;
  /** Optional original source link. */
  sourceUrl?: string;
  image?: string;
  approvedAt: string;
  used?: boolean;
}

function fileFor(type: BucketType): string {
  return path.join(PATHS.approvedDir, `${type}.json`);
}

function load(type: BucketType): BucketItem[] {
  const f = fileFor(type);
  if (!fs.existsSync(f)) return [];
  try {
    const items = JSON.parse(fs.readFileSync(f, "utf8")) as BucketItem[];
    // Strip any per-section RSVP baked into older items — RSVP belongs only in
    // the assembled issue (twice), never inside an individual section.
    return items.map((it) => ({ ...it, markdown: stripRsvp(it.markdown) }));
  } catch {
    return [];
  }
}

function save(type: BucketType, items: BucketItem[]): void {
  fs.mkdirSync(PATHS.approvedDir, { recursive: true });
  fs.writeFileSync(fileFor(type), JSON.stringify(items, null, 2), "utf8");
}

export function listApproved(type: BucketType): BucketItem[] {
  return load(type);
}

export function listAllApproved(): Record<BucketType, BucketItem[]> {
  const types: BucketType[] = ["recipe", "news-blurb", "weekly-recap", "workout-tip", "playlist"];
  return Object.fromEntries(types.map((t) => [t, load(t)])) as Record<BucketType, BucketItem[]>;
}

export function approve(item: Omit<BucketItem, "approvedAt">): BucketItem {
  const items = load(item.type);
  if (items.some((i) => i.id === item.id)) {
    return items.find((i) => i.id === item.id)!;
  }
  const stored: BucketItem = { ...item, approvedAt: new Date().toISOString() };
  items.unshift(stored);
  save(item.type, items);
  return stored;
}

export function markUsed(type: BucketType, id: string): void {
  const items = load(type);
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  items[idx]!.used = true;
  save(type, items);
}

export function removeApproved(type: BucketType, id: string): void {
  const items = load(type).filter((i) => i.id !== id);
  save(type, items);
}

/**
 * Pull one unused item of each type and assemble a Beehiiv-ready markdown blob.
 * Empty slots show as a labeled placeholder so the editor knows what to fill.
 */
// Remove any embedded RSVP paragraph (older items baked it into every section).
// The assembler is the single source of RSVP, inserting it exactly twice.
function stripRsvp(md: string): string {
  return md
    .split(/\n{2,}/)
    .filter((p) => !/save your spot|rsvp for this friday|see you on the stairs|🎟️/i.test(p))
    .join("\n\n")
    .trim();
}

export function assembleIssue(): { markdown: string; used: Array<{ type: BucketType; id: string }> } {
  const SECTIONS: Array<{ type: BucketType; heading: string }> = [
    { type: "weekly-recap", heading: "🪜 Last Friday" },
    { type: "workout-tip", heading: "🔥 Workout of the Week" },
    { type: "news-blurb", heading: "📰 What we're reading" },
    { type: "recipe", heading: "🥗 Recipe of the Week" },
    { type: "playlist", heading: "🎧 New Gym Songs" },
  ];

  const usedRefs: Array<{ type: BucketType; id: string }> = [];
  const blocks: string[] = [];

  // Manual lead-in sections (match the real Monday Drop order).
  const welcome = welcomeMarkdown();
  if (welcome) blocks.push(welcome);
  const motw = messageOfTheWeekMarkdown();
  if (motw) blocks.push(motw);
  const community = communityUpdateMarkdown();
  if (community) blocks.push(community);
  const announcement = announcementMarkdown();
  if (announcement) blocks.push(announcement);

  const photos = recapImageUrl();
  for (const sec of SECTIONS) {
    const items = load(sec.type).filter((i) => !i.used);
    const pick = items[0];
    let block: string;
    if (pick) {
      const md = stripRsvp(pick.markdown.trim());
      // If the content already starts with its own heading, don't double it up.
      block = /^#{1,3}\s/.test(md) ? md : `## ${sec.heading}\n\n${md}`;
      usedRefs.push({ type: sec.type, id: pick.id });
    } else {
      block = `## ${sec.heading}\n\n_(no approved ${sec.type} yet — add one in the dashboard)_`;
    }
    // Image recap link rides along with the Last Friday section.
    if (sec.type === "weekly-recap" && photos) {
      block += `\n\n📸 [See all the photos from last Friday →](${photos})`;
    }
    blocks.push(block);
  }

  // Insert the RSVP CTA as its own section — once in the middle, once at the end.
  const midCta = rsvpBlock("mid");
  const endCta = rsvpBlock("end");
  const out: string[] = [];
  const mid = Math.floor(blocks.length / 2);
  blocks.forEach((b, i) => {
    out.push(b);
    if (midCta && i === mid) out.push(midCta);
  });
  if (endCta) out.push(endCta);

  const date = new Date().toISOString().slice(0, 10);
  const header = `# Friday Stairs — Newsletter ${date}\n\nSee you on the Riverwalk. 7am, every Friday.`;
  const footer = `_See you on the stairs._\n\n— Friday Stairs`;
  const markdown = [header, ...out, footer].join("\n\n---\n\n");
  return { markdown, used: usedRefs };
}
