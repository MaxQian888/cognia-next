/**
 * Pi package types — a field-for-field mirror of Pi 0.84.1's own
 * `PackageSource` (see `core/settings-manager.d.ts` inside
 * `@earendil-works/pi-coding-agent`).
 *
 * Two properties of that shape drive everything in this module:
 *
 *   - **An entry is either a bare string or an object**, and the object form
 *     carries resource filters rather than metadata. There is no `version`
 *     field (the version rides inside `source`) and no `enabled` field —
 *     disabling is expressed as `autoload: false` plus filter arrays, which is
 *     what Pi's own `pi config` TUI writes.
 *   - **`packages` lives in `settings.json` next to unrelated preferences**,
 *     so every reader here takes an explicit key allowlist rather than
 *     iterating whatever the file happens to contain.
 */

/** Which settings file an entry came from. */
export type PiPackageScope = "user" | "project"

/**
 * The object form of a package entry. Exactly the six fields Pi declares —
 * adding a seventh here without checking the upstream type would silently
 * invent behaviour.
 */
export interface PiPackageEntry {
  source: string
  /** `false` = start empty and apply only the explicit filters below. */
  autoload?: boolean
  extensions?: string[]
  skills?: string[]
  prompts?: string[]
  themes?: string[]
}

/** `"npm:pkg@1.0.0"` or `{ source: "npm:pkg@1.0.0", skills: [] }`. */
export type PiPackageSource = string | PiPackageEntry

/** A package entry tagged with the settings file it was read from. */
export interface ScopedPiPackage {
  pkg: PiPackageSource
  scope: PiPackageScope
}

/** How a package spec is distributed. */
export type PiSourceKind = "npm" | "git" | "local"

/** A parsed package spec. `raw` is always the original, unmodified string. */
export interface ParsedPiSource {
  raw: string
  kind: PiSourceKind
  /** npm package name, version stripped (`@scope/name` or `name`). */
  name?: string
  /** npm version / git ref, when the spec pinned one. */
  version?: string
  /** git host, lowercased (`github.com`). */
  host?: string
  /** git `owner/repo`, or the local path. */
  path?: string
}

/** Read the spec string out of either entry form. */
export function piPackageSourceString(pkg: PiPackageSource): string {
  return typeof pkg === "string" ? pkg : pkg.source
}

/** Normalize either entry form to the object form, without inventing fields. */
export function asPiPackageEntry(pkg: PiPackageSource): PiPackageEntry {
  return typeof pkg === "string" ? { source: pkg } : pkg
}

/**
 * Whether Pi will auto-load everything this package ships.
 *
 * `autoload: false` is Pi's "installed but inert" state: the package stays in
 * `packages[]` and its explicitly-listed resources still apply, but nothing is
 * picked up implicitly. This is what Cognia's disable toggle writes, so that
 * `pi config` and Cognia agree on a single source of truth.
 */
export function isPiPackageAutoloaded(pkg: PiPackageSource): boolean {
  return typeof pkg === "string" ? true : pkg.autoload !== false
}
