import { VerificationReportSchema, type VerificationReport } from "../contracts/schemas"
import { junitFixture } from "../fake/memory-acceptance"
import {
  CODE_ACCEPTANCE_VERIFIER_VERSION,
  MAX_FAILED_TEST_CHECKS,
  SANDBOX_TIERS,
  buildCodeAcceptanceReport,
  codeAcceptanceFacts,
  isSandboxTier,
  judgeRuntimeAcceptance,
  parseAcceptanceReport,
  type AcceptanceExecution,
} from "./code-acceptance"

const REPORT_ID = "11111111-1111-4111-8111-111111111111"
const PASS = junitFixture([
  { name: "lists users", status: "passed" },
  { name: "race condition", status: "passed" },
])

function execution(overrides: Partial<AcceptanceExecution> = {}): AcceptanceExecution {
  return {
    reportId: REPORT_ID,
    revision: "rev-2",
    tier: "container",
    exitCode: 0,
    timedOut: false,
    report: { format: "junit", content: PASS, truncated: false },
    requiredTests: [],
    ...overrides,
  }
}

function check(report: VerificationReport, id: string) {
  return report.checks.find((c) => c.check_id === id)
}

describe("buildCodeAcceptanceReport", () => {
  it("passes a green run and records the tier, the counts and the revision", () => {
    const report = buildCodeAcceptanceReport(
      execution({ artifactRefs: ["22222222-2222-4222-8222-222222222222"] })
    )
    expect(VerificationReportSchema.parse(report)).toEqual(report)
    expect(report).toMatchObject({
      report_id: REPORT_ID,
      status: "passed",
      level: "tool_verified",
      revision: "rev-2",
      verifier_version: CODE_ACCEPTANCE_VERIFIER_VERSION,
      artifact_refs: ["22222222-2222-4222-8222-222222222222"],
    })
    expect(report.checks.every((c) => c.executed_by === "runtime")).toBe(true)
    expect(check(report, "sandbox")).toMatchObject({ status: "passed", summary: "tier=container" })
    expect(check(report, "required_tests")?.status).toBe("not_applicable")
    expect(codeAcceptanceFacts(report)).toEqual({
      tier: "container",
      exit: "0",
      report: "junit",
      discovered: 2,
      passed: 2,
      failed: 0,
      errored: 0,
      skipped: 0,
      revision: "rev-2",
    })
  })

  it("[ACC:DEL-02] fails an exit-0 run that discovered no test or skipped every one", () => {
    const zero = buildCodeAcceptanceReport(
      execution({ report: { format: "junit", content: junitFixture([]), truncated: false } })
    )
    expect(zero.status).toBe("failed")
    expect(check(zero, "tests_discovered")).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("no test was discovered"),
    })

    const skipped = buildCodeAcceptanceReport(
      execution({
        report: {
          format: "json",
          content: JSON.stringify({
            numTotalTests: 2,
            testResults: [
              {
                name: "a.test.ts",
                status: "passed",
                assertionResults: [
                  { title: "x", status: "pending" },
                  { title: "y", status: "skipped" },
                ],
              },
            ],
          }),
          truncated: false,
        },
      })
    )
    expect(skipped.status).toBe("failed")
    expect(check(skipped, "tests_discovered")?.summary).toContain("every test was skipped")

    // A green generic report with zero tests is the same failure.
    const generic = buildCodeAcceptanceReport(
      execution({ report: { format: "json", content: '{"tests":[]}', truncated: false } })
    )
    expect(generic.status).toBe("failed")
  })

  it("requires every required test to have run and passed — skipped is not passed", () => {
    const content = junitFixture([
      { name: "race condition", classname: "users.List", status: "passed" },
      { name: "empty page", classname: "users.List", status: "skipped" },
      { name: "other", status: "passed" },
    ])
    const ok = buildCodeAcceptanceReport(
      execution({
        report: { format: "junit", content, truncated: false },
        requiredTests: ["users.List.race condition", " race condition "],
      })
    )
    expect(check(ok, "required_tests")).toMatchObject({
      status: "passed",
      summary: "required=2 missing=0 not_passed=0",
    })

    const bad = buildCodeAcceptanceReport(
      execution({
        report: { format: "junit", content, truncated: false },
        requiredTests: ["empty page", "pagination"],
      })
    )
    expect(bad.status).toBe("failed")
    expect(check(bad, "required_tests")?.summary).toBe(
      "required=2 missing=1 not_passed=1 — missing: pagination — not passed: empty page"
    )
  })

  it("fails a non-zero exit or a failing test, and lists the failing cases", () => {
    const failing = buildCodeAcceptanceReport(
      execution({
        exitCode: 1,
        report: {
          format: "junit",
          content: junitFixture([
            { name: "race", status: "failed", message: "expected 2 rows" },
            { name: "boom", status: "error", message: "TypeError" },
          ]),
          truncated: false,
        },
      })
    )
    expect(failing.status).toBe("failed")
    expect(check(failing, "command_exit")).toMatchObject({ status: "failed", summary: "exit=1" })
    expect(check(failing, "tests_result")?.summary).toBe("failed=1 errored=1 suite_errors=0")
    expect(check(failing, "test:fixture::race")?.summary).toBe("failed: expected 2 rows")
    expect(check(failing, "test:fixture::boom")?.summary).toBe("error: TypeError")

    // An exit 1 with a green report is still a failed command.
    expect(buildCodeAcceptanceReport(execution({ exitCode: 2 })).status).toBe("failed")
  })

  it("lists at most the configured failing cases and dedupes their ids", () => {
    const many = junitFixture(
      Array.from({ length: MAX_FAILED_TEST_CHECKS + 3 }, () => ({
        name: "same",
        status: "failed" as const,
      }))
    )
    const report = buildCodeAcceptanceReport(
      execution({ report: { format: "junit", content: many, truncated: false } })
    )
    const listed = report.checks.filter((c) => c.kind === "test")
    expect(listed).toHaveLength(MAX_FAILED_TEST_CHECKS)
    expect(listed[1].check_id).toBe("test:fixture::same#2")
    expect(check(report, "tests_failing_unlisted")).toMatchObject({
      status: "failed",
      summary: "unlisted=3",
    })
  })

  it("is inconclusive — never a pass — when the run or its report cannot be read", () => {
    expect(buildCodeAcceptanceReport(execution({ timedOut: true, exitCode: null })).status).toBe(
      "inconclusive"
    )
    expect(buildCodeAcceptanceReport(execution({ exitCode: null })).status).toBe("inconclusive")
    const missing = buildCodeAcceptanceReport(
      execution({ report: { format: "junit", content: null, truncated: false } })
    )
    expect(missing.status).toBe("inconclusive")
    expect(check(missing, "report")?.summary).toBe("report=missing")
    expect(
      buildCodeAcceptanceReport(
        execution({ report: { format: "junit", content: PASS, truncated: true } })
      ).status
    ).toBe("inconclusive")
    const garbled = buildCodeAcceptanceReport(
      execution({ report: { format: "json", content: "{", truncated: false } })
    )
    expect(garbled.status).toBe("inconclusive")
    expect(codeAcceptanceFacts(garbled).report).toBe("REPORT_MALFORMED")
    // A report whose header disagrees with its body proves nothing.
    const lying = PASS.replace('<testsuites tests="2"', '<testsuites tests="5"')
    const inconsistent = buildCodeAcceptanceReport(
      execution({ report: { format: "junit", content: lying, truncated: false } })
    )
    expect(inconsistent.status).toBe("inconclusive")
    expect(check(inconsistent, "report_consistency")?.summary).toBe("declared=5 discovered=2")
  })

  it("parses either format and knows the sandbox tiers", () => {
    expect(parseAcceptanceReport("junit", PASS)).toMatchObject({ ok: true })
    expect(parseAcceptanceReport("json", '{"tests":[]}')).toMatchObject({ ok: true })
    expect(SANDBOX_TIERS).toEqual(["microvm", "container", "os"])
    expect(isSandboxTier("os")).toBe(true)
    expect(isSandboxTier("none")).toBe(false)
  })
})

