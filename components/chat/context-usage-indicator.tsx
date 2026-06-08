"use client"

/**
 * ContextUsageIndicator — the single token / context-window read-out shown
 * under the composer (generic + workflow toolbars both mount this). It is the
 * consolidation of the two former copies (the inline `<Context>` blocks in
 * `bottom-toolbar` / `workflow-bottom-toolbar`) plus the deleted header
 * `ContextGauge`, all of which used to size the window differently.
 *
 * Faithful to Claude Code / Codex: the ring tints green → amber → red as the
 * window fills, and the hover card draws the auto-compact threshold as a
 * marker on the fill bar. All window sizing flows through the one source of
 * truth in `lib/claude/usage.ts`.
 *
 * The vendored `ai-elements/context.tsx` is reused untouched — color + the
 * threshold marker are layered via its `children` override slots.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { LanguageModelUsage, UIMessage } from "ai"
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextTrigger,
} from "@/components/ai-elements/context"
import { useChatStore } from "@/stores/chat"
import { cn } from "@/lib/utils"
import type { UsageInfo } from "@/lib/claude/adapter"
import {
  AUTO_COMPACT_FRACTION,
  computeContextWindowUsage,
  getLatestUsage,
  sumSessionUsage,
  type ContextLevel,
} from "@/lib/claude/usage"

const LEVEL_TEXT: Record<ContextLevel, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  crit: "text-red-500",
}

const LEVEL_FILL: Record<ContextLevel, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  crit: "bg-red-500",
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact" })
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" })
const sessionCost = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
})

interface ContextUsageIndicatorProps {
  /** Model id used to size the context window. */
  modelId?: string
  /** Override the model-derived window size (mostly for tests). */
  maxTokens?: number
  /** Extra classes for the trigger button (e.g. `ml-auto` on the generic toolbar). */
  triggerClassName?: string
}

export function ContextUsageIndicator({
  modelId,
  maxTokens,
  triggerClassName,
}: ContextUsageIndicatorProps) {
  const t = useTranslations("chat.composer.toolbar")
  const messages = useChatStore((s) => s.messages)

  const usage = useMemo<UsageInfo | null>(() => getLatestUsage(messages as UIMessage[]), [messages])
  const win = useMemo(
    () => computeContextWindowUsage(usage, modelId, maxTokens),
    [usage, modelId, maxTokens]
  )
  const session = useMemo(() => sumSessionUsage(messages as UIMessage[]), [messages])
  // Whole-session billed tokens (every turn re-charges its full prompt), kept
  // distinct from `win.used` (current window occupancy = latest turn only).
  const sessionTokens =
    session.inputTokens +
    session.outputTokens +
    session.cacheReadInputTokens +
    session.cacheCreationInputTokens

  // Map `UsageInfo` (snake-cased upstream, camelCased here) to the
  // `LanguageModelUsage` shape the AI Elements body + cost footer consume.
  const aiUsage: LanguageModelUsage | undefined = usage
    ? ({
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens:
          (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
        totalTokens: win.used,
      } as unknown as LanguageModelUsage)
    : undefined

  return (
    <div
      data-testid="context-usage-indicator"
      data-used-tokens={win.used}
      data-max-tokens={win.max}
      data-session-tokens={sessionTokens}
    >
      <Context maxTokens={win.max} modelId={modelId} usage={aiUsage} usedTokens={win.used}>
        <ContextTrigger
          className={cn(
            "h-6 gap-1.5 px-1.5 text-[11px] font-normal",
            LEVEL_TEXT[win.level],
            triggerClassName
          )}
        />
        <ContextContent>
          <ContextContentHeader>
            <ContextWindowHeader
              fraction={win.fraction}
              level={win.level}
              used={win.used}
              max={win.max}
            />
          </ContextContentHeader>
          <ContextContentBody>
            <div className="space-y-1.5">
              <UsageRow label={t("usageInput")} slot={<ContextInputUsage />} />
              <UsageRow label={t("usageOutput")} slot={<ContextOutputUsage />} />
              <UsageRow label={t("usageCached")} slot={<ContextCacheUsage />} />
              <div className="mt-1.5 space-y-1.5 border-t pt-1.5" data-testid="session-total">
                <UsageRow
                  label={t("sessionTotal", { turns: session.turns })}
                  slot={
                    <span>
                      {compact.format(sessionTokens)}
                      {session.totalCostUsd > 0 ? (
                        <span className="ml-2 text-muted-foreground">
                          {sessionCost.format(session.totalCostUsd)}
                        </span>
                      ) : null}
                    </span>
                  }
                />
              </div>
            </div>
          </ContextContentBody>
          <ContextContentFooter />
        </ContextContent>
      </Context>
    </div>
  )
}

export function ContextWindowHeader({
  fraction,
  level,
  used,
  max,
}: {
  fraction: number
  level: ContextLevel
  used: number
  max: number
}) {
  const t = useTranslations("chat.composer.toolbar")
  const thresholdPct = percent.format(AUTO_COMPACT_FRACTION)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <p>{percent.format(fraction)}</p>
        <p className="font-mono text-muted-foreground">
          {compact.format(used)} / {compact.format(max)}
        </p>
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("contextUsageAria", { pct: percent.format(fraction) })}
        data-testid="context-window-bar"
        data-level={level}
      >
        <div
          className={cn("h-full rounded", LEVEL_FILL[level])}
          style={{ width: `${fraction * 100}%` }}
        />
        {/* Auto-compact threshold marker. */}
        <div
          className="absolute inset-y-0 w-px bg-foreground/60"
          style={{ left: `${AUTO_COMPACT_FRACTION * 100}%` }}
          data-testid="context-compact-marker"
        />
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t("compactThreshold", { pct: thresholdPct })}
      </p>
    </div>
  )
}

export function UsageRow({ label, slot }: { label: string; slot: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{slot}</span>
    </div>
  )
}

export default ContextUsageIndicator
