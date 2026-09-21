/**
 * `code_fixture` acceptance: what a sandboxed test run proves (ADR-0188 B4).
 *
 * The host runs the approved acceptance command of a `.cognia/workspace.json`
 * profile in an isolated worktree, with no network, in the strongest sandbox
 * tier it has, and collects the report file the profile names. This module is
 * the pure half: it turns what came back — the exit code, the report, the tier
 * and the revision the command ran on — into a `VerificationReport`, and it
 * decides whether a report may be believed for a given revision.
 *
 * Acceptance rules:
 * - the command must exit 0; a timeout or a kill is `inconclusive`;
 * - the report must be readable (a missing, truncated or malformed report is
 *   `inconclusive`: it proves nothing either way);
 * - at least one test must be discovered, and not every test may be skipped —
 *   a green exit over zero tests is a failure (DEL-02);
 * - no test may fail or error, and no suite may fail to load;
 * - every required test must be present and have passed — skipped is not passed;
 * - a report that contradicts its own totals is `inconclusive`.
 *
 * Belief rules (`judgeRuntimeAcceptance`):
 * - only a runtime report at level `tool_verified` whose every check the
 *   runtime executed counts — a worker's "all tests pass" never does (DEL-01);
 * - it counts only for the revision it names — a pass on v1 says nothing
 *   about v2 (DEL-03);
 * - it must say which sandbox tier ran it.
 */

import {
  CONTRACT_SCHEMA_VERSION,
  VerificationReportSchema,
  type VerificationCheck,
  type VerificationReport,
} from "../contracts/schemas"
import { parseJsonTestReport } from "./json-report"
import { parseJUnitReport } from "./junit-report"
import {
  testCaseMatches,
  type ParsedTestReport,
  type TestReportParseOptions,
  type TestReportParseResult,
} from "./test-report"

export const CODE_ACCEPTANCE_VERIFIER_VERSION = "code-acceptance-1"

/** Sandbox tiers, strongest first (DESIGN §10): a microVM, a container, the OS sandbox. */
export const SANDBOX_TIERS = ["microvm", "container", "os"] as const
export type SandboxTier = (typeof SANDBOX_TIERS)[number]

export function isSandboxTier(value: unknown): value is SandboxTier {
  return typeof value === "string" && (SANDBOX_TIERS as readonly string[]).includes(value)
}

export type AcceptanceReportFormat = "junit" | "json"

/** Failing cases listed as checks of their own; the rest are counted, not listed. */
export const MAX_FAILED_TEST_CHECKS = 20

/** Characters of one failing case's message kept in its check. */
const CHECK_MESSAGE_CHARS = 500

export function parseAcceptanceReport(
  format: AcceptanceReportFormat,
  content: string,
  options: TestReportParseOptions = {}
): TestReportParseResult {
  return format === "junit"
    ? parseJUnitReport(content, options)
    : parseJsonTestReport(content, options)
}

export interface AcceptanceExecution {
  /** A UUID for the report. */
  reportId: string
  /** The revision the command ran on — the staged result revision. */
  revision: string
  tier: SandboxTier
  /** Null when the process did not exit on its own (killed, sandbox fault). */
  exitCode: number | null
  timedOut: boolean
  report: {
    format: AcceptanceReportFormat
    /** Null when the command left no report at the profile's path. */
    content: string | null
    /** The host cut the report at its size cap. */
    truncated: boolean
  }
  /** Tests the profile requires to have run and passed. */
  requiredTests: readonly string[]
  /** Stored report and log artifacts (UUIDs). */
  artifactRefs?: readonly string[]
  parseOptions?: TestReportParseOptions
}

function runtimeCheck(
  check_id: string,
  kind: string,
  status: VerificationCheck["status"],
  summary: string,
  artifact_refs: readonly string[] = []
): VerificationCheck {
  return {
    check_id,
    kind,
    status,
    summary,
    executed_by: "runtime",
    artifact_refs: [...artifact_refs],
  }
}

function aggregate(checks: readonly VerificationCheck[]): VerificationReport["status"] {
  if (checks.some((c) => c.status === "failed")) return "failed"
  if (checks.some((c) => c.status === "inconclusive")) return "inconclusive"
  return "passed"
}

