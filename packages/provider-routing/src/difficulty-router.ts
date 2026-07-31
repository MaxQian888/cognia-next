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

import type { RoutingStrategySelector } from "@cognia/provider-types/routing-strategy"
import type {
  RoutingCapabilityRequirements,
  RoutingTaskHints,
  TaskCategory,
  TaskClassification,
} from "@cognia/provider-types/auto-router"
import type { DifficultyRoutingSettings } from "./routing-types"
import { getProviderRoutingRuntimeAdapters } from "./runtime-adapters"
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

/**
 * Choose an Auto alias from the configured low-to-high ladder. Missing tiers
 * degrade toward cheaper enabled aliases first, then climb to the next
 * available tier. This is shared by the planner and the compatibility export
 * under `lib/routing/auto-tier`.
 */
export function pickAutoAlias(
  score: number,
  candidateAliases: readonly string[],
  thresholds: { balanced: number; powerful: number },
  availableAliases: ReadonlySet<string>
): string | undefined {
  if (candidateAliases.length === 0) return undefined
  const target =
    score < thresholds.balanced
      ? 0
      : score < thresholds.powerful
        ? Math.min(1, candidateAliases.length - 1)
        : candidateAliases.length - 1
  const present = (index: number): string | undefined => {
    const alias = candidateAliases[index]?.toLowerCase()
    return alias && availableAliases.has(alias) ? alias : undefined
  }
  for (let index = target; index >= 0; index--) {
    const alias = present(index)
    if (alias) return alias
  }
  for (let index = target + 1; index < candidateAliases.length; index++) {
    const alias = present(index)
    if (alias) return alias
  }
  return undefined
}

function classifyCategory(text: string, hints?: RoutingTaskHints): TaskCategory {
  if (hints?.category) return hints.category
  if (
    hints?.hasCode ||
    /```|\b(code|typescript|javascript|python|rust|debug|refactor)\b|代码|编程|重构|调试/i.test(
      text
    )
  ) {
    return "coding"
  }
  if (/\b(prove|theorem|calculus|equation|math)\b|证明|定理|方程|数学|微积分/i.test(text)) {
    return "math"
  }
  if (/\b(translate|translation)\b|翻译|译成/i.test(text)) return "translation"
  if (/\b(summarize|summary)\b|总结|摘要/i.test(text)) return "summarization"
  if (/\b(research|sources?|literature)\b|研究|资料|文献/i.test(text)) return "research"
  if (/\b(write|story|poem|creative)\b|创作|故事|诗歌/i.test(text)) return "creative"
  if (/\b(analy[sz]e|compare|evaluate)\b|分析|比较|评估/i.test(text)) return "analysis"
  return text.trim() ? "general" : "conversation"
}

/**
 * Deterministic request classification shared by Auto routing and the
 * difficulty strategy. It is local-only and never sends prompt text to a
 * model or plugin.
 */
export function classifyRoutingTask(input: {
  text: string
  estimatedInputTokens?: number
  requirements?: RoutingCapabilityRequirements
  taskHints?: RoutingTaskHints
}): TaskClassification {
  const text = input.text
  const score = scoreDifficulty(text)
  const estimatedInputTokens =
    input.estimatedInputTokens ?? (text.trim() ? Math.ceil(text.length / 3) : 0)
  const category = classifyCategory(text, input.taskHints)
  const hasImage = input.taskHints?.attachmentKinds?.includes("image") ?? false
  const requiresCoding = category === "coding" || Boolean(input.taskHints?.hasCode)
  const requiresReasoning =
    Boolean(input.requirements?.reasoning) ||
    score >= 0.5 ||
    /\b(prove|reason|step[- ]by[- ]step)\b|证明|推理|逐步/i.test(text)

  return {
    difficultyScore: score,
    complexity:
      score < 0.2 ? "simple" : score < 0.5 ? "moderate" : score < 0.75 ? "complex" : "expert",
    category,
    requiresReasoning,
    requiresTools: Boolean(input.requirements?.tools),
    requiresVision: Boolean(input.requirements?.vision || hasImage),
    requiresCreativity: category === "creative",
    requiresCoding,
    requiresLongContext:
      estimatedInputTokens > 32_000 ||
      Boolean(input.requirements?.minContextTokens && input.requirements.minContextTokens > 32_000),
    estimatedInputTokens,
    estimatedOutputTokens: requiresReasoning || requiresCoding ? 4096 : 1024,
    confidence: Math.min(
      0.95,
      0.55 +
        (category !== "general" && category !== "conversation" ? 0.15 : 0) +
        (requiresReasoning ? 0.1 : 0) +
        (input.taskHints?.attachmentKinds?.length ? 0.1 : 0)
    ),
  }
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
  return getProviderRoutingRuntimeAdapters().getDifficultyRoutingSettings()
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
