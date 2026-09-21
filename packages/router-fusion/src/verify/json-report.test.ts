import { GENERIC_TEST_STATUSES, parseJsonTestReport } from "./json-report"

function ok(value: unknown) {
  const parsed = parseJsonTestReport(JSON.stringify(value))
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`)
  return parsed.report
}

describe("parseJsonTestReport", () => {
  it("reads a jest --json report: assertions, skips and a file that failed to load", () => {
    const report = ok({
      numTotalTests: 4,
      numFailedTests: 1,
      numPendingTests: 1,
      numTodoTests: 1,
      numRuntimeErrorTestSuites: 1,
      success: false,
      testResults: [
        {
          name: "/w/src/users/list.test.ts",
          status: "failed",
          message: "",
          assertionResults: [
            {
              ancestorTitles: ["users", "list"],
              title: "renders",
              fullName: "users list renders",
              status: "passed",
              failureMessages: [],
              duration: 12.4,
            },
            {
              ancestorTitles: ["users"],
              title: "race",
              status: "failed",
              failureMessages: ["", "Expected 2, received 3"],
              duration: null,
            },
            { ancestorTitles: [], title: "later", status: "pending", failureMessages: [] },
            { title: "someday", status: "todo" },
          ],
        },
        {
          name: "/w/src/broken.test.ts",
          status: "failed",
          message: "SyntaxError: Unexpected token",
          assertionResults: [],
        },
      ],
    })
    expect(report.kind).toBe("jest_json")
    expect(report.totals).toEqual({ discovered: 4, passed: 1, failed: 1, errored: 0, skipped: 2 })
    expect(report.cases[0]).toEqual({
      id: "/w/src/users/list.test.ts::users list renders",
      name: "renders",
      fullName: "users list renders",
      scope: "/w/src/users/list.test.ts",
      file: "/w/src/users/list.test.ts",
      className: null,
      status: "passed",
      message: null,
      durationMs: 12,
    })
    expect(report.cases[1]).toMatchObject({
      fullName: "users race",
      message: "Expected 2, received 3",
    })
    expect(report.suiteErrors).toEqual(["/w/src/broken.test.ts: SyntaxError: Unexpected token"])
    expect(report.declared).toEqual({ tests: 4, failures: 1, errors: 1, skipped: 2 })
  })

  it("counts an unknown assertion status as an error and names runtime errors it cannot place", () => {
    const report = ok({
      numRuntimeErrorTestSuites: 2,
      testResults: [
        {
          testFilePath: "a.test.ts",
          testExecError: { message: "cannot find module" },
          assertionResults: [{ title: "t", status: "focused" }],
        },
      ],
    })
    expect(report.cases[0]).toMatchObject({
      status: "error",
      message: 'unknown test status "focused"',
    })
    expect(report.suiteErrors).toEqual([
      "a.test.ts: cannot find module",
      "2 test suite(s) failed to run (numRuntimeErrorTestSuites)",
    ])
    expect(report.declared).toBeNull()
  })

  it("reads the generic {tests:[{id,status}]} shape", () => {
    const report = ok({
      tests: [
        { id: "users::race", status: "passed", name: "race", duration_ms: 3.6 },
        { id: "users::list", status: "failed", message: "boom" },
        { id: "users::later", status: "skipped" },
        { id: "users::crash", status: "error", message: null },
      ],
    })
    expect(report.kind).toBe("generic_json")
    expect(report.totals).toEqual({ discovered: 4, passed: 1, failed: 1, errored: 1, skipped: 1 })
    expect(report.cases[0]).toMatchObject({ id: "users::race", name: "race", durationMs: 4 })
    expect(report.cases[1]).toMatchObject({ name: "users::list", message: "boom" })
    expect(report.declared).toBeNull()
    expect(GENERIC_TEST_STATUSES).toEqual(["passed", "failed", "error", "skipped"])
  })

  it("refuses what it cannot read instead of guessing", () => {
    expect(parseJsonTestReport("")).toMatchObject({ ok: false, code: "REPORT_EMPTY" })
    expect(parseJsonTestReport("{nope")).toMatchObject({ ok: false, code: "REPORT_MALFORMED" })
    expect(parseJsonTestReport("[]")).toMatchObject({ ok: false, code: "REPORT_UNSUPPORTED" })
    expect(parseJsonTestReport('{"results": []}')).toMatchObject({
      ok: false,
      code: "REPORT_UNSUPPORTED",
    })
    expect(parseJsonTestReport('{"tests": [{"id": "x", "status": "green"}]}')).toMatchObject({
      ok: false,
      code: "REPORT_MALFORMED",
    })
    expect(
      parseJsonTestReport('{"testResults": [{"assertionResults": [{"status": "passed"}]}]}')
    ).toMatchObject({
      ok: false,
      code: "REPORT_MALFORMED",
    })
    expect(parseJsonTestReport('{"tests": []}', { maxBytes: 3 })).toMatchObject({
      ok: false,
      code: "REPORT_TOO_LARGE",
    })
  })
})
