/**
 * Reading and writing Pi's `packages` array.
 *
 * Three rules this module exists to enforce:
 *
 *   1. **Key allowlist.** `settings.json` is Pi's whole preference file. This
 *      module parses `packages` (and nothing else that reaches a caller), and
 *      the rest of the parsed object is dropped on the floor rather than
 *      returned, logged, or attached to telemetry. Pi keeps credentials in a
 *      separate mode-600 `auth.json`, so this is defence rather than
 *      necessity — but a custom-provider block could carry a key, and a reader
 *      that hands the whole object to its caller is one refactor away from
 *      leaking it into a support report.
 *   2. **Two scopes, read separately.** Never a merged view: Pi's generic
 *      settings merge treats arrays as replace, so a merged read would report
 *      the user's packages as gone whenever a repo declares one. See
 *      `resolve.ts`.
 *   3. **Never clobber an unparseable file.** If `settings.json` exists but
 *      does not parse, writing would serialize `{}` over every preference the
 *      user has. The write refuses instead. This mirrors the guard in
 *      `lib/claude/sync.ts`, which exists because of exactly that bug class.
 */

import type { AgentReadResult } from "@/lib/claude/ipc"
import type { PiPackageSource } from "./types"

/** The only key this module ever reads out of Pi's settings file. */
const PACKAGES_KEY = "packages"

/** Just enough of {@link AgentReadResult} to decide read/write safety. */
type PiConfigRead = Pick<AgentReadResult, "parsed" | "exists" | "parseError">

export interface PiSettingsIoDeps {
  readAgentConfig: (agent: "pi") => Promise<PiConfigRead>
  writeAgentConfig: (agent: "pi", value: unknown) => Promise<{ path: string; backupPath?: string }>
  readTextFile: (path: string) => Promise<string>
  writeTextFile: (path: string, contents: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

/**
 * "The file is there but we could not understand it" — the state in which a
 * write must refuse. `parseError` is the authoritative signal; a `null`
 * `parsed` on an existing file is treated the same way because serializing
 * over it would still discard whatever the file really held.
 */
function isUnparseable(result: PiConfigRead): boolean {
  return result.exists && (result.parseError !== undefined || result.parsed === null)
}

async function defaultDeps(): Promise<PiSettingsIoDeps> {
  const [ipc, files] = await Promise.all([
    import("@/lib/claude/ipc"),
    import("@/lib/file/file-operations"),
  ])
  return {
    readAgentConfig: (agent) => ipc.readAgentConfig(agent),
    writeAgentConfig: (agent, value) => ipc.writeAgentConfig(agent, value),
    readTextFile: files.readTextFile,
    writeTextFile: files.writeTextFile,
    exists: files.exists,
  }
}

/** A validated `packages` array; anything malformed is dropped with a note. */
export interface PiPackagesRead {
  packages: PiPackageSource[]
  /** True when the file exists but could not be parsed — writes must refuse. */
  unparseable: boolean
  /** True when the file is absent (a fresh Pi install, or Pi not installed). */
  missing: boolean
  warnings: string[]
}

const EMPTY_READ: PiPackagesRead = {
  packages: [],
  unparseable: false,
  missing: true,
  warnings: [],
}

/**
 * Pull `packages` out of an already-parsed settings object, validating each
 * entry against Pi's `PackageSource` shape. Pure — this is the allowlist.
 */
export function extractPiPackages(parsed: unknown): {
  packages: PiPackageSource[]
  warnings: string[]
} {
  const warnings: string[] = []
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { packages: [], warnings }
  }
  const raw = (parsed as Record<string, unknown>)[PACKAGES_KEY]
  if (raw === undefined) return { packages: [], warnings }
  if (!Array.isArray(raw)) {
    warnings.push("`packages` is not an array — ignoring it.")
    return { packages: [], warnings }
  }

  const packages: PiPackageSource[] = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      packages.push(entry)
      continue
    }
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { source?: unknown }).source === "string"
    ) {
      // Copy only the six fields Pi declares. An unknown field is preserved
      // nowhere, so a round-trip cannot resurrect something Pi stopped
      // supporting — but it is reported so the user is not surprised.
      const source = entry as Record<string, unknown>
      const known: PiPackageSource = { source: source.source as string }
      if (typeof source.autoload === "boolean") known.autoload = source.autoload
      for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
        const value = source[key]
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          known[key] = value as string[]
        }
      }
      const extra = Object.keys(source).filter(
        (k) => !["source", "autoload", "extensions", "skills", "prompts", "themes"].includes(k)
      )
      if (extra.length > 0) {
        warnings.push(
          `Entry "${known.source}" has fields Pi 0.84.1 does not define: ${extra.join(", ")}.`
        )
      }
      packages.push(known)
      continue
    }
    warnings.push("Skipped a package entry that is neither a string nor a { source } object.")
  }
  return { packages, warnings }
}

