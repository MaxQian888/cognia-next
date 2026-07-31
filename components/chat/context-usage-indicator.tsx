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
import { useShallow } from "zustand/react/shallow"
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
import { ScissorsIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { compactSession } from "@/lib/claude/ipc"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SdkContextUsage } from "@cognia/agent-config-types"
import { resolveModelContextLength } from "@/lib/ai/model-options"
import { estimateCostFromTotals } from "@/lib/usage/session-analytics"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { ContextSourceBreakdown } from "@/components/chat/context-source-breakdown"
import type { UsageDisplayMode } from "@/types/appearance"
import {
  AUTO_COMPACT_FRACTION,
  computeContextWindowUsage,
  contextLevel,
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
  /** Active provider id — disambiguates custom / discovered model metadata. */
  providerId?: string
  /** Override the model-derived window size (mostly for tests). */
  maxTokens?: number
  /** Extra classes for the trigger button (e.g. `ml-auto` on the generic toolbar). */
  triggerClassName?: string
  /**
   * SDK-authoritative context usage (from the live `getContextUsage()` control
   * method). When present, the true window size + occupancy + per-category
   * breakdown replace the message-derived estimate. Absent → estimate path.
   */
  sdkUsage?: SdkContextUsage | null
}

export function ContextUsageIndicator({
  modelId,
  providerId,
  maxTokens,
  triggerClassName,
  sdkUsage,
}: ContextUsageIndicatorProps) {
  const t = useTranslations("chat.composer.toolbar")
  const { mode } = useUsageDisplayMode()
  // Cheap-signature subscription instead of the raw `messages` array: streaming
  // text deltas swap the array reference on every rAF frame, but token usage
  // only moves when a message lands or its `metadata.usage` is merged
  // (message_start / message_delta / result). Subscribing to
  // `[length, latest usage ref]` (getLatestUsage early-exits from the tail, so
  // the per-set selector cost is O(1)) keeps this toolbar indicator — and its
  // two O(n) usage scans below — off the per-token render path.
  const [messageCount, usage] = useChatStore(
    useShallow((s) => [s.messages.length, getLatestUsage(s.messages as UIMessage[])] as const)
  )
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  // Window sizing: an explicit `maxTokens` prop wins (tests / pinned
  // deployments); otherwise the model's declared context length — from the
  // custom, discovered, or built-in catalog, the same source the model picker
  // shows — overrides the curated pattern table, so the indicator and the
  // picker can never disagree about a known model's window.
  const catalogWindow = useMemo(
    () => resolveModelContextLength(modelId, providerId, providerSettings, customProviders),
    [modelId, providerId, providerSettings, customProviders]
  )
  const effectiveMax = maxTokens ?? catalogWindow
  const win = useMemo(() => {
    // SDK-authoritative path: the live query reports the TRUE window size and
    // occupancy (incl. system prompt, tools, memory the estimate can't see).
    if (sdkUsage && sdkUsage.maxTokens > 0) {
      const max = sdkUsage.maxTokens
      const used = sdkUsage.totalTokens
      const fraction = Math.min(1, Math.max(0, used / max))
      return {
        used,
        max,
        fraction,
        remaining: Math.max(0, max - used),
        level: contextLevel(fraction),
        compactThresholdTokens: Math.round(max * AUTO_COMPACT_FRACTION),
      }
    }
    return computeContextWindowUsage(usage, modelId, effectiveMax)
  }, [sdkUsage, usage, modelId, effectiveMax])
  // O(n) over the whole history — recomputed only when the usage signature
  // above moves (a few times per turn), never per streamed token. Reading the
  // array via getState() is safe here: the signature deps pin when it re-runs.
  // `breakdownMessages` hands the popover's source breakdown the same
  // signature-pinned array ref so its own O(n) walk follows the same cadence.
  const { session, breakdownMessages } = useMemo(
    () => {
      const msgs = useChatStore.getState().messages as UIMessage[]
      return { session: sumSessionUsage(msgs), breakdownMessages: msgs }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messageCount/usage ARE the recompute signal for the store read above
    [messageCount, usage]
  )
  // Whole-session billed tokens (every turn re-charges its full prompt), kept
  // distinct from `win.used` (current window occupancy = latest turn only).
  const sessionTokens =
    session.inputTokens +
    session.outputTokens +
    session.cacheReadInputTokens +
    session.cacheCreationInputTokens
  // Session cost: prefer the SDK's own figure (most accurate — it bakes in cache
  // tiers); when absent (ai-sdk / non-Anthropic path reports 0) estimate it from
  // the per-model pricing tables so the read-out isn't stuck at "$0.00".
  const sessionCostUsd =
    session.totalCostUsd > 0
      ? session.totalCostUsd
      : estimateCostFromTotals(session, modelId, providerId)

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
      data-session-cost={sessionCostUsd}
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
                      {sessionCostUsd > 0 ? (
                        <span className="ml-2 text-muted-foreground">
                          {sessionCost.format(sessionCostUsd)}
                        </span>
                      ) : null}
                    </span>
                  }
                />
              </div>
              {sdkUsage ? (
                <SdkBreakdown usage={sdkUsage} mode={mode} />
              ) : (
                <ContextSourceBreakdown messages={breakdownMessages} mode={mode} />
              )}
              <CompactNowButton sessionId={activeSessionId} usedTokens={win.used} />
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
          className={cn("h-full rounded transition-all duration-500", LEVEL_FILL[level])}
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

/**
 * "Compact now" action shown in the context hover card. Routes a manual
 * compaction control message to the sidecar (works on both send paths —
 * `lib/claude/ipc.ts:compactSession`). Disabled with no active session or an
 * empty window (nothing to compact). Exported so it is unit-testable without
 * driving the Radix hover card open in jsdom.
 */
export function CompactNowButton({
  sessionId,
  usedTokens,
}: {
  sessionId: string | null
  usedTokens: number
}) {
  const t = useTranslations("chat.composer.toolbar")
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="mt-1 h-7 w-full justify-start gap-1.5 text-xs"
      disabled={!sessionId || usedTokens === 0}
      onClick={() => {
        if (sessionId) void compactSession(sessionId)
      }}
      data-testid="compact-now-button"
    >
      <ScissorsIcon className="size-3" />
      {t("compactNow")}
    </Button>
  )
}

