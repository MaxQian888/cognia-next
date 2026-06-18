/**
 * Heuristic difficulty router (RouteLLM-lite).
 *
 * A registered routing strategy (`id: "difficulty"`) that scores the
 * outgoing prompt 0–1 with cheap lexical heuristics (length, code
 * blocks, multi-step/reasoning keywords) and picks the user-configured
 * STRONG model at/above the threshold, the WEAK model below it. No
 * trained classifier, no network — RouteLLM's win-rate threshold idea
 * reduced to a deterministic desktop heuristic.
 *
 * Inert until configured: when the settings block is disabled or the
 * model pair is missing, selection falls back to chain order. The
 * selector never throws (engine contract).
 */

import type { ModelMappingEntry } from "@/types/provider/model-mapping"
import type { RoutingStrategySelector } from "@/types/provider/routing-strategy"
import type { DifficultyRoutingSettings } from "@/types/routing/tool-route"
import { getRoutingStrategy, registerRoutingStrategy } from "./strategy-registry"

/** Reasoning/complexity markers (EN + zh) — each hit raises the score. */
const COMPLEXITY_KEYWORDS: ReadonlyArray<RegExp> = [
  // One pattern per SEMANTIC group (EN + zh together) so hit counting
  // weighs both languages identically.
  /step[- ]by[- ]step|multi[- ]step|逐步|一步一步|思考链/i,
  /\bprove\b|\bproof\b|\btheorem\b|证明|定理|推理/i,
  /\banaly[sz]e\b|\banalysis\b|分析|评估/i,
  /\bimplement\b|\brefactor\b|\bdebug\b|实现|重构|调试/i,
  /\balgorithm\b|\boptimi[sz]e\b|\barchitecture\b|算法|优化|架构|设计方案/i,
  /\bmath\b|\bcalculus\b|\bderivative\b|数学|微积分|导数/i,
]

/**
 * Score a prompt's difficulty into [0, 1]. Deterministic and cheap
 * (O(text length), no awaits).
 */
export function scoreDifficulty(text: string): number {
  if (!text.trim()) return 0
  let score = 0

  // Length: long prompts usually carry more context/constraints.
  score += Math.min(text.length / 2000, 1) * 0.3

  // Code: fenced blocks are a strong signal, inline code a weak one.
  if (/```/.test(text)) {
    score += 0.25
  } else if (/`[^`\n]+`/.test(text)) {
    score += 0.1
  }

  // Reasoning keywords, capped so keyword stuffing saturates.
  let keywordHits = 0
  for (const pattern of COMPLEXITY_KEYWORDS) {
    if (pattern.test(text)) keywordHits++
  }
  score += Math.min(keywordHits * 0.15, 0.3)

  // Structural complexity: many sentences/questions.
  const sentences = text.split(/[.!?。!?]+/).filter((s) => s.trim().length > 0)
  if (sentences.length > 5) score += 0.1

  return Math.min(1, score)
}

/** Pure selector core — settings injected for deterministic tests. */
export function createDifficultySelector(
  getSettings: () => DifficultyRoutingSettings | undefined
): RoutingStrategySelector {
  return {
    id: "difficulty",
    label: "Difficulty (strong/weak)",
    select: (entries, _telemetry, ctx) => {
      if (entries.length === 0) return null
      const settings = getSettings()
      if (!settings?.enabled || !settings.strongModel || !settings.weakModel) {
        return entries[0]
      }
      const score = scoreDifficulty(ctx?.promptText ?? "")
      const target = score >= settings.threshold ? settings.strongModel : settings.weakModel

      const exact = entries.find(
        (e) => e.providerId === target.providerId && e.modelId === target.modelId
      )
      if (exact) return exact
      // The configured pair may not be in this alias's chain — fall back to
      // the same provider, then chain order.
      const sameProvider = entries.find((e) => e.providerId === target.providerId)
      return sameProvider ?? entries[0]
    },
  }
}

function readSettings(): DifficultyRoutingSettings | undefined {
  try {
    // Lazy require keeps the zustand store out of non-renderer bundles.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useSettingsStore } = require("@/stores/settings") as {
      useSettingsStore: {
        getState: () => { settings?: { difficultyRouting?: DifficultyRoutingSettings } }
      }
    }
    return useSettingsStore.getState().settings?.difficultyRouting
  } catch {
    return undefined
  }
}

/**
 * Host registration — module import is the side effect (build-preview-engine
 * imports this, so every engine construction has it). Presence-checked
 * rather than flag-guarded so a test-time overlay reset re-registers.
 */
export function ensureDifficultyStrategyRegistered(): void {
  if (getRoutingStrategy("difficulty")) return
  registerRoutingStrategy(createDifficultySelector(readSettings))
}

ensureDifficultyStrategyRegistered()
