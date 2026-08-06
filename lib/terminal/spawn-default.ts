"use client"

/**
 * "Open a terminal the way the user would expect" — the shell/profile/cwd
 * resolution that used to live inline in the dock.
 *
 * Extracted so the title bar's Terminal → New can actually spawn instead of
 * merely opening the panel, without duplicating the precedence rules. Every
 * entry point that creates a terminal for the *user* (as opposed to an agent,
 * a workflow node, or a plugin) should go through here so they cannot drift.
 *
 * Precedence, highest first:
 *   * an explicit `shellOverride` (the dock's shell picker),
 *   * the named `profileId`, or the configured default profile,
 *   * the project's `terminalConfig.shell`,
 *   * the user's `settings.terminal.defaultShell`,
 *   * the platform default (`resolveDefaultShell`).
 *
 * Toasts stay at the call sites: each surface has its own `useTranslations`
 * namespace, and this module has no React context to read one from.
 */

import { findProfile, profileToSpawnFields, type TerminalProfile } from "@/lib/terminal/profiles"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { spawnFromDock, type SpawnOutcome } from "@/lib/terminal/spawn-orchestrator"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

export interface SpawnDefaultTerminalOptions {
  /** Defaults to the active project. Pass `null` for an explicitly project-less tab. */
  projectId?: string | null
  /** Explicit shell path; wins over every other source. */
  shellOverride?: string
  /** Launch a saved profile. Falls back to the resolved default when missing or blank. */
  profileId?: string
  /** Explicit child worktree cwd; wins over profile and project defaults. */
  cwdOverride?: string
  rows?: number
  cols?: number
}

interface TerminalSettings {
  defaultShell?: string
  forceUtf8?: boolean
  sandboxed?: boolean
  profiles?: TerminalProfile[]
  defaultProfileId?: string
}

/** Spawn the terminal a user asking for "a new terminal" means. */
export async function spawnDefaultTerminal(
  opts: SpawnDefaultTerminalOptions = {}
): Promise<SpawnOutcome> {
  const projectState = useProjectStore.getState()
  const projectId = opts.projectId !== undefined ? opts.projectId : projectState.activeProjectId
  const project = projectId ? (projectState.projects.find((p) => p.id === projectId) ?? null) : null

  const terminal = (useSettingsStore.getState().settings?.terminal ?? {}) as TerminalSettings
  const forceUtf8 = terminal.forceUtf8 ?? true
  // ADR-0028 Phase 3 (P4.1) — opt-in sandboxed terminal. Off by default.
  const sandboxed = terminal.sandboxed ?? false
  const rows = opts.rows ?? 24
  const cols = opts.cols ?? 80

  // A profile carries its own shell, args, cwd and env, so resolve it first and
  // only fall through when it is gone or has a blank shell.
  const profileId = opts.profileId ?? terminal.defaultProfileId
  if (!opts.shellOverride && profileId) {
    const profile = findProfile(terminal.profiles, profileId)
    const fields = profile ? profileToSpawnFields(profile) : null
    if (fields) {
      return spawnFromDock({
        req: {
          ...fields,
          ...(opts.cwdOverride?.trim() ? { cwd: opts.cwdOverride.trim() } : {}),
          profileId,
          rows,
          cols,
          projectId: projectId ?? undefined,
          enableShellIntegration: true,
          forceUtf8,
          sandboxed,
        },
        store: useTerminalStore.getState(),
      })
    }
  }

  const shell =
    opts.shellOverride && opts.shellOverride.trim().length > 0
      ? opts.shellOverride
      : resolveDefaultShell({
          projectShell: project?.terminalConfig?.shell,
          settingShell: terminal.defaultShell,
        })

  return spawnFromDock({
    req: {
      shell,
      rows,
      cols,
      cwd:
        opts.cwdOverride?.trim() ||
        project?.terminalConfig?.cwd?.trim() ||
        project?.rootDir?.trim() ||
        undefined,
      env: project?.terminalConfig?.env,
      projectId: projectId ?? undefined,
      enableShellIntegration: true,
      forceUtf8,
      sandboxed,
    },
    store: useTerminalStore.getState(),
  })
}
