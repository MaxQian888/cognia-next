/**
 * Project an IM conversation's effective configuration onto a composition
 * selection (ADR-0117).
 *
 * Pure and side-effect free: it takes what `resolveImEffectiveConfig` already
 * resolved and restates it in axis terms. This is the whole of the IM side of
 * the mode unification — there is no second resolver, no second precedence
 * chain, and no second store. `resolveComposition` still decides the final
 * values, including every cap.
 *
 * Why this exists at all: `resolveTurnComposition` falls back to
 * `compositionForSession()`, which reads the localStorage-backed zustand store.
 * An IM turn has no business inheriting whatever the desktop user last picked
 * in the composer chip, and it has a full Dexie config stack of its own. This
 * module is what connects the second to the first.
 *
 * What it deliberately does NOT do:
 *
 *   - Map a Character onto a preset. Characters are a persona system with its
 *     own storage and editor; preset ids come from the preset catalog. The
 *     preset comes from the session's `agentModeId`, and the character keeps
 *     driving persona through the path it always has.
 *   - Own the orchestration target id. `orchestrationRef` is copied from the
 *     routing fields that already hold it, so the two can never disagree.
 */

import { projectEffectiveComposition } from "@/lib/agent/composition/project-effective-composition"
import type {
  ProjectedCompositionProvenance,
  ProjectedComposition,
} from "@/lib/agent/composition/project-effective-composition"

import { appPresetCatalog } from "@/lib/agent/composition/app-preset-catalog"
import { selectionFromLegacyModeId } from "@/lib/agent/composition/legacy-mode-mapping"
import type { ImConfigSource, resolveImEffectiveConfig } from "@/lib/connectors/effective-config"

type ImEffectiveConfig = ReturnType<typeof resolveImEffectiveConfig>

/** Which layer supplied each axis, for the chip and the override dialog. */
export type ImCompositionProvenance = ProjectedCompositionProvenance<ImConfigSource>

export type ImCompositionProjection = ProjectedComposition<ImConfigSource>

/**
 * Provenance and warnings are kept apart on purpose. `AgentCompositionWarning`
 * records a *downgrade* — something the resolver refused. `ImConfigSource`
 * records *where a value came from*. Merging them would make "the bot default
 * won" render as a failure.
 */
export function projectImComposition(input: {
  effective: ImEffectiveConfig
  /**
   * The bound ChatSession's `agentModeId`. It supplies the preset and any
   * legacy axis overlay (`plan` implies `authority: "plan"`); the
   * conversation's own axes are layered on top, because a channel's explicit
   * configuration outranks a session-level mode the operator set elsewhere.
   */
  sessionModeId?: string | null
  /**
   * Preset ids that count as known. Defaults to the app catalog (built-ins
   * plus the user's custom and plugin presets); tests and non-app hosts pass
   * their own.
   */
  knownPresetIds?: ReadonlySet<string>
  /** Carried through unchanged so the runtime binding stays ADR-0090's. */
  runtimeBindingRef?: string
}): ImCompositionProjection {
  const { effective } = input
  const target = effective.target.effective

  const knownPresetIds =
    input.knownPresetIds ?? new Set(appPresetCatalog().map((preset) => preset.id))

  return projectEffectiveComposition<ImConfigSource>({
    base: selectionFromLegacyModeId(input.sessionModeId, knownPresetIds).selection,
    // The preset comes from the session's mode, not from the conversation
    // row. Say so rather than claiming a channel-level choice nobody made.
    presetSource: input.sessionModeId ? "session" : "system-default",
    orchestration: {
      policy: target.kind === "team" ? "team" : target.kind === "workflow" ? "workflow" : "direct",
      ...(target.kind === "direct" ? {} : { ref: target.id }),
      source: effective.target.source,
    },
    engagement: effective.engagement,
    autonomy: effective.autonomy,
    authority: effective.authority,
    ...(input.runtimeBindingRef ? { runtimeBindingRef: input.runtimeBindingRef } : {}),
  })
}
