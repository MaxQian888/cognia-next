"use client"

/**
 * `<RunPanel>` — the durable "second clock" pinned above the composer. It is
 * the web analogue of the CLI's `BottomStatus`, upgraded from a 3-line status
 * bar into a collapsible panel:
 *
 *   collapsed: ⟳ Working · 47s · Esc to interrupt    ← parity with the old bar
 *   expanded:  ▸ Plan / Tools / Sub-agents / Summary ← the whole turn's timeline
 *
 * Mounts while the bound session is busy OR has a queued steer, and ALSO when
 * idle if the last turn left a replayable record (a one-line "Last run" bar
 * that expands to the same sections). The elapsed timer ticks once a second and
 * only while busy, reading the active-work clock so it freezes during approval.
 *
 * Exported as `RunStatusBar` from `./run-status-bar` for an unchanged mount
 * contract in `chat-view.tsx`.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { usePlatform } from "@/hooks/use-platform"
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  Loader2,
  MessageSquareIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  useChatStore,
  useSessionMessages,
  useSessionRunId,
  useSessionRunTiming,
  useSessionStatus,
  useSessionSteerQueue,
  useSessionToolTimestamps,
  type SteerEntry,
} from "@/stores/chat"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  activeElapsedMs,
  formatRunElapsed,
  selectActiveToolLines,
  selectRunningSubagentChip,
} from "@/lib/claude/run-status"
import { deriveRunRecord, toRunStatus } from "@/lib/claude/run-record"
import { getLatestUsage } from "@/lib/claude/usage"
import { useSettingsStore } from "@/stores/settings"
import {
  aggregateRunBarUsage,
  EMPTY_RUN_BAR_USAGE,
  needsLiveUsage,
  resolveRunStatusBarSettings,
  type RunBarUsageTotals,
} from "@/lib/chat/run-bar-metrics"
import type { RunStatusBarSettings } from "@cognia/agent-config-types"
import {
  formatCostInCurrency,
  formatTokens,
  formatTokensPerSec,
  tokensPerSecond,
} from "@/types/system/usage"
import { TodoList } from "./todo-list"
import { ToolCallRow } from "./message-parts/tool-call-row"
import { SubagentTree } from "./message-parts/subagent-tree"

const PANEL_BODY_ID = "run-panel-body"

export interface RunStatusBarProps {
  /** Session this panel reports on (the bound pane's id). */
  sessionId: string | null
  /** Interrupt the running turn (same target as the composer's Stop). */
  onStop?: () => Promise<void> | void
  /** Interrupt and immediately replay the queued steer ("Send now"). */
  onSteerNow?: () => Promise<void> | void
  /** Replay the queued steer now with no turn boundary (errored/idle queue). */
  onSteerFlush?: () => Promise<void> | void
  className?: string
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  )
}

/**
 * One queued steer message in the Run Panel. View mode shows the framing text,
 * an attachment count, and a remove control; clicking the text opens an inline
 * editor (Enter / blur commits, Esc cancels) so the user can tweak or drop a
 * follow-up before it replays.
 */
