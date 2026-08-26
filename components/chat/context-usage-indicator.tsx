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
 * The popover reads top-down as: how full is the window → what did the last
 * turn cost → what is actually in the window (collapsible detail) → act on it.
 * Every row keeps a value at all times: a fresh session shows "—" rather than
 * an empty column, which is what made the panel look broken before the first
 * reply landed.
 *
 * The vendored `ai-elements/context.tsx` is reused untouched — color, the
 * threshold marker and the footer are layered via its `children` override slots.
 */

import { useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import type { UIMessage } from "ai"
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
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
import { priceTokensForModel, type CostTokens } from "@/lib/usage/pricing"
import { useUsageDisplayMode } from "@/hooks/usage/use-usage-display-mode"
import { useOptionalChatScope } from "@/components/chat/chat-scope-provider"
import { ContextDetailPanel } from "@/components/chat/context-detail-panel"
import {
  buildEstimateContextBreakdown,
  buildSdkContextBreakdown,
  resolveAutoCompaction,
  type AutoCompactionPolicy,
} from "@/lib/claude/context-breakdown"
import type { UsageInfo } from "@/lib/claude/adapter"
import {
  AUTO_COMPACT_FRACTION,
  computeContextWindowUsage,
  contextLevel,
  getLatestRunProviderId,
  getLatestUsage,
  sumSessionUsage,
  type ContextLevel,
  type SessionUsageTotals,
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

/** Em dash for "not known yet" — distinct from a real, measured zero. */
const UNKNOWN = "—"

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
  // Detail-panel disclosure lives here, not in the panel: the hover card
  // unmounts its content on close, so state held inside would reset on every
  // re-open. `detailed` display mode opens the section by default.
  //
  // Null until the user touches the section; from then on their choice wins.
  // The default has to be DERIVED rather than seeded into `useState`: `mode`
  // comes from the settings store, which hydrates after this mounts, so a
  // one-shot initializer always captured the pre-hydration `"standard"` and
  // the `detailed` preference never took effect at all.
  const [detailChoice, setDetailChoice] = useState<boolean | null>(null)
  const detailOpen = detailChoice ?? mode === "detailed"
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
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
        reported: true,
        windowSource: "agent" as const,
      }
    }
    return computeContextWindowUsage(usage, modelId, effectiveMax)
  }, [sdkUsage, usage, modelId, effectiveMax])
  // O(n) over the whole history — recomputed only when the usage signature
  // above moves (a few times per turn), never per streamed token. Reading the
  // array via getState() is safe here: the signature deps pin when it re-runs.
  // `breakdown` walks the same signature-pinned array ref, so the popover's
  // detail follows the same cadence.
  const { session, breakdown, agentOwned, assistantTurns } = useMemo(
    () => {
      const msgs = useChatStore.getState().messages as UIMessage[]
      return {
        session: sumSessionUsage(msgs),
        assistantTurns: msgs.reduce((acc, m) => acc + (m.role === "assistant" ? 1 : 0), 0),
        // The lane the newest turn actually ran on. Every external protocol
        // reports `context-management: unsupported`, so an external turn's
        // compaction is the agent's business, not the sidecar's.
        agentOwned: getLatestRunProviderId(msgs) === "external",
        breakdown:
          sdkUsage && sdkUsage.maxTokens > 0
            ? buildSdkContextBreakdown(sdkUsage)
            : buildEstimateContextBreakdown(msgs, win.used, win.max),
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messageCount/usage ARE the recompute signal for the store read above
    [messageCount, usage, sdkUsage, win.used, win.max]
  )
  const compaction = resolveAutoCompaction(sdkUsage, {
    occupancyReported: win.reported,
    agentOwned,
  })
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

  return (
    <div
      data-testid="context-usage-indicator"
      data-used-tokens={win.used}
      data-max-tokens={win.max}
      data-session-tokens={sessionTokens}
      data-session-cost={sessionCostUsd}
      data-compaction={compaction.source}
      data-window-source={win.windowSource}
    >
      <Context
        maxTokens={win.max}
        modelId={modelId}
        usedTokens={win.used}
        openDelay={80}
        closeDelay={200}
      >
        <ContextTrigger>
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "h-6 gap-1.5 px-1.5 text-[11px] font-normal",
              win.reported ? LEVEL_TEXT[win.level] : "text-muted-foreground",
              triggerClassName
            )}
            data-testid="context-trigger"
            data-reported={win.reported}
            aria-label={
              win.reported
                ? t("contextUsageAria", { pct: percent.format(win.fraction) })
                : t("windowUnknown")
            }
          >
            <span className="font-medium">
              {win.reported ? percent.format(win.fraction) : UNKNOWN}
            </span>
            <ContextRing fraction={win.reported ? win.fraction : 0} muted={!win.reported} />
          </Button>
        </ContextTrigger>
        <ContextContent className="w-72">
          <ContextContentHeader>
            <ContextWindowHeader
              title={t("contextTitle")}
              fraction={win.fraction}
              level={win.level}
              used={win.used}
              max={win.max}
              reported={win.reported}
              compaction={compaction}
            />
          </ContextContentHeader>
          <ContextContentBody>
            <div className="space-y-1.5">
              <ContextTurnSummary
                usage={usage}
                session={session}
                modelId={modelId}
                providerId={providerId}
                assistantTurns={assistantTurns}
              />
              {mode === "simplified" ? null : (
                <ContextDetailPanel
                  breakdown={breakdown}
                  open={detailOpen}
                  onOpenChange={setDetailChoice}
                  expanded={expandedGroups}
                  onExpandedChange={setExpandedGroups}
                />
              )}
              <CompactNowButton
                sessionId={activeSessionId}
                usedTokens={win.used}
                // The sidecar can only compact sessions it runs. An external
                // agent owns its own history, so the control would post a
                // frame into the void — an enabled button that does nothing.
                supported={compaction.source !== "agent-owned"}
              />
            </div>
          </ContextContentBody>
          <ContextContentFooter>
            <span className="text-muted-foreground">{t("sessionCost")}</span>
            <span className="font-mono tabular-nums">
              {sessionCostUsd > 0 ? sessionCost.format(sessionCostUsd) : UNKNOWN}
            </span>
          </ContextContentFooter>
        </ContextContent>
      </Context>
    </div>
  )
}

