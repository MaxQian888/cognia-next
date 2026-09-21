import { readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type {
  EvalEnvironmentCompatibility,
  EvalPreflightResult,
  EvalProject,
} from "@cognia/eval-core"
import { serializePortableManifest } from "@cognia/eval-core"
import { checkCliEvalPreflight } from "../eval/preflight"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface CliEvalProjectDocument {
  schema?: "cognia-eval-project/v1"
  project: EvalProject
  cases?: unknown[]
}

export interface CliEvalExecutionResult {
  exitCode: 0 | 1 | 2 | 130
  checkpoint: unknown
}

export interface EvalCommandDeps {
  readJson(pathname: string): Promise<unknown>
  writeJson(pathname: string, value: unknown): Promise<void>
  executeProject(
    document: CliEvalProjectDocument,
    checkpointPath: string
  ): Promise<CliEvalExecutionResult>
  preflightProject(
    project: EvalProject,
    pathname: string
  ): Promise<{
    project: EvalProject
    environmentCompatibility: EvalEnvironmentCompatibility
    result: EvalPreflightResult
  }>
  /** Resolves on SIGINT; injected so `eval record` is testable without signals. */
  waitForInterrupt(): Promise<void>
  /** The CLI config a runtime replay drives a real agent session with. */
  resolveConfig(): Promise<import("../config/schema").ResolvedConfig>
  /** Capture seam for live recording; injected by tests to avoid opening a socket. */
  recordSession: typeof import("../eval/replay/fixture-maintenance").recordSession
  /** Wall clock; injected so a routing report is reproducible in tests. */
  now(): number
  /** Process environment the live confirmation rule reads. */
  env(): Readonly<Record<string, string | undefined>>
}

const HELP = `Usage:
  cognia eval preflight <project>
  cognia eval run <project> --checkpoint <path>
  cognia eval status <checkpoint>
  cognia eval report <checkpoint>
  cognia eval export <checkpoint> --password <password> [--output <prefix>]
  cognia eval import <bundle> --password <password> --output <path>
  cognia eval replay <fixture> [--runtime] [--allow-recorded] [--password <password>] [--platform <headless|tauri>]
  cognia eval record <fixture> --live --password <password> --output <path>
  cognia eval refresh <fixture> [--password <password>] [--output <path>]
  cognia eval routing --fake [--seed <n>] [--sessions <n>] [--output <path>]
  cognia eval routing --live --samples <file> [--settings <file>] [--seed <n>] [--output <path>]
`

const ROUTING_HELP = `Usage:
  cognia eval routing --fake [options]
  cognia eval routing --live --samples <file> [options]

Trains, calibrates and gates the learned router (ADR-0188 B6) and prints the
report as JSON.

  --fake                generate the sample set deterministically from a seed.
                        No model, no provider, no money; the report is labelled
                        "simulated" and claims nothing about quality or saving.
  --live                read samples that really happened from --samples. Under
                        the same confirmation rule as the live smoke: it needs
                        the user's settings export and the shared $5 ledger cap.
  --samples <file>      routing sample export (Evaluation → Routing → Export)
  --settings <file>     settings export; or set the live-smoke settings variable
  --seed <n>            seeds the calibration draw and the bootstrap (default 1)
  --sessions <n>        simulated conversations to generate (--fake only)
  --iterations <n>      bootstrap replicates
  --output <path>       also write the report JSON to this path
`

async function readJson(pathname: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(pathname), "utf8"))
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  const target = path.resolve(pathname)
  const temporary = `${target}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporary, target)
}

async function executeProject(
  document: CliEvalProjectDocument,
  checkpointPath: string
): Promise<CliEvalExecutionResult> {
  const { executeCliEvalProject } = await import("../eval/execute-project")
  return executeCliEvalProject(document, checkpointPath)
}

function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve())
  })
}

async function resolveConfig(): Promise<import("../config/schema").ResolvedConfig> {
  const { loadConfig } = await import("../config/load")
  return loadConfig()
}

async function recordSession(
  options: import("../eval/replay/fixture-maintenance").RecordSessionOptions
) {
  const maintenance = await import("../eval/replay/fixture-maintenance")
  return maintenance.recordSession(options)
}

const defaultDeps: EvalCommandDeps = {
  readJson,
  writeJson,
  executeProject,
  preflightProject: checkCliEvalPreflight,
  waitForInterrupt,
  resolveConfig,
  recordSession,
  now: Date.now,
  env: () => process.env,
}

/** A whole-number flag, refusing anything that is not one. */
function intFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(args, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new Error(`--${name} must be a whole number, got ${raw}`)
  return value
}

/**
 * `cognia eval routing` (ADR-0188 B6 WP-F2): train, calibrate and gate the
 * learned router over a sample set.
 *
 * The two modes are mutually exclusive on purpose, exactly like the live
 * smoke's: a report is either simulated or live, never a blend whose numbers
 * could be read as the other. `--live` answers to the same confirmation rule
 * as the smoke — the user's settings export plus the shared $5 ledger cap —
 * and additionally refuses a simulated sample file, because a live report may
 * not be built from generated rows (EVAL-04).
 *
 * Exit codes follow the rest of this command: 0 when the experiment ran, 2 for
 * a refusal the operator can fix, 1 for a usage or read error.
 */
async function runRoutingSubcommand(
  args: ParsedArgs,
  out: OutputSink,
  deps: EvalCommandDeps
): Promise<number> {
  if (boolFlag(args, "help") || boolFlag(args, "h")) {
    out.write(ROUTING_HELP)
    return 0
  }
  const fake = boolFlag(args, "fake")
  const live = boolFlag(args, "live")
  if (fake === live) {
    out.error(`eval routing needs exactly one of --fake or --live\n${ROUTING_HELP}`)
    return 1
  }
  const seed = intFlag(args, "seed") ?? 1
  const iterations = intFlag(args, "iterations")
  const sessions = intFlag(args, "sessions")
  const createdAt = new Date(deps.now()).toISOString()
  const experiment = await import("@/lib/ai/eval/routing-experiment")

  let result: Awaited<ReturnType<typeof experiment.runSimulatedRoutingExperiment>>
  let cap: { capUsd: string; settingsPath: string; samplesPath: string } | null = null

  if (fake) {
    result = await experiment.runSimulatedRoutingExperiment({
      seed,
      createdAt,
      ...(sessions === undefined ? {} : { sessionCount: sessions }),
      ...(iterations === undefined ? {} : { iterations }),
    })
  } else {
    const guard = await import("@/lib/router-fusion/eval/routing-live-guard")
    const decision = guard.checkRoutingLiveRun({
      env: deps.env(),
      settingsPath: stringFlag(args, "settings") ?? null,
      samplesPath: stringFlag(args, "samples") ?? args.positionals[0] ?? null,
    })
    if (!decision.ok) {
      out.error(`${decision.code}: ${decision.message}`)
      return 2
    }
    const rows = await experiment.parseRoutingSamples(await deps.readJson(decision.samplesPath), {
      now: deps.now(),
    })
    const { sampleSetLabel } = await import("@/lib/router-fusion/eval/routing-sample")
    const labelCheck = guard.checkRoutingLiveSamples(sampleSetLabel(rows))
    if (!labelCheck.ok) {
      out.error(`${labelCheck.code}: ${labelCheck.message}`)
      return 2
    }
    cap = {
      capUsd: decision.capUsd,
      settingsPath: decision.settingsPath,
      samplesPath: decision.samplesPath,
    }
    result = await experiment.runRecordedRoutingExperiment(rows, {
      seed,
      createdAt,
      ...(iterations === undefined ? {} : { iterations }),
    })
  }

  const payload = cap ? { ...result.report, live: cap } : result.report
  const output = stringFlag(args, "output")
  if (output) await deps.writeJson(output, payload)
  out.json(payload)
  return 0
}

function parseDocument(value: unknown): CliEvalProjectDocument {
  if (!value || typeof value !== "object" || !("project" in value)) {
    throw new Error("Evaluation project file must contain a project object")
  }
  return value as CliEvalProjectDocument
}

function checkpointExitCode(value: unknown): 0 | 1 | 2 | 130 {
  if (!value || typeof value !== "object") return 1
  const checkpoint = value as { status?: string; outcome?: string }
  if (checkpoint.status === "cancelled") return 130
  if (checkpoint.status === "failed" || checkpoint.status === "interrupted") return 1
  if (checkpoint.status === "completed") {
    return checkpoint.outcome === "no_conclusion" ? 2 : 0
  }
  return 2
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

async function exportCheckpoint(
  checkpointPath: string,
  prefix: string,
  checkpoint: unknown,
  deps: EvalCommandDeps,
  password: string
): Promise<string[]> {
  const jsonPath = `${prefix}.json`
  const csvPath = `${prefix}.csv`
  const htmlPath = `${prefix}.html`
  const bundlePath = `${prefix}.cognia-eval`
  await deps.writeJson(jsonPath, checkpoint)
  const rows =
    checkpoint &&
    typeof checkpoint === "object" &&
    Array.isArray((checkpoint as { samples?: unknown[] }).samples)
      ? ((checkpoint as { samples: Array<Record<string, unknown>> }).samples ?? [])
      : []
  const columns = ["variantId", "caseId", "repetition", "status", "quality", "cost", "latencyMs"]
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
  ].join("\n")
  await writeFile(path.resolve(csvPath), `${csv}\n`, "utf8")
  const report = htmlEscape(JSON.stringify(checkpoint, null, 2))
  await writeFile(
    path.resolve(htmlPath),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Cognia evaluation report</title><style>body{font:14px system-ui;max-width:1080px;margin:32px auto;padding:0 20px;color:#18181b}pre{white-space:pre-wrap;background:#f4f4f5;padding:20px;border-radius:12px}</style><h1>Cognia evaluation report</h1><pre>${report}</pre></html>`,
    "utf8"
  )
  const typed = checkpoint as {
    projectId?: string
    status?: string
    recommendation?: unknown
    portableProject?: {
      name: string
      mode: "model" | "agent"
      datasetDigest: string
      variants: Array<{ id: string; name: string; providerId?: string; modelId?: string }>
      appVersion: string
      randomSeed: number
    }
  }
  if (!typed.projectId || !typed.portableProject) {
    throw new Error(
      "Checkpoint predates portable replay metadata; run the project again before export"
    )
  }
  const { createEvalReplayBundle } = await import("@/lib/ai/eval/replay-bundle")
  const manifest = JSON.parse(
    serializePortableManifest({
      schema: "cognia-eval/v2",
      exportedAt: new Date().toISOString(),
      project: {
        id: typed.projectId,
        name: typed.portableProject.name,
        mode: typed.portableProject.mode,
        datasetDigest: typed.portableProject.datasetDigest,
      },
      experiment: {
        id: `cli:${typed.projectId}`,
        status: (typed.status ?? "failed") as "completed",
        randomSeed: typed.portableProject.randomSeed,
        appVersion: typed.portableProject.appVersion,
      },
      variants: typed.portableProject.variants,
      aggregates: typed.recommendation ? [{ recommendation: typed.recommendation }] : [],
    })
  )
  const bundle = await createEvalReplayBundle(
    manifest,
    [{ id: "checkpoint", kind: "sample", payload: checkpoint }],
    password
  )
  await deps.writeJson(bundlePath, bundle)
  return [jsonPath, csvPath, htmlPath, bundlePath]
}

