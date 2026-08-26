/**
 * The four named IM behaviour modes, as a projection over the composition axes.
 *
 * ## Why a preset layer at all
 *
 * The axes are the truth — `autonomy` decides whether a turn runs and whether
 * its product ships, `engagement` decides where it runs — but "does this bot
 * answer, and does a human sign off" is one question to an operator, not two
 * dropdowns. The presets name the four combinations that are actually
 * meaningful, and the advanced editor stays available for the rest.
 *
 * ## Why a preset writes only what distinguishes it
 *
 * `engagement` normally FOLLOWS the execution target: a conversation bound to
 * a team runs in the background because that is where a team's product lands.
 * Writing an explicit `engagement` freezes that, so a preset only does it when
 * the freeze IS the choice — `delegate` means "run this in the background"
 * and `silent` means "this belongs to a person". `assistant` and `draft` leave
 * engagement derived, so binding a team later keeps working.
 *
 * ## Why `delegate` can be unavailable
 *
 * `engagement: "background"` currently only has a carrier when there is a team
 * or workflow to carry it: a single-agent background run mints no
 * `ExecutionRun`, so the conversation would sit on a value nothing acts on.
 * Rather than ship an option that silently does nothing, `delegate` reports
 * itself unavailable until a target is bound — which is what the settings UI
 * renders as a disabled row with a reason.
 */

import type { AutonomyLevel, EngagementMode } from "@cognia/agent-config-types/agent-composition"

import type { ConnectorMode } from "@/types/connectors/policy"

import { connectorModeFromComposition, type ImTargetKind } from "./mode-projection"

export const IM_MODE_PRESET_IDS = ["assistant", "delegate", "draft", "silent"] as const
export type ImModePresetId = (typeof IM_MODE_PRESET_IDS)[number]

/** What the picker shows when the stored axes match no named preset. */
export const IM_MODE_CUSTOM = "custom" as const
export type ImModeSelection = ImModePresetId | typeof IM_MODE_CUSTOM

/** The axis values a preset writes. `undefined` means "leave it derived". */
export interface ImModePresetAxes {
  autonomy: AutonomyLevel
  engagement?: EngagementMode
}

export const IM_MODE_PRESETS: Readonly<Record<ImModePresetId, ImModePresetAxes>> = {
  /** Answers in the thread, acting on its own. Engagement follows the target. */
  assistant: { autonomy: "act" },
  /** Runs the work in the background and reports progress back. */
  delegate: { autonomy: "act", engagement: "background" },
  /** Produces a reply and holds it for a human to send. */
  draft: { autonomy: "suggest" },
  /** Records the conversation; a person answers it. */
  silent: { autonomy: "observe", engagement: "human" },
}

/**
 * Which preset a stored pair of axes represents, or `custom`.
 *
 * Order matters: `human`/`observe` is `silent` whatever else is set, because
 * neither runs a turn at all.
 */
export function imModePresetFor(input: {
  autonomy: AutonomyLevel
  engagement: EngagementMode
}): ImModeSelection {
  if (input.engagement === "human" || input.autonomy === "observe") return "silent"
  if (input.autonomy === "suggest") return "draft"
  if (input.autonomy !== "act") return IM_MODE_CUSTOM
  return input.engagement === "background" ? "delegate" : "assistant"
}

/** Why a preset cannot be chosen here, or `null` when it can. */
export type ImModeUnavailableReason = "delegate_needs_target"

export function imModePresetUnavailableReason(
  preset: ImModePresetId,
  targetKind: ImTargetKind
): ImModeUnavailableReason | null {
  // See the module docblock: background has no carrier without a team or
  // workflow, so offering it would be offering a value nothing acts on.
  if (preset === "delegate" && targetKind === "direct") return "delegate_needs_target"
  return null
}

/**
 * The patch that selecting `preset` writes.
 *
 * `engagement: undefined` is an explicit clear, not an omission: switching
 * from `delegate` back to `assistant` has to REMOVE the frozen background
 * value, or the conversation keeps running in the background under a preset
 * that says it answers inline.
 *
 * `mode` is mirrored alongside so `InboxSendPolicy.forcedMode`, the scheduled
 * digest path and any client predating the axes keep reading the same answer.
 */
export function imModePresetPatch(preset: ImModePresetId): {
  autonomy: AutonomyLevel
  engagement: EngagementMode | undefined
  mode: ConnectorMode
} {
  const axes = IM_MODE_PRESETS[preset]
  return {
    autonomy: axes.autonomy,
    engagement: axes.engagement,
    // The mirror needs a concrete engagement; a preset that leaves it derived
    // is inline for mirroring purposes, which is what the three-value mirror
    // has always meant for a bot that answers.
    mode: connectorModeFromComposition(axes.autonomy, axes.engagement ?? "inline"),
  }
}