function SteerQueueRow({
  entry,
  onCommit,
  onRemove,
}: {
  entry: SteerEntry
  onCommit: (text: string) => void
  onRemove: () => void
}) {
  const tp = useTranslations("chat.runPanel")
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.text)
  // Guard so Enter (which also blurs the input) doesn't commit twice.
  const committedRef = useRef(false)
  const attachCount = entry.blocks?.length ?? 0

  const beginEdit = () => {
    setDraft(entry.text)
    committedRef.current = false
    setEditing(true)
  }
  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    setEditing(false)
    const next = draft.trim()
    if (!next) onRemove()
    else if (next !== entry.text) onCommit(next)
  }
  const cancel = () => {
    committedRef.current = true
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="pl-5">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              cancel()
            }
          }}
          aria-label={tp("ariaEditSteer")}
          className="h-6 text-[11px]"
          data-testid="run-panel-steer-edit"
        />
      </div>
    )
  }

  return (
    <div
      className="group flex items-center gap-1 pl-5 text-[11px] text-muted-foreground/80"
      data-testid="run-panel-steer-row"
    >
      <button
        type="button"
        onClick={beginEdit}
        aria-label={tp("ariaEditSteer")}
        className="min-w-0 flex-1 truncate text-left hover:text-foreground"
      >
        • {entry.text.replace(/\s+/g, " ").trim() || tp("emptySteer")}
      </button>
      {attachCount > 0 && (
        <span
          className="flex shrink-0 items-center gap-0.5"
          aria-label={tp("ariaSteerAttachments", { count: attachCount })}
        >
          <PaperclipIcon className="size-3" aria-hidden />×{attachCount}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={tp("ariaRemoveSteer")}
        className="shrink-0 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </div>
  )
}

/**
 * The configurable metric strip on the run bar's collapsed face. Renders only
 * the metrics the user enabled in Settings → Conversation → Run status bar.
 * Usage-derived chips (tokens, speed, cost, context%) stay hidden until the
 * bound session has at least one turn carrying usage; the tools chip shows only
 * while busy (the idle "Last run" line already carries a tool count).
 */
function RunBarMetrics({
  totals,
  cfg,
  toolsCount,
  busy,
}: {
  totals: RunBarUsageTotals
  cfg: Required<RunStatusBarSettings>
  toolsCount: number
  busy: boolean
}) {
  const t = useTranslations("chat.runStatus")
  const tp = useTranslations("chat.runPanel")
  const usageReady = totals.turns > 0
  const chips: React.ReactNode[] = []

  if (cfg.showOutputTokens && usageReady) {
    chips.push(
      <span key="tokens">{t("metricTokens", { value: formatTokens(totals.outputTokens) })}</span>
    )
  }
  if (cfg.showSpeed && usageReady) {
    const speed = tokensPerSecond(totals.outputTokens, totals.durationMs)
    if (speed != null) {
      chips.push(<span key="speed">{t("metricSpeed", { value: formatTokensPerSec(speed) })}</span>)
    }
  }
  if (cfg.showCost && usageReady && totals.costUsd > 0) {
    chips.push(<span key="cost">{formatCostInCurrency(totals.costUsd)}</span>)
  }
  if (cfg.showContextPct && usageReady) {
    chips.push(
      <span key="ctx">{t("metricContext", { pct: Math.round(totals.contextFraction * 100) })}</span>
    )
  }
  if (cfg.showTools && busy && toolsCount > 0) {
    chips.push(<span key="tools">{tp("summaryTools", { count: toolsCount })}</span>)
  }

  if (chips.length === 0) return null
  return (
    <div
      data-testid="run-bar-metrics"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[11px] tabular-nums text-muted-foreground"
    >
      {chips}
    </div>
  )
}

function RunPanelImpl({
  sessionId,
  onStop,
  onSteerNow,
  onSteerFlush,
  className,
}: RunStatusBarProps) {
  const t = useTranslations("chat.runStatus")
  const tp = useTranslations("chat.runPanel")
  // Capacitor native shell has no hardware Esc; show a touch-appropriate label.
  const isMobile = usePlatform() === "mobile"
  const status = useSessionStatus(sessionId)
  const timing = useSessionRunTiming(sessionId)
  const steerQueue = useSessionSteerQueue(sessionId)
  const messages = useSessionMessages(sessionId)
  const runId = useSessionRunId(sessionId)
  const toolTimestamps = useSessionToolTimestamps(sessionId)
  const subAgents = useSubagentRuntimeStore((s) => s.subAgents)
  const runBarCfg = useSettingsStore((s) => s.settings?.runStatusBar)
  const resolvedBar = useMemo(() => resolveRunStatusBarSettings(runBarCfg), [runBarCfg])

  const busy = status === "streaming" || status === "awaiting_approval"

  // Elapsed ticker — the interval mounts only while busy, so an idle pane never
  // ticks. Free of synchronous set-state in the effect.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy])

  const [expanded, setExpanded] = useState(false)

  const record = useMemo(
    () =>
      deriveRunRecord({
        sessionId: sessionId ?? "",
        runId,
        messages,
        runTiming: timing,
        status: toRunStatus(status),
        toolTimestamps,
      }),
    [sessionId, runId, messages, timing, status, toolTimestamps]
  )

  // Live usage aggregate for the metric strip — only computed when at least one
  // usage-derived chip (tokens / speed / cost / context%) is enabled. The
  // aggregate walks the WHOLE history, so it is gated on a cheap usage
  // signature (message count + latest usage ref, which only move a few times
  // per turn) instead of the `messages` array ref, which swaps every streamed
  // frame. `getLatestUsage` early-exits from the tail → O(1) per store set.
  const [usageMsgCount, latestUsage] = useChatStore(
    useShallow((s) => {
      const msgs = sessionId ? (s.sessions[sessionId]?.messages ?? undefined) : undefined
      return [msgs?.length ?? 0, msgs ? getLatestUsage(msgs) : null] as const
    })
  )
  const usageTotals = useMemo(
    () => (needsLiveUsage(resolvedBar) ? aggregateRunBarUsage(messages) : EMPTY_RUN_BAR_USAGE),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the usage signature (count + latest usage) gates the O(n) walk; `messages` itself swaps every frame
    [usageMsgCount, latestUsage, resolvedBar]
  )

  const hasWork =
    record.tools.length > 0 || record.todos.length > 0 || record.subagentParts.length > 0
  const replay = !busy && steerQueue.length === 0 && hasWork

  // Nothing live, nothing queued, and no replayable record → render nothing.
  if (!busy && steerQueue.length === 0 && !replay) return null

  const elapsedMs = activeElapsedMs(timing, toRunStatus(status), now)
  const elapsed = elapsedMs != null ? formatRunElapsed(elapsedMs) : null
  const toolLines = busy ? selectActiveToolLines(messages, 3) : []
  const subagentChip = busy ? selectRunningSubagentChip(subAgents) : null
  const verb = status === "awaiting_approval" ? t("waitingApproval") : t("working")
  const queueDepth = steerQueue.length

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      data-testid="run-status-bar"
      className={cn(
        "@container/runpanel flex flex-col gap-1 border-t border-border/50 bg-background/60 px-3 py-1.5 text-xs",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {hasWork && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={PANEL_BODY_ID}
            aria-label={expanded ? tp("collapse") : tp("expand")}
            data-testid="run-panel-toggle"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5" aria-hidden />
            ) : (
              <ChevronRightIcon className="size-3.5" aria-hidden />
            )}
          </button>
        )}

        {busy ? (
          <div className="flex flex-1 items-center gap-2 text-foreground/80">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-amber-500" aria-hidden />
            <span className="font-medium">{verb}</span>
            {resolvedBar.showElapsed && elapsed && (
              <span className="tabular-nums text-muted-foreground" data-testid="run-status-elapsed">
                · {elapsed}
              </span>
            )}
            <button
              type="button"
              onClick={() => void onStop?.()}
              aria-label={tp("ariaInterrupt")}
              className="ml-auto text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {isMobile ? t("interruptHintTouch") : t("interruptHint")}
            </button>
          </div>
        ) : replay ? (
          <div className="flex flex-1 items-center gap-2 text-muted-foreground">
            <span className="font-medium">{tp("lastRun")}</span>
            <span className="tabular-nums" data-testid="run-panel-replay-summary">
              ·{" "}
              {tp("lastRunSummary", {
                count: record.counts.tools,
                elapsed: elapsed ?? formatRunElapsed(0),
              })}
            </span>
          </div>
        ) : (
          // Not busy, not replayable, but a queue lingers — the turn ended
          // (errored/interrupted) without draining. No settle event is coming,
          // so surface an explicit flush/discard rather than letting the queue
          // sit stuck.
          queueDepth > 0 && (
            <div
              className="flex flex-1 items-center gap-2 text-muted-foreground"
              data-testid="run-panel-stuck-queue"
            >
              <span className="font-medium text-foreground/80">
                {tp("runFailedQueued", { count: queueDepth })}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {onSteerFlush && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-5 px-2 text-[11px]"
                    aria-label={t("ariaSteerNow")}
                    onClick={() => void onSteerFlush()}
                  >
                    {t("steerNow")}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-5 px-2 text-[11px]"
                  aria-label={tp("ariaDiscardQueue")}
                  onClick={() => sessionId && useChatStore.getState().clearSteerQueue(sessionId)}
                >
                  {tp("discardQueue")}
                </Button>
              </div>
            </div>
          )
        )}
      </div>

      <RunBarMetrics
        totals={usageTotals}
        cfg={resolvedBar}
        toolsCount={record.counts.tools}
        busy={busy}
      />

      {toolLines.map((line) => (
        <div
          key={line.id}
          className="flex items-center gap-1 truncate pl-5 font-mono text-[11px] text-muted-foreground"
          title={line.label}
        >
          <CornerDownRightIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{line.label}</span>
        </div>
      ))}

      {(queueDepth > 0 || subagentChip) && (
        <div className="flex flex-wrap items-center gap-2 pl-5 text-[11px]">
          {queueDepth > 0 && (
            <span
              className="flex items-center gap-1 text-muted-foreground"
              data-testid="run-status-steer-chip"
            >
              <MessageSquareIcon className="size-3" aria-hidden />
              <span className="sr-only">{tp("ariaSteerQueue")}</span>
              {t("queued", { count: queueDepth })}
            </span>
          )}
          {subagentChip && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <BotIcon className="size-3" aria-hidden />
              <span className="sr-only">{tp("ariaSubagent")}</span>
              {subagentChip.name}
              {subagentChip.count > 1 ? `×${subagentChip.count}` : ""}
            </span>
          )}
          {queueDepth > 0 && busy && onSteerNow && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-2 text-[11px]"
              aria-label={t("ariaSteerNow")}
              onClick={() => void onSteerNow()}
            >
              {t("steerNow")}
            </Button>
          )}
        </div>
      )}

      {steerQueue.map((entry) => (
        <SteerQueueRow
          key={entry.id}
          entry={entry}
          onCommit={(text) =>
            sessionId && useChatStore.getState().updateSteerEntry(sessionId, entry.id, text)
          }
          onRemove={() =>
            sessionId && useChatStore.getState().removeSteerEntry(sessionId, entry.id)
          }
        />
      ))}

      {expanded && hasWork && (
        <div
          id={PANEL_BODY_ID}
          data-testid="run-panel-body"
          className="mt-1 flex max-h-[40vh] flex-col gap-2 overflow-y-auto border-t border-border/40 pt-2"
        >
          {record.todos.length > 0 && (
            <section>
              <SectionHeading>{tp("sectionPlan")}</SectionHeading>
              <TodoList todos={record.todos} defaultOpen />
            </section>
          )}

          {record.tools.length > 0 && (
            <section>
              <SectionHeading>{tp("sectionTools")}</SectionHeading>
              <div className="flex flex-col gap-0.5">
                {record.tools.map((entry) => {
                  const toolElapsed =
                    entry.startedAt != null
                      ? formatRunElapsed((entry.endedAt ?? now) - entry.startedAt)
                      : null
                  return (
                    <div key={entry.id} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <ToolCallRow part={entry.part} />
                      </div>
                      {toolElapsed && (
                        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
                          {toolElapsed}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {record.subagentParts.length > 0 && (
            <section>
              <SectionHeading>{tp("sectionSubagents")}</SectionHeading>
              <SubagentTree parts={record.subagentParts as never} mode="standard" />
            </section>
          )}

          <section className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground @sm/runpanel:gap-x-4">
            <SectionHeading>{tp("sectionSummary")}</SectionHeading>
            {elapsed && <span className="tabular-nums">{elapsed}</span>}
            <span>{tp("summaryTools", { count: record.counts.tools })}</span>
            {record.counts.subagents > 0 && (
              <span>{tp("summarySubagents", { count: record.counts.subagents })}</span>
            )}
            {record.todoCounts.total > 0 && (
              <span>
                {tp("summaryTodos", {
                  done: record.todoCounts.done,
                  total: record.todoCounts.total,
                })}
              </span>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

export const RunPanel = memo(RunPanelImpl)
export const RunStatusBar = RunPanel
