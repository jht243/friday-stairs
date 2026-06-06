import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";

export interface DismissedStore {
  urls: string[];
}

export function loadDismissed(): Set<string> {
  if (!fs.existsSync(PATHS.dismissed)) return new Set();
  try {
    const store = JSON.parse(fs.readFileSync(PATHS.dismissed, "utf8")) as DismissedStore;
    return new Set(store.urls ?? []);
  } catch {
    return new Set();
  }
}

function save(set: Set<string>): void {
  fs.mkdirSync(path.dirname(PATHS.dismissed), { recursive: true });
  fs.writeFileSync(
    PATHS.dismissed,
    JSON.stringify({ urls: Array.from(set) }, null, 2),
    "utf8",
  );
}

export function dismissUrl(url: string): void {
  const set = loadDismissed();
  set.add(url);
  save(set);
}

export function undismissUrl(url: string): void {
  const set = loadDismissed();
  set.delete(url);
  save(set);
}

export function clearDismissed(): void {
  save(new Set());
}
