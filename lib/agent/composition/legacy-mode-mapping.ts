/**
 * `agentModeId` → composition selection (ADR-0117).
 *
 * `agentModeId` stays a supported public field on sessions, scheduler payloads,
 * prompt presets and plugin contributions, so this mapping is a permanent
 * compatibility surface, not a one-shot migration script.
 *
 * The one rule that matters more than fidelity: an id this build does not
 * recognise resolves to Standard at `default` authority. It never infers,
 * inherits or preserves `bypassPermissions` — an unknown mode is exactly the
 * case where guessing an elevated permission would be worst.
 */

import { STANDARD_PRESET_ID } from "./preset-catalog"
import type {
  AgentCompositionSelectionV1,
  AgentCompositionWarning,
} from "@cognia/agent-config-types/agent-composition"

export interface LegacyModeMigration {
  selection: AgentCompositionSelectionV1
  /** Present only when the id was not recognised. */
  warning?: AgentCompositionWarning
}

/**
 * Legacy ids that are Standard with a different axis value.
 *
 * `plan` and `build` only ever set `permissionMode`; `workflow` only ever meant
 * "decompose this". Keeping them as presets would have made three copies of
 * Standard whose prompts could drift apart.
 */
const AXIS_OVERLAYS: Record<string, Omit<AgentCompositionSelectionV1, "presetId">> = {
  general: {},
  plan: { authority: "plan" },
  build: { authority: "acceptEdits" },
  workflow: { orchestration: "workflow" },
}

/**
 * Migrate a legacy mode id.
 *
 * `knownPresetIds` is passed in rather than imported so the caller decides what
 * "known" means — the built-in catalog on the CLI, and the catalog plus the
 * user's custom and plugin modes in the app.
 */
export function selectionFromLegacyModeId(
  modeId: string | null | undefined,
  knownPresetIds: ReadonlySet<string>
): LegacyModeMigration {
  const trimmed = typeof modeId === "string" ? modeId.trim() : ""

  // Nothing was ever chosen — this is a default, not a fallback, so it carries
  // no warning. A warning here would put a compatibility banner on every
  // session that simply predates the field.
  if (trimmed.length === 0) {
    return { selection: { presetId: STANDARD_PRESET_ID } }
  }

  // `Object.hasOwn`, never `in` or a bare index: a mode id of `toString` or
  // `constructor` would otherwise hit `Object.prototype` and get spread into
  // the selection as a function.
  const overlay = Object.hasOwn(AXIS_OVERLAYS, trimmed) ? AXIS_OVERLAYS[trimmed] : undefined
  if (overlay) {
    return {
      selection: { presetId: STANDARD_PRESET_ID, ...overlay, legacyModeId: trimmed },
    }
  }

  if (knownPresetIds.has(trimmed)) {
    return { selection: { presetId: trimmed, legacyModeId: trimmed } }
  }

  return {
    selection: {
      presetId: STANDARD_PRESET_ID,
      authority: "default",
      legacyModeId: trimmed,
    },
    warning: {
      reason: "unknown-legacy-mode",
      requested: trimmed,
      applied: STANDARD_PRESET_ID,
    },
  }
}

/** Whether a legacy id maps onto axis values instead of a preset of its own. */
export function isAxisOnlyLegacyModeId(modeId: string): boolean {
  return Object.hasOwn(AXIS_OVERLAYS, modeId)
}
