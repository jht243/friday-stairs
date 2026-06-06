const BANNED_PHRASES = [
  "guaranteed results",
  "transform your body",
  "lose weight fast",
  "100% success",
  "doctor recommended",
  "scientifically proven",
];

const FOOTER = `\n\n_Friday Stairs is a community workout, not medical advice. Check with a doc before starting anything new._`;

export function hasBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((p) => lower.includes(p));
}

export function applyComplianceFooter(text: string, includeFooter: boolean): string {
  if (!includeFooter) return text;
  if (text.toLowerCase().includes("not medical advice")) return text;
  return text + FOOTER;
}
