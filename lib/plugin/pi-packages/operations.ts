/**
 * Desktop operations on contributed Pi packages (ADR-0210): prepare, install,
 * remove and install-state.
 *
 * Install and remove are NOT reimplemented here. They delegate to
 * `lib/pi-packages/host.ts` `runPiMutation` with the package's absolute
 * directory as the spec, so a plugin package takes exactly the path a catalog
 * package takes: `pi install <abs dir> [-l]` when Pi is reachable, otherwise
 * the settings-edit fallback, whose `degradedReason` is surfaced unchanged.
 *
 * `prepare` is the one new spawn, and it is deliberately narrow:
 *
 *   - the program is `npm` or `pnpm` (validated), resolved to an absolute path
 *     through `detect_binary` like `requires.binaries`, never through a shell;
 *   - the argv is the manifest's static list, never templated;
 *   - the caller MUST supply `confirm`, which receives the exact program, argv
 *     and working directory before anything runs — there is no code path that
 *     spawns without it;
 *   - it runs through `plugin_cli_exec` (no shell, kill-on-drop, the 600s
 *     native ceiling) and is written to the automation audit log;
 *   - it is desktop-only: the web and mobile builds have no process table.
 */

import type { AutomationAuditLogRow } from "@/lib/automation/audit"
import type { BinaryDetectionResult } from "@/lib/cli-bridge/detect-cli"
import { piPackageIdentity } from "@/lib/pi-packages/identity"
import {
  runPiMutation,
  type PiMutationOutcome,
  type PiPackagesSnapshot,
} from "@/lib/pi-packages/host"
import type { PiCliAvailability, PiMutationPlan } from "@/lib/pi-packages/mutate"
import { piPackageSourceString, type PiPackageScope } from "@/lib/pi-packages/types"
import { isTauri } from "@/lib/tauri"
import {
  clampPiPackagePrepareTimeout,
  type PluginPiPackageRef,
} from "@/types/plugin/plugin-pi-package"
import {
  isPiPackageReady,
  PiPackageResolutionError,
  resolveContributedPiPackage,
  type PiPackagePrepareState,
  type PiPackageResolveDeps,
  type ResolvedContributedPiPackage,
} from "./resolve"

/** Wire shape of the `plugin_cli_exec` Tauri command result. */
interface CliExecWireResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
}

/** Exactly what a prepare run will execute — what the consent prompt shows. */
export interface PiPackagePreparePlan {
  ref: PluginPiPackageRef
  pluginId: string
  packageId: string
  program: "npm" | "pnpm"
  args: string[]
  /** Absolute working directory: the package directory. */
  cwd: string
  timeoutMs: number
  /** Absolute marker path, when declared. */
  markerPath?: string
  /** `program arg …` with whitespace-bearing args JSON-quoted. */
  commandLine: string
}

export type PiPackageOperationErrorCode =
  | PiPackageResolutionError["code"]
  | "desktop-only"
  | "no-prepare"
  | "declined"
  | "binary-missing"
  | "timeout"
  | "exit-code"
  | "marker-missing"
  | "execution-failed"
  | "needs-prepare"
  | "symlinks-created"

export interface PiPackagePrepareOutcome {
  ok: boolean
  plan?: PiPackagePreparePlan
  code?: PiPackageOperationErrorCode
  /** Combined stdout + stderr, for the details disclosure. */
  output?: string
  /** The package manager's exit code, on `exit-code`. */
  exitCode?: number | null
  /** The first symbolic link the run left behind, on `symlinks-created`. */
  link?: string
  error?: string
}

export interface PiPackageMutationOutcome {
  ok: boolean
  code?: PiPackageOperationErrorCode
  /** The mutation plan, so the UI can show the command or the degraded notice. */
  plan?: PiMutationPlan
  /** Set when the settings-edit fallback was used because Pi is not reachable. */
  degradedReason?: PiMutationPlan["degradedReason"]
  /** Present on `needs-prepare`. */
  prepareState?: PiPackagePrepareState
  output?: string
  error?: string
}