/** Read the user-scope `packages` array via the agent-config IPC. */
export async function readUserPiPackages(deps?: PiSettingsIoDeps): Promise<PiPackagesRead> {
  const resolved = deps ?? (await defaultDeps())
  let result: PiConfigRead
  try {
    result = await resolved.readAgentConfig("pi")
  } catch (error) {
    // `write_agent_config` maps a missing parent dir to this message; the read
    // side surfaces the same condition as "Pi is not installed here".
    const message = error instanceof Error ? error.message : String(error)
    return { ...EMPTY_READ, warnings: [message] }
  }
  if (!result.exists) return { ...EMPTY_READ }
  if (isUnparseable(result)) {
    return { packages: [], unparseable: true, missing: false, warnings: [] }
  }
  const { packages, warnings } = extractPiPackages(result.parsed)
  return { packages, unparseable: false, missing: false, warnings }
}

/** Read a project-scope `<cwd>/.pi/settings.json`. */
export async function readProjectPiPackages(
  cwd: string,
  deps?: PiSettingsIoDeps
): Promise<PiPackagesRead> {
  const resolved = deps ?? (await defaultDeps())
  const path = projectSettingsPath(cwd)
  if (!(await resolved.exists(path).catch(() => false))) return { ...EMPTY_READ }
  let text: string
  try {
    text = await resolved.readTextFile(path)
  } catch (error) {
    return {
      ...EMPTY_READ,
      missing: false,
      warnings: [error instanceof Error ? error.message : String(error)],
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { packages: [], unparseable: true, missing: false, warnings: [] }
  }
  const { packages, warnings } = extractPiPackages(parsed)
  return { packages, unparseable: false, missing: false, warnings }
}

/** `<cwd>/.pi/settings.json` — Pi's project scope is never relocated by env. */
export function projectSettingsPath(cwd: string): string {
  return `${cwd.replace(/[\\/]+$/, "")}/.pi/settings.json`
}

export interface WritePiPackagesResult {
  path: string
  backupPath?: string
}

/**
 * Replace the `packages` array in the user settings file, preserving every
 * other key.
 *
 * Refuses when the file exists but does not parse — writing then would
 * serialize `{}` over the user's whole configuration.
 */
export async function writeUserPiPackages(
  packages: readonly PiPackageSource[],
  deps?: PiSettingsIoDeps
): Promise<WritePiPackagesResult> {
  const resolved = deps ?? (await defaultDeps())
  const current = await resolved.readAgentConfig("pi")
  if (isUnparseable(current)) {
    throw new Error(
      "Pi's settings.json exists but could not be parsed — refusing to overwrite it. " +
        "Fix the file by hand, then retry."
    )
  }
  const base =
    current.parsed && typeof current.parsed === "object" && !Array.isArray(current.parsed)
      ? (current.parsed as Record<string, unknown>)
      : {}
  return resolved.writeAgentConfig("pi", { ...base, [PACKAGES_KEY]: [...packages] })
}

/**
 * Replace the `packages` array in a project settings file, preserving every
 * other key. Same unparseable guard as the user scope.
 */
export async function writeProjectPiPackages(
  cwd: string,
  packages: readonly PiPackageSource[],
  deps?: PiSettingsIoDeps
): Promise<WritePiPackagesResult> {
  const resolved = deps ?? (await defaultDeps())
  const path = projectSettingsPath(cwd)
  let base: Record<string, unknown> = {}
  if (await resolved.exists(path).catch(() => false)) {
    const text = await resolved.readTextFile(path)
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>
      }
    } catch {
      throw new Error(
        `${path} exists but could not be parsed — refusing to overwrite it. ` +
          "Fix the file by hand, then retry."
      )
    }
  }
  const next = { ...base, [PACKAGES_KEY]: [...packages] }
  await resolved.writeTextFile(path, `${JSON.stringify(next, null, 2)}\n`)
  return { path }
}
