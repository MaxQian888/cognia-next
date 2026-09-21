import {
  TEST_MESSAGE_MAX_CHARS,
  capMessage,
  caseIdOf,
  precheckReport,
  tallyTestCases,
  testCaseMatches,
  type ParsedTestCase,
} from "./test-report"

function testCase(overrides: Partial<ParsedTestCase> = {}): ParsedTestCase {
  return {
    id: "tests/users/race.test.ts::users race",
    name: "race",
    fullName: "users race",
    scope: "tests/users/race.test.ts",
    file: "tests/users/race.test.ts",
    className: "users.Race",
    status: "passed",
    message: null,
    durationMs: null,
    ...overrides,
  }
}

describe("test-report", () => {
  it("tallies cases by status", () => {
    expect(
      tallyTestCases([
        testCase(),
        testCase({ status: "failed" }),
        testCase({ status: "error" }),
        testCase({ status: "skipped" }),
        testCase({ status: "skipped" }),
      ])
    ).toEqual({ discovered: 5, passed: 1, failed: 1, errored: 1, skipped: 2 })
    expect(tallyTestCases([])).toEqual({
      discovered: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: 0,
    })
  })

  it("matches a required test by the names runners print, exactly", () => {
    const c = testCase()
    for (const name of [
      "tests/users/race.test.ts::users race",
      "users race",
      "race",
      "users.Race.race",
      "tests/users/race.test.ts::race",
      "  race  ",
    ]) {
      expect(testCaseMatches(c, name)).toBe(true)
    }
    for (const name of ["", "rac", "users", "tests/users/race.test.ts"]) {
      expect(testCaseMatches(c, name)).toBe(false)
    }
    expect(testCaseMatches(testCase({ className: null, file: null }), "users.Race.race")).toBe(
      false
    )
  })

  it("prechecks size and emptiness, caps messages and builds ids", () => {
    expect(precheckReport("  \n")).toMatchObject({ ok: false, code: "REPORT_EMPTY" })
    expect(precheckReport("héllo", { maxBytes: 5 })).toMatchObject({
      ok: false,
      code: "REPORT_TOO_LARGE",
    })
    expect(precheckReport("hello", { maxBytes: 5 })).toBeNull()
    expect(capMessage(undefined)).toBeNull()
    expect(capMessage("   ")).toBeNull()
    expect(capMessage("  boom ")).toBe("boom")
    expect(capMessage("x".repeat(TEST_MESSAGE_MAX_CHARS + 10))?.endsWith("…")).toBe(true)
    expect(caseIdOf(null, "a b")).toBe("a b")
    expect(caseIdOf("f.ts", "a b")).toBe("f.ts::a b")
  })
})