function reportChecks(
  parsed: ParsedTestReport,
  requiredTests: readonly string[]
): VerificationCheck[] {
  const { totals } = parsed
  const checks: VerificationCheck[] = []
  const counts = `discovered=${totals.discovered} passed=${totals.passed} failed=${totals.failed} errored=${totals.errored} skipped=${totals.skipped}`
  let discoveredStatus: VerificationCheck["status"] = "passed"
  let discoveredNote = ""
  if (totals.discovered === 0) {
    discoveredStatus = "failed"
    discoveredNote = " — no test was discovered"
  } else if (totals.skipped === totals.discovered) {
    discoveredStatus = "failed"
    discoveredNote = " — every test was skipped"
  }
  checks.push(
    runtimeCheck("tests_discovered", "tests", discoveredStatus, `${counts}${discoveredNote}`)
  )

  const broken = totals.failed + totals.errored + parsed.suiteErrors.length
  checks.push(
    runtimeCheck(
      "tests_result",
      "tests",
      broken === 0 ? "passed" : "failed",
      `failed=${totals.failed} errored=${totals.errored} suite_errors=${parsed.suiteErrors.length}`
    )
  )

  if (parsed.declared?.tests !== null && parsed.declared?.tests !== undefined) {
    const consistent = parsed.declared.tests === totals.discovered
    checks.push(
      runtimeCheck(
        "report_consistency",
        "report",
        consistent ? "passed" : "inconclusive",
        `declared=${parsed.declared.tests} discovered=${totals.discovered}`
      )
    )
  }

  const required = [...new Set(requiredTests.map((t) => t.trim()).filter((t) => t.length > 0))]
  if (required.length === 0) {
    checks.push(runtimeCheck("required_tests", "tests", "not_applicable", "required=0"))
  } else {
    const missing: string[] = []
    const notPassed: string[] = []
    for (const wanted of required) {
      const matches = parsed.cases.filter((testCase) => testCaseMatches(testCase, wanted))
      if (matches.length === 0) missing.push(wanted)
      else if (matches.some((testCase) => testCase.status !== "passed")) notPassed.push(wanted)
    }
    const ok = missing.length === 0 && notPassed.length === 0
    checks.push(
      runtimeCheck(
        "required_tests",
        "tests",
        ok ? "passed" : "failed",
        [
          `required=${required.length} missing=${missing.length} not_passed=${notPassed.length}`,
          ...(missing.length > 0 ? [`missing: ${missing.slice(0, 10).join(", ")}`] : []),
          ...(notPassed.length > 0 ? [`not passed: ${notPassed.slice(0, 10).join(", ")}`] : []),
        ].join(" — ")
      )
    )
  }

  const seen = new Map<string, number>()
  const uniqueId = (base: string): string => {
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  }
  const failing = parsed.cases.filter((c) => c.status === "failed" || c.status === "error")
  for (const testCase of failing.slice(0, MAX_FAILED_TEST_CHECKS)) {
    const note = testCase.message ? testCase.message.slice(0, CHECK_MESSAGE_CHARS) : "(no message)"
    checks.push(
      runtimeCheck(uniqueId(`test:${testCase.id}`), "test", "failed", `${testCase.status}: ${note}`)
    )
  }
  if (failing.length > MAX_FAILED_TEST_CHECKS) {
    checks.push(
      runtimeCheck(
        "tests_failing_unlisted",
        "tests",
        "failed",
        `unlisted=${failing.length - MAX_FAILED_TEST_CHECKS}`
      )
    )
  }
  parsed.suiteErrors.slice(0, MAX_FAILED_TEST_CHECKS).forEach((error, index) => {
    checks.push(
      runtimeCheck(
        `suite_error:${index + 1}`,
        "test",
        "failed",
        error.slice(0, CHECK_MESSAGE_CHARS)
      )
    )
  })
  return checks
}

/** The verification report of one sandboxed acceptance run. */
export function buildCodeAcceptanceReport(execution: AcceptanceExecution): VerificationReport {
  const refs = execution.artifactRefs ?? []
  const checks: VerificationCheck[] = [
    runtimeCheck("sandbox", "sandbox", "passed", `tier=${execution.tier}`),
  ]

  if (execution.timedOut) {
    checks.push(runtimeCheck("command_exit", "command", "inconclusive", "exit=timeout"))
  } else if (execution.exitCode === null) {
    checks.push(runtimeCheck("command_exit", "command", "inconclusive", "exit=none"))
  } else {
    checks.push(
      runtimeCheck(
        "command_exit",
        "command",
        execution.exitCode === 0 ? "passed" : "failed",
        `exit=${execution.exitCode}`
      )
    )
  }

  const { report } = execution
  if (report.content === null) {
    checks.push(runtimeCheck("report", "report", "inconclusive", "report=missing"))
  } else if (report.truncated) {
    checks.push(runtimeCheck("report", "report", "inconclusive", "report=truncated", refs))
  } else {
    const parsed = parseAcceptanceReport(report.format, report.content, execution.parseOptions)
    if (!parsed.ok) {
      checks.push(
        runtimeCheck(
          "report",
          "report",
          "inconclusive",
          `report=${parsed.code} — ${parsed.message}`,
          refs
        )
      )
    } else {
      checks.push(runtimeCheck("report", "report", "passed", `report=${parsed.report.kind}`, refs))
      checks.push(...reportChecks(parsed.report, execution.requiredTests))
    }
  }

  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    report_id: execution.reportId,
    status: aggregate(checks),
    level: "tool_verified",
    checks,
    revision: execution.revision,
    verifier_version: CODE_ACCEPTANCE_VERIFIER_VERSION,
    artifact_refs: [...refs],
  }
}

