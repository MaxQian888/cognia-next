/**
 * Deciding whether a project environment's setup may be skipped.
 *
 * See `ProjectEnvironmentSetupReuse` for the contract. This module holds the
 * pure pieces (path validation, the canonical fingerprint input, choosing the
 * record a decision rests on) plus the one I/O step each needs, behind
 * injectable dependencies so the executor stays a thin caller.
 */

import type {
  ProjectEnvironment,
  ProjectEnvironmentInitialization,
  ProjectEnvironmentSetupReuse,
} from "@/types/project-environment"

/** Bumped when the fingerprint's input shape changes, so old records stop matching. */
const FINGERPRINT_VERSION = 1

/** Keeps a pathological list from turning every turn into a directory walk. */
export const MAX_SETUP_REUSE_PATHS = 32

export interface SetupReuseIo {
  /** Content of a root-relative file; rejects when missing or unreadable as text. */
  readFile: (root: string, relPath: string) => Promise<string>
  /** Existence and cheap identity of a root-relative path; never rejects for a missing path. */
  statFile: (
    root: string,
    relPath: string
  ) => Promise<{ exists: boolean; size?: number; mtimeMs?: number }>
  sha256Hex: (value: string) => Promise<string>
}

/**
 * A root-relative path setup reuse may read, or a reason it may not. Absolute
 * paths and `..` segments are refused outright rather than normalized: the
 * workspace fs commands confine reads to the root anyway, and a declaration
 * that tries to leave it is a mistake worth surfacing, not silently fixing.
 */
export function validateSetupReusePath(raw: string): { ok: true; path: string } | { ok: false } {
  const path = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
  if (!path) return { ok: false }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { ok: false }
  if (path.split("/").some((segment) => segment === ".." || segment === "")) return { ok: false }
  return { ok: true, path }
}

/** Throws on an invalid declaration; used by the save-time boundary check. */
export function assertSetupReuse(reuse: ProjectEnvironmentSetupReuse): void {
  for (const list of [reuse.inputs, reuse.outputs]) {
    if (!Array.isArray(list)) throw new Error("Setup reuse inputs and outputs must be lists")
    if (list.length > MAX_SETUP_REUSE_PATHS) {
      throw new Error(`Setup reuse accepts at most ${MAX_SETUP_REUSE_PATHS} paths per list`)
    }
    for (const entry of list) {
      if (typeof entry !== "string" || !validateSetupReusePath(entry).ok) {
        throw new Error(`Setup reuse path must stay inside the execution root: ${String(entry)}`)
      }
    }
  }
}

/**
 * The declaration the executor acts on, or `null` when reuse is off. Invalid
 * or duplicate paths are dropped here too, so a row saved before validation
 * existed cannot make the executor read outside the root.
 */
export function effectiveSetupReuse(
  environment: Pick<ProjectEnvironment, "setupReuse">
): ProjectEnvironmentSetupReuse | null {
  const reuse = environment.setupReuse
  if (!reuse?.enabled) return null
  const clean = (list: unknown): string[] => {
    if (!Array.isArray(list)) return []
    const seen = new Set<string>()
    for (const entry of list) {
      if (typeof entry !== "string") continue
      const verdict = validateSetupReusePath(entry)
      if (verdict.ok) seen.add(verdict.path)
    }
    return [...seen].sort().slice(0, MAX_SETUP_REUSE_PATHS)
  }
  return { enabled: true, inputs: clean(reuse.inputs), outputs: clean(reuse.outputs) }
}

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/**
 * Everything about the environment definition a setup depends on, without any
 * file I/O. Two setup requests with the same signature would run the same
 * command in the same way, which is also the test for joining one that is
 * already in flight.
 */
export function setupSignature(
  environment: Pick<
    ProjectEnvironment,
    "setupScript" | "variables" | "keyringReferences" | "policy"
  >
): string {
  return canonicalJson({
    v: FINGERPRINT_VERSION,
    setupScript: environment.setupScript,
    variables: environment.variables,
    keyringReferences: [...environment.keyringReferences]
      .map(({ variable, keyringRef }) => ({ variable, keyringRef }))
      .sort((a, b) => a.variable.localeCompare(b.variable)),
    policy: environment.policy ?? null,
  })
}

/**
 * The fingerprint a successful setup is recorded under: the signature plus the
 * content of every declared input. A missing input is part of the answer
 * (`absent`), since creating the lockfile must re-run setup. An input that
 * cannot be read as text falls back to its size and mtime. One that cannot
 * even be stat'ed makes the fingerprint unavailable, and setup simply runs.
 */
export async function computeSetupFingerprint(
  signature: string,
  executionRoot: string,
  reuse: ProjectEnvironmentSetupReuse,
  io: SetupReuseIo
): Promise<string> {
  const inputs = await Promise.all(
    reuse.inputs.map(async (path) => {
      try {
        return { path, content: await io.sha256Hex(await io.readFile(executionRoot, path)) }
      } catch {
        const stat = await io.statFile(executionRoot, path)
        if (!stat.exists) return { path, content: "absent" }
        return { path, content: `stat:${stat.size ?? "?"}:${stat.mtimeMs ?? "?"}` }
      }
    })
  )
  return io.sha256Hex(canonicalJson({ signature, inputs }))
}

/** True when every declared output still exists under the root. */
export async function setupOutputsPresent(
  executionRoot: string,
  reuse: ProjectEnvironmentSetupReuse,
  io: SetupReuseIo
): Promise<boolean> {
  const stats = await Promise.all(reuse.outputs.map((path) => io.statFile(executionRoot, path)))
  return stats.every((stat) => stat.exists)
}

/**
 * The record a reuse decision rests on: the most recent *finished* setup for
 * this root and scope. Only the latest counts. A failed run after a success may
 * have left the root half-installed, so an older success must not vouch for it.
 */
export function latestSetupRecord(
  environment: Pick<ProjectEnvironment, "lastInitialization" | "initializationHistory">,
  executionRoot: string,
  scope: ProjectEnvironmentInitialization["scope"]
): ProjectEnvironmentInitialization | null {
  const candidates = [
    ...(environment.initializationHistory ?? []),
    ...(environment.lastInitialization ? [environment.lastInitialization] : []),
  ].filter(
    (record) =>
      record.executionRoot === executionRoot &&
      record.scope === scope &&
      record.status !== "running"
  )
  let latest: ProjectEnvironmentInitialization | null = null
  for (const record of candidates) {
    const at = record.completedAt ?? record.startedAt
    const latestAt = latest ? (latest.completedAt ?? latest.startedAt) : -Infinity
    if (at >= latestAt) latest = record
  }
  return latest
}

/** Whether `record` vouches for skipping a setup whose fingerprint is `fingerprint`. */
export function recordAllowsReuse(
  record: ProjectEnvironmentInitialization | null,
  fingerprint: string
): boolean {
  return record?.status === "succeeded" && record.fingerprint === fingerprint
}
