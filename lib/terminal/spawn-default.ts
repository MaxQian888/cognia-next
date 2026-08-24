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
 *   * what the HOST reported as its own default, when the session will spawn
 *     over `ws` / `webrtc` (`ensureHostCapabilities`),
 *   * the platform default (`resolveDefaultShell`).
 *
 * The host tier exists because the two below it describe the wrong machine on
 * a remote transport: `resolveDefaultShell` falls back to a `navigator.userAgent`
 * sniff, so a macOS browser paired to a Linux `cognia-server` asked it for
 * `/bin/zsh` and got a failed spawn with no explanation. It sits *below* the
 * explicit settings on purpose — a user who typed a shell path meant it.
 *
 * Toasts stay at the call sites: each surface has its own `useTranslations`
 * namespace, and this module has no React context to read one from.
 */

import { ensureHostCapabilities } from "@/lib/terminal/host-capabilities"
import { ensureTerminalHostProfilesSynced } from "@/lib/terminal/host-profiles"
import { findProfile, profileToSpawnFields, type TerminalProfile } from "@/lib/terminal/profiles"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { spawnFromDock, type SpawnOutcome } from "@/lib/terminal/spawn-orchestrator"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { resolvePanelRoot } from "@/lib/workspace/panel-follow"
import { useChatStore } from "@/stores/chat/chat-store"
import type { SessionExecutionContext } from "@/types/execution-context"

/**
 * The focused conversation's durable execution binding.
 *
 * Read lazily and never fatally: a terminal that cannot find the conversation
 * still opens, on the workspace root, which is what it did before any of this
 * existed.
 */
async function loadSessionExecutionContext(
  sessionId: string | null | undefined
): Promise<SessionExecutionContext | null> {
  if (!sessionId) return null
  try {
    const { getDb } = await import("@/lib/db/schema")
    return (await getDb().sessions.get(sessionId))?.executionContext ?? null
  } catch {
    return null
  }
}

export interface SpawnDefaultTerminalOptions {
  /** Defaults to the active project. Pass `null` for an explicitly project-less tab. */
  projectId?: string | null
  /** Explicit shell path; wins over every other source. */
  shellOverride?: string
  /** Launch a saved profile. Falls back to the resolved default when missing or blank. */
  profileId?: string
  /** Explicit child worktree cwd; wins over profile and project defaults. */
  cwdOverride?: string
  /**
   * The conversation this terminal belongs to. Its execution root becomes the
   * cwd, which is what makes a terminal opened for a managed-worktree
   * conversation land in the worktree instead of in the checkout it was cut
   * from — the directory the agent is actually working in.
   *
   * Below `cwdOverride` (an explicit ask) and above the project's configured
   * cwd, because `terminalConfig.cwd` describes the workspace, not this turn.
   */
  sessionExecutionContext?: SessionExecutionContext | null
  /**
   * Which conversation to inherit the execution root from when
   * `sessionExecutionContext` is not supplied. Defaults to the focused
   * conversation; pass `null` for a deliberately conversation-less terminal.
   */
  sessionId?: string | null
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
  const executionContext =
    opts.sessionExecutionContext !== undefined
      ? opts.sessionExecutionContext
      : await loadSessionExecutionContext(
          opts.sessionId !== undefined ? opts.sessionId : useChatStore.getState().activeSessionId
        )
  // One rule for every panel that operates on a directory. A terminal always
  // FOLLOWS — it is never pinnable — so a stale pin can never point a shell at
  // a tree the agent is not working in.
  const followed = resolvePanelRoot({
    panel: "terminal",
    executionContext,
    activeProject: project,
  })

  const terminal = (useSettingsStore.getState().settings?.terminal ?? {}) as TerminalSettings
  const forceUtf8 = terminal.forceUtf8 ?? true
  // ADR-0028 Phase 3 (P4.1) — opt-in sandboxed terminal. Off by default.
  const sandboxed = terminal.sandboxed ?? false
  const rows = opts.rows ?? 24
  const cols = opts.cols ?? 80

  // A remote host only ever receives a profile *id* — the shell, args, cwd and
  // env below never cross the wire — so it has to have been told what that id
  // means before the spawn frame arrives, or it answers "unknown terminal
  // profile". Shares boot's sync, so this is normally already settled.
  await ensureTerminalHostProfilesSynced()

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
          // A profile carries its own cwd, but the conversation's execution
          // root outranks it for the same reason it outranks the project's:
          // the profile describes a habit, the execution root describes where
          // this work is happening.
          ...(opts.cwdOverride?.trim()
            ? { cwd: opts.cwdOverride.trim() }
            : followed.source === "execution" && followed.root
              ? { cwd: followed.root }
              : {}),
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

  // Only probed when nothing more specific was chosen, and a no-op on the
  // local PTY (where `shell-detect` is already describing the right machine).
  const hostDefaultShell =
    opts.shellOverride && opts.shellOverride.trim().length > 0
      ? undefined
      : ((await ensureHostCapabilities())?.defaultShell ?? undefined)

  const shell =
    opts.shellOverride && opts.shellOverride.trim().length > 0
      ? opts.shellOverride
      : resolveDefaultShell({
          projectShell: project?.terminalConfig?.shell,
          settingShell: terminal.defaultShell,
          hostDefaultShell,
        })

  return spawnFromDock({
    req: {
      shell,
      rows,
      cols,
      cwd:
        opts.cwdOverride?.trim() ||
        (followed.source === "execution" ? (followed.root ?? undefined) : undefined) ||
        project?.terminalConfig?.cwd?.trim() ||
        followed.root ||
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