export interface PiPackageOperationDeps {
  isDesktop: () => boolean
  detect: (name: string) => Promise<BinaryDetectionResult>
  invokeExec: (request: Record<string, unknown>) => Promise<CliExecWireResult>
  appendAudit: (row: AutomationAuditLogRow) => Promise<void>
  now: () => number
  runMutation: typeof runPiMutation
  /**
   * The first symbolic link under `dir` (relative), or `null` when there is
   * none. Throwing means "could not check" and is not treated as a failure.
   */
  findSymlink: (dir: string) => Promise<string | null>
  resolveDeps?: Partial<PiPackageResolveDeps>
}

function defaultDeps(): PiPackageOperationDeps {
  return {
    isDesktop: isTauri,
    detect: async (name) => {
      const { detectCli } = await import("@/lib/cli-bridge/detect-cli")
      return detectCli(name)
    },
    invokeExec: async (request) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<CliExecWireResult>("plugin_cli_exec", { request })
    },
    appendAudit: async (row) => {
      const { getDb } = await import("@/lib/db/schema")
      await getDb().automationAuditLog.add(row)
    },
    now: () => Date.now(),
    runMutation: runPiMutation,
    findSymlink: defaultFindSymlink,
  }
}

/**
 * POSIX `find` in the package directory (desktop only, like the marker
 * probe). Windows npm writes `.cmd` shims rather than links, so it is skipped
 * there.
 */
async function defaultFindSymlink(dir: string): Promise<string | null> {
  const [{ executeShell }, { detectOsFamily }] = await Promise.all([
    import("@/lib/shell/exec"),
    import("@/lib/platform/os"),
  ])
  if (detectOsFamily() === "windows") return null
  const result = await executeShell("find . -type l -print", dir, 60)
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`symlink probe exited ${result.exitCode ?? "?"}`)
  }
  const first = result.stdout.split("\n").find((line) => line.trim().length > 0)
  return first ? first.trim() : null
}

function withDeps(deps?: Partial<PiPackageOperationDeps>): PiPackageOperationDeps {
  return { ...defaultDeps(), ...deps }
}

function renderCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))].join(" ")
}

/** The prepare plan for a resolved package, or `null` when it declares none. Pure. */
export function planPiPackagePrepare(
  resolved: ResolvedContributedPiPackage
): PiPackagePreparePlan | null {
  const prepare = resolved.def.prepare
  if (!prepare) return null
  const args = [...prepare.args]
  // The plugin runtime refuses to load a plugin whose tree contains a
  // symbolic link (`validate_symlink_free_tree`), and npm links every
  // dependency's executables into `node_modules/.bin` by default — one
  // ordinary prepare run would leave the plugin unloadable. The host adds the
  // flag (it is part of the command the user approves); anything that still
  // creates a link is caught after the run (`symlinks-created`).
  if (prepare.program === "npm" && !args.includes("--no-bin-links")) {
    args.push("--no-bin-links")
  }
  return {
    ref: resolved.ref,
    pluginId: resolved.pluginId,
    packageId: resolved.def.id,
    program: prepare.program,
    args,
    cwd: resolved.packageDir,
    timeoutMs: clampPiPackagePrepareTimeout(prepare.timeoutMs),
    markerPath: resolved.markerPath,
    commandLine: renderCommandLine(prepare.program, args),
  }
}

function failure(error: unknown): { code: PiPackageOperationErrorCode; error: string } {
  if (error instanceof PiPackageResolutionError) return { code: error.code, error: error.message }
  return {
    code: "execution-failed",
    error: error instanceof Error ? error.message : String(error),
  }
}

