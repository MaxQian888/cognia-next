/**
 * JSON test reports (ADR-0188 B4, DEL-02).
 *
 * Two shapes, told apart by their top-level keys:
 *
 * - **jest `--json`**: `{ testResults: [{ name, status, message, assertionResults: [...] }], numTotalTests, … }`.
 *   An assertion is `passed`, `failed`, or skipped (`pending`, `skipped`,
 *   `todo`, `disabled`). A test file that failed to run at all — a syntax
 *   error, a crash in setup — reports no assertions and a message: that is a
 *   suite error, never "zero failures".
 * - **generic**: `{ tests: [{ id, status, name?, message?, duration_ms? }] }`
 *   with `status` one of `passed`, `failed`, `error`, `skipped`.
 *
 * Anything else is refused. A status the parser does not know is counted as
 * an error rather than guessed into a pass.
 */

import { z } from "zod"

import {
  capMessage,
  caseIdOf,
  precheckReport,
  refuseReport,
  tallyTestCases,
  type DeclaredTotals,
  type ParsedTestCase,
  type TestCaseStatus,
  type TestReportParseOptions,
  type TestReportParseResult,
} from "./test-report"

const count = z.int().min(0)

const JestAssertion = z.looseObject({
  ancestorTitles: z.array(z.string()).optional(),
  title: z.string(),
  fullName: z.string().optional(),
  status: z.string(),
  failureMessages: z.array(z.string()).nullable().optional(),
  duration: z.number().nullable().optional(),
})

const JestFile = z.looseObject({
  name: z.string().optional(),
  testFilePath: z.string().optional(),
  status: z.string().optional(),
  message: z.string().nullable().optional(),
  failureMessage: z.string().nullable().optional(),
  testExecError: z.looseObject({ message: z.string().optional() }).nullable().optional(),
  assertionResults: z.array(JestAssertion).optional(),
})

const JestReport = z.looseObject({
  numTotalTests: count.optional(),
  numFailedTests: count.optional(),
  numPendingTests: count.optional(),
  numTodoTests: count.optional(),
  numRuntimeErrorTestSuites: count.optional(),
  testResults: z.array(JestFile),
})

export const GENERIC_TEST_STATUSES = ["passed", "failed", "error", "skipped"] as const

const GenericReport = z.looseObject({
  tests: z.array(
    z.looseObject({
      id: z.string().min(1),
      status: z.enum(GENERIC_TEST_STATUSES),
      name: z.string().optional(),
      message: z.string().nullable().optional(),
      duration_ms: z.number().min(0).nullable().optional(),
    })
  ),
})

const JEST_SKIPPED = new Set(["pending", "skipped", "todo", "disabled"])

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
}

function jestStatus(raw: string): { status: TestCaseStatus; note: string | null } {
  if (raw === "passed") return { status: "passed", note: null }
  if (raw === "failed") return { status: "failed", note: null }
  if (JEST_SKIPPED.has(raw)) return { status: "skipped", note: null }
  return { status: "error", note: `unknown test status "${raw}"` }
}

function parseJest(value: unknown): TestReportParseResult {
  const parsed = JestReport.safeParse(value)
  if (!parsed.success) {
    return refuseReport("REPORT_MALFORMED", `not a jest --json report: ${issuesText(parsed.error)}`)
  }
  const report = parsed.data
  const cases: ParsedTestCase[] = []
  const suiteErrors: string[] = []
  for (const file of report.testResults) {
    const path = file.name ?? file.testFilePath ?? null
    const assertions = file.assertionResults ?? []
    const loadError = file.testExecError?.message ?? file.failureMessage ?? file.message ?? null
    if (file.testExecError || (file.status === "failed" && assertions.length === 0)) {
      suiteErrors.push(
        `${path ?? "(test file)"}: ${capMessage(loadError) ?? "the test file failed to run"}`
      )
    }
    for (const assertion of assertions) {
      const titlePath = [...(assertion.ancestorTitles ?? []), assertion.title]
      const fullName = assertion.fullName?.trim() || titlePath.join(" ")
      const { status, note } = jestStatus(assertion.status)
      const failure = assertion.failureMessages?.find((m) => m.trim().length > 0) ?? null
      cases.push({
        id: caseIdOf(path, fullName),
        name: assertion.title,
        fullName,
        scope: path,
        file: path,
        className: null,
        status,
        message: capMessage(note ?? failure),
        durationMs:
          typeof assertion.duration === "number" && assertion.duration >= 0
            ? Math.round(assertion.duration)
            : null,
      })
    }
  }
  const declared: DeclaredTotals | null =
    report.numTotalTests === undefined
      ? null
      : {
          tests: report.numTotalTests,
          failures: report.numFailedTests ?? null,
          errors: report.numRuntimeErrorTestSuites ?? null,
          skipped:
            report.numPendingTests === undefined && report.numTodoTests === undefined
              ? null
              : (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
        }
  if ((report.numRuntimeErrorTestSuites ?? 0) > suiteErrors.length) {
    suiteErrors.push(
      `${report.numRuntimeErrorTestSuites} test suite(s) failed to run (numRuntimeErrorTestSuites)`
    )
  }
  return {
    ok: true,
    report: { kind: "jest_json", cases, totals: tallyTestCases(cases), declared, suiteErrors },
  }
}

function parseGeneric(value: unknown): TestReportParseResult {
  const parsed = GenericReport.safeParse(value)
  if (!parsed.success) {
    return refuseReport(
      "REPORT_MALFORMED",
      `not a {tests:[{id,status}]} report: ${issuesText(parsed.error)}`
    )
  }
  const cases: ParsedTestCase[] = parsed.data.tests.map((test) => {
    const name = test.name?.trim() || test.id
    return {
      id: test.id,
      name,
      fullName: name,
      scope: null,
      file: null,
      className: null,
      status: test.status,
      message: capMessage(test.message),
      durationMs: typeof test.duration_ms === "number" ? Math.round(test.duration_ms) : null,
    }
  })
  return {
    ok: true,
    report: {
      kind: "generic_json",
      cases,
      totals: tallyTestCases(cases),
      declared: null,
      suiteErrors: [],
    },
  }
}

export function parseJsonTestReport(
  content: string,
  options: TestReportParseOptions = {}
): TestReportParseResult {
  const refused = precheckReport(content, options)
  if (refused) return refused
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    return refuseReport(
      "REPORT_MALFORMED",
      `the report is not JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return refuseReport("REPORT_UNSUPPORTED", "a JSON test report is an object")
  }
  const record = value as Record<string, unknown>
  if (Array.isArray(record.testResults)) return parseJest(value)
  if (Array.isArray(record.tests)) return parseGeneric(value)
  return refuseReport(
    "REPORT_UNSUPPORTED",
    "a JSON test report has `testResults` (jest --json) or `tests` ({tests:[{id,status}]})"
  )
}
