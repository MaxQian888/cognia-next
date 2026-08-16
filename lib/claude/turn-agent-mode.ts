/**
 * What preset — and what legacy mode record — this turn runs under (ADR-0117).
 *
 * `build-options.ts` used to read `useAgentRuntimeStore.getState().modeId`, a
 * single app-wide value. ADR-0117 made the selection per-session, so the send
 * path and the two pickers had drifted apart: choosing a mode in the settings
 * sheet or the composer chip changed the recorded composition and nothing else.
 * The prompt and the tool whitelist still came from the global id.
 *
 * Two values come back rather than one, because they answer different questions:
 *
 *   - `preset` owns the prompt delta and the default tool set. Minimal, Code and
 *     Creator have no `AgentModeConfig` at all, so a mode-record-only resolution
 *     cannot see them.
 *   - `mode` is the legacy record, when one backs the preset. It still owns the
 *     model / temperature / max-token overrides that `buildAgentModeSessionUpdate`
 *     reads, which the preset shape does not carry.
 *
 * Extracted from the send path rather than inlined because `build-options.ts` is
 * ~3,700 lines and async; this decision is worth asserting on directly.
 */

import { resolveActiveAgentMode } from "@/lib/agent/resolve-agent-mode"
import { appPresetCatalog } from "@/lib/agent/composition/app-preset-catalog"
import { compositionForSession } from "@/stores/agent/agent-runtime-store"
import { STANDARD_PRESET, presetFromAgentMode } from "@/lib/agent/composition/preset-catalog"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { AgentPermissionMode } from "@cognia/agent-config-types"
import type { AgentPresetDefinitionV1 } from "@cognia/agent-config-types/agent-composition"

export interface TurnAgentMode {
  /** Absent only when the caller suppressed modes entirely. */
  preset?: AgentPresetDefinitionV1
  /** Absent for a preset with no legacy mode behind it (Minimal / Code / Creator). */
  mode?: AgentModeConfig
  /**
   * Permission this composition asks for, when it asks for one at all.
   *
   * Deliberately NOT the fully resolved authority: every built-in preset carries
   * a `recommends.authority`, so passing that through unconditionally would
   * shadow the character's and the app's permission mode for every session —
   * a silent behaviour change for users who never touched a mode. Only an
   * explicit axis choice on the selection, or a preset that has no mode record
   * to speak for it, contributes here. `maxAuthority` still caps the result.
   */
  requestedAuthority?: AgentPermissionMode
}

export interface ResolveTurnAgentModeInput {
  /** `null` suppresses modes; a record overrides the session's selection. */
  explicitMode?: AgentModeConfig | null
  sessionId?: string
}

/** Rank used only to apply a preset's `maxAuthority` cap. */
const AUTHORITY_RANK: Record<AgentPermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  dontAsk: 3,
  auto: 3,
  bypassPermissions: 4,
}

function capAuthority(
  requested: AgentPermissionMode | undefined,
  max: AgentPermissionMode | undefined
): AgentPermissionMode | undefined {
  if (!requested) return undefined
  if (!max) return requested
  return AUTHORITY_RANK[requested] > AUTHORITY_RANK[max] ? max : requested
}

export function resolveTurnAgentMode(input: ResolveTurnAgentModeInput = {}): TurnAgentMode {
  // Suppression: the caller wants no mode contribution at all. Everything
  // downstream short-circuits on the absent fields, exactly as before.
  if (input.explicitMode === null) return {}

  // Explicit override — the scheduler passes a resolved record for a payload's
  // `agentModeId`, which must win over whatever the synthetic session selected.
  if (input.explicitMode) {
    const preset = presetFromAgentMode(input.explicitMode, "builtin")
    return {
      preset,
      mode: input.explicitMode,
      requestedAuthority: input.explicitMode.permissionMode,
    }
  }

  const selection = compositionForSession(input.sessionId)
  const preset =
    appPresetCatalog().find((candidate) => candidate.id === selection.presetId) ?? STANDARD_PRESET

  // A preset that projects a mode keeps that mode's permission at its existing
  // precedence (via `mode.permissionMode` in the send path), so only a preset
  // with nothing behind it speaks for itself here.
  const mode = resolveActiveAgentMode(preset.legacyModeId ?? preset.id)
  const presetOnlyAuthority = mode ? undefined : preset.recommends?.authority

  return {
    preset,
    mode,
    requestedAuthority: capAuthority(
      selection.authority ?? presetOnlyAuthority,
      preset.maxAuthority
    ),
  }
}
