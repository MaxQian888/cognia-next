/**
 * Turn-error classification. A failed turn used to collapse to a single raw
 * `✗ <message>` cell with no severity, no category, and no hint about what to do
 * next. This module buckets an error (by its `RunAndCaptureError.code` and/or its
 * message text) into a small set of categories and attaches a one-line
 * remediation hint — so the `ErrorCell` can render a "here's how to fix it" line
 * and the desktop notification can use a short, human title.
 *
 * Pure and dependency-free (regex + code switch) so it unit-tests trivially and
 * runs in the esbuild bundle.
 */

/** Coarse bucket a turn error falls into. Drives the hint + notification title. */
export type ErrorCategory =
  "auth" | "rateLimit" | "network" | "timeout" | "sidecar" | "permission" | "generic"

export interface ClassifiedError {
  category: ErrorCategory
  /** Short human title (for the desktop notification / logs). */
  title: string
  /** One-line remediation hint (rendered dim under the error). Absent for the
   * generic bucket, where there is nothing specific to suggest. */
  hint?: string
}

export interface ClassifyErrorInput {
  /** The error's message (`(err as Error).message`). */
  message: string
  /** The `RunAndCaptureError.code`, when the error carried one. */
  code?: string
}

/**
 * Ordered matchers. The FIRST whose test passes wins, so put the most specific /
 * highest-signal buckets first (auth before the broader network catch, etc.).
 */
const MATCHERS: Array<{
  category: ErrorCategory
  title: string
  hint: string
  test: (m: string) => boolean
}> = [
  {
    category: "auth",
    title: "Authentication failed",
    hint: "Check your API key or token — run /provider to re-authenticate.",
    test: (m) =>
      /\b(401|403|unauthorized|forbidden|invalid api key|authentication|api key)\b/i.test(m),
  },
  {
    category: "rateLimit",
    title: "Rate limited",
    hint: "Quota exhausted or overloaded — see /limits for the reset window.",
    test: (m) => /\b(429|529|rate[\s-]?limit|quota|too many requests|overloaded)\b/i.test(m),
  },
  {
    category: "timeout",
    title: "Request timed out",
    hint: "The response stalled — retry, or raise streamIdleTimeoutMs in settings.",
    test: (m) => /\b(timeout|timed out|etimedout|idle)\b/i.test(m),
  },
  {
    category: "network",
    title: "Network error",
    hint: "Can't reach the provider — check your connection or proxy.",
    test: (m) =>
      /\b(econnrefused|econnreset|enotfound|eai_again|epipe|socket hang up|fetch failed|network|dns)\b/i.test(
        m
      ),
  },
  {
    category: "permission",
    title: "Permission denied",
    hint: "A tool was blocked — adjust with /mode or approve it when prompted.",
    test: (m) => /\bpermission denied\b/i.test(m),
  },
]

/**
 * Classify a turn error into a {@link ClassifiedError}. `code` is checked first
 * (the sidecar-exit code is authoritative regardless of message), then the
 * message is run through the ordered matchers, falling back to `generic`.
 */
export function classifyError(input: ClassifyErrorInput): ClassifiedError {
  const message = input.message ?? ""
  if (input.code === "sidecar_exited") {
    return {
      category: "sidecar",
      title: "Backend stopped",
      hint: "The agent backend exited — it restarts automatically on your next message.",
    }
  }
  for (const matcher of MATCHERS) {
    if (matcher.test(message)) {
      return { category: matcher.category, title: matcher.title, hint: matcher.hint }
    }
  }
  return { category: "generic", title: "Error" }
}