/**
 * Per-category token breakdown from the SDK's `getContextUsage()` — what is
 * actually occupying the window (system prompt, tools, MCP, memory, agents,
 * commands). Only shown when SDK usage is available; zero-token groups hidden.
 *
 * Verbosity is mode-aware: the simplified usage-display mode hides this detail
 * (the headline ring is enough); standard/detailed keep it.
 */
export function SdkBreakdown({ usage, mode }: { usage: SdkContextUsage; mode?: UsageDisplayMode }) {
  const t = useTranslations("chat.composer.toolbar")
  if (mode === "simplified") return null
  const sum = (arr?: Array<{ tokens: number }>) =>
    (arr ?? []).reduce((acc, x) => acc + (x.tokens ?? 0), 0)
  const rows = [
    {
      key: "systemPrompt",
      label: t("breakdownSystemPrompt"),
      tokens: sum(usage.systemPromptSections),
    },
    { key: "systemTools", label: t("breakdownTools"), tokens: sum(usage.systemTools) },
    { key: "mcp", label: t("breakdownMcp"), tokens: sum(usage.mcpTools) },
    { key: "memory", label: t("breakdownMemory"), tokens: sum(usage.memoryFiles) },
    { key: "agents", label: t("breakdownAgents"), tokens: sum(usage.agents) },
    { key: "commands", label: t("breakdownCommands"), tokens: usage.slashCommands?.tokens ?? 0 },
  ].filter((r) => r.tokens > 0)
  if (rows.length === 0) return null
  return (
    <div className="mt-1.5 space-y-1.5 border-t pt-1.5" data-testid="sdk-breakdown">
      <p className="text-[10px] uppercase text-muted-foreground">{t("breakdownTitle")}</p>
      {rows.map((r) => (
        <UsageRow key={r.key} label={r.label} slot={<span>{compact.format(r.tokens)}</span>} />
      ))}
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