function auditId(now: number): string {
  return `pipkg_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Run a package's dependency step after the user approved the exact command.
 *
 * `confirm` is required and receives the plan; returning `false` (or throwing)
 * spawns nothing.
 */
export async function preparePiPackage(
  ref: string,
  options: {
    confirm: (plan: PiPackagePreparePlan) => Promise<boolean>
    deps?: Partial<PiPackageOperationDeps>
  }
): Promise<PiPackagePrepareOutcome> {
  const deps = withDeps(options.deps)
  if (!deps.isDesktop()) {
    return {
      ok: false,
      code: "desktop-only",
      error: "Preparing a Pi package is only available in the desktop app.",
    }
  }

  let resolved: ResolvedContributedPiPackage
  try {
    resolved = await resolveContributedPiPackage(ref, { deps: deps.resolveDeps })
  } catch (error) {
    return { ok: false, ...failure(error) }
  }
  const plan = planPiPackagePrepare(resolved)
  if (!plan) {
    return { ok: false, code: "no-prepare", error: `Pi package ${ref} declares no prepare step.` }
  }

  let approved = false
  try {
    approved = await options.confirm(plan)
  } catch {
    approved = false
  }
  if (!approved) {
    return { ok: false, plan, code: "declined", error: "The prepare step was not approved." }
  }

  // Post-consent: resolve the program to an absolute path so PATH shadowing
  // in the spawn environment cannot substitute a different binary.
  const probe = await deps.detect(plan.program)
  if (!probe.available || !probe.path) {
    return {
      ok: false,
      plan,
      code: "binary-missing",
      error: `"${plan.program}" was not found on this machine. Install it, then retry.`,
    }
  }

  const started = deps.now()
  let wire: CliExecWireResult
  try {
    wire = await deps.invokeExec({
      pluginId: plan.pluginId,
      toolName: `pi-package-prepare:${plan.packageId}`,
      program: probe.path,
      args: plan.args,
      cwd: plan.cwd,
      env: {},
      stdin: null,
      timeoutMs: plan.timeoutMs,
      maxOutputBytes: null,
    })
  } catch (error) {
    await audit(deps, plan, probe.path, started, String(error))
    return { ok: false, plan, code: "execution-failed", error: String(error) }
  }
  await audit(deps, plan, probe.path, started, null)

  const output = [wire.stdout, wire.stderr].filter((part) => part.trim()).join("\n")
  if (wire.timedOut) {
    return {
      ok: false,
      plan,
      output,
      code: "timeout",
      error: `\`${plan.commandLine}\` timed out after ${Math.round(plan.timeoutMs / 1000)}s.`,
    }
  }
  if (wire.exitCode !== 0) {
    return {
      ok: false,
      plan,
      output,
      code: "exit-code",
      exitCode: wire.exitCode,
      error: `\`${plan.commandLine}\` exited ${wire.exitCode ?? "?"}.`,
    }
  }

  let link: string | null = null
  try {
    link = await deps.findSymlink(plan.cwd)
  } catch {
    link = null
  }
  if (link) {
    return {
      ok: false,
      plan,
      output,
      code: "symlinks-created",
      error: `\`${plan.commandLine}\` created a symbolic link (${link}); Cognia's plugin loader refuses plugin trees that contain links.`,
      link,
    }
  }

  if (resolved.def.prepare?.marker) {
    let state: PiPackagePrepareState
    try {
      const recheck = await resolveContributedPiPackage(ref, { deps: deps.resolveDeps })
      state = recheck.prepareState
    } catch (error) {
      return { ok: false, plan, output, ...failure(error) }
    }
    if (state !== "prepared") {
      return {
        ok: false,
        plan,
        output,
        code: "marker-missing",
        error: `\`${plan.commandLine}\` succeeded but did not create ${resolved.def.prepare.marker}.`,
      }
    }
  }
  return { ok: true, plan, output }
}

async function audit(
  deps: PiPackageOperationDeps,
  plan: PiPackagePreparePlan,
  program: string,
  started: number,
  error: string | null
): Promise<void> {
  const now = deps.now()
  await deps
    .appendAudit({
      id: auditId(now),
      ts: now,
      surface: "plugin",
      pluginId: plan.pluginId,
      command: [program, ...plan.args].join(" ").slice(0, 2000),
      processName: program.split(/[\\/]/).pop() ?? null,
      windowTitle: null,
      decision: "allow",
      reason: `pi-package prepare (${plan.ref})`,
      durationMs: Math.max(0, now - started),
      error,
    })
    .catch(() => {
      // Audit is best-effort; it must never turn a finished run into a failure.
    })
}

