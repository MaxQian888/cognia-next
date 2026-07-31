// Pure helpers for applying a preset's payload onto a chat session.
//
// Used in two places: (a) the chat-header config sheet, when the user picks
// a preset from the dropdown and chooses a conflict-resolution strategy;
// (b) `lib/db/sessions.ts:createSession`, when a default preset auto-applies
// to a new session that has no character and no caller-provided overrides.
//
// The helper is pure (no DB reads, no React) so its behaviour can be unit-
// tested without an IndexedDB harness. Callers persist the patch via
// `updateSession` themselves.

import type { ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"

/**
 * Strategy for reconciling preset fields with non-empty session values.
 *
 * - `overwrite-all`: every preset field replaces the session's value.
 * - `fill-empty`: only touches session fields that are currently empty
 *   (undefined / "" / [] / objects with no keys).
 * - `merge`: same as `fill-empty` for scalars; for arrays, unions the
 *   incoming preset value with the session's existing entries.
 */
export type ApplyPresetStrategy = "overwrite-all" | "fill-empty" | "merge"

/**
 * The shape we can patch on `ChatSession` directly. Note that arrays
 * (allowed/disallowed tools, mcpServerIds, skillIds) and `agentModeId` are
 * NOT carried in the ChatSession row — they live on the character / agent-
 * mode store. The patch builder still surfaces them so callers can route
 * those fields through the appropriate stores when applying a preset.
 */
export interface SessionPresetPatch {
  systemPrompt?: string
  model?: string
  permissionMode?: ChatSession["permissionMode"]
  workingDir?: string
}

/** Non-session-row fields a preset can carry. Routed by the chat header UI. */
export interface ExtendedPresetPatch {
  effort?: SystemPromptPreset["effort"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  agentModeId?: string
}

export interface PresetApplicationPlan {
  /** Patch to merge into ChatSession via `updateSession`. */
  sessionPatch: SessionPresetPatch
  /** Extended fields the caller may route to other stores. */
  extended: ExtendedPresetPatch
  /** Fields the preset would have set but that the strategy chose to keep. */
  preserved: Array<keyof SessionPresetPatch | keyof ExtendedPresetPatch>
  /**
   * Fields the preset wanted to write where the session already had a
   * non-empty value. Drives the "this will overwrite X" warning UI.
   */
  conflicts: Array<keyof SessionPresetPatch | keyof ExtendedPresetPatch>
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value as object).length === 0
  return false
}

function unionUnique<T>(a: T[] | undefined, b: T[] | undefined): T[] {
  const out = new Set<T>()
  for (const v of a ?? []) out.add(v)
  for (const v of b ?? []) out.add(v)
  return [...out]
}

/**
 * Compute which preset fields would conflict with the supplied session — i.e.
 * the preset has a value AND the session already has a non-empty value for
 * the same field. Used to drive the chat-header conflict dialog.
 */
export function detectPresetConflicts(
  preset: SystemPromptPreset,
  session: Pick<ChatSession, "systemPrompt" | "model" | "permissionMode" | "workingDir">
): Array<keyof SessionPresetPatch> {
  const conflicts: Array<keyof SessionPresetPatch> = []
  if (!isEmpty(preset.content) && !isEmpty(session.systemPrompt)) conflicts.push("systemPrompt")
  if (!isEmpty(preset.model) && !isEmpty(session.model)) conflicts.push("model")
  if (!isEmpty(preset.permissionMode) && !isEmpty(session.permissionMode))
    conflicts.push("permissionMode")
  if (!isEmpty(preset.workingDir) && !isEmpty(session.workingDir)) conflicts.push("workingDir")
  return conflicts
}

/**
 * Build the full application plan: session patch + extended fields the
 * caller can route to other stores, plus the conflict / preserved sets so
 * the UI can render an honest summary of what changed.
 *
 * Strategy semantics:
 *   - `overwrite-all`: every non-empty preset field is included in the
 *     patch, regardless of session state.
 *   - `fill-empty`: a preset field is only included if the session's
 *     existing value is empty.
 *   - `merge`: same as `fill-empty` for scalars; for array fields (tools,
 *     mcp, skills), the patch is the UNION of preset + session arrays
 *     even when the session value is non-empty.
 */
export function buildPresetApplicationPlan(
  preset: SystemPromptPreset,
  session: Pick<ChatSession, "systemPrompt" | "model" | "permissionMode" | "workingDir">,
  strategy: ApplyPresetStrategy,
  extras?: {
    /** Existing arrays elsewhere in the app the preset may merge into. */
    sessionAllowedTools?: string[]
    sessionDisallowedTools?: string[]
    sessionMcpServerIds?: string[]
    sessionSkillIds?: string[]
  }
): PresetApplicationPlan {
  const sessionPatch: SessionPresetPatch = {}
  const extended: ExtendedPresetPatch = {}
  const preserved: PresetApplicationPlan["preserved"] = []
  const conflicts: PresetApplicationPlan["conflicts"] = []

  type ScalarField = "systemPrompt" | "model" | "permissionMode" | "workingDir" | "effort"
  type ScalarSpec<K extends ScalarField> = {
    field: K
    presetValue: K extends "systemPrompt"
      ? string | undefined
      : K extends "effort"
        ? SystemPromptPreset["effort"]
        : K extends "permissionMode"
          ? ChatSession["permissionMode"]
          : string | undefined
    sessionValue: unknown
    target: "session" | "extended"
  }
  const scalars = [
    {
      field: "systemPrompt",
      presetValue: preset.content,
      sessionValue: session.systemPrompt,
      target: "session",
    } satisfies ScalarSpec<"systemPrompt">,
    {
      field: "model",
      presetValue: preset.model,
      sessionValue: session.model,
      target: "session",
    } satisfies ScalarSpec<"model">,
    {
      field: "permissionMode",
      presetValue: preset.permissionMode,
      sessionValue: session.permissionMode,
      target: "session",
    } satisfies ScalarSpec<"permissionMode">,
    {
      field: "workingDir",
      presetValue: preset.workingDir,
      sessionValue: session.workingDir,
      target: "session",
    } satisfies ScalarSpec<"workingDir">,
    {
      field: "effort",
      presetValue: preset.effort,
      sessionValue: undefined,
      target: "extended",
    } satisfies ScalarSpec<"effort">,
  ] as const

  for (const spec of scalars) {
    if (isEmpty(spec.presetValue)) continue
    const sessionEmpty = isEmpty(spec.sessionValue)
    const shouldWrite = strategy === "overwrite-all" ? true : sessionEmpty
    if (!shouldWrite) {
      preserved.push(spec.field)
      conflicts.push(spec.field)
      continue
    }
    if (!sessionEmpty) conflicts.push(spec.field)
    if (spec.target === "session") {
      ;(sessionPatch as Record<string, unknown>)[spec.field] = spec.presetValue
    } else {
      ;(extended as Record<string, unknown>)[spec.field] = spec.presetValue
    }
  }

  // --- Array fields (extended; not on ChatSession directly) ---------
  const arrayFields = [
    {
      field: "allowedTools" as const,
      presetValue: preset.allowedTools,
      sessionValue: extras?.sessionAllowedTools,
    },
    {
      field: "disallowedTools" as const,
      presetValue: preset.disallowedTools,
      sessionValue: extras?.sessionDisallowedTools,
    },
    {
      field: "mcpServerIds" as const,
      presetValue: preset.mcpServerIds,
      sessionValue: extras?.sessionMcpServerIds,
    },
    {
      field: "skillIds" as const,
      presetValue: preset.skillIds,
      sessionValue: extras?.sessionSkillIds,
    },
  ]

  for (const spec of arrayFields) {
    if (isEmpty(spec.presetValue)) continue
    const sessionEmpty = isEmpty(spec.sessionValue)
    if (strategy === "overwrite-all") {
      if (!sessionEmpty) conflicts.push(spec.field)
      ;(extended as Record<string, unknown>)[spec.field] = [...(spec.presetValue ?? [])]
      continue
    }
    if (strategy === "merge") {
      if (!sessionEmpty) conflicts.push(spec.field)
      ;(extended as Record<string, unknown>)[spec.field] = unionUnique(
        spec.sessionValue,
        spec.presetValue
      )
      continue
    }
    // fill-empty
    if (sessionEmpty) {
      ;(extended as Record<string, unknown>)[spec.field] = [...(spec.presetValue ?? [])]
    } else {
      preserved.push(spec.field)
      conflicts.push(spec.field)
    }
  }

  // --- agentModeId (single scalar; routed to extended) -------------
  if (!isEmpty(preset.agentModeId)) {
    // We don't compare against session for agent mode — it lives in a
    // global zustand store. Always set it under overwrite-all, and only
    // set it under fill-empty/merge if the caller hasn't yet (caller
    // detects this externally). For now, always include — UI can choose
    // to ignore.
    extended.agentModeId = preset.agentModeId
  }

  return { sessionPatch, extended, preserved, conflicts }
}

/**
 * Convenience for the createSession auto-apply path. Given a default preset
 * and the partial session payload the caller is constructing, return only
 * the ChatSession-row fields that should be filled in (never overwriting
 * caller-provided values). Extended fields are dropped — the auto-apply
 * path doesn't have access to per-session tool/skill/mcp storage.
 */
export function buildAutoApplySessionPatch(
  preset: SystemPromptPreset,
  partial: Partial<ChatSession>
): SessionPresetPatch {
  const patch: SessionPresetPatch = {}
  if (!isEmpty(preset.content) && isEmpty(partial.systemPrompt)) patch.systemPrompt = preset.content
  if (!isEmpty(preset.model) && isEmpty(partial.model)) patch.model = preset.model
  if (!isEmpty(preset.permissionMode) && isEmpty(partial.permissionMode))
    patch.permissionMode = preset.permissionMode
  if (!isEmpty(preset.workingDir) && isEmpty(partial.workingDir))
    patch.workingDir = preset.workingDir
  return patch
}
