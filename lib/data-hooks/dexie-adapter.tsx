"use client"

// Dexie-backed implementation of `DataAdapter` — the production adapter for
// the PC desktop app. Reactive reads delegate to `dexie-react-hooks`'
// `useLiveQuery`; mutations are direct passthroughs to the existing helpers
// under `lib/db/*`. The shape is identical to what the chat components were
// doing inline before this refactor — same SSR guards, same dependency keys.

import { useLiveQuery } from "dexie-react-hooks"
import { listCharacters, getCharacter } from "@/lib/db/characters"
import { listSkillsByIds } from "@/lib/db/skills"
import { listPresets, recordPresetUsage } from "@/lib/db/prompt-presets"
import { updateSession } from "@/lib/db/sessions"
import { clearMessages } from "@/lib/db/messages"
import { trustWorkspace } from "@/lib/db/trusted-workspaces"
import type { DataAdapter, SessionPatch } from "./types"

const isClient = (): boolean => typeof window !== "undefined"

/**
 * Singleton — `DataAdapter` instance backed by Dexie. The hook properties
 * (`useCharacters` etc.) ARE React hooks; consumers must respect React's
 * rules of hooks at the call site (i.e. call them at the top of a component).
 */
export const dexieAdapter: DataAdapter = {
  useCharacters() {
    return useLiveQuery(() => (isClient() ? listCharacters() : Promise.resolve([])), [])
  },

  useCharacter(id) {
    return useLiveQuery(
      () => (isClient() && id ? getCharacter(id) : Promise.resolve(undefined)),
      [id ?? ""]
    )
  },

  useSkillsByIds(ids) {
    // Stable string key so `useLiveQuery` re-runs only when membership changes,
    // not on every parent re-render that produces a new array reference.
    const key = ids?.join(",") ?? ""
    return useLiveQuery(
      () => (isClient() && ids && ids.length > 0 ? listSkillsByIds([...ids]) : Promise.resolve([])),
      [key]
    )
  },

  usePresets() {
    return useLiveQuery(() => (isClient() ? listPresets() : Promise.resolve([])), [])
  },

  async clearMessages(sessionId: string): Promise<void> {
    await clearMessages(sessionId)
  },

  async updateSession(id: string, patch: SessionPatch): Promise<void> {
    await updateSession(id, patch)
  },

  async recordPresetUsage(id: string): Promise<void> {
    await recordPresetUsage(id)
  },

  async trustWorkspace(path: string, note?: string): Promise<void> {
    await trustWorkspace(path, note)
  },
}
