"use client"

/**
 * Reactive + imperative access to the session's *effective* working
 * directory — the exact same resolution chain `resolveSendOptions` applies at
 * send time (session override → active workspace primary root → character
 * default → app default, see `lib/workspace/effective-cwd.ts`).
 *
 * Chat surfaces that gate behaviour on "is there a working directory?" must
 * resolve through here instead of reading `session.workingDir` directly —
 * otherwise selecting a workspace updates what the model runs in while the
 * UI still claims no working directory exists.
 */

import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useCharacter } from "@/lib/data-hooks/context"
import { resolveCharacterById } from "@/lib/db/characters"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"
import type { ChatSession } from "@cognia/agent-config-types"

type SessionCwdFields = Pick<ChatSession, "workingDir" | "characterId">

/** Reactive effective cwd for a session (or the fallback chain when null). */
export function useEffectiveCwd(session: SessionCwdFields | null | undefined): string | null {
  const activeProject = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId) ?? null) : null
  )
  const character = useCharacter(session?.characterId)
  const defaultWorkingDir = useSettingsStore((s) => s.settings?.defaultWorkingDir)
  return (
    resolveEffectiveCwd({
      sessionWorkingDir: session?.workingDir,
      activeProject,
      characterWorkingDir: character?.workingDir,
      defaultWorkingDir,
    }) ?? null
  )
}

/**
 * One-shot (non-hook) variant for async call sites that fetch the session row
 * themselves (e.g. the slash-commands settings section). Reads the stores via
 * `getState()` and resolves the character from Dexie.
 */
export async function resolveEffectiveCwdForSession(
  session: SessionCwdFields | null | undefined
): Promise<string | null> {
  const ps = useProjectStore.getState()
  const activeProject = ps.activeProjectId
    ? (ps.projects.find((p) => p.id === ps.activeProjectId) ?? null)
    : null
  const character = session?.characterId
    ? await resolveCharacterById(session.characterId).catch(() => undefined)
    : undefined
  return (
    resolveEffectiveCwd({
      sessionWorkingDir: session?.workingDir,
      activeProject,
      characterWorkingDir: character?.workingDir,
      defaultWorkingDir: useSettingsStore.getState().settings?.defaultWorkingDir,
    }) ?? null
  )
}
