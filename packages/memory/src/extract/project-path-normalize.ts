/**
 * Rewrite absolute filesystem paths out of text destined for project mining.
 *
 * WHY THIS EXISTS, and why it is not a `@cognia/redact` rule:
 *
 * `PII_KINDS` covers email, phone, national ids, cards, keys and names — it has
 * no home-directory or absolute-path rule, so `/Users/<name>/…` sails straight
 * through `hasNoLeakingPii`. For personal memory that has been harmless, because
 * the extractor only ever saw message prose. Project mining feeds it TOOL RESULT
 * bodies — Read/Bash/Grep/Edit output — which are saturated with absolute paths
 * carrying the OS username and the names of the user's other projects, and the
 * mined claim then lands in both Dexie and the shared `cognia_memory` vector
 * collection.
 *
 * Widening `PII_KINDS` is not an option: that const is shared by Twin, Goal,
 * connector auto-reply and Agent-Team shared memory, so adding a kind changes
 * their redaction output too. This is the local fix, and it runs BEFORE
 * `redactText` so the placeholder text those rules emit is never re-parsed as a
 * path.
 *
 * CALIBRATION — deliberately narrower than "block on any absolute path".
 * Rewriting in-root paths to workspace-relative is unconditional. Blocking is
 * reserved for paths that IDENTIFY someone: home directories, Windows user
 * profiles, and macOS per-user temp roots. System paths (`/usr`, `/etc`, `/opt`,
 * `/Library`, `/tmp`, …) are public knowledge and reveal nothing about the user;
 * blocking on those would silently kill mining for most real coding sessions
 * while protecting nothing. The leak this guards is the username and the names
 * of unrelated projects, not the existence of `/usr/bin/node`.
 *
 * Pure: no I/O, no platform lookups. Roots are supplied by the caller.
 */

/**
 * Absolute paths that identify a person or their unrelated work.
 *
 * Each alternative requires a segment AFTER the container directory — bare
 * `/Users` or `/home` names no one. `/Users/Shared` and `/Users/Public` are
 * macOS system directories and are excluded for the same reason.
 */
const IDENTIFYING_PATH = new RegExp(
  [
    // POSIX home directories: /Users/<person>/…, /home/<person>/…
    String.raw`(?:^|[\s"'(<=:,\[])\/(?:Users|home)\/(?!Shared(?:[\/\s"')>\],]|$))(?!Public(?:[\/\s"')>\],]|$))[^\/\s"'()<>\[\],;]+`,
    // The root account's home.
    String.raw`(?:^|[\s"'(<=:,\[])\/root\/[^\s"'()<>\[\],;]+`,
    // macOS per-user temp roots — the segments are user-scoped hashes.
    String.raw`(?:^|[\s"'(<=:,\[])(?:\/private)?\/var\/folders\/[^\s"'()<>\[\],;]+`,
    // Windows user profiles: C:\Users\<person>\…
    String.raw`(?:^|[\s"'(<=:,\[])[A-Za-z]:[\\\/]Users[\\\/](?!Public(?:[\\\/\s"')>\],]|$))[^\\\/\s"'()<>\[\],;]+`,
  ].join("|"),
  "u"
)

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Build a matcher for one root that tolerates either separator at every segment
 * boundary, so a Windows root still matches text that quotes it with forward
 * slashes (and vice versa).
 */
function rootBody(root: string): string {
  return normalizeSeparators(root).replace(/\/+$/, "").split("/").map(escapeRegExp).join("[\\\\/]")
}

export interface NormalizeProjectPathsOptions {
  /** Absolute project roots. Longest wins, so nested roots resolve correctly. */
  roots: readonly string[]
}

export type NormalizeProjectPathsResult =
  | { ok: true; text: string; rewrittenCount: number }
  | { ok: false; reason: "identifying_path_outside_roots" }

/**
 * Rewrite in-root absolute paths to workspace-relative form, then refuse the
 * text outright if an identifying path survives.
 *
 * Refusing rather than redacting is deliberate: a claim mined from text we had
 * to censor mid-sentence is a claim whose evidence no longer says what the
 * transcript said, and the caller can simply skip the window.
 */
export function normalizeProjectPaths(
  text: string,
  options: NormalizeProjectPathsOptions
): NormalizeProjectPathsResult {
  let out = text
  let rewrittenCount = 0

  const roots = [...options.roots]
    .filter((root) => root.trim().length > 0)
    .sort((a, b) => b.length - a.length)

  for (const root of roots) {
    const body = rootBody(root)
    if (!body) continue
    // Root + separator → strip entirely, leaving a workspace-relative path.
    out = out.replace(new RegExp(`${body}[\\\\/]`, "gu"), () => {
      rewrittenCount += 1
      return ""
    })
    // The bare root, not followed by another path character → the workspace itself.
    out = out.replace(new RegExp(`${body}(?![\\\\/\\w.-])`, "gu"), () => {
      rewrittenCount += 1
      return "."
    })
  }

  if (IDENTIFYING_PATH.test(out)) {
    return { ok: false, reason: "identifying_path_outside_roots" }
  }
  return { ok: true, text: out, rewrittenCount }
}

/** True when `text` still carries a path that identifies a person. */
export function hasIdentifyingPath(text: string): boolean {
  return IDENTIFYING_PATH.test(text)
}
