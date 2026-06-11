import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";

export interface IssueSettings {
  rsvpUrl?: string;
  recapImageUrl?: string;
  // Add-to-calendar links
  icalUrl?: string;
  gcalUrl?: string;
  // Welcome / intro section
  welHeader?: string;
  welBody?: string;
  // Message of the Week (founder's note)
  motwTitle?: string;
  motwSub?: string;
  motwBody?: string;
  motwSig?: string;
  // Community Update section
  cuHeader?: string;
  cuSub?: string;
  cuBody?: string;
  // Free-form announcement / sponsor section
  annHeader?: string;
  annSub?: string;
  annBody?: string;
  // legacy fields from earlier versions
  quote?: string;
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

/** Add-to-calendar line ("📅 Add to calendar: iCal · Google"), or "" if none set. */
export function calendarLine(): string {
  const s = loadSettings();
  const links: string[] = [];
  if (s.icalUrl?.trim()) links.push(`[iCal](${s.icalUrl.trim()})`);
  if (s.gcalUrl?.trim()) links.push(`[Google Calendar](${s.gcalUrl.trim()})`);
  return links.length ? `📅 **Add to your calendar:** ${links.join(" · ")}` : "";
}

/**
 * Standalone "how to RSVP" CTA section. Inserted at most twice in the assembled
 * issue (middle + end). Mid variant also carries the calendar links.
 */
export function rsvpBlock(variant: "mid" | "end" = "mid"): string | null {
  const url = loadRsvpUrl();
  if (!url) return null;
  if (variant === "end") {
    return `## 🎟️ See You on the Stairs\nOne more time — this Friday is free, and we'd love to have you. **[RSVP here →](${url})** and bring a friend.`;
  }
  const cal = calendarLine();
  let md = `## 🎟️ Save Your Spot\nFriday Stairs is free, but RSVP so we know you're coming — it helps us plan the music and the crowd. **[RSVP for this Friday →](${url})**`;
  if (cal) md += `\n\n${cal}`;
  return md;
}

/** Link to a photo/image recap of last Friday, if set. */
export function recapImageUrl(): string | null {
  return loadSettings().recapImageUrl?.trim() || null;
}

/** Welcome / intro section. Null if empty. */
export function welcomeMarkdown(): string | null {
  const s = loadSettings();
  const header = s.welHeader?.trim();
  const body = s.welBody?.trim();
  if (!header && !body) return null;
  let md = `## 👋 ${header || "Welcome"}`;
  if (body) md += `\n\n${body}`;
  return md;
}

/** Message of the Week (founder's note). Null if empty. */
export function messageOfTheWeekMarkdown(): string | null {
  const s = loadSettings();
  const title = s.motwTitle?.trim();
  const sub = s.motwSub?.trim();
  const body = s.motwBody?.trim();
  const sig = s.motwSig?.trim();
  if (!title && !body) return null;
  let md = `## 💬 Message of the Week`;
  if (title) md += `\n### ${title}`;
  if (sub) md += `\n_${sub}_`;
  if (body) md += `\n\n${body}`;
  if (sig) md += `\n\n— ${sig}`;
  return md;
}

/** Community Update section. Null if empty. */
export function communityUpdateMarkdown(): string | null {
  const s = loadSettings();
  const header = s.cuHeader?.trim();
  const sub = s.cuSub?.trim();
  const body = s.cuBody?.trim();
  if (!header && !body) return null;
  let md = `## 📣 ${header || "Community Update"}`;
  if (sub) md += `\n_${sub}_`;
  if (body) md += `\n\n${body}`;
  return md;
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
