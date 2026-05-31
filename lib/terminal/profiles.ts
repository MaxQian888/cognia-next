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