/**
 * Latest-turn + whole-session token read-out.
 *
 * Every row always carries a value: an em dash before the first reply lands,
 * a real number after. The previous version delegated these three rows to the
 * vendored `Context*Usage` slots, which render `null` at zero tokens — so a
 * fresh session (and, because of a field-name mismatch, the cache row at every
 * size) showed a label with an empty column next to it.
 *
 * Exported so it is unit-testable without driving the Radix hover card open.
 */
export function ContextTurnSummary({
  usage,
  session,
  modelId,
  providerId,
  assistantTurns = 0,
}: {
  usage: UsageInfo | null
  session: SessionUsageTotals
  modelId?: string
  providerId?: string
  /**
   * Assistant turns in the transcript, usage-bearing or not. Separates "nothing
   * has run yet" from "turns ran and this runtime reports no tokens" — the GUI
   * external-agent lane is the second case, and calling it the first was a lie
   * about which fact is missing.
   */
  assistantTurns?: number
}) {
  const t = useTranslations("chat.composer.toolbar")
  const sessionTokens =
    session.inputTokens +
    session.outputTokens +
    session.cacheReadInputTokens +
    session.cacheCreationInputTokens
  // Per FIELD, not per object. An ACP agent reports context occupancy with no
  // prompt/completion split at all, so `inputTokens` is absent — printing that
  // as `0` would claim the turn cost nothing. Absent stays "—"; a reported zero
  // still prints 0.
  const cacheFields = [usage?.cacheReadInputTokens, usage?.cacheCreationInputTokens]
  const turnCached = cacheFields.some((v) => v !== undefined)
    ? cacheFields.reduce<number>((acc, v) => acc + (v ?? 0), 0)
    : null
  // Each row carries the billing UNITS it stands for, not just a token count:
  // the cached row merges reads and writes for display, but those bill at very
  // different rates (a write is ~1.25x the base input rate, a read ~0.1x), so
  // pricing the merged number as if it were all cache reads under-reported a
  // cache-priming turn by an order of magnitude.
  const slices: Array<{ key: string; label: string; tokens: number | null; units: CostTokens }> = [
    {
      key: "input",
      label: t("usageInput"),
      tokens: usage?.inputTokens ?? null,
      units: { inputTokens: usage?.inputTokens ?? 0 },
    },
    {
      key: "output",
      label: t("usageOutput"),
      tokens: usage?.outputTokens ?? null,
      units: { outputTokens: usage?.outputTokens ?? 0 },
    },
    {
      key: "cached",
      label: t("usageCached"),
      tokens: turnCached,
      units: {
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
      },
    },
  ]
  return (
    <div className="space-y-1.5" data-testid="context-turn-summary">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("latestTurn")}
      </p>
      {slices.map((slice) => (
        <UsageRow
          key={slice.key}
          label={slice.label}
          slot={
            <TokenSlice
              tokens={slice.tokens}
              cost={slice.tokens ? sliceCost(providerId, modelId, slice.units) : undefined}
            />
          }
        />
      ))}
      {session.turns === 0 ? (
        <p className="pt-0.5 text-[10px] text-muted-foreground">
          {assistantTurns > 0 ? t("usageNotReported") : t("noUsageYet")}
        </p>
      ) : null}
      <div className="mt-1.5 space-y-1.5 border-t pt-1.5" data-testid="session-total">
        <UsageRow
          label={t("sessionTotal", { turns: session.turns })}
          // A completed turn always spends tokens, so a zero here means the
          // runtime reported none — unknown, not free.
          slot={<span>{sessionTokens > 0 ? compact.format(sessionTokens) : UNKNOWN}</span>}
        />
      </div>
    </div>
  )
}

