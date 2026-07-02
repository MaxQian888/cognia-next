/**
 * Execution pipeline for declarative CLI tools (`manifest.cliTools`).
 *
 * Security gates, in order:
 *   ① `cli:execute` permission via the guard + consent broker (defense in
 *      depth — `invokePluginTool` gates the plugin's declared permission
 *      set too, but this executor must hold on every path it's reachable
 *      from)
 *   ② binary resolution + trust: `requires` binaries resolve through
 *      `detect_binary` to an absolute path with a minVersion gate;
 *      `plugin-dir` binaries pass the fingerprint trust policy (untrusted →
 *      one-time consent prompt)
 *   ③ injection-proof argv substitution (`buildArgv`) — params land as
 *      discrete argv elements, never through a shell
 *   ④ cwd policy resolution (workspace-bounded for `param` cwds)
 *   ⑤ static manifest env only — params can never set env vars
 *   ⑥ `plugin_cli_exec` (no shell, kill_on_drop, output caps)
 *   ⑦ exit-code policy + output parsing
 *   ⑧ an `automationAuditLog` row per invocation
 *
 * Deps are injectable (mirroring `invoke-plugin-tool.ts`) so tests run
 * without Tauri/Dexie.
 */

import type { PluginBinaryRequirement, PluginCliToolDef, PluginPermission } from "@/types/plugin"
import type { AutomationAuditLogRow } from "@/lib/db/schema"
import type { BinaryDetectionResult } from "@/lib/cli-bridge/detect-cli"
import type { CliBinaryEvaluation } from "./cli-binary-policy"
import { buildArgv, parseOutput, resolveCwd, CliTemplateError } from "./template"

const CLI_EXECUTE: PluginPermission = "cli:execute"

/** Wire shape of the `plugin_cli_exec` Tauri command result. */
interface CliExecWireResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
}

/** What a cliTool returns to the agent. */
export interface CliToolExecutionResult {
  output: string | string[] | unknown
  exitCode: number | null
  truncated: boolean
}

export class CliToolExecutionError extends Error {
  constructor(
    public readonly code:
      | "permission-denied"
      | "binary-missing"
      | "binary-untrusted"
      | "template"
      | "timeout"
      | "exit-code"
      | "execution-failed",
    message: string
  ) {
    super(message)
    this.name = "CliToolExecutionError"
  }
}

export interface ExecuteCliToolContext {
  /** Absolute plugin install directory. */
  pluginPath: string
  /** Manifest `requires.binaries` declarations. */
  requiresBinaries: PluginBinaryRequirement[]
  /** `manifest.author.publicKey` fingerprint, if any. */
  publisherFingerprint?: string
}

export interface CliToolDeps {
  checkPermission: (pluginId: string, reason: string) => Promise<boolean>
  requestBinaryConsent: (pluginId: string, reason: string) => Promise<boolean>
  detect: (name: string, versionArg?: string) => Promise<BinaryDetectionResult>
  satisfiesMin: (version: string | null, minVersion?: string) => boolean
  evaluatePluginDirBinary: (input: {
    pluginId: string
    binaryPath: string
    publisherFingerprint?: string
    pluginPath: string
  }) => Promise<CliBinaryEvaluation>
  invokeExec: (request: Record<string, unknown>) => Promise<CliExecWireResult>
  appendAudit: (row: AutomationAuditLogRow) => Promise<void>
  getWorkspaceRoot: () => string | undefined
  now: () => number
}

let depsOverride: CliToolDeps | null = null

/** Test-only deps injection (pass null to restore defaults). */
export function __setCliToolDepsForTesting(deps: CliToolDeps | null): void {
  depsOverride = deps
}

