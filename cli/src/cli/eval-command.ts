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
  if (!args.subcommand || !target) {
    out.error(HELP)
    return 1
  }
  try {
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
