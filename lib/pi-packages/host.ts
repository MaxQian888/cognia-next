/**
 * The IO edge of the Pi package system.
 *
 * Everything else in `lib/pi-packages/` is pure. This module is the one place
 * that touches a shell or a file, and it exists so the rules never have to:
 * `planPiMutation` decides *what* to run, this decides *how* to run it, and the
 * two are tested separately.
 *
 * The CLI is preferred over editing `settings.json` for a reason that is easy
 * to miss: `pi install` also downloads the package. Editing the array only
 * records intent, and Pi resolves it on next launch. That makes the fallback
 * genuinely weaker rather than merely different, so it is reported as degraded
 * instead of being presented as an equivalent path.
 */

import { loggers } from "@cognia/logging"

import { executeShell, type ShellResult } from "@/lib/shell/exec"
import { isTauri } from "@/lib/tauri"
import { piPackageIdentity } from "./identity"
import {
  applyPiMutationToList,
  planPiMutation,
  setPiPackageAutoload,
  type PiCliAvailability,
  type PiMutationPlan,
  type PiMutationRequest,
} from "./mutate"
import {
  readProjectPiPackages,
  readUserPiPackages,
  writeProjectPiPackages,
  writeUserPiPackages,
  type PiPackagesRead,
} from "./settings-io"
import { piPackageSourceString, type PiPackageScope, type PiPackageSource } from "./types"

const log = loggers.ui

/** Pi's own CLI is quick, but an npm install behind it is not. */
const CLI_TIMEOUT_SECS = 180
const VERSION_TIMEOUT_SECS = 15

export interface PiHostDeps {
  exec: (cmd: string, cwd: string, timeoutSecs?: number) => Promise<ShellResult>
  readUser: () => Promise<PiPackagesRead>
  readProject: (cwd: string) => Promise<PiPackagesRead>
  writeUser: (packages: readonly PiPackageSource[]) => Promise<{ path: string }>
  writeProject: (cwd: string, packages: readonly PiPackageSource[]) => Promise<{ path: string }>
  /** Resolved `$PI_CODING_AGENT_DIR` / `~/.pi/agent`, or null when unknown. */
  piAgentDir: () => Promise<string | null>
  isDesktop: () => boolean
}

function defaultDeps(): PiHostDeps {
  return {
    exec: executeShell,
    readUser: () => readUserPiPackages(),
    readProject: (cwd) => readProjectPiPackages(cwd),
    writeUser: (packages) => writeUserPiPackages(packages),
    writeProject: (cwd, packages) => writeProjectPiPackages(cwd, packages),
    piAgentDir: async () => {
      const { resolveVendorRoots } = await import("@/lib/agent-roots")
      return (await resolveVendorRoots()).piAgentDir || null
    },
    isDesktop: isTauri,
  }
}

/**
 * Is `pi` reachable, and at what version?
 *
 * A non-zero exit is treated as "not available" rather than an error: the only
 * consequence is that mutations take the settings-edit path, which works
 * without Pi. Throwing here would break the whole pane over a missing binary
 * that the pane is specifically designed to cope with.
 */
export async function detectPiCli(deps?: Partial<PiHostDeps>): Promise<PiCliAvailability> {
  const resolved = { ...defaultDeps(), ...deps }
  if (!resolved.isDesktop()) return { available: false }
  try {
    const result = await resolved.exec("pi --version", ".", VERSION_TIMEOUT_SECS)
    if (result.exitCode !== 0) return { available: false }
    // Pi prints a bare semver; tolerate a `pi 0.84.1` prefix either way.
    const version = /\d+\.\d+\.\d+[\w.-]*/.exec(result.stdout)?.[0]
    return { available: true, version }
  } catch (error) {
    log.debug("pi cli probe failed", { error: String(error) })
    return { available: false }
  }
}

/** Both scopes, read separately. Never a merged view — see `resolve.ts`. */
export interface PiPackagesSnapshot {
  user: PiPackagesRead
  project: PiPackagesRead
  cli: PiCliAvailability
  /** Absolute path the project scope was read from, when a workspace is open. */
  projectCwd: string | null
  /**
   * Pi's agent dir, which is the base a *user-scope* relative local spec
   * resolves against. Needed for identity: `./ext` in the user file and `./ext`
   * in a project file are two different packages, and collapsing them would
   * make one disappear from the list.
   */
  userBaseDir: string | null
}

