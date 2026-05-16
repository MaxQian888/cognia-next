"use client"

/**
 * ContextGauge — header-mounted ring chart showing how much of the model's
 * context window the active chat session has consumed. Reads token usage
 * from the most-recent assistant message's `metadata.usage` and combines it
 * with a model-specific window size to render an `ai-elements/context.tsx`
 * ring + hover-card breakdown.
 *
 * When no usage has been recorded yet (fresh session) the gauge renders
 * `null` rather than a misleading 0 / N ring.
 */

import { useMemo } from "react"
import type { UIMessage } from "ai"
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context"
import { useChatStore } from "@/stores/chat"
import type { UsageInfo } from "@/lib/claude/adapter"

/**
 * Conservative defaults for the major Claude tiers. Models we don't recognise
 * fall back to 200k which is the standard Claude 4.X window.
 */
const CONTEXT_WINDOW_BY_PREFIX: Array<[RegExp, number]> = [
  [/claude-opus-4-7\[1m\]/i, 1_000_000],
  [/claude-opus-4/i, 200_000],
  [/claude-sonnet-4/i, 200_000],
  [/claude-haiku-4/i, 200_000],
  [/claude-3-5-sonnet/i, 200_000],
  [/claude-3-5-haiku/i, 200_000],
  [/claude-3-opus/i, 200_000],
  [/gpt-4o/i, 128_000],
  [/o1-/i, 200_000],
  [/gemini-1\.5/i, 1_000_000],
]

const DEFAULT_CONTEXT_WINDOW = 200_000

export function contextWindowForModel(model: string | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW
  for (const [re, size] of CONTEXT_WINDOW_BY_PREFIX) {
    if (re.test(model)) return size
  }
  return DEFAULT_CONTEXT_WINDOW
}

interface ContextGaugeProps {
  /** Model id used to size the context window. */
  modelId?: string
  /** Override the model-derived window size. */
  maxTokens?: number
  className?: string
}

export function ContextGauge({ modelId, maxTokens, className }: ContextGaugeProps) {
  const messages = useChatStore((s) => s.messages)

  const usage = useMemo<UsageInfo | undefined>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as UIMessage & { metadata?: { usage?: UsageInfo } }
      if (m.role === "assistant" && m.metadata?.usage) {
        return m.metadata.usage
      }
    }
    return undefined
  }, [messages])

  const max = maxTokens ?? contextWindowForModel(modelId)
  const used = useMemo(() => {
    if (!usage) return 0
    return (
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0)
    )
  }, [usage])

  if (!usage) return null

  // Shape adapter — `ai-elements/context.tsx` consumes LanguageModelUsage
  // (camelCase fields). Map our UsageInfo into the shape it expects.
  const usageForRing = {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
    reasoningTokens: 0,
    totalTokens: used,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  }

  return (
    <div
      data-testid="context-gauge"
      data-used-tokens={used}
      data-max-tokens={max}
      className={className}
    >
      <Context usedTokens={used} maxTokens={max} usage={usageForRing} modelId={modelId}>
        <ContextTrigger />
        <ContextContent>
          <ContextContentHeader />
          <ContextContentBody>
            <ContextInputUsage />
            <ContextOutputUsage />
            <ContextReasoningUsage />
            <ContextCacheUsage />
          </ContextContentBody>
          <ContextContentFooter />
        </ContextContent>
      </Context>
    </div>
  )
}

export default ContextGauge
