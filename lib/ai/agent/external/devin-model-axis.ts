/**
 * Devin's thinking axis, folded out of its model list.
 *
 * `devin acp` publishes a single `model` config option whose ids encode
 * (family, effort, serving tier) in one string:
 * `claude-opus-5-high-fast` = Opus 5 / high effort / fast serving,
 * `gpt-5-6-sol-none-priority` = Sol / no thinking / priority serving,
 * `swe-2-max` = SWE-2 / max effort. A bare id inherits the effort its display
 * name ends with (`swe-1-7` → "SWE-1.7 Max"), and a name with no effort tail
 * (`swe-1-6` → "SWE-1.6") has no axis at all. "Thinking" and "Adaptive" are
 * boolean/on-autopilot variants rather than rungs on the effort ladder, so
 * they group into the same family but are never offered as levels.
 *
 * "Fusion" ids pair a lead with a fixed sidekick
 * (`fusion-claude-opus-5-max-sidekick-glm-5-2` → "Fusion (Claude Opus 5 Max +
 * GLM-5.2 High)"): the sidekick effort is part of the recipe, so the axis is
 * only the lead's effort.
 *
 * The synthetic {@link devinThoughtLevelOption} is a `thought_level` select
 * whose values are the effort tokens the CURRENT family offers
 * (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`), in ladder order —
 * the exact same shape `resolveExternalAgentThinking` already resolves and
 * `projectAgentLevels`/`clampThinkingLevel` already project onto the app
 * vocabulary. `devinModelIdForLevel` walks the same table in reverse: the
 * family member whose effort is the requested level becomes the `model`
 * write. Suffixes Devin adds later land inside the family automatically —
 * they just won't be reachable through a level until they use a known token.
 */

import type { AcpConfigOption, AcpConfigOptionValue } from "@/types/agent/external-agent"
import { findModelConfigOption, flattenValues } from "./session-models"

/** Config-option id the synthesized Devin thinking axis answers to. */
export const DEVIN_THOUGHT_LEVEL_OPTION_ID = "devin.thought_level"

/**
 * Effort rungs that can be offered as a `thought_level`. `thinking` (the
 * boolean on/off variant) and `null` (no effort in the name) are deliberately
 * absent: neither is a point on the ladder.
 */
const PUBLISHABLE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

