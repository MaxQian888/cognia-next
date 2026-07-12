"use client"

/**
 * Per-message token/cost breakdown.
 *
 * Extracted from `message-renderer` so lightweight surfaces (the mobile
 * `message-action-sheet`) can reuse it without pulling the renderer's heavy
 * `ai-elements` / streamdown dependency chain into their bundle. Rendered in a
 * desktop tooltip and as a plain block in the mobile action sheet.
 */

import { useTranslations } from "next-intl"

import type { UsageInfo } from "@/lib/claude/adapter"

export function UsageBreakdown({ usage }: { usage: UsageInfo }) {
  const t = useTranslations("chat.message")
  return (
    <div className="space-y-0.5 font-mono text-xs">
      <div>{t("usageInput", { n: usage.inputTokens ?? 0 })}</div>
      <div>{t("usageOutput", { n: usage.outputTokens ?? 0 })}</div>
      {usage.reasoningTokens !== undefined && usage.reasoningTokens > 0 && (
        <div>{t("usageReasoning", { n: usage.reasoningTokens })}</div>
      )}
      {usage.cacheReadInputTokens !== undefined && usage.cacheReadInputTokens > 0 && (
        <div>{t("usageCacheHit", { n: usage.cacheReadInputTokens })}</div>
      )}
      {usage.cacheCreationInputTokens !== undefined && usage.cacheCreationInputTokens > 0 && (
        <div>{t("usageCacheWrite", { n: usage.cacheCreationInputTokens })}</div>
      )}
      {usage.totalCostUsd !== undefined && (
        <div>{t("usageCost", { cost: usage.totalCostUsd.toFixed(4) })}</div>
      )}
    </div>
  )
}
