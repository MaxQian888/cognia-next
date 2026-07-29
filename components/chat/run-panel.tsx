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
 * The panel reports on queued follow-ups but does not host them: a steer is a
 * real message in the transcript from the moment it is typed, and that bubble
 * is where it is read, edited, and removed. All that lives here is the pending
 * count (a way back to the first one) and the interrupt-and-send escalation.
 *
 * Exported as `RunStatusBar` from `./run-status-bar` for an unchanged mount
 * contract in `chat-view.tsx`.
 */
import { memo, useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { usePlatform } from "@/hooks/use-platform"
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  Loader2,
  MessageSquareIcon,
  ZapIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { MOBILE_SPRING, mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"
import { steerMetaOf } from "@/lib/claude/steer"
import { discardPendingSteer } from "@/hooks/chat/steer-runtime"
import { cn } from "@/lib/utils"
import {
  useChatStore,
  useSessionMessages,
  useSessionRunId,
  useSessionRunTiming,
  useSessionStatus,
  useSessionSteerQueue,
  useSessionToolTimestamps,
} from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
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
 * Pending-steer counter. Each queued follow-up is already a bubble in the
 * transcript (that is where it is edited and removed), so the panel only
 * reports how many are still undelivered and offers a way back to the first
 * one — a long turn easily scrolls them out of view.
 *
 * Springs on each change so a follow-up landing in the queue registers even
 * while the tool lines above it are churning.
 */
function SteerQueueChip({
  count,
  onLocate,
}: {
  count: number
  onLocate: (() => void) | undefined
}) {
  const t = useTranslations("chat.runStatus")
  const tp = useTranslations("chat.runPanel")
  const transition = useReducedMotionTransition(MOBILE_SPRING)
  const label = t("queued", { count })

  const body = (
    <>
      <MessageSquareIcon className="size-3" aria-hidden />
      <motion.span
        key={count}
        initial={{ scale: 0.72, opacity: 0.4 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={transition}
        className="tabular-nums"
      >
        {label}
      </motion.span>
    </>
  )

  if (!onLocate) {
    return (
      <span
        className="flex items-center gap-1 text-muted-foreground"
        data-testid="run-status-steer-chip"
      >
        <span className="sr-only">{tp("ariaSteerQueue")}</span>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onLocate}
      aria-label={tp("ariaLocateSteer")}
      className="flex items-center gap-1 rounded text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      data-testid="run-status-steer-chip"
    >
      {body}
    </button>
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
  const jumpToMessage = useChatViewportStore((s) => s.jumpToMessage)
  const steerInterruptConfirmed = useSettingsStore((s) => s.settings?.steerInterruptConfirmed)
  const saveSettings = useSettingsStore((s) => s.save)
  const [confirmSteerNow, setConfirmSteerNow] = useState(false)
  const panelTransition = useReducedMotionTransition(mobileTransition("fast"))

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

  // Scroll back to the oldest still-undelivered follow-up. Queued entries live
  // in the transcript now, and a long turn scrolls them away; the chip is the
  // way back. It resolves the message from the queue rather than trusting an
  // id, so the chip stays inert when no matching bubble is mounted.
  const queueDepth = steerQueue.length
  const firstPendingSteerId = (() => {
    if (queueDepth === 0) return null
    const pending = new Set(steerQueue.map((entry) => entry.id))
    const hit = messages.find((message) => {
      const meta = steerMetaOf(message.metadata)
      return meta ? pending.has(meta.entryId) : false
    })
    return hit?.id ?? null
  })()
  const locatePendingSteer =
    jumpToMessage && firstPendingSteerId ? () => jumpToMessage(firstPendingSteerId) : undefined

  // "Interrupt and send" aborts the running turn's in-flight tool calls to
  // deliver the queue early — not obvious from a button, so the first use asks
  // and the answer is remembered. Afterwards it fires straight away.
  const runSteerNow = () => void onSteerNow?.()
  const requestSteerNow = () => {
    if (steerInterruptConfirmed) runSteerNow()
    else setConfirmSteerNow(true)
  }

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

  return (
    // Grows in rather than popping: this bar appears directly above the
    // composer, and an instant appearance shoves the whole transcript up while
    // the user is still reading it. Safe to animate height here — the panel
    // sits outside the virtualized message list.
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      transition={panelTransition}
      style={{ overflow: "hidden" }}
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
                  // Per-entry rather than `clearSteerQueue`: each queued entry
                  // also has a bubble in the transcript, and emptying only the
                  // queue would leave those behind reading "Not delivered" —
                  // which is not what "Discard" promises.
                  onClick={() => {
                    if (!sessionId) return
                    for (const entry of steerQueue) discardPendingSteer(sessionId, entry.id)
                  }}
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
          {queueDepth > 0 && <SteerQueueChip count={queueDepth} onLocate={locatePendingSteer} />}
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
              className="h-5 gap-1 px-2 text-[11px] text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-500 dark:hover:text-amber-400"
              aria-label={t("ariaSteerNow")}
              title={t("steerNowHint")}
              onClick={requestSteerNow}
              data-testid="run-panel-steer-now"
            >
              <ZapIcon className="size-3" aria-hidden />
              {t("steerNow")}
            </Button>
          )}
        </div>
      )}

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

      <AlertDialog open={confirmSteerNow} onOpenChange={setConfirmSteerNow}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tp("steerNowConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{tp("steerNowConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tp("steerNowConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="run-panel-steer-now-confirm"
              onClick={() => {
                // Remember the answer before acting: the interrupt settles the
                // turn, which unmounts this panel's busy face.
                void saveSettings({ steerInterruptConfirmed: true })
                runSteerNow()
              }}
            >
              {tp("steerNowConfirmAccept")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}

export const RunPanel = memo(RunPanelImpl)
export const RunStatusBar = RunPanel
