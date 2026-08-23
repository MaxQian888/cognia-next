/**
 * Turn a test runner's tail output into counts — or into `inconclusive`.
 *
 * The single rule this module exists to enforce: **output that could not be
 * parsed is `inconclusive`, never `0 failed`.** A run whose reporter changed
 * format, whose process was killed, or whose output was truncated must not
 * render as a green check. Every branch below either finds an explicit count
 * line or gives up loudly.
 *
 * Formats are tried independently of what `detect` guessed, because the guess
 * is frequently `package-script` ("`pnpm test`" — could be anything). The
 * runner hint only orders the attempts.
 */

import type { RunVerificationSummary } from "@/types/execution/run"
import type { VerificationRunner } from "./detect"

/**
 * Only the tail is scanned. Every supported reporter prints its totals last,
 * and a full suite's output can be megabytes — none of which we want to hold
 * or walk.
 */
const TAIL_CHARS = 16_384

const INCONCLUSIVE: RunVerificationSummary = {
  conclusion: "inconclusive",
  passed: 0,
  failed: 0,
  skipped: 0,
  total: 0,
}

/** Flatten the many shapes a tool result arrives in into scannable text. */
export function verificationOutputText(result: unknown): string {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return result.map(verificationOutputText).join("\n")
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    if (Array.isArray(record.content)) return verificationOutputText(record.content)
    const streams = [record.stdout, record.stderr, record.output]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
    if (streams.length > 0) return streams
  }
  return ""
}

const int = (raw: string | undefined): number => {
  const value = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(value) ? value : 0
}

function seconds(raw: string | undefined, unit: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return undefined
  if (unit === "ms") return Math.round(value)
  if (unit === "m") return Math.round(value * 60_000)
  return Math.round(value * 1000)
}

/** `Tests:  1 failed, 2 skipped, 10 passed, 13 total` */
function parseJest(text: string): RunVerificationSummary | null {
  const line = /^\s*Tests:\s+(.+)$/m.exec(text)
  if (!line) return null
  const body = line[1]
  const pick = (label: string) => {
    const hit = new RegExp(`(\\d+)\\s+${label}`).exec(body)
    return hit ? int(hit[1]) : 0
  }
  const total = pick("total")
  if (total === 0 && !/\d+\s+total/.test(body)) return null
  const failed = pick("failed")
  const duration = /^\s*Time:\s+([\d.]+)\s*(ms|s|m)\b/m.exec(text)
  return {
    conclusion: failed > 0 ? "failed" : "passed",
    passed: pick("passed"),
    failed,
    skipped: pick("skipped") + pick("todo"),
    total,
    ...(duration ? { durationMs: seconds(duration[1], duration[2]) } : {}),
  }
}

/** `Tests  3 failed | 10 passed | 1 skipped (14)` */
function parseVitest(text: string): RunVerificationSummary | null {
  const line = /^\s*Tests\s{2,}(.+)$/m.exec(text)
  if (!line) return null
  const body = line[1]
  const pick = (label: string) => {
    const hit = new RegExp(`(\\d+)\\s+${label}`).exec(body)
    return hit ? int(hit[1]) : 0
  }
  const totalHit = /\((\d+)\)\s*$/.exec(body.trim())
  const failed = pick("failed")
  const passed = pick("passed")
  const skipped = pick("skipped") + pick("todo")
  const total = totalHit ? int(totalHit[1]) : passed + failed + skipped
  if (total === 0) return null
  const duration = /^\s*Duration\s+([\d.]+)\s*(ms|s|m)\b/m.exec(text)
  return {
    conclusion: failed > 0 ? "failed" : "passed",
    passed,
    failed,
    skipped,
    total,
    ...(duration ? { durationMs: seconds(duration[1], duration[2]) } : {}),
  }
}

/**
 * `2 failed` / `10 passed (3.4s)` / `1 skipped` / `3 flaky`, each on its own
 * line. Requires at least one such line so unrelated output cannot match.
 */
function parsePlaywright(text: string): RunVerificationSummary | null {
  const pick = (label: string) => {
    const hit = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(text)
    return hit ? int(hit[1]) : 0
  }
  const passed = pick("passed")
  const failed = pick("failed")
  const skipped = pick("skipped")
  const flaky = pick("flaky")
  const didNotRun = pick("did not run")
  const total = passed + failed + skipped + flaky + didNotRun
  if (total === 0) return null
  const duration = /^\s*\d+\s+passed\s+\(([\d.]+)(ms|s|m)\)/m.exec(text)
  return {
    // A flaky test passed on retry; it is not a failure, but it is not silence
    // either — it stays visible through the counts.
    conclusion: failed > 0 ? "failed" : "passed",
    passed: passed + flaky,
    failed,
    skipped: skipped + didNotRun,
    total,
    ...(duration ? { durationMs: seconds(duration[1], duration[2]) } : {}),
  }
}

/** `test result: ok. 10 passed; 0 failed; 2 ignored; …; finished in 0.12s` */
function parseCargo(text: string): RunVerificationSummary | null {
  const lines = [...text.matchAll(/^\s*test result:\s+(\w+)\.\s+(.+)$/gm)]
  if (lines.length === 0) return null
  let passed = 0
  let failed = 0
  let skipped = 0
  let durationMs: number | undefined
  for (const line of lines) {
    const body = line[2]
    const pick = (label: string) => {
      const hit = new RegExp(`(\\d+)\\s+${label}`).exec(body)
      return hit ? int(hit[1]) : 0
    }
    passed += pick("passed")
    failed += pick("failed")
    skipped += pick("ignored") + pick("filtered out")
    const finished = /finished in\s+([\d.]+)(ms|s|m)?/.exec(body)
    if (finished) durationMs = (durationMs ?? 0) + (seconds(finished[1], finished[2] ?? "s") ?? 0)
  }
  return {
    conclusion: failed > 0 ? "failed" : "passed",
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

const PARSERS: Record<
  Exclude<VerificationRunner, "package-script">,
  (text: string) => RunVerificationSummary | null
> = {
  jest: parseJest,
  vitest: parseVitest,
  playwright: parsePlaywright,
  "cargo-test": parseCargo,
}

const ORDER: ReadonlyArray<Exclude<VerificationRunner, "package-script">> = [
  "jest",
  "vitest",
  "playwright",
  "cargo-test",
]

/**
 * Parse a verification summary out of tool output.
 *
 * The tool's own error flag is deliberately NOT an input. A non-zero exit with
 * a parseable report is already `failed` with real counts, and a non-zero exit
 * without one is already `inconclusive` — the process may have died before the
 * reporter ran, and claiming zero failures there would be a lie. There is no
 * third answer for the flag to select, so taking it would only imply one.
 */
export function parseVerificationOutput(
  runner: VerificationRunner,
  result: unknown
): RunVerificationSummary {
  const full = verificationOutputText(result)
  const text = full.length > TAIL_CHARS ? full.slice(-TAIL_CHARS) : full
  if (text.trim().length === 0) return INCONCLUSIVE

  const first = runner === "package-script" ? undefined : runner
  const attempts = first ? [first, ...ORDER.filter((name) => name !== first)] : ORDER
  for (const name of attempts) {
    const parsed = PARSERS[name](text)
    if (parsed) return parsed
  }
  // Unparseable. Deliberately NOT `{failed: 0, conclusion: "passed"}` — see the
  // module docblock.
  return { ...INCONCLUSIVE }
}
