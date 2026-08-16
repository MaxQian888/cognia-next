/**
 * Issue identifier vocabulary — pure string logic, no storage.
 *
 * An issue prints as `<projectKey>-<number>` (e.g. `MERC-2`). The key belongs
 * to the issue-project and is immutable; the number is allocated monotonically
 * per project by `lib/db/issue-counters.ts` inside a Dexie `rw` transaction
 * (this repo has no other sequential-id precedent, and a read-modify-write
 * outside a transaction collides across tabs/windows).
 *
 * Identifiers are denormalized onto the issue row at creation, so they survive
 * their project being renamed or deleted and never need a join to render.
 *
 * GitHub mirror rows do NOT get a local identifier — they print as
 * `owner/repo#123`. Two competing numbering schemes on one board makes
 * `MERC-7` and `#7` indistinguishable in conversation, which defeats the whole
 * point of having a printable id.
 */

/** 2–5 characters, starting with a letter. Uppercase alphanumerics only. */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,4}$/

export const PROJECT_KEY_MIN_LENGTH = 2
export const PROJECT_KEY_MAX_LENGTH = 5

/** Used when a project name yields no usable latin letters at all. */
const FALLBACK_KEY = "PRJ"

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_PATTERN.test(key)
}

/** Uppercase, drop everything that isn't A–Z or 0–9, split into words. */
function toWords(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Best-effort key for a project name, before deduplication.
 *
 *   "Cognia"            → "COGN"
 *   "Mobile Rewrite"    → "MR"      (initials when there are several words)
 *   "Q3 Launch Plan"    → "QLP"
 *   "认知"               → "PRJ"     (no latin letters to work with)
 */
export function suggestProjectKey(name: string): string {
  const words = toWords(name)
  if (words.length === 0) return FALLBACK_KEY

  if (words.length > 1) {
    const initials = words
      .map((word) => word[0])
      .join("")
      .slice(0, PROJECT_KEY_MAX_LENGTH)
    if (initials.length >= PROJECT_KEY_MIN_LENGTH && /^[A-Z]/.test(initials)) return initials
  }

  const joined = words.join("")
  const candidate = joined.slice(0, 4)
  if (candidate.length >= PROJECT_KEY_MIN_LENGTH && /^[A-Z]/.test(candidate)) return candidate

  // Single short or digit-leading word ("Q3", "2026") — pad from the fallback
  // so the result still starts with a letter and clears the minimum length.
  return FALLBACK_KEY
}

/**
 * A key that is valid AND not already taken. Appends a numeric discriminator,
 * truncating the base so the result never exceeds `PROJECT_KEY_MAX_LENGTH`.
 *
 * Callers pass the set of keys currently in use (keys are globally unique, not
 * per-workspace, so an identifier pasted into a chat resolves unambiguously).
 */
export function deriveProjectKey(name: string, taken: ReadonlySet<string>): string {
  const base = suggestProjectKey(name)
  if (!taken.has(base)) return base

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const suffixText = String(suffix)
    const room = PROJECT_KEY_MAX_LENGTH - suffixText.length
    if (room < 1) break
    const candidate = `${base.slice(0, room)}${suffixText}`
    if (isValidProjectKey(candidate) && !taken.has(candidate)) return candidate
  }

  // Pathological: 1000 collisions on one base. Fall back to a random tail.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tail = Math.floor(Math.random() * 10_000)
      .toString(36)
      .toUpperCase()
      .slice(0, 4)
    const candidate = `${base.slice(0, PROJECT_KEY_MAX_LENGTH - tail.length)}${tail}`
    if (isValidProjectKey(candidate) && !taken.has(candidate)) return candidate
  }

  throw new Error("Unable to derive a unique project key")
}

/** `("MERC", 2)` → `"MERC-2"`. */
export function formatIssueIdentifier(projectKey: string, issueNumber: number): string {
  return `${projectKey}-${issueNumber}`
}

/**
 * Inverse of `formatIssueIdentifier`. Returns undefined for anything that
 * isn't a well-formed local identifier — including GitHub refs like
 * `owner/repo#123`, which deliberately do not parse here.
 */
export function parseIssueIdentifier(
  identifier: string
): { projectKey: string; issueNumber: number } | undefined {
  const match = /^([A-Z][A-Z0-9]{1,4})-(\d+)$/.exec(identifier.trim())
  if (!match) return undefined
  const issueNumber = Number(match[2])
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return undefined
  return { projectKey: match[1], issueNumber }
}

/**
 * Find every local identifier mentioned in free text — used to linkify commit
 * messages, IM replies and issue descriptions. Returns unique matches in the
 * order they appear.
 */
export function extractIssueIdentifiers(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{1,4}-\d+)\b/g)) {
    seen.add(match[1])
  }
  return [...seen]
}
