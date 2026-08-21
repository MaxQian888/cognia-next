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
  RoutingDifficultySignals,
  RoutingDifficultyTier,
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

/** Empty contribution set — the shape every signal path starts from. */
const NO_SIGNALS: RoutingDifficultySignals = {
  length: 0,
  code: 0,
  keywords: 0,
  structure: 0,
  attachments: 0,
  threadDepth: 0,
  tools: 0,
  effortFloor: 0,
}

/**
 * A user who picked an effort level already answered "how hard is this?".
 * Treating it as a FLOOR rather than a term respects that answer without
 * letting it override evidence pointing higher.
 */
const EFFORT_FLOOR: Record<string, number> = {
  low: 0,
  medium: 0,
  high: 0.5,
  xhigh: 0.7,
  max: 0.8,
}

export interface DeterministicDifficultyInput {
  text: string
  taskHints?: RoutingTaskHints
  requirements?: RoutingCapabilityRequirements
}

/**
 * Score difficulty from every signal the request already carries.
 *
 * `scoreDifficulty(text)` stays exactly as it was — four callers depend on the
 * one-argument form, and the text-only score is still the backbone here. What
 * this adds is the context the router already had and never read: attachments,
 * thread depth, tool reach, and the effort the user explicitly asked for.
 *
 * Still O(text) with no awaits. The <40ms budget is a property of the code
 * shape, not of a timer — which is why it is asserted structurally rather than
 * measured.
 */
export function deterministicDifficulty(input: DeterministicDifficultyInput): {
  score: number
  signals: RoutingDifficultySignals
} {
  const text = input.text ?? ""
  const signals: RoutingDifficultySignals = { ...NO_SIGNALS }

  signals.length = Math.min(text.length / 2000, 1) * 0.3
  signals.code = /```/.test(text) ? 0.25 : /`[^`\n]+`/.test(text) ? 0.1 : 0
  let keywordHits = 0
  for (const pattern of COMPLEXITY_KEYWORDS) {
    if (pattern.test(text)) keywordHits++
  }
  signals.keywords = text.trim() ? Math.min(keywordHits * 0.15, 0.3) : 0
  const sentences = text.split(/[.!?。!?]+/).filter((part) => part.trim().length > 0)
  signals.structure = sentences.length > 5 ? 0.1 : 0

  // A non-text modality is more than a capability requirement: reading a
  // screenshot or a document is a harder task than answering the same sentence.
  const attachments = input.taskHints?.attachmentKinds ?? []
  if (attachments.length > 0) {
    const heavy = attachments.some((kind) => kind !== "image")
    signals.attachments = Math.min(0.1 + attachments.length * 0.05, heavy ? 0.25 : 0.2)
  } else if (input.requirements?.vision) {
    signals.attachments = 0.1
  }

  // Thread depth: more prior constraints to hold, and a request that has
  // already survived several turns is rarely the trivial one.
  const messageCount = input.taskHints?.messageCount ?? 0
  signals.threadDepth = messageCount > 4 ? Math.min((messageCount - 4) * 0.02, 0.15) : 0

  // Tool reach: a turn that can act on the world is more consequential than
  // one that can only answer. Bounded low — reach is not the same as need.
  const toolCount = input.taskHints?.toolCount ?? (input.requirements?.tools ? 1 : 0)
  signals.tools = toolCount > 0 ? Math.min(0.05 + toolCount * 0.01, 0.15) : 0

  const summed = Math.min(
    1,
    signals.length +
      signals.code +
      signals.keywords +
      signals.structure +
      signals.attachments +
      signals.threadDepth +
      signals.tools
  )
  signals.effortFloor = EFFORT_FLOOR[input.taskHints?.requestedEffort ?? "low"] ?? 0
  return { score: Math.max(summed, signals.effortFloor), signals }
}

/** Which tier a score falls in, given the configured cut points. */
export function difficultyTier(
  score: number,
  thresholds: { balanced: number; powerful: number }
): RoutingDifficultyTier {
  if (score < thresholds.balanced) return "fast"
  return score < thresholds.powerful ? "balanced" : "powerful"
}

/**
 * True when the score sits close enough to a cut point that a second opinion
 * could change the answer.
 *
 * This is the whole cost-control mechanism. The deterministic score always
 * runs; the judge is consulted only here, so an unambiguous prompt pays
 * nothing and the median request gains 0 ms.
 */
export function isAmbiguousDifficulty(
  score: number,
  thresholds: { balanced: number; powerful: number },
  band: number
): boolean {
  if (band <= 0) return false
  return (
    Math.abs(score - thresholds.balanced) <= band || Math.abs(score - thresholds.powerful) <= band
  )
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