export async function evalCommand(
  args: ParsedArgs,
  options: { out?: OutputSink } = {},
  overrides: Partial<EvalCommandDeps> = {}
): Promise<number> {
  const out = options.out ?? realOutput
  const deps = { ...defaultDeps, ...overrides }
  const target = args.positionals[0]
  // `routing` takes its inputs from flags, so it is the one subcommand with no
  // required positional.
  if (!args.subcommand || (!target && args.subcommand !== "routing")) {
    out.error(HELP)
    return 1
  }
  try {
    if (args.subcommand === "routing") {
      return await runRoutingSubcommand(args, out, deps)
    }
    if (args.subcommand === "preflight") {
      const document = parseDocument(await deps.readJson(target))
      const verified = await deps.preflightProject(document.project, target)
      out.json({
        ...verified.result,
        environmentCompatibility: verified.environmentCompatibility,
      })
      return verified.result.ok ? 0 : 2
    }
    if (args.subcommand === "run") {
      const checkpointPath = stringFlag(args, "checkpoint")
      if (!checkpointPath) throw new Error("eval run requires --checkpoint <path>")
      const document = parseDocument(await deps.readJson(target))
      const verified = await deps.preflightProject(document.project, target)
      if (!verified.result.ok) {
        out.json({
          ...verified.result,
          environmentCompatibility: verified.environmentCompatibility,
        })
        return 2
      }
      const result = await deps.executeProject(
        { ...document, project: verified.project },
        checkpointPath
      )
      await deps.writeJson(checkpointPath, result.checkpoint)
      return result.exitCode
    }
    if (args.subcommand === "replay") {
      const { runReplay, canonicalDriver } = await import("../eval/replay/run-replay")
      const { isEncryptedReplayFixtureBundle, openEncryptedReplayFixture } =
        await import("../eval/replay/fixture-maintenance")
      const platform = stringFlag(args, "platform") === "tauri" ? "tauri" : "headless"
      // Canonical replay drives nothing; runtime replay runs the real agent
      // session against the tape server. The flag is explicit rather than
      // inferred from the scenario level so spawning a sidecar is always a
      // choice the operator made.
      const driver = boolFlag(args, "runtime")
        ? (await import("../eval/replay/runtime-driver")).createRuntimeDriver({
            config: await deps.resolveConfig(),
          })
        : canonicalDriver
      const document = await deps.readJson(target)
      const replayInput = isEncryptedReplayFixtureBundle(document)
        ? await openEncryptedReplayFixture(
            document,
            stringFlag(args, "password") ??
              (() => {
                throw new Error("eval replay requires --password for an encrypted recording")
              })()
          )
        : document
      const result = await runReplay({
        raw: replayInput,
        // A fixture read off disk is repository content unless the operator
        // says otherwise, and repository content must be synthetic.
        requireSynthetic: !boolFlag(args, "allow-recorded"),
        platform,
        driver,
      })
      out.write(`${result.summary}\n`)
      return result.ok ? 0 : 1
    }
    if (args.subcommand === "record") {
      // Recording is the one path that reaches a real provider and spends real
      // money, so it cannot be reached by a typo: `--live` is mandatory and has
      // no default.
      if (!boolFlag(args, "live")) {
        throw new Error("eval record talks to a real provider and requires an explicit --live flag")
      }
      const output = stringFlag(args, "output")
      if (!output) throw new Error("eval record requires --output <path>")
      const password = stringFlag(args, "password")
      if (!password) throw new Error("eval record requires --password <password>")

      const { sealReplayFixture } = await import("../eval/replay/fixture-maintenance")
      const document = (await deps.readJson(target)) as { scenario?: unknown }
      const scenario = (document.scenario ??
        document) as import("@cognia/agent-config-types/model-request-surface").ReplayScenarioV1

      const recorded = await deps.recordSession({
        scenario,
        upstream: stringFlag(args, "upstream"),
        waitForCompletion: async (proxy) => {
          out.write(
            `recording on ${proxy.baseUrl}\n` +
              `  point the agent at it, e.g. ANTHROPIC_BASE_URL=${proxy.baseUrlFor("root")}\n` +
              `  press Ctrl-C when the session is done\n`
          )
          await deps.waitForInterrupt()
        },
      })

      const encrypted = await sealReplayFixture(
        {
          scenario: recorded.scenario,
          tapes: recorded.tapes,
          assets: recorded.assets,
        },
        password
      )
      await deps.writeJson(output, encrypted)
      out.json({
        recorded: output,
        tapes: recorded.tapes.length,
        actors: recorded.actors,
        synthetic: false,
        encrypted: true,
        note: "real recording encrypted; keep its password outside the repository",
      })
      return 0
    }
    if (args.subcommand === "refresh") {
      const {
        isEncryptedReplayFixtureBundle,
        openEncryptedReplayFixture,
        refreshFixture,
        sealReplayFixture,
      } = await import("../eval/replay/fixture-maintenance")
      const document = await deps.readJson(target)
      const encrypted = isEncryptedReplayFixtureBundle(document)
      const password = stringFlag(args, "password")
      if (encrypted && !password) {
        throw new Error("eval refresh requires --password for an encrypted recording")
      }
      const fixture = encrypted
        ? await openEncryptedReplayFixture(document, password as string)
        : document
      const result = refreshFixture(fixture)
      const output = stringFlag(args, "output") ?? target
      await deps.writeJson(
        output,
        encrypted ? await sealReplayFixture(result.fixture, password as string) : result.fixture
      )
      out.json({
        refreshed: output,
        changes: result.changes,
        warnings: result.warnings,
      })
      // Warnings are things refresh is not allowed to fix by itself, so they
      // must not read as success.
      return result.warnings.length > 0 ? 2 : 0
    }
    if (args.subcommand === "import") {
      const password = stringFlag(args, "password")
      const output = stringFlag(args, "output")
      if (!password) throw new Error("eval import requires --password <password>")
      if (!output) throw new Error("eval import requires --output <path>")
      const { openEvalReplayBundle } = await import("@/lib/ai/eval/replay-bundle")
      const payload = await openEvalReplayBundle(
        (await deps.readJson(target)) as import("@/lib/ai/eval/replay-bundle").EvalReplayBundle,
        password
      )
      await deps.writeJson(output, payload)
      out.json({ imported: output })
      return 0
    }
    const checkpoint = await deps.readJson(target)
    if (args.subcommand === "status") {
      out.json(checkpoint)
      return checkpointExitCode(checkpoint)
    }
    if (args.subcommand === "report") {
      out.write(`${JSON.stringify(checkpoint, null, 2)}\n`)
      return checkpointExitCode(checkpoint)
    }
    if (args.subcommand === "export") {
      const prefix = stringFlag(args, "output") ?? target.replace(/\.[^.]+$/, "")
      const password = stringFlag(args, "password")
      if (!password) throw new Error("eval export requires --password <password>")
      const paths = await exportCheckpoint(target, prefix, checkpoint, deps, password)
      out.json({ exported: paths })
      return checkpointExitCode(checkpoint)
    }
    out.error(`Unknown eval subcommand "${args.subcommand}"\n${HELP}`)
    return 1
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