export async function loadPiPackages(
  cwd: string | null,
  deps?: Partial<PiHostDeps>
): Promise<PiPackagesSnapshot> {
  const resolved = { ...defaultDeps(), ...deps }
  const [user, project, cli, userBaseDir] = await Promise.all([
    resolved.readUser(),
    cwd
      ? resolved.readProject(cwd)
      : Promise.resolve({ packages: [], unparseable: false, missing: true, warnings: [] }),
    detectPiCli(resolved),
    resolved.piAgentDir(),
  ])
  return { user, project, cli, projectCwd: cwd, userBaseDir }
}

export interface PiMutationOutcome {
  ok: boolean
  plan: PiMutationPlan
  /** Combined stdout+stderr when the CLI ran, for the details disclosure. */
  output?: string
  error?: string
}

/**
 * Carry out one mutation.
 *
 * Refuses up front when the target file exists but does not parse. That check
 * is skipped for the CLI path only because Pi does its own parse and would
 * refuse too — but we still read first, because a corrupted file means the
 * fallback cannot be used if the CLI then fails.
 */
export async function runPiMutation(
  request: PiMutationRequest,
  context: { cwd: string | null; cli: PiCliAvailability },
  deps?: Partial<PiHostDeps>
): Promise<PiMutationOutcome> {
  const resolved = { ...defaultDeps(), ...deps }
  const plan = planPiMutation(request, context.cli)

  if (request.scope === "project" && !context.cwd) {
    return {
      ok: false,
      plan,
      error: "No workspace folder is open, so there is no project scope to write to.",
    }
  }

  if (plan.strategy === "pi-cli" && plan.command) {
    // Run in the project dir for `-l`, so Pi writes the right `.pi/`.
    const cwd = request.scope === "project" ? context.cwd! : "."
    try {
      const result = await resolved.exec(plan.command, cwd, CLI_TIMEOUT_SECS)
      const output = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n")
      if (result.timedOut) {
        return { ok: false, plan, output, error: `\`${plan.command}\` timed out.` }
      }
      if (result.exitCode !== 0) {
        return {
          ok: false,
          plan,
          output,
          error: `\`${plan.command}\` exited ${result.exitCode ?? "?"}.`,
        }
      }
      return { ok: true, plan, output }
    } catch (error) {
      return { ok: false, plan, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Settings-edit fallback: read, apply purely, write back.
  try {
    const current =
      request.scope === "project"
        ? await resolved.readProject(context.cwd!)
        : await resolved.readUser()
    if (current.unparseable) {
      return {
        ok: false,
        plan,
        error:
          "Pi's settings file exists but could not be parsed. Writing would discard every " +
          "preference in it — fix the file by hand, then retry.",
      }
    }
    const next = applyPiMutationToList(current.packages, request)
    if (request.scope === "project") await resolved.writeProject(context.cwd!, next)
    else await resolved.writeUser(next)
    return { ok: true, plan }
  } catch (error) {
    return { ok: false, plan, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Flip a package between autoloaded and inert.
 *
 * Always the settings-edit path: `pi config` is an interactive TUI, so there is
 * no non-interactive CLI equivalent to prefer. The write is still Pi's own
 * representation (`autoload: false`), so the TUI and Cognia stay in agreement.
 */
export async function setPiPackageEnabled(
  spec: string,
  scope: PiPackageScope,
  enabled: boolean,
  context: { cwd: string | null },
  deps?: Partial<PiHostDeps>
): Promise<{ ok: boolean; error?: string }> {
  const resolved = { ...defaultDeps(), ...deps }
  if (scope === "project" && !context.cwd) {
    return { ok: false, error: "No workspace folder is open." }
  }
  try {
    const current =
      scope === "project" ? await resolved.readProject(context.cwd!) : await resolved.readUser()
    if (current.unparseable) {
      return {
        ok: false,
        error: "Pi's settings file exists but could not be parsed — refusing to overwrite it.",
      }
    }
    const identity = piPackageIdentity(spec)
    const present = current.packages.some(
      (pkg) => piPackageIdentity(piPackageSourceString(pkg)) === identity
    )
    if (!present) return { ok: false, error: `${spec} is not declared in this scope.` }

    const next = setPiPackageAutoload(current.packages, spec, enabled)
    if (scope === "project") await resolved.writeProject(context.cwd!, next)
    else await resolved.writeUser(next)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