export interface CodeAcceptanceFacts {
  tier: SandboxTier | null
  exit: string | null
  report: string | null
  discovered: number | null
  passed: number | null
  failed: number | null
  errored: number | null
  skipped: number | null
  revision: string | null
}

function keyValues(summary: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of summary.matchAll(/([a-z_]+)=([^\s—]+)/g)) {
    if (!out.has(match[1])) out.set(match[1], match[2])
  }
  return out
}

function countOf(values: Map<string, string>, key: string): number | null {
  const raw = values.get(key)
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  return Number.parseInt(raw, 10)
}

/**
 * The facts a checks table shows — tier, exit, discovered/failed/skipped and
 * the revision — read back from a report this module built. A report from any
 * other verifier yields nulls, never guesses.
 */
export function codeAcceptanceFacts(report: VerificationReport): CodeAcceptanceFacts {
  const byId = new Map(report.checks.map((check) => [check.check_id, check]))
  const own = (id: string) => {
    const check = byId.get(id)
    return check && check.executed_by === "runtime"
      ? keyValues(check.summary)
      : new Map<string, string>()
  }
  const sandbox = own("sandbox")
  const tier = sandbox.get("tier")
  const tests = own("tests_discovered")
  return {
    tier: isSandboxTier(tier) ? tier : null,
    exit: own("command_exit").get("exit") ?? null,
    report: own("report").get("report") ?? null,
    discovered: countOf(tests, "discovered"),
    passed: countOf(tests, "passed"),
    failed: countOf(tests, "failed"),
    errored: countOf(tests, "errored"),
    skipped: countOf(tests, "skipped"),
    revision: report.revision,
  }
}

export type RuntimeReportRejection =
  /** No runtime report exists for the revision: a claim is all there is (DEL-01). */
  | "NO_RUNTIME_REPORT"
  /** The object is not a contract `VerificationReport`. */
  | "REPORT_INVALID"
  /** The report is about another revision (DEL-03). */
  | "REVISION_MISMATCH"
  /** It is not a runtime report at level `tool_verified`, or a model executed a check (DEL-01). */
  | "NOT_TOOL_VERIFIED"
  /** It does not say which sandbox tier ran it. */
  | "SANDBOX_TIER_MISSING"

export type AcceptanceVerdict =
  | { status: "passed"; report: VerificationReport; tier: SandboxTier }
  | { status: "failed"; report: VerificationReport; tier: SandboxTier; reason: "ACCEPTANCE_FAILED" }
  | {
      status: "inconclusive"
      report: VerificationReport | null
      tier: SandboxTier | null
      reason: RuntimeReportRejection | "ACCEPTANCE_INCONCLUSIVE"
    }

/** Whether a report may be believed for `expectedRevision`, and what it then says. */
export function judgeRuntimeAcceptance(
  report: unknown,
  expectedRevision: string
): AcceptanceVerdict {
  if (report === null || report === undefined) {
    return { status: "inconclusive", report: null, tier: null, reason: "NO_RUNTIME_REPORT" }
  }
  const parsed = VerificationReportSchema.safeParse(report)
  if (!parsed.success) {
    return { status: "inconclusive", report: null, tier: null, reason: "REPORT_INVALID" }
  }
  const value = parsed.data
  const tier = codeAcceptanceFacts(value).tier
  if (value.revision === null || value.revision !== expectedRevision) {
    return { status: "inconclusive", report: value, tier, reason: "REVISION_MISMATCH" }
  }
  if (
    value.level !== "tool_verified" ||
    value.checks.length === 0 ||
    value.checks.some((check) => check.executed_by !== "runtime")
  ) {
    return { status: "inconclusive", report: value, tier, reason: "NOT_TOOL_VERIFIED" }
  }
  if (!tier)
    return { status: "inconclusive", report: value, tier: null, reason: "SANDBOX_TIER_MISSING" }
  if (value.status === "passed") return { status: "passed", report: value, tier }
  if (value.status === "failed") {
    return { status: "failed", report: value, tier, reason: "ACCEPTANCE_FAILED" }
  }
  return { status: "inconclusive", report: value, tier, reason: "ACCEPTANCE_INCONCLUSIVE" }
}
