// DataAdapter — the abstraction that lets chat components run against either
// Dexie (PC desktop app) or a WebSocket bridge to a remote PC (mobile PWA).
//
// Reactive read hooks mirror the live-query semantics consumers already
// expected from `useLiveQuery` (returns `undefined` while loading, then the
// resolved value, then re-renders when underlying data changes).
//
// Mutations are one-shot Promises. Callers that don't await (toast UX) can
// `void adapter.recordPresetUsage(id)` exactly as they did with the raw helpers.

import type { Character, ChatSession, Skill, SystemPromptPreset } from "@cognia/agent-config-types"

/** Patch type accepted by `updateSession`. Mirrors the shape that
 * `lib/db/sessions.ts:updateSession` already accepts so callers don't need to
 * change their argument shape after the refactor. */
export type SessionPatch = Partial<Omit<ChatSession, "id" | "createdAt">>

/**
 * The full surface that chat components need from persistence. Each adapter
 * implementation is responsible for honouring React's rules of hooks for the
 * `use*` methods — they are React hooks and must be called at the top level
 * of a component or another hook.
 */
export interface DataAdapter {
  /** Reactive list of all characters, sorted by name. `undefined` while loading. */
  useCharacters(): Character[] | undefined
  /** Reactive single character lookup. `undefined` while loading or when `id` is falsy. */
  useCharacter(id: string | null | undefined): Character | undefined
  /** Reactive batch lookup of skills by id. `undefined` while loading;
   * `[]` when `ids` is empty. Order matches input ids; missing rows dropped. */
  useSkillsByIds(ids: readonly string[] | null | undefined): Skill[] | undefined
  /** Reactive list of all prompt presets, sorted by sortOrder/updatedAt. */
  usePresets(): SystemPromptPreset[] | undefined

  /** Drop every message in `sessionId`. */
  clearMessages(sessionId: string): Promise<void>
  /** Patch session row. Bumps `updatedAt`. */
  updateSession(id: string, patch: SessionPatch): Promise<void>
  /** Bump usage counter on a preset. Fire-and-forget friendly. */
  recordPresetUsage(id: string): Promise<void>
  /** Record user trust for a workspace path. */
  trustWorkspace(path: string, note?: string): Promise<void>
}