const EFFORT_LABEL: Record<string, string> = {
  none: "No thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

/**
 * Effort phrases a Devin display name can end with, most specific first so
 * "Low Thinking" never degrades into the bare `thinking` tail. The trailing
 * `thinking` entry is LAST for that reason: it only matches when no qualified
 * phrase did.
 */
const EFFORT_TAILS: ReadonlyArray<readonly [string, string]> = [
  [" no thinking", "none"],
  [" xhigh thinking", "xhigh"],
  [" x-high thinking", "xhigh"],
  [" high thinking", "high"],
  [" medium thinking", "medium"],
  [" low thinking", "low"],
  [" max thinking", "max"],
  [" minimal", "minimal"],
  [" none", "none"],
  [" xhigh", "xhigh"],
  [" x-high", "xhigh"],
  [" high", "high"],
  [" medium", "medium"],
  [" low", "low"],
  [" max", "max"],
  [" thinking", "thinking"],
]

/** Serving-tier tails that sit AFTER the effort word in a display name. */
const MODIFIER_TAILS = [" fast", " 1m"] as const

interface DevinModelEntry {
  /** The wire model id — the write target, never the parse input. */
  id: string
  /**
   * Family key: sibling ids that differ ONLY in effort share one. Changing
   * the thinking level must not change the model the user picked, so the key
   * keeps the base name plus serving modifiers (and, for fusions, the fixed
   * sidekick) verbatim.
   */
  family: string
  /** Effort token from the display name, or null when the name carries none. */
  effort: string | null
}

/**
 * Read (base, effort, modifiers) out of a display-name tail. `modifiers` is
 * kept in the family key so `…-fast` and `…-1m` variants do not mix with the
 * standard tier.
 */
function parseNameTail(name: string): { base: string; effort: string | null; mods: string[] } {
  let rest = name.trim().toLowerCase()
  const mods: string[] = []
  for (;;) {
    const tail = MODIFIER_TAILS.find((t) => rest.endsWith(t))
    if (!tail) break
    mods.unshift(tail.trim())
    rest = rest.slice(0, rest.length - tail.length)
  }
  const effort = EFFORT_TAILS.find(([tail]) => rest.endsWith(tail))
  if (effort) rest = rest.slice(0, rest.length - effort[0].length)
  return { base: rest.trim(), effort: effort?.[1] ?? null, mods }
}

/**
 * Classify one catalog value. Fusion entries key on the lead's base plus the
 * sidekick's verbatim name — the sidekick effort is fixed by the recipe, so
 * ids that differ only in the LEAD's effort form the axis.
 */
function parseDevinModelEntry(value: AcpConfigOptionValue): DevinModelEntry {
  const name = (value.name ?? "").trim()
  const fusion = /^fusion \((.+)\)$/i.exec(name)
  if (fusion) {
    const parts = fusion[1].split(" + ")
    if (parts.length >= 2) {
      const lead = parseNameTail(parts[0])
      const family = `fusion:${lead.base}|${lead.mods.join("+")}|${parts.slice(1).join(" + ")}`
      return { id: value.value, family, effort: lead.effort }
    }
    return { id: value.value, family: name.toLowerCase(), effort: null }
  }
  const { base, effort, mods } = parseNameTail(name)
  return { id: value.value, family: `${base}|${mods.join("+")}`, effort }
}

/**
 * The `thought_level` select for the family the option currently sits in.
 * Values are effort tokens (not model ids) so the published vocabulary IS the
 * thinking vocabulary `resolveExternalAgentThinking` resolves against —
 * tokens outside the app surface still fold in through `projectAgentLevels`
 * and `clampThinkingLevel`. `undefined` when the family offers no rung a user
 * can pick, which is the signal callers use to show the control at all.
 */
export function devinThoughtLevelOption(
  modelOption: AcpConfigOption | undefined
): AcpConfigOption | undefined {
  if (modelOption?.type !== "select" || !modelOption.options.length) return undefined
  const entries = flattenValues(modelOption.options).map(parseDevinModelEntry)
  const current = entries.find((e) => e.id === modelOption.currentValue)
  if (!current) return undefined
  const efforts = new Set(
    entries
      .filter((e) => e.family === current.family && e.effort !== null && e.effort !== "thinking")
      .map((e) => e.effort as string)
  )
  const offered = PUBLISHABLE_EFFORTS.filter((e) => efforts.has(e))
  if (!offered.length) return undefined
  return {
    id: DEVIN_THOUGHT_LEVEL_OPTION_ID,
    name: "Thinking level",
    description: "Reasoning effort, applied by switching the model variant",
    category: "thought_level",
    type: "select",
    currentValue: current.effort === "thinking" ? "" : (current.effort ?? ""),
    options: offered.map((effort) => ({ value: effort, name: EFFORT_LABEL[effort] ?? effort })),
  }
}

/**
 * The model id that carries `level` inside the option's CURRENT family —
 * `undefined` when the family has no member at that rung, which the adapter
 * reports back as an unknown level rather than guessing at another family.
 */
export function devinModelIdForLevel(
  modelOption: AcpConfigOption | undefined,
  level: string
): string | undefined {
  if (modelOption?.type !== "select" || !modelOption.options.length) return undefined
  const entries = flattenValues(modelOption.options).map(parseDevinModelEntry)
  const current = entries.find((e) => e.id === modelOption.currentValue)
  if (!current) return undefined
  // The session is already on the requested rung: writing its own id back is
  // the no-op answer, never a gratuitous hop to a sibling alias of that rung.
  if (current.effort === level) return current.id
  return entries.find((e) => e.family === current.family && e.effort === level)?.id
}

/**
 * A raw `configOptions` list with the synthesized axis appended — unless the
 * agent already published a real `thought_level` select, which always wins:
 * the overlay exists to cover what Devin's wire shape lacks, not to shadow a
 * genuine control.
 */
export function withDevinThoughtLevelOption(
  options: AcpConfigOption[] | undefined
): AcpConfigOption[] | undefined {
  if (!options) return options
  if (options.some((o) => o.category === "thought_level" && o.type === "select")) return options
  const synthetic = devinThoughtLevelOption(findModelConfigOption(options))
  return synthetic ? [...options, synthetic] : options
}
