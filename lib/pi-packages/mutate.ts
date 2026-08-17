/**
 * Installing, removing and pinning Pi packages.
 *
 * Pi owns a complete package CLI — `pi install <source> [-l]`,
 * `pi remove`/`pi uninstall`, `pi list`, `pi update --extension <source>` —
 * so the preferred path is to let Pi mutate its own file. Cognia only edits
 * `settings.json` directly when Pi is not reachable (Windows, or a machine
 * being configured for another one), which is the case the desktop-three-
 * platform decision requires.
 *
 * The command/fallback choice is a **pure function** (`planPiMutation`),
 * deliberately split from execution, so the rule lives in one testable place
 * instead of being re-derived inside a Tauri command and a Node backend where
 * the two could drift. That split is the pattern `dsh-runtime-install.ts`
 * already establishes in this repo.
 *
 * `pi install` also performs the npm download, so the fallback is genuinely
 * weaker, not merely different: it records intent and Pi resolves the package
 * on its next launch. The plan says so explicitly rather than pretending the
 * two paths are equivalent.
 */

import { piPackageIdentity } from "./identity"
import { piPackageSourceString, type PiPackageScope, type PiPackageSource } from "./types"

export type PiMutationKind = "install" | "remove" | "update"

/** How a mutation will be carried out. */
export type PiMutationStrategy =
  /** Shell out to Pi's own CLI — installs/downloads as well as recording. */
  | "pi-cli"
  /** Edit `settings.json` directly; Pi resolves the package on next launch. */
  | "settings-edit"

export interface PiMutationRequest {
  kind: PiMutationKind
  /** Full spec, e.g. `npm:@aliou/pi-guardrails@0.17.0`. */
  spec: string
  scope: PiPackageScope
}

export interface PiMutationPlan {
  strategy: PiMutationStrategy
  /** The exact argv Pi would be invoked with, when strategy is `pi-cli`. */
  command?: string
  /**
   * Set when the chosen strategy is materially weaker than the alternative,
   * so the UI can say so before the user commits.
   */
  degradedReason?: "pi-unavailable"
}

export interface PiCliAvailability {
  /** `pi` resolves on PATH. */
  available: boolean
  /** Reported `pi --version`, when known. */
  version?: string
}

/**
 * Decide how to carry out a mutation. Pure.
 *
 * `-l`/`--local` is Pi's project-scope flag; omitting it targets user scope.
 * There is no `--global` flag — user scope is the default.
 */
export function planPiMutation(request: PiMutationRequest, cli: PiCliAvailability): PiMutationPlan {
  if (!cli.available) {
    return { strategy: "settings-edit", degradedReason: "pi-unavailable" }
  }

  const scopeFlag = request.scope === "project" ? " -l" : ""
  const spec = shellQuote(request.spec)

  switch (request.kind) {
    case "install":
      return { strategy: "pi-cli", command: `pi install ${spec}${scopeFlag}` }
    case "remove":
      return { strategy: "pi-cli", command: `pi remove ${spec}${scopeFlag}` }
    case "update":
      // `pi update --extensions` deliberately skips exact-pinned specs, so a
      // pinned package must be updated by name via --extension.
      return { strategy: "pi-cli", command: `pi update --extension ${spec}${scopeFlag}` }
  }
}

/**
 * Quote a spec for the shell. Pi specs are npm/git/path strings, but they can
 * contain `@`, `/` and (for local paths) spaces, and this string is handed to
 * a shell.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9@._:/-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Apply a mutation to a package array without touching disk. Pure, so the
 * fallback path's result can be asserted independently of any IO.
 *
 * Matching is by Pi's identity rule, so re-installing at a new pin replaces
 * the existing entry rather than adding a duplicate.
 */
export function applyPiMutationToList(
  packages: readonly PiPackageSource[],
  request: PiMutationRequest,
  baseDir?: string
): PiPackageSource[] {
  const targetIdentity = piPackageIdentity(request.spec, baseDir)
  const sameIdentity = (pkg: PiPackageSource) =>
    piPackageIdentity(piPackageSourceString(pkg), baseDir) === targetIdentity

  if (request.kind === "remove") return packages.filter((pkg) => !sameIdentity(pkg))

  const index = packages.findIndex(sameIdentity)
  if (index === -1) return [...packages, request.spec]

  // Replace in place so ordering — which Pi treats as meaningful for resource
  // collisions — is preserved across a version bump.
  const next = [...packages]
  const existing = next[index]
  next[index] = typeof existing === "string" ? request.spec : { ...existing, source: request.spec }
  return next
}

/**
 * Toggle a package between autoloaded and inert.
 *
 * Pi has no `enabled` field: "installed but inert" is `autoload: false`, which
 * is exactly what `pi config` writes. Using Pi's own representation keeps the
 * TUI and Cognia agreeing on one source of truth instead of Cognia keeping a
 * private list that `pi list` cannot see.
 */
export function setPiPackageAutoload(
  packages: readonly PiPackageSource[],
  spec: string,
  autoload: boolean,
  baseDir?: string
): PiPackageSource[] {
  const targetIdentity = piPackageIdentity(spec, baseDir)
  return packages.map((pkg) => {
    if (piPackageIdentity(piPackageSourceString(pkg), baseDir) !== targetIdentity) return pkg
    const entry = typeof pkg === "string" ? { source: pkg } : { ...pkg }
    if (autoload) {
      // Omit the field entirely rather than writing `autoload: true`; that is
      // Pi's default and a redundant key would show up as noise in a diff of
      // a version-controlled project settings file.
      delete entry.autoload
      return Object.keys(entry).length === 1 ? entry.source : entry
    }
    entry.autoload = false
    return entry
  })
}
