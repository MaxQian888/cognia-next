/**
 * Terminal launch profiles (Windows-Terminal style).
 *
 * A profile bundles a named shell + cwd + env + args so the dock can spawn a
 * preconfigured terminal in one click. Profiles are stored in
 * `settings.terminal.profiles` and a `defaultProfileId` selects the one the
 * plain "+ New" affordance uses. Pure helpers only — no React, no store.
 */

import type { SpawnRequest } from "./types"

export interface TerminalProfile {
  /** Stable id (used as React key + `defaultProfileId` reference). */
  id: string
  /** User-facing label shown in the picker + settings list. */
  name: string
  /** Shell binary — absolute path or PATH-resolvable name. */
  shell: string
  /** Optional initial working directory. */
  cwd?: string
  /** Optional extra argv passed after the shell. */
  args?: string[]
  /** Optional extra environment variables. */
  env?: Record<string, string>
}

/** Find a profile by id, or `undefined`. */
export function findProfile(
  profiles: readonly TerminalProfile[] | undefined,
  id: string | undefined
): TerminalProfile | undefined {
  if (!profiles || !id) return undefined
  return profiles.find((p) => p.id === id)
}

/**
 * Build the spawn fields a profile contributes. Empty/whitespace shell is
 * rejected (returns `null`) so a half-filled profile never spawns a broken
 * PTY. `rows`/`cols`/`forceUtf8`/`enableShellIntegration` are the caller's
 * concern — this only maps the profile-owned fields.
 */
export function profileToSpawnFields(
  profile: TerminalProfile
): Pick<SpawnRequest, "shell" | "cwd" | "args" | "env"> | null {
  const shell = profile.shell?.trim()
  if (!shell) return null
  return {
    shell,
    cwd: profile.cwd?.trim() || undefined,
    args: profile.args && profile.args.length > 0 ? profile.args : undefined,
    env: profile.env && Object.keys(profile.env).length > 0 ? profile.env : undefined,
  }
}

/**
 * Parse the settings-UI "one argument per line" textarea into a profile
 * `args` array. Blank lines are dropped; interior whitespace is preserved
 * verbatim (an argv entry may legitimately contain spaces). Returns
 * `undefined` for an all-blank input so the profile stores no empty array.
 */
export function parseProfileArgs(text: string): string[] | undefined {
  const args = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return args.length > 0 ? args : undefined
}

/** Inverse of {@link parseProfileArgs} — args back to textarea text. */
export function formatProfileArgs(args: readonly string[] | undefined): string {
  return args?.join("\n") ?? ""
}

/**
 * Parse the settings-UI "KEY=VALUE per line" textarea into a profile `env`
 * record. Lines without `=` or with an empty key are skipped (a half-typed
 * line must not clobber the record with a garbage entry); the value keeps
 * any further `=` verbatim (`PATH=C:\x=y` → value `C:\x=y`). Returns
 * `undefined` when no valid pair remains.
 */
export function parseProfileEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  let count = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    env[key] = line.slice(eq + 1)
    count += 1
  }
  return count > 0 ? env : undefined
}

/** Inverse of {@link parseProfileEnv} — env record back to textarea text. */
export function formatProfileEnv(env: Record<string, string> | undefined): string {
  if (!env) return ""
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

/** Generate a reasonably-unique profile id without `Math.random`/`Date.now`. */
export function nextProfileId(existing: readonly TerminalProfile[] | undefined): string {
  const used = new Set((existing ?? []).map((p) => p.id))
  let n = (existing?.length ?? 0) + 1
  let id = `profile-${n}`
  while (used.has(id)) {
    n += 1
    id = `profile-${n}`
  }
  return id
}
