/**
 * `cognia-agent security <report|scan>` — the CI face of the security scanner.
 *
 * Both subcommands end in the same place: a normalized report is run through
 * the shared gate in `@cognia/security-findings`, so a pipeline and the
 * desktop panel cannot disagree about whether a scan passed.
 *
 *  - `report` evaluates an artifact that already exists. No Docker, no
 *    scanner, no network — it is the piece a pipeline runs on an artifact a
 *    previous step produced.
 *  - `scan` runs the `strix` CLI first, then evaluates its artifact.
 *
 * ## Exit codes
 *
 *  - `0` clean under the configured policy
 *  - `1` the question was not answered: no authorization, an incomplete
 *        environment, an unreadable artifact, or bad usage
 *  - `2` findings at or above `--fail-on`
 *
 * A pipeline that collapses every non-zero into "failed" loses the one
 * distinction that matters — `2` is fixed by changing code, `1` is not.
 *
 * ## Credentials
 *
 * The LLM key is read from the environment (`LLM_API_KEY` / `STRIX_LLM_API_KEY`)
 * and never accepted as a flag. Argv is world-readable through `ps` on most
 * systems and lands verbatim in shell history and CI logs; the desktop
 * plugin's `buildStrixEnv` established the same rule.
 */

import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  baselineFingerprintsFromSarif,
  evaluateGate,
  isSeverity,
  normalizeReport,
  toSarifLog,
  type GateResult,
  type ScanReport,
  type Severity,
} from "@cognia/security-findings"

