import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";

export interface IssueSettings {
  rsvpUrl?: string;
  quote?: string;
  recapImageUrl?: string;
  // Free-form announcement / sponsor section
  annHeader?: string;
  annSub?: string;
  annBody?: string;
  // legacy fields from earlier versions
  quoteLink?: string;
  url?: string;
}

export function loadSettings(): IssueSettings {
  try {
    return JSON.parse(fs.readFileSync(PATHS.rsvp, "utf8")) as IssueSettings;
  } catch {
    return {};
  }
}

export function saveSettings(partial: IssueSettings): IssueSettings {
  const next = { ...loadSettings(), ...partial };
  fs.mkdirSync(path.dirname(PATHS.rsvp), { recursive: true });
  fs.writeFileSync(PATHS.rsvp, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function loadRsvpUrl(): string | null {
  const s = loadSettings();
  return (s.rsvpUrl || s.url)?.trim() || null;
}

export function saveRsvpUrl(url: string): void {
  saveSettings({ rsvpUrl: url.trim() });
}

/**
 * Standalone "how to RSVP" paragraph. Inserted at most twice in the assembled
 * issue (middle + end) — NOT appended to every section.
 * Returns null if no RSVP link is set.
 */
export function rsvpBlock(variant: "mid" | "end" = "mid"): string | null {
  const url = loadRsvpUrl();
  if (!url) return null;
  if (variant === "end") {
    return `## 🎟️ See You on the Stairs\nOne more time — this Friday is free, and we'd love to have you. **[RSVP here →](${url})** and bring a friend.`;
  }
  return `## 🎟️ Save Your Spot\nFriday Stairs is free, but RSVP so we know you're coming — it helps us plan the music and the crowd. **[RSVP for this Friday →](${url})**`;
}

/**
 * Build the "Quote of the Week" markdown block from saved settings.
 * Returns null if no quote is set.
 */
export function quoteMarkdown(): string | null {
  const s = loadSettings();
  const quote = s.quote?.trim();
  if (!quote) return null;
  return `> _"${quote}"_`;
}

/** Link to a photo/image recap of last Friday, if set. */
export function recapImageUrl(): string | null {
  return loadSettings().recapImageUrl?.trim() || null;
}

/** Build the free-form announcement / sponsor section. Null if empty. */
export function announcementMarkdown(): string | null {
  const s = loadSettings();
  const header = s.annHeader?.trim();
  const sub = s.annSub?.trim();
  const body = s.annBody?.trim();
  if (!header && !body) return null;
  let md = `## ${header || "Announcement"}`;
  if (sub) md += `\n_${sub}_`;
  if (body) md += `\n\n${body}`;
  return md;
}
