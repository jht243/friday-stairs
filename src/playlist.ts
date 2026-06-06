import OpenAI from "openai";
import { GENERATION_MODEL } from "./config.js";

export interface PlaylistTrack {
  title: string;
  artist: string;
  bpm?: number;
  energy?: "warmup" | "build" | "peak" | "cool";
  reason?: string;
  spotifySearchUrl: string;
}

export interface PlaylistRequest {
  durationMinutes: number;
  shape?: string;
  genres?: string[];
  avoid?: string[];
}

function searchUrl(title: string, artist: string): string {
  // encodeURIComponent leaves ()! untouched; encode parens too so they don't
  // break markdown link parsing in [text](url).
  const q = encodeURIComponent(`${title} ${artist}`).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `https://open.spotify.com/search/${q}`;
}

const SCHEMA = `{
  "tracks": [
    { "title": "string", "artist": "string", "bpm": number, "energy": "warmup|build|peak|cool", "reason": "one short sentence on why this fits" }
  ]
}`;

export async function suggestPlaylist(client: OpenAI, req: PlaylistRequest): Promise<PlaylistTrack[]> {
  const duration = Math.max(15, Math.min(60, req.durationMinutes));
  const trackCount = Math.round(duration * 1.1); // ~1 track per minute, slightly over

  const sys = `You are a DJ programming a high-energy ${duration}-minute outdoor stair workout for a community fitness group in Tampa. The set has 4 phases: WARMUP (low BPM, building), BUILD (climbing energy), PEAK (max intensity for the hardest stair sets), COOL (descent + recovery). Tracks must be real, well-known, and findable on Spotify. Bias toward genres that crush outdoors at sunrise: open-format hip-hop, Afrobeats, house, Latin/reggaeton, pop-punk and rock for peak, R&B for cool. Avoid downer ballads.`;

  const user = `Generate exactly ${trackCount} tracks for a ${duration}-minute set.
${req.shape ? `Shape: ${req.shape}` : ""}
${req.genres?.length ? `Lean into: ${req.genres.join(", ")}` : ""}
${req.avoid?.length ? `Avoid: ${req.avoid.join(", ")}` : ""}

Return JSON ONLY matching this shape:
${SCHEMA}

Distribute across phases as roughly 20% warmup / 30% build / 30% peak / 20% cool. Real tracks only — no AI-generated names. Vary artists; don't repeat any artist twice in a row.`;

  const res = await client.chat.completions.create({
    model: GENERATION_MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{"tracks":[]}';
  let parsed: { tracks?: Array<Omit<PlaylistTrack, "spotifySearchUrl">> } = {};
  try { parsed = JSON.parse(raw); } catch {}
  const tracks = parsed.tracks ?? [];
  return tracks
    .filter((t) => t.title && t.artist)
    .map((t) => ({ ...t, spotifySearchUrl: searchUrl(t.title, t.artist) }));
}

/**
 * Three fresh "new gym songs" to feature in the newsletter each week.
 * Capped at 3 by design — a small, digestible weekly pick, not a full set.
 */
export async function suggestNewGymSongs(client: OpenAI, n = 3): Promise<PlaylistTrack[]> {
  const count = Math.min(3, Math.max(1, n));
  const res = await client.chat.completions.create({
    model: GENERATION_MODEL,
    temperature: 0.8,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You recommend recent, high-energy songs good for a stair/HIIT workout. Real, findable tracks only. Favor songs released or trending recently. No lyrics — just title, artist, and a one-line reason.",
      },
      {
        role: "user",
        content: `Pick exactly ${count} fresh gym songs to feature in this week's Friday Stairs newsletter. Mix of genres that hit outdoors at sunrise (hip-hop, Afrobeats, house, pop-punk, Latin). Return JSON ONLY: {"tracks":[{"title":"...","artist":"...","bpm":number,"reason":"why it slaps for the stairs, one sentence"}]}. Exactly ${count}.`,
      },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? '{"tracks":[]}';
  let parsed: { tracks?: Array<Omit<PlaylistTrack, "spotifySearchUrl">> } = {};
  try { parsed = JSON.parse(raw); } catch {}
  return (parsed.tracks ?? [])
    .filter((t) => t.title && t.artist)
    .slice(0, count)
    .map((t) => ({ ...t, spotifySearchUrl: searchUrl(t.title, t.artist) }));
}

function appleSearchUrl(title: string, artist: string): string {
  const q = encodeURIComponent(`${title} ${artist}`).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `https://music.apple.com/us/search?term=${q}`;
}

export function newGymSongsToMarkdown(tracks: PlaylistTrack[]): string {
  const lines: string[] = [
    "## 🎵 New Gym Songs",
    "_Three fresh tracks for the stairs this week._",
    "",
  ];
  tracks.forEach((t) => {
    lines.push(`- **${t.title}** — ${t.artist} · [Spotify](${t.spotifySearchUrl}) · [Apple](${appleSearchUrl(t.title, t.artist)})`);
  });
  return lines.join("\n");
}

export function playlistToMarkdown(req: PlaylistRequest, tracks: PlaylistTrack[]): string {
  const lines: string[] = [];
  lines.push(`**${req.durationMinutes}-min Friday Stairs set** — ${tracks.length} tracks`);
  if (req.shape) lines.push(`_Shape: ${req.shape}_`);
  lines.push("");
  lines.push("| Track | BPM | ▶ |");
  lines.push("|-------|-----|---|");
  tracks.forEach((t) => {
    lines.push(`| **${t.title}** — ${t.artist} | ${t.bpm ?? "—"} | [Spotify](${t.spotifySearchUrl}) |`);
  });
  return lines.join("\n");
}