async function defaultDeps(): Promise<CliToolDeps> {
  const [
    { getPermissionGuard },
    { getPluginConsentBroker },
    { detectCli, satisfiesMinVersion },
    { evaluateCliBinary },
    { invoke },
    { getDb },
  ] = await Promise.all([
    import("@/lib/plugin/security/permission-guard"),
    import("@/lib/plugin/security/consent-broker"),
    import("@/lib/cli-bridge/detect-cli"),
    import("./cli-binary-policy"),
    import("@tauri-apps/api/core"),
    import("@/lib/db/schema"),
  ])
  return {
    checkPermission: (pluginId, reason) =>
      getPermissionGuard().checkWithConsent(pluginId, CLI_EXECUTE, getPluginConsentBroker(), {
        reason,
        context: "executeCliTool",
      }),
    requestBinaryConsent: (pluginId, reason) =>
      getPluginConsentBroker().request({ pluginId, permission: CLI_EXECUTE, reason }),
    detect: detectCli,
    satisfiesMin: satisfiesMinVersion,
    evaluatePluginDirBinary: evaluateCliBinary,
    invokeExec: (request) => invoke<CliExecWireResult>("plugin_cli_exec", { request }),
    appendAudit: async (row) => {
      await getDb().automationAuditLog.add(row)
    },
    getWorkspaceRoot: () => {
      try {
        // Lazy require keeps the store out of non-UI bundles; primaryRootOf
        // mirrors lib/claude/build-options.ts's cwd resolution.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { useProjectStore } = require("@/stores/project/project-store") as {
          useProjectStore: {
            getState: () => {
              activeProjectId: string | null
              projects: Array<{ id: string; roots?: unknown }>
            }
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { primaryRootOf } = require("@/lib/workspace/roots") as {
          primaryRootOf: (p: { roots?: unknown }) => { path?: string } | undefined
        }
        const state = useProjectStore.getState()
        const project = state.activeProjectId
          ? state.projects.find((p) => p.id === state.activeProjectId)
          : undefined
        return project ? primaryRootOf(project)?.path : undefined
      } catch {
        return undefined
      }
    },
    now: () => Date.now(),
  }
}

function joinPluginPath(pluginPath: string, relPath: string): string {
  const base = pluginPath.replace(/[\\/]+$/, "")
  return `${base}/${relPath.replace(/\\/g, "/").replace(/^\/+/, "")}`
}

/**
 * Resolve the program to execute. `requires` binaries prefer the
 * detect_binary absolute path (PATH-shadowing defense); `plugin-dir`
 * binaries pass the trust policy first.
 */
async function resolveBinary(
  deps: CliToolDeps,
  pluginId: string,
  def: PluginCliToolDef,
  ctx: ExecuteCliToolContext
): Promise<string> {
  const binary = def.binary
  if (binary.kind === "requires") {
    const requirement = ctx.requiresBinaries.find((b) => b.name === binary.name)
    const probe = await deps.detect(binary.name, def.versionArg)
    if (!probe.available) {
      const hint = requirement?.documentation ? ` Install help: ${requirement.documentation}` : ""
      throw new CliToolExecutionError(
        "binary-missing",
        `Required binary "${binary.name}" was not found on this machine.${hint}`
      )
    }
    if (!deps.satisfiesMin(probe.version, requirement?.minVersion)) {
      throw new CliToolExecutionError(
        "binary-missing",
        `Binary "${binary.name}" version ${probe.version ?? "unknown"} is below the required minimum ${requirement?.minVersion}.`
      )
    }
    return probe.path ?? binary.name
  }

  // plugin-dir
  const binaryPath = joinPluginPath(ctx.pluginPath, binary.relPath)
  const decision = await deps.evaluatePluginDirBinary({
    pluginId,
    binaryPath,
    publisherFingerprint: ctx.publisherFingerprint,
    pluginPath: ctx.pluginPath,
  })
  if (decision.allowed) {
    return binaryPath
  }
  if (decision.requiresPrompt) {
    const granted = await deps.requestBinaryConsent(
      pluginId,
      `Run plugin binary ${binary.relPath}: ${decision.reason}`
    )
    if (granted) {
      return binaryPath
    }
  }
  throw new CliToolExecutionError("binary-untrusted", decision.reason)
}

function makeAuditId(now: number): string {
  return `cli_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Execute one declarative CLI tool invocation. */
export async function executeCliTool(
  pluginId: string,
  def: PluginCliToolDef,
  args: Record<string, unknown>,
  ctx: ExecuteCliToolContext
): Promise<CliToolExecutionResult> {
  const deps = depsOverride ?? (await defaultDeps())

  // ① permission gate (silent tier passes through; confirm prompts; forbid denies)
  const allowed = await deps.checkPermission(pluginId, `Run CLI tool ${def.name}`)
  if (!allowed) {
    throw new CliToolExecutionError(
      "permission-denied",
      `cli:execute denied for plugin ${pluginId}`
    )
  }

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new CliToolExecutionError("template", "tool arguments must be an object")
  }

  // ② binary resolution + trust
  const program = await resolveBinary(deps, pluginId, def, ctx)

  // ③④⑤ template substitution + cwd + static env
  let argv: string[]
  let cwd: string | undefined
  try {
    argv = buildArgv(def.argv, args)
    cwd = resolveCwd(def.cwd, args, {
      pluginPath: ctx.pluginPath,
      workspaceRoot: deps.getWorkspaceRoot(),
    })
  } catch (error) {
    if (error instanceof CliTemplateError) {
      throw new CliToolExecutionError("template", error.message)
    }
    throw error
  }

  let stdinValue: string | undefined
  if (def.stdin) {
    const value = args[def.stdin.param]
    if (typeof value !== "string") {
      throw new CliToolExecutionError(
        "template",
        `stdin param "${def.stdin.param}" must be a string`
      )
    }
    stdinValue = value
  }

  // ⑥ spawn
  const started = deps.now()
  let wire: CliExecWireResult
  try {
    wire = await deps.invokeExec({
      pluginId,
      toolName: def.name,
      program,
      args: argv,
      cwd: cwd ?? null,
      env: def.env ?? {},
      stdin: stdinValue ?? null,
      timeoutMs: def.timeoutMs ?? null,
      maxOutputBytes: def.maxOutputBytes ?? null,
    })
  } catch (error) {
    await audit(deps, pluginId, program, argv, started, String(error))
    throw new CliToolExecutionError("execution-failed", String(error))
  }

  // ⑧ audit (best-effort)
  await audit(deps, pluginId, program, argv, started, null)

  // ⑦ exit-code policy + parsing
  if (wire.timedOut) {
    throw new CliToolExecutionError(
      "timeout",
      `CLI tool ${def.name} timed out: ${wire.stderr || "no output"}`
    )
  }
  const successCodes = def.successExitCodes ?? [0]
  if (wire.exitCode === null || !successCodes.includes(wire.exitCode)) {
    const stderrTail = wire.stderr.slice(-2000)
    throw new CliToolExecutionError(
      "exit-code",
      `CLI tool ${def.name} exited with code ${wire.exitCode}: ${stderrTail || "no stderr"}`
    )
  }

  return {
    output: parseOutput(wire.stdout, def.outputParse),
    exitCode: wire.exitCode,
    truncated: wire.truncated,
  }
}

async function audit(
  deps: CliToolDeps,
  pluginId: string,
  program: string,
  argv: string[],
  started: number,
  error: string | null
): Promise<void> {
  const now = deps.now()
  await deps
    .appendAudit({
      id: makeAuditId(now),
      ts: now,
      surface: "plugin",
      pluginId,
      command: [program, ...argv].join(" ").slice(0, 2000),
      processName: program.split(/[\\/]/).pop() ?? null,
      windowTitle: null,
      decision: "allow",
      reason: "cliTools invocation",
      durationMs: Math.max(0, now - started),
      error,
    })
    .catch(() => {
      // Audit is best-effort; never block the result.
    })
}
