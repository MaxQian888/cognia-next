/**
 * The default resolver behind `PiRpcClientAdapter`'s plugin-package seam
 * (ADR-0210): turns an agent's `metadata.piPackages` references into what a
 * hosted Pi session loads.
 *
 * Every reference must resolve. A package that is missing, belongs to a
 * disabled plugin, has no directory, declares no `hostedSession` or is not
 * prepared fails the WHOLE session start with a typed
 * {@link PiPackageResolutionError} — silently starting without a package the
 * user opted into would hand them an agent that behaves differently from the
 * one they configured, with nothing on screen to say why.
 *
 * ## The same package installed in Pi AND opted into a hosted session
 *
 * A user can `pi install` a plugin's package (it then sits in Pi's own
 * `settings.json`) and also opt a hosted agent into it. Whether Pi then loads
 * it twice depends on Pi's loading semantics, verified in Pi's resource loader
 * (`ResourceLoader.mergePaths`, `dist/core/resource-loader.js`):
 *
 *   - `-e` paths and settings-package extension paths are merged into one list
 *     DEDUPLICATED BY CANONICAL PATH, `-e` first. A hosted extension that is
 *     the very file the installed package declares therefore loads once.
 *   - There is no per-package, per-session exclusion: `--no-extensions` drops
 *     every settings package, and the only other lever is rewriting the user's
 *     own `settings.json`, which Cognia must not do behind their back.
 *
 * So the one case that genuinely double-loads is a hosted extension that lies
 * OUTSIDE the package directory (a Cognia-specific wrapper around the package,
 * e.g. `pi/cognia-workbench.ts` over `vendor/`) while Pi also autoloads the
 * installed package in this session: both would register the package's tools.
 * Skipping the wrapper would silently drop the hosted-session semantics the
 * user opted into (its env-driven governance), so that case is refused with
 * `double-load` and a message naming both fixes: switch the agent to the
 * `isolated` policy, or remove the package from that Pi scope. Every other
 * combination keeps the explicit `-e` and relies on Pi's canonical-path dedupe.
 *
 * Which scopes a session loads follows `extensionPolicyArgs`: `isolated`
 * (`--no-extensions`) loads none, `global` (`--no-approve`) loads the user
 * scope only (project resources stay untrusted), `trusted-project`
 * (`--approve`) loads both. When the agent pins its own `PI_CODING_AGENT_DIR`
 * the user scope Pi reads is not the one Cognia can see, so only the project
 * scope is checked.
 */

import type { PiHostedPackage, PiPackageResolverContext } from "@cognia/agent-pi/rpc-client"
import { piPackageIdentity } from "@/lib/pi-packages/identity"
import type { PiPackageScope, PiPackageSource } from "@/lib/pi-packages/types"
import { piPackageSourceString } from "@/lib/pi-packages/types"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import {
  PiPackageResolutionError,
  resolveContributedPiPackage,
  type PiPackageResolveDeps,
  type ResolvedContributedPiPackage,
} from "./resolve"

/** Pi's two settings scopes as the session's Pi would read them. */
export interface PiSettingsForSession {
  user: readonly PiPackageSource[]
  project: readonly PiPackageSource[]
  /** Base for user-scope relative specs (the Pi agent dir), when known. */
  userBaseDir: string | null
  /** The workspace whose `.pi/settings.json` was read, when any. */
  projectCwd: string | null
}

export interface HostedPiPackagesDeps {
  /** True when external-agent processes run on a different device than this one. */
  processesRunRemotely: () => boolean
  /** Read Pi's package lists. Throwing means "unknown": no double-load check. */
  readPiSettings: (cwd: string | null) => Promise<PiSettingsForSession>
  resolveDeps?: Partial<PiPackageResolveDeps>
}

function defaultProcessesRunRemotely(): boolean {
  // Mirrors agent-transport's routing: an active remote transport means the
  // Pi process is spawned on the paired host, not here.
  return Boolean(getActiveRemoteTransport())
}

async function defaultReadPiSettings(cwd: string | null): Promise<PiSettingsForSession> {
  // The readers `loadPiPackages` uses, without its `pi --version` probe: a
  // session start must not spawn an extra process just to read two files.
  const [{ readUserPiPackages, readProjectPiPackages }, { resolveVendorRoots }] = await Promise.all(
    [import("@/lib/pi-packages/settings-io"), import("@/lib/agent-roots")]
  )
  const [user, project, roots] = await Promise.all([
    readUserPiPackages(),
    cwd ? readProjectPiPackages(cwd) : Promise.resolve({ packages: [] as PiPackageSource[] }),
    resolveVendorRoots(),
  ])
  return {
    user: user.packages,
    project: project.packages,
    userBaseDir: roots.piAgentDir || null,
    projectCwd: cwd,
  }
}