/**
 * Price one slice of the latest turn. Returns `undefined` when no pricing layer
 * knows the model — formatting an unpriced model as "$0.00" is what made a free
 * model and an unknown one indistinguishable.
 */
function sliceCost(
  providerId: string | undefined,
  modelId: string | undefined,
  units: CostTokens
): string | undefined {
  if (!modelId) return undefined
  const { cost, known } = priceTokensForModel(providerId, modelId, units)
  if (!known || cost <= 0) return undefined
  return sessionCost.format(cost)
}

function TokenSlice({ tokens, cost }: { tokens: number | null; cost?: string }) {
  if (tokens === null) return <span className="text-muted-foreground">{UNKNOWN}</span>
  return (
    <span className="tabular-nums">
      {compact.format(tokens)}
      {cost ? <span className="ml-2 text-muted-foreground">{cost}</span> : null}
    </span>
  )
}

export function ContextWindowHeader({
  fraction,
  level,
  used,
  max,
  title,
  reported = true,
  compaction,
}: {
  fraction: number
  level: ContextLevel
  used: number
  max: number
  /**
   * Optional heading. With it the header reads title → percent → bar →
   * threshold + size (the composer popover); without it the original
   * percent-left / size-right layout is preserved for the diagnostics card.
   */
  title?: string
  /**
   * False when the runtime published no usage at all. The bar then shows an
   * empty muted track and the read-out says "—": an unknown occupancy is not
   * an empty window, and rendering 0% asserts something no one measured.
   */
  reported?: boolean
  /**
   * Resolved auto-compaction policy. Absent → the built-in sidecar default,
   * which is what every non-composer caller is looking at.
   */
  compaction?: AutoCompactionPolicy
}) {
  const t = useTranslations("chat.composer.toolbar")
  const policy: AutoCompactionPolicy = compaction ?? {
    threshold: AUTO_COMPACT_FRACTION,
    enabled: true,
    source: "builtin",
  }
  const size = `${compact.format(used)} / ${compact.format(max)}`
  const shown = reported ? percent.format(fraction) : UNKNOWN
  const note =
    policy.threshold !== null
      ? t("compactThreshold", { pct: percent.format(policy.threshold) })
      : policy.source === "agent-owned"
        ? t("compactAgentOwned")
        : policy.source === "sdk"
          ? t("compactDisabled")
          : t("windowUnknown")
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        {title ? <p className="truncate font-medium">{title}</p> : <p>{shown}</p>}
        {title ? (
          <p
            className={cn(
              "font-mono font-medium tabular-nums",
              reported ? LEVEL_TEXT[level] : "text-muted-foreground"
            )}
          >
            {shown}
          </p>
        ) : (
          <p className="font-mono text-muted-foreground">{size}</p>
        )}
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-valuenow={reported ? Math.round(fraction * 100) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={
          reported ? t("contextUsageAria", { pct: percent.format(fraction) }) : t("windowUnknown")
        }
        data-testid="context-window-bar"
        data-level={level}
        data-reported={reported}
      >
        {reported ? (
          <div
            className={cn("h-full rounded transition-all duration-500", LEVEL_FILL[level])}
            style={{ width: `${fraction * 100}%` }}
          />
        ) : null}
        {/* Auto-compact threshold marker — only where a threshold really applies. */}
        {reported && policy.threshold !== null ? (
          <div
            className="absolute inset-y-0 w-px bg-foreground/60"
            style={{ left: `${policy.threshold * 100}%` }}
            data-testid="context-compact-marker"
          />
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <p>{note}</p>
        {title ? <p className="font-mono tabular-nums">{reported ? size : UNKNOWN}</p> : null}
      </div>
    </div>
  )
}

/**
 * The composer chip's fill ring. Re-implemented here rather than reusing the
 * vendored `ContextIcon` because that one derives its own arc from
 * `usedTokens / maxTokens` and has no way to say "unknown" — it would draw an
 * empty ring for a runtime that reported nothing, which reads as "0% used".
 */
export function ContextRing({ fraction, muted }: { fraction: number; muted?: boolean }) {
  const circumference = 2 * Math.PI * 10
  return (
    <svg
      aria-hidden
      height="20"
      width="20"
      viewBox="0 0 24 24"
      style={{ color: "currentcolor" }}
      data-testid="context-ring"
      data-muted={muted ? "true" : "false"}
    >
      <circle
        cx={12}
        cy={12}
        r={10}
        fill="none"
        opacity={0.25}
        stroke="currentColor"
        strokeWidth={2}
        strokeDasharray={muted ? "2 3" : undefined}
      />
      {muted ? null : (
        <circle
          cx={12}
          cy={12}
          r={10}
          fill="none"
          opacity={0.7}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, fraction)))}
          style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
        />
      )}
    </svg>
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
  supported = true,
}: {
  sessionId: string | null
  usedTokens: number
  /** False when this session's runtime owns compaction (external agents). */
  supported?: boolean
}) {
  const t = useTranslations("chat.composer.toolbar")
  const scope = useOptionalChatScope()
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="mt-1 h-7 w-full justify-start gap-1.5 text-xs"
      disabled={!supported || !sessionId || usedTokens === 0}
      onClick={() => {
        if (!sessionId) return
        if (scope?.sessionId === sessionId && scope.compact) void scope.compact()
        else void compactSession(sessionId)
      }}
      data-testid="compact-now-button"
    >
      <ScissorsIcon className="size-3" />
      {t("compactNow")}
    </Button>
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
