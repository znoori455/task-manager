// @mentions. Display names are identities here, so a mention is "@" + a name
// made of letters, digits, "_", "." or "-" (names with spaces can't be mentioned).
// Matching is case-insensitive; names are compared lowercased.

const MENTION = /(^|\s)@(\w[\w.-]*)/g;

/** Lowercased, de-duplicated names mentioned in `content`, in order of appearance. */
export function extractMentions(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(MENTION)) out.add(m[2].replace(/[.-]+$/, "").toLowerCase());
  return [...out];
}

export function mentions(content: string, name: string): boolean {
  return extractMentions(content).includes(name.toLowerCase());
}

/** Recipients are keyed by lowercased display name. */
export const userKey = (name: string) => name.trim().toLowerCase();
