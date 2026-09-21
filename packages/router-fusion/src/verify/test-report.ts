/**
 * The one shape every test-report parser produces (ADR-0188 B4, DEL-02).
 *
 * A delegate run is accepted only on a report its acceptance command wrote in
 * the sandbox — JUnit XML or a JSON report. Both parsers normalise to this
 * shape, so the rules that decide acceptance (`code-acceptance.ts`) are
 * written once: how many tests were discovered, how many passed, failed,
 * errored or were skipped, and what the report says about itself.
 *
 * A parser never guesses. A report it cannot read is a refusal with a code,
 * and the acceptance rules turn that into `inconclusive`, never a pass.
 */

export type TestCaseStatus = "passed" | "failed" | "error" | "skipped"

/** Which parser read the report. */
export type TestReportKind = "junit" | "jest_json" | "generic_json"

export interface ParsedTestCase {
  /** `<scope>::<fullName>`, or `fullName` alone when the report names no scope. */
  id: string
  /** The case's own title. */
  name: string
  /** The describe path and the title, space-joined; the title alone when there is no path. */
  fullName: string
  /** The file, class or suite the case belongs to; null when the report names none. */
  scope: string | null
  /** The source file, when the report names one. */
  file: string | null
  /** The JUnit `classname`, when there is one. */
  className: string | null
  status: TestCaseStatus
  /** The first failure, error or skip message, trimmed and capped. */
  message: string | null
  durationMs: number | null
}

export interface TestTotals {
  discovered: number
  passed: number
  failed: number
  errored: number
  skipped: number
}

/** What a report states about itself, when it states it. */
export interface DeclaredTotals {
  tests: number | null
  failures: number | null
  errors: number | null
  skipped: number | null
}

export interface ParsedTestReport {
  kind: TestReportKind
  cases: ParsedTestCase[]
  totals: TestTotals
  declared: DeclaredTotals | null
  /** Failures outside any single case: a suite that did not load, a runtime error. */
  suiteErrors: string[]
}

export type TestReportRefusal =
  "REPORT_EMPTY" | "REPORT_TOO_LARGE" | "REPORT_MALFORMED" | "REPORT_UNSUPPORTED"

export type TestReportParseResult =
  { ok: true; report: ParsedTestReport } | { ok: false; code: TestReportRefusal; message: string }

export interface TestReportParseOptions {
  /** UTF-8 bytes a report may have; the sandbox caps what it collects too. */
  maxBytes?: number
}

/** A report larger than this is refused rather than parsed. */
export const TEST_REPORT_MAX_BYTES = 16 * 1024 * 1024
/** Characters of one failure message kept per case. */
export const TEST_MESSAGE_MAX_CHARS = 2_000

export function refuseReport(code: TestReportRefusal, message: string): TestReportParseResult {
  return { ok: false, code, message }
}

/** The empty/too-large refusal every parser applies first, or null when the content may be parsed. */
export function precheckReport(
  content: string,
  options: TestReportParseOptions = {}
): TestReportParseResult | null {
  if (content.trim().length === 0) return refuseReport("REPORT_EMPTY", "the report is empty")
  const maxBytes = options.maxBytes ?? TEST_REPORT_MAX_BYTES
  const bytes = new TextEncoder().encode(content).byteLength
  if (bytes > maxBytes) {
    return refuseReport("REPORT_TOO_LARGE", `the report is ${bytes} bytes; at most ${maxBytes}`)
  }
  return null
}

export function capMessage(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > TEST_MESSAGE_MAX_CHARS
    ? `${trimmed.slice(0, TEST_MESSAGE_MAX_CHARS)}…`
    : trimmed
}

export function caseIdOf(scope: string | null, fullName: string): string {
  return scope ? `${scope}::${fullName}` : fullName
}

export function tallyTestCases(cases: readonly ParsedTestCase[]): TestTotals {
  const totals: TestTotals = {
    discovered: cases.length,
    passed: 0,
    failed: 0,
    errored: 0,
    skipped: 0,
  }
  for (const testCase of cases) {
    if (testCase.status === "passed") totals.passed++
    else if (testCase.status === "failed") totals.failed++
    else if (testCase.status === "error") totals.errored++
    else totals.skipped++
  }
  return totals
}

/**
 * Whether a required-test name from an acceptance profile names this case.
 * A profile may name a case by its id, its full name, its title, or the forms
 * test runners print (`<class>.<title>`, `<file>::<title>`,
 * `<file>::<full name>`). Matching is exact; nothing is a prefix or a pattern.
 */
export function testCaseMatches(testCase: ParsedTestCase, required: string): boolean {
  const wanted = required.trim()
  if (wanted.length === 0) return false
  const forms = new Set<string>([testCase.id, testCase.fullName, testCase.name])
  if (testCase.className) forms.add(`${testCase.className}.${testCase.name}`)
  if (testCase.file) {
    forms.add(`${testCase.file}::${testCase.name}`)
    forms.add(`${testCase.file}::${testCase.fullName}`)
  }
  return forms.has(wanted)
}
