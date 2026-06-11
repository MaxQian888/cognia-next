/**
 * Segment-aware glob matching for file-access deny patterns.
 *
 * Replaces the old substring `String.includes()` test that backed
 * `FileAccessPolicy.deniedGlobs`. Substring matching had two failure modes:
 * false positives (`.env` matched `.environment`) and a denial-of-everything
 * when a denied token happened to appear in an allowed root's prefix. This
 * matcher operates on path *segments* so a bare token like `.env` matches only
 * a whole segment equal to it, never a longer segment that merely contains it.
 *
 * Pure and synchronous (no fs, no Tauri). Case handling is the caller's job —
 * lowercase both `relPath` and `pattern` before calling on Windows-like paths.
 *
 * Pattern grammar (forward-slash separated):
 *   - a literal segment matches that exact segment,
 *   - `*` matches any run of characters within a single segment (not `/`),
 *   - `**` matches zero or more whole segments,
 *   - a pattern with NO `/` (e.g. `.env`, `*.pem`) is a single-segment matcher
 *     applied to *every* segment of the path (basename-style),
 *   - a pattern with `/` is anchored against the whole relative path; use
 *     leading/trailing `**` (e.g. `**​/.git/**`) for "anywhere".
 * Leading/trailing slashes are trimmed, so `/.git/` is equivalent to the bare
 * token `.git` (matches a `.git` segment anywhere).
 */

/** Compile a single path segment pattern (may contain `*`) to an anchored RegExp. */
function compileSegment(pattern: string): RegExp {
  let body = ""
  for (const ch of pattern) {
    if (ch === "*") {
      body += "[^/]*"
    } else {
      // Escape every regex metacharacter; `*` is handled above.
      body += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${body}$`)
}

/** True when a single path segment matches a single-segment pattern. */
function singleSegmentMatch(segment: string, pattern: string): boolean {
  if (!pattern.includes("*")) return segment === pattern
  return compileSegment(pattern).test(segment)
}

/**
 * Anchored sequence match of path segments against pattern segments, where a
 * `**` pattern segment matches zero or more whole path segments. Standard
 * wildcard DP, evaluated back-to-front.
 */
function matchSegments(segs: readonly string[], pats: readonly string[]): boolean {
  const n = segs.length
  const m = pats.length
  // dp[i][j] = segs[i..] matches pats[j..]
  const dp: boolean[][] = Array.from({ length: n + 1 }, () => new Array<boolean>(m + 1).fill(false))
  dp[n][m] = true
  // Trailing `**` segments can match the empty remainder.
  for (let j = m - 1; j >= 0; j--) {
    dp[n][j] = pats[j] === "**" && dp[n][j + 1]
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (pats[j] === "**") {
        // Match zero segments (advance pattern) or one+ (advance path).
        dp[i][j] = dp[i][j + 1] || dp[i + 1][j]
      } else {
        dp[i][j] = singleSegmentMatch(segs[i], pats[j]) && dp[i + 1][j + 1]
      }
    }
  }
  return dp[0][0]
}

/**
 * Decide whether `relPath` (a workspace-root-relative, forward-slash path)
 * matches the deny `pattern`. See the module doc for the grammar.
 */
export function matchesDeniedGlob(relPath: string, pattern: string): boolean {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "")
  if (!trimmed) return false
  // `**` alone matches everything, including the empty path.
  if (trimmed === "**") return true

  const segs = relPath.split("/").filter((s) => s !== "")

  if (!trimmed.includes("/")) {
    // Single-segment matcher applied to every segment (basename-style).
    return segs.some((seg) => singleSegmentMatch(seg, trimmed))
  }

  const pats = trimmed.split("/").filter((s) => s !== "")
  return matchSegments(segs, pats)
}