/**
 * Does this settings entry make Pi load the package's extensions? A bare
 * string or an object without an `extensions` filter autoloads unless
 * `autoload: false`; an explicit `extensions` filter loads exactly what it
 * lists, so a non-empty one counts as loading.
 */
export function piSettingsEntryLoadsExtensions(pkg: PiPackageSource): boolean {
  if (typeof pkg === "string") return true
  if (Array.isArray(pkg.extensions)) return pkg.extensions.length > 0
  return pkg.autoload !== false
}

/** Scopes a session under `policy` loads settings packages from. */
export function piScopesLoadedByPolicy(
  policy: PiPackageResolverContext["extensionPolicy"],
  options: { userScopeVisible: boolean }
): PiPackageScope[] {
  const scopes: PiPackageScope[] =
    policy === "global" ? ["user"] : policy === "trusted-project" ? ["user", "project"] : []
  return options.userScopeVisible ? scopes : scopes.filter((scope) => scope !== "user")
}

/** The first loaded scope in which Pi itself would load `packageDir`, or null. */
export function piScopeLoadingPackage(
  packageDir: string,
  settings: PiSettingsForSession,
  scopes: readonly PiPackageScope[]
): PiPackageScope | null {
  const target = piPackageIdentity(packageDir)
  for (const scope of scopes) {
    const entries = scope === "user" ? settings.user : settings.project
    const baseDir =
      scope === "user"
        ? (settings.userBaseDir ?? undefined)
        : settings.projectCwd
          ? `${settings.projectCwd.replace(/[\\/]+$/, "")}/.pi`
          : undefined
    const hit = entries.some(
      (pkg) =>
        piPackageIdentity(piPackageSourceString(pkg), baseDir) === target &&
        piSettingsEntryLoadsExtensions(pkg)
    )
    if (hit) return scope
  }
  return null
}

function isInside(dir: string, path: string): boolean {
  const root = dir.replace(/[\\/]+$/, "")
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
}

function assertNoDoubleLoad(
  pkg: ResolvedContributedPiPackage,
  settings: PiSettingsForSession | null,
  scopes: readonly PiPackageScope[]
): void {
  if (!settings || scopes.length === 0) return
  const scope = piScopeLoadingPackage(pkg.packageDir, settings, scopes)
  if (!scope) return
  const outside = pkg.extensions.filter((entry) => !isInside(pkg.packageDir, entry))
  if (outside.length === 0) return // Pi's canonical-path dedupe loads each file once.
  throw new PiPackageResolutionError(
    "double-load",
    pkg.ref,
    `Pi package ${pkg.ref} is also installed in your Pi (${scope} scope), and this agent's ` +
      `extension policy loads that copy too, so its tools would register twice. Switch the ` +
      `agent's Pi extension policy to "isolated", or remove the package from Pi's ${scope} packages.`
  )
}

/** Resolve every reference for one hosted session, in order, deduplicated. */
export async function resolveHostedPiPackages(
  refs: readonly string[],
  context: PiPackageResolverContext,
  deps: Partial<HostedPiPackagesDeps> = {}
): Promise<PiHostedPackage[]> {
  const unique = [...new Set(refs)]
  if (unique.length === 0) return []
  const remote = (deps.processesRunRemotely ?? defaultProcessesRunRemotely)()
  if (remote) {
    // The package directories live on THIS device; a process on the paired
    // host could not read them, and a path from here means nothing there.
    throw new PiPackageResolutionError(
      "not-on-disk",
      unique[0],
      "Plugin Pi packages can only be loaded when the agent runs on this device, not on a paired host."
    )
  }

  const resolvedPackages: ResolvedContributedPiPackage[] = []
  for (const ref of unique) {
    resolvedPackages.push(
      await resolveContributedPiPackage(ref, {
        cwd: context.cwd ?? null,
        forSession: true,
        deps: deps.resolveDeps,
      })
    )
  }

  const scopes = piScopesLoadedByPolicy(context.extensionPolicy, {
    userScopeVisible: !context.piAgentDirOverride,
  })
  let settings: PiSettingsForSession | null = null
  if (scopes.length > 0) {
    try {
      settings = await (deps.readPiSettings ?? defaultReadPiSettings)(context.cwd ?? null)
    } catch {
      // Unreadable settings: no double-load check is possible. Keep the
      // explicit `-e`; Pi's own canonical-path dedupe still applies.
      settings = null
    }
  }

  return resolvedPackages.map((pkg) => {
    assertNoDoubleLoad(pkg, settings, scopes)
    return {
      ref: pkg.ref,
      extensions: pkg.extensions,
      env: pkg.env,
      tools: pkg.tools,
      readableRoots: [pkg.pluginRoot],
      controlsSession: pkg.controlsSession,
      ...(pkg.minPiVersion ? { minPiVersion: pkg.minPiVersion } : {}),
    }
  })
}
