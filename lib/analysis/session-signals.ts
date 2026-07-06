/**
 * Regex-heavy detectors for {@link import("./session-report").analyzeSession}.
 * Isolated here so the noisy pattern logic is independently unit-tested and the
 * report module stays about orchestration.
 *
 * Ported (algorithm, not code) from an external agent-orchestration app's
 * session analyzer. All pure string functions — no clock, no I/O.
 */

/**
 * User-message phrases that signal a course-correction (the user telling the
 * assistant it went the wrong way). Each entry is a stable id + matcher.
 */
const FRICTION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "actually", re: /\bactually\b/i },
  { id: "undo", re: /\bundo\b/i },
  { id: "revert", re: /\brevert\b/i },
  { id: "wait", re: /\bwait\b/i },
  { id: "no", re: /^\s*no[,.\s]/i },
  { id: "stop", re: /\bstop\b/i },
  { id: "thats-wrong", re: /\b(that'?s|this is)\s+(wrong|incorrect|not right)\b/i },
]

/** Distinct friction signal ids found in one user message (no duplicates). */
export function detectFriction(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const { id, re } of FRICTION_PATTERNS) {
    if (re.test(text)) out.push(id)
  }
  return out
}

/**
 * Semantic signals extracted from a thinking/reasoning block — the kind of
 * cognition the model is doing. Independent (a block can carry several).
 */
const THINKING_SIGNALS: Array<{ id: string; re: RegExp }> = [
  { id: "planning", re: /\b(plan|step\s*\d|first|then|next|approach|strategy)\b/i },
  { id: "uncertainty", re: /\b(not sure|unsure|maybe|might|perhaps|unclear|i think|possibly)\b/i },
  {
    id: "alternatives",
    re: /\b(alternativ|instead|option|either|on the other hand|vs\.?|or we could)\b/i,
  },
]

/** Distinct thinking-signal ids found in one reasoning block. */
export function detectThinkingSignals(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const { id, re } of THINKING_SIGNALS) {
    if (re.test(text)) out.push(id)
  }
  return out
}

/**
 * Parse a test-runner summary out of a tool-result string. Recognises the
 * common "N passed, M failed" / "N passing, M failing" shapes (jest, vitest,
 * mocha, pytest-ish). Returns `null` when no clear pass/fail count is present.
 */
export function parseTestSummary(text: string): { passed: number; failed: number } | null {
  if (!text) return null
  const passed = text.match(/(\d+)\s+(?:passed|passing)\b/i)
  const failed = text.match(/(\d+)\s+(?:failed|failing)\b/i)
  if (!passed && !failed) return null
  return {
    passed: passed ? Number.parseInt(passed[1], 10) : 0,
    failed: failed ? Number.parseInt(failed[1], 10) : 0,
  }
}

/**
 * The first two whitespace-delimited words of a shell command — the "prefix"
 * used to group repeated invocations for thrashing detection (e.g. `npm run`,
 * `git status`, `pnpm test`). Empty string for an empty command.
 */
export function bashCommandPrefix(command: string): string {
  const trimmed = (command ?? "").trim()
  if (!trimmed) return ""
  return trimmed.split(/\s+/).slice(0, 2).join(" ")
}

/** Whether a shell command is a `git commit` (for the cost-per-commit metric). */
export function isGitCommit(command: string): boolean {
  return /\bgit\s+commit\b/.test(command ?? "")
}

/** A user message is a permission denial echoed back as a tool result. */
export function isPermissionDenialText(text: string): boolean {
  if (!text) return false
  return /\b(permission denied|not allowed|denied by|requires approval|user (?:rejected|denied))\b/i.test(
    text
  )
}

// Thrashing thresholds (exported so the report + tests share one source).
/** A Bash command prefix repeated at least this many times counts as thrashing. */
export const BASH_THRASH_THRESHOLD = 5
/** A file edited at least this many times counts as thrashing. */
export const FILE_EDIT_THRASH_THRESHOLD = 3