describe("judgeRuntimeAcceptance", () => {
  const passed = buildCodeAcceptanceReport(execution())

  it("[ACC:DEL-01] believes only a runtime report at tool_verified", () => {
    expect(judgeRuntimeAcceptance(null, "rev-2")).toMatchObject({
      status: "inconclusive",
      reason: "NO_RUNTIME_REPORT",
    })
    expect(judgeRuntimeAcceptance({ status: "passed" }, "rev-2")).toMatchObject({
      status: "inconclusive",
      reason: "REPORT_INVALID",
    })
    const byModel: VerificationReport = {
      ...passed,
      checks: passed.checks.map((c, i) => (i === 1 ? { ...c, executed_by: "model" } : c)),
    }
    expect(judgeRuntimeAcceptance(byModel, "rev-2")).toMatchObject({
      status: "inconclusive",
      reason: "NOT_TOOL_VERIFIED",
    })
    expect(judgeRuntimeAcceptance({ ...passed, level: "model_review" }, "rev-2")).toMatchObject({
      reason: "NOT_TOOL_VERIFIED",
    })
    expect(judgeRuntimeAcceptance({ ...passed, checks: [] }, "rev-2")).toMatchObject({
      reason: "NOT_TOOL_VERIFIED",
    })
    const noTier = { ...passed, checks: passed.checks.filter((c) => c.check_id !== "sandbox") }
    expect(judgeRuntimeAcceptance(noTier, "rev-2")).toMatchObject({
      status: "inconclusive",
      reason: "SANDBOX_TIER_MISSING",
    })
  })

  it("[ACC:DEL-03] never lets a report about one revision stand for another", () => {
    expect(judgeRuntimeAcceptance(passed, "rev-3")).toMatchObject({
      status: "inconclusive",
      reason: "REVISION_MISMATCH",
      tier: "container",
    })
    expect(judgeRuntimeAcceptance({ ...passed, revision: null }, "rev-2")).toMatchObject({
      reason: "REVISION_MISMATCH",
    })
    expect(judgeRuntimeAcceptance(passed, "rev-2")).toMatchObject({
      status: "passed",
      tier: "container",
    })
  })

  it("carries a believable failure or inconclusive result through", () => {
    const failed = buildCodeAcceptanceReport(execution({ exitCode: 1 }))
    expect(judgeRuntimeAcceptance(failed, "rev-2")).toMatchObject({
      status: "failed",
      reason: "ACCEPTANCE_FAILED",
    })
    const unclear = buildCodeAcceptanceReport(execution({ timedOut: true }))
    expect(judgeRuntimeAcceptance(unclear, "rev-2")).toMatchObject({
      status: "inconclusive",
      reason: "ACCEPTANCE_INCONCLUSIVE",
    })
    expect(codeAcceptanceFacts({ ...passed, checks: [] })).toMatchObject({
      tier: null,
      discovered: null,
    })
  })
})