function fromMutation(outcome: PiMutationOutcome): PiPackageMutationOutcome {
  return {
    ok: outcome.ok,
    plan: outcome.plan,
    degradedReason: outcome.plan.degradedReason,
    output: outcome.output,
    error: outcome.error,
    ...(outcome.ok ? {} : { code: "execution-failed" as const }),
  }
}

/**
 * Install a contributed package into the user's Pi (`scope`), with the
 * package's absolute directory as the spec.
 *
 * Refuses with `needs-prepare` when a declared prepare marker is missing or
 * could not be checked, so the caller can offer the prepare step first: Pi
 * never installs dependencies for a local package, and a package installed
 * without them fails at load time inside Pi where Cognia cannot explain it.
 */
export async function installPiPackage(
  ref: string,
  scope: PiPackageScope,
  context: { cwd: string | null; cli: PiCliAvailability },
  deps?: Partial<PiPackageOperationDeps>
): Promise<PiPackageMutationOutcome> {
  const resolvedDeps = withDeps(deps)
  let resolved: ResolvedContributedPiPackage
  try {
    resolved = await resolveContributedPiPackage(ref, { deps: resolvedDeps.resolveDeps })
  } catch (error) {
    return { ok: false, ...failure(error) }
  }
  if (!isPiPackageReady(resolved.prepareState)) {
    return {
      ok: false,
      code: "needs-prepare",
      prepareState: resolved.prepareState,
      error: `Pi package ${ref} must be prepared before it is installed.`,
    }
  }
  try {
    return fromMutation(
      await resolvedDeps.runMutation({ kind: "install", spec: resolved.packageDir, scope }, context)
    )
  } catch (error) {
    return { ok: false, ...failure(error) }
  }
}

/** Remove a contributed package from the user's Pi (`scope`). */
export async function removePiPackage(
  ref: string,
  scope: PiPackageScope,
  context: { cwd: string | null; cli: PiCliAvailability },
  deps?: Partial<PiPackageOperationDeps>
): Promise<PiPackageMutationOutcome> {
  const resolvedDeps = withDeps(deps)
  let resolved: ResolvedContributedPiPackage
  try {
    resolved = await resolveContributedPiPackage(ref, { deps: resolvedDeps.resolveDeps })
  } catch (error) {
    return { ok: false, ...failure(error) }
  }
  try {
    return fromMutation(
      await resolvedDeps.runMutation({ kind: "remove", spec: resolved.packageDir, scope }, context)
    )
  } catch (error) {
    return { ok: false, ...failure(error) }
  }
}

/** Per-scope install state. `project` is `null` when no workspace is open. */
export interface PiPackageInstallState {
  user: boolean
  project: boolean | null
}

/**
 * Is `packageDir` declared in either scope of a snapshot? Pure.
 *
 * Matching is by Pi's own identity rule (`local:<resolved path>`), with each
 * scope's entries resolved against that scope's base directory, so an entry Pi
 * recorded relative to its settings file still matches the absolute directory.
 */
export function piPackageInstallStateFromSnapshot(
  packageDir: string,
  snapshot: PiPackagesSnapshot
): PiPackageInstallState {
  const target = piPackageIdentity(packageDir)
  const declaredIn = (packages: PiPackagesSnapshot["user"]["packages"], baseDir?: string) =>
    packages.some((pkg) => piPackageIdentity(piPackageSourceString(pkg), baseDir) === target)
  return {
    user: declaredIn(snapshot.user.packages, snapshot.userBaseDir ?? undefined),
    project: snapshot.projectCwd
      ? declaredIn(snapshot.project.packages, `${snapshot.projectCwd.replace(/[\\/]+$/, "")}/.pi`)
      : null,
  }
}