import { type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface SecurityDeps {
  out?: OutputSink
  env?: Record<string, string | undefined>
  readFile?: (path: string) => Promise<string>
  writeFile?: (path: string, contents: string) => Promise<void>
  /** Runs the scanner. Returns its exit code and the artifact it wrote. */
  runScanner?: (input: ScannerInput) => Promise<ScannerOutcome>
}

export interface ScannerInput {
  target: string
  env: Record<string, string | undefined>
  out: OutputSink
}

export interface ScannerOutcome {
  exitCode: number
  /** Raw artifact text, or null when the scanner produced none (a clean scan). */
  artifact: string | null
  /** Set when the scanner could not be run at all. */
  error?: string
}

const USAGE = `cognia-agent security <report|scan>

  report --input <file>            evaluate an existing scanner artifact
  scan   --target <t> --authorized run strix against a target, then evaluate

Shared flags:
  --fail-on <severity>   exit 2 when a finding is at or above this severity
                         (critical|high|medium|low|info). Omitted = report only.
  --only-new             consider only findings absent from --baseline
  --baseline <file>      a SARIF log from a previous run
  --sarif <file>         write this run's SARIF 2.1.0 log here
  --target <t>           label the report (report mode; required for scan)
  --json                 emit one JSON result object instead of text

Credentials come from the environment (LLM_API_KEY), never from a flag.
`

function flagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function boolFlagValue(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true"
}

interface Policy {
  failOn?: Severity
  onlyNew: boolean
  baselinePath?: string
  sarifPath?: string
  json: boolean
}

function readPolicy(args: ParsedArgs, out: OutputSink): Policy | null {
  const failOnRaw = flagValue(args, "fail-on")
  if (failOnRaw !== undefined && !isSeverity(failOnRaw)) {
    out.error(`--fail-on must be one of critical|high|medium|low|info (got "${failOnRaw}")`)
    return null
  }
  return {
    ...(failOnRaw !== undefined && isSeverity(failOnRaw) ? { failOn: failOnRaw } : {}),
    onlyNew: boolFlagValue(args, "only-new"),
    ...(flagValue(args, "baseline") ? { baselinePath: flagValue(args, "baseline") } : {}),
    ...(flagValue(args, "sarif") ? { sarifPath: flagValue(args, "sarif") } : {}),
    json: boolFlagValue(args, "json"),
  }
}

/**
 * Load the baseline.
 *
 * A missing or unreadable baseline yields an EMPTY set rather than an error.
 * That over-reports — every finding looks new — which is the safe direction
 * for a gate; treating an unreadable baseline as "everything is known" would
 * turn a typo in a path into a silent pass.
 */
async function loadBaseline(
  path: string | undefined,
  read: (path: string) => Promise<string>,
  out: OutputSink
): Promise<ReadonlySet<string> | undefined> {
  if (!path) return undefined
  try {
    return baselineFingerprintsFromSarif(JSON.parse(await read(path)))
  } catch (error) {
    out.error(
      `baseline could not be read (${error instanceof Error ? error.message : String(error)}); ` +
        `treating every finding as new`
    )
    return new Set()
  }
}

function describe(report: ScanReport, result: GateResult, policy: Policy, out: OutputSink): void {
  if (policy.json) {
    out.json({
      target: report.target,
      completeness: report.completeness,
      ...(report.unreadableReason ? { unreadableReason: report.unreadableReason } : {}),
      exitCode: result.exitCode,
      verdict: result.verdict,
      counts: result.counts,
      blocking: result.blocking.map((finding) => ({
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        title: finding.title,
        severity: finding.severity,
      })),
      suppressed: result.suppressed.length,
      ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
    })
    return
  }

  if (result.verdict === "inconclusive") {
    out.error(
      `INCONCLUSIVE — ${report.unreadableReason ?? "the scan report could not be parsed"}.\n` +
        `This is NOT a clean result: the scan may have found vulnerabilities that could not be read.`
    )
    return
  }

  const counts = result.counts
  out.write(
    `${report.target || "(no target)"}: ` +
      `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ` +
      `${counts.low} low, ${counts.info} info\n`
  )
  if (result.suppressed.length > 0) {
    out.write(`${result.suppressed.length} finding(s) suppressed by policy\n`)
  }
  if (result.degradedReason === "only-new-without-baseline") {
    out.error("--only-new was given without --baseline; every finding is treated as new")
  }
  if (!policy.failOn) {
    // Said out loud rather than defaulted to a threshold: adopting this command
    // must not start failing builds on day one, but neither should a pipeline
    // believe it is gated when it is not.
    out.write("report only: no --fail-on given, so the exit code does not reflect findings\n")
    return
  }
  if (result.blocking.length === 0) {
    out.write(`clean at or above ${policy.failOn}\n`)
    return
  }
  out.error(`${result.blocking.length} finding(s) at or above ${policy.failOn}:`)
  for (const finding of result.blocking) {
    out.error(`  [${finding.severity}] ${finding.ruleId} — ${finding.title}`)
  }
}

async function evaluate(
  report: ScanReport,
  policy: Policy,
  deps: Required<Pick<SecurityDeps, "readFile" | "writeFile">>,
  out: OutputSink
): Promise<number> {
  const baseline = await loadBaseline(policy.baselinePath, deps.readFile, out)
  const result = evaluateGate(report, {
    ...(policy.failOn ? { failOn: policy.failOn } : {}),
    onlyNew: policy.onlyNew,
    ...(baseline ? { baseline } : {}),
  })

  if (policy.sarifPath) {
    // Written even for an inconclusive run: the log carries
    // `executionSuccessful: false`, which is how a consumer learns the run
    // cannot be read as a pass. Skipping the write would leave the previous
    // log in place and look like a successful scan.
    const log = toSarifLog(report, { ...(baseline ? { baseline } : {}) })
    await deps.writeFile(policy.sarifPath, `${JSON.stringify(log, null, 2)}\n`)
  }

  describe(report, result, policy, out)
  return result.exitCode
}

/**
 * Run Strix in a fresh directory and read the artifact it writes there.
 * Stdout is progress output, not the vulnerability report.
 */
export async function runStrixScanner(
  input: ScannerInput,
  spawnScanner: typeof spawn = spawn
): Promise<ScannerOutcome> {
  let scanDirectory: string | undefined
  try {
    scanDirectory = await mkdtemp(join(tmpdir(), "cognia-strix-"))
    const processOutcome = await new Promise<{ exitCode: number; error?: string }>((resolve) => {
      const child = spawnScanner("strix", ["-n", "--target", input.target], {
        cwd: scanDirectory,
        env: input.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let settled = false
      const finish = (outcome: { exitCode: number; error?: string }) => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      child.stdout.on("data", (chunk: Buffer) => input.out.write(chunk.toString()))
      child.stderr.on("data", (chunk: Buffer) => input.out.error(chunk.toString().trimEnd()))
      child.on("error", (error) =>
        finish({ exitCode: 1, error: `strix could not be started: ${error.message}` })
      )
      child.on("close", (code) => finish({ exitCode: code ?? 1 }))
    })

    if (processOutcome.error) {
      return { exitCode: processOutcome.exitCode, artifact: null, error: processOutcome.error }
    }
    if (processOutcome.exitCode === 1) {
      return {
        exitCode: 1,
        artifact: null,
        error: "strix exited with code 1 before producing a trustworthy report",
      }
    }

    const artifact = await readStrixVulnerabilityArtifact(scanDirectory)
    if (processOutcome.exitCode === 2 && artifact === null) {
      return {
        exitCode: 2,
        artifact: null,
        error: "strix reported vulnerabilities but produced no vulnerability artifact",
      }
    }
    if (processOutcome.exitCode !== 0 && processOutcome.exitCode !== 2) {
      return {
        exitCode: processOutcome.exitCode,
        artifact: null,
        error: `strix exited with unexpected code ${processOutcome.exitCode}`,
      }
    }
    return { exitCode: processOutcome.exitCode, artifact }
  } catch (error) {
    return {
      exitCode: 1,
      artifact: null,
      error: `strix scan artifact could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    if (scanDirectory)
      await rm(scanDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readStrixVulnerabilityArtifact(scanDirectory: string): Promise<string | null> {
  const runsDirectory = join(scanDirectory, "strix_runs")
  let entries
  try {
    entries = await readdir(runsDirectory, { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
  const runDirectories = entries.filter((entry) => entry.isDirectory())
  if (runDirectories.length === 0) return null
  if (runDirectories.length !== 1) {
    throw new Error(`expected one Strix run directory, found ${runDirectories.length}`)
  }
  try {
    return await readFile(
      join(runsDirectory, runDirectories[0].name, "vulnerabilities.json"),
      "utf8"
    )
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

export async function securityCommand(args: ParsedArgs, deps: SecurityDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"))
  const write =
    deps.writeFile ?? ((path: string, contents: string) => writeFile(path, contents, "utf8"))
  const io = { readFile: read, writeFile: write }

  const policy = readPolicy(args, out)
  if (!policy) return 1

  if (args.subcommand === "report") {
    const input = flagValue(args, "input")
    if (!input) {
      out.error(`security report requires --input <file>\n\n${USAGE}`)
      return 1
    }
    let raw: string
    try {
      raw = await read(input)
    } catch (error) {
      out.error(
        `could not read ${input}: ${error instanceof Error ? error.message : String(error)}`
      )
      return 1
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // Deliberately routed through `normalizeReport` as `unreadable` rather
      // than returning early: the SARIF log still gets written, marked failed,
      // so a consumer sees an explicit "this run cannot be trusted".
      return evaluate(
        normalizeReport({
          target: flagValue(args, "target") ?? input,
          report: null,
          readError: error instanceof Error ? error.message : String(error),
        }),
        policy,
        io,
        out
      )
    }
    return evaluate(
      normalizeReport({ target: flagValue(args, "target") ?? input, report: parsed }),
      policy,
      io,
      out
    )
  }

  if (args.subcommand === "scan") {
    const target = flagValue(args, "target")
    if (!target) {
      out.error(`security scan requires --target <target>\n\n${USAGE}`)
      return 1
    }
    // A pentest against a system you are not cleared to test may be a crime.
    // The desktop panel makes the operator tick a box; headless has to ask for
    // the same assertion explicitly, and there is no env var that grants it —
    // it must be a deliberate act at the call site.
    if (!boolFlagValue(args, "authorized")) {
      out.error(
        "security scan requires --authorized: it actively attacks the target.\n" +
          "Only scan systems you own or are explicitly authorized to test."
      )
      return 1
    }
    if (!env.LLM_API_KEY && !env.STRIX_LLM_API_KEY) {
      out.error(
        "no LLM credentials in the environment (set LLM_API_KEY or STRIX_LLM_API_KEY).\n" +
          "Keys are never accepted as flags — argv is visible to other processes."
      )
      return 1
    }

    const outcome = await (deps.runScanner ?? runStrixScanner)({ target, env, out })
    if (outcome.error) {
      out.error(outcome.error)
      return 1
    }
    if (outcome.exitCode === 1) {
      return evaluate(
        normalizeReport({
          target,
          report: null,
          readError: "strix exited with code 1 before producing a trustworthy report",
          tool: { name: "strix" },
        }),
        policy,
        io,
        out
      )
    }
    let parsed: unknown = null
    let readError: string | undefined
    if (outcome.artifact !== null) {
      try {
        parsed = JSON.parse(outcome.artifact)
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error)
      }
    }
    return evaluate(
      normalizeReport({
        target,
        report: parsed,
        ...(readError ? { readError } : {}),
        tool: { name: "strix" },
      }),
      policy,
      io,
      out
    )
  }

  out.error(USAGE)
  return 1
}
