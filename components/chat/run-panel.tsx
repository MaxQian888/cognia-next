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
 * Queued follow-ups ("steers") get a section of their own in the expanded body.
 * Each one is also a real message in the transcript from the moment it is typed,
 * and that bubble is where it is read — but the bubbles render in ARRIVAL order
 * and scatter through a long turn, so the SEND order (which is what the model
 * reads: the whole queue is joined into one framed turn) is only legible here.
 * Reordering, rewriting, removing, and the interrupt-and-send escalation all
 * live in this panel; the bubble keeps the light-weight edit/remove shortcuts.
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
  GripVerticalIcon,
  Loader2,
  MessageSquareIcon,
  PaperclipIcon,
  PencilIcon,
  XIcon,
  ZapIcon,
} from "lucide-react"

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
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
import { discardPendingSteer, editPendingSteer } from "@/hooks/chat/steer-runtime"
import { resolveDragEnd } from "@/lib/chat/attachments/reorder"
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
 * Pending-steer counter, and the way into the queue section below it.
 *
 * The bubbles in the transcript stay the place a single follow-up is read, but
 * they are scattered through a long turn and they render in ARRIVAL order —
 * neither of which lets the user see, let alone rearrange, the order the queue
 * will actually be sent in. The chip opens that list; a session with no queue
 * never renders it.
 *
 * Springs on each change so a follow-up landing in the queue registers even
 * while the tool lines above it are churning.
 */
function SteerQueueChip({
  count,
  onToggle,
  expanded,
}: {
  count: number
  onToggle: (() => void) | undefined
  expanded: boolean
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

  if (!onToggle) {
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
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={PANEL_BODY_ID}
      aria-label={tp("ariaManageSteer")}
      className="flex items-center gap-1 rounded text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      data-testid="run-status-steer-chip"
    >
      {body}
    </button>
  )
}

/**
 * The queue itself — every still-undelivered follow-up, in the order it will be
 * sent, with the three things the bubbles cannot offer: reordering, a multi-line
 * rewrite, and a jump back to the message in the transcript.
 *
 * Order is the point. `buildSteerPayload` joins the whole queue into ONE framed
 * turn, so this list reads top-to-bottom as the paragraphs the model will get —
 * which is why the row index is shown even for a single entry, and why the
 * bubbles carry the same index (see `SteerStatusBadge`).
 *
 * Reordering is a @dnd-kit vertical sortable, set up the way the composer's
 * attachment chips are (`attachment-preview.tsx`): a `PointerSensor` with a
 * small activation distance so a press that never moves still reaches the row's
 * own buttons, a `KeyboardSensor` so the same move is possible without a mouse,
 * and the commit decision delegated to the pure `resolveDragEnd` — jsdom gives
 * every element a 0x0 box, so the library can never resolve a drop target in a
 * test and only OUR half of the branch is worth exercising.
 */
function SteerQueueSection({
  sessionId,
  queue,
  onLocate,
}: {
  sessionId: string
  queue: readonly SteerEntry[]
  onLocate: ((entryId: string) => void) | undefined
}) {
  const tp = useTranslations("chat.runPanel")
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const move = useChatStore((s) => s.moveSteerEntry)

  // `distance: 4` is what keeps every row control clickable: a press with no
  // movement never starts a drag, so the jump / edit / remove buttons — and the
  // caret placement inside an open editor — still get their event.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const commitEdit = () => {
    if (!editing) return
    const next = editing.text.trim()
    setEditing(null)
    if (!next) discardPendingSteer(sessionId, editing.id)
    else editPendingSteer(sessionId, editing.id, next)
  }

  const onDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const overId = resolveDragEnd(activeId, event.over ? String(event.over.id) : null)
    if (!overId) return
    // The store's move is expressed as a signed step, so translate "landed on
    // that row" into one.
    const from = queue.findIndex((entry) => entry.id === activeId)
    const to = queue.findIndex((entry) => entry.id === overId)
    if (from < 0 || to < 0) return
    move(sessionId, activeId, to - from)
  }

  // dnd-kit ships English-only default announcements and instructions, and they
  // are read aloud — so they are user-facing strings like any other and have to
  // come from the message catalog.
  const total = queue.length
  const positionOf = (id: unknown) => queue.findIndex((entry) => entry.id === String(id)) + 1
  const announcements = {
    onDragStart: ({ active }: { active: { id: unknown } }) =>
      tp("dndPickedUp", { index: positionOf(active.id), total }),
    onDragOver: ({ over }: { over: { id: unknown } | null }) =>
      over ? tp("dndOver", { position: positionOf(over.id), total }) : undefined,
    onDragEnd: ({ over }: { over: { id: unknown } | null }) =>
      over ? tp("dndDropped", { position: positionOf(over.id), total }) : tp("dndCancelled"),
    onDragCancel: () => tp("dndCancelled"),
  }

  return (
    <section data-testid="run-panel-queue-section">
      <SectionHeading>{tp("sectionQueue")}</SectionHeading>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: tp("dndInstructions") },
        }}
      >
        <SortableContext
          items={queue.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-0.5">
            {queue.map((entry, index) => (
              <SteerQueueRow
                key={entry.id}
                entry={entry}
                index={index}
                editing={editing?.id === entry.id ? editing.text : null}
                onEditChange={(text) => setEditing({ id: entry.id, text })}
                onEditOpen={() => setEditing({ id: entry.id, text: entry.text })}
                onEditCancel={() => setEditing(null)}
                onEditCommit={commitEdit}
                onLocate={onLocate ? () => onLocate(entry.id) : undefined}
                onRemove={() => discardPendingSteer(sessionId, entry.id)}
                tp={tp}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <p className="px-1 pt-1 text-[10px] text-muted-foreground/70">{tp("queueMergeHint")}</p>
    </section>
  )
}

/**
 * One queued follow-up. The drag listeners sit on the grip alone, never on the
 * row: the row body is a jump-to-message button and holds three more controls,
 * and `touch-none` (which the listeners require) would otherwise eat the
 * panel's own scroll on the mobile shell.
 */
function SteerQueueRow({
  entry,
  index,
  editing,
  onEditChange,
  onEditOpen,
  onEditCancel,
  onEditCommit,
  onLocate,
  onRemove,
  tp,
}: {
  entry: SteerEntry
  index: number
  editing: string | null
  onEditChange: (text: string) => void
  onEditOpen: () => void
  onEditCancel: () => void
  onEditCommit: () => void
  onLocate: (() => void) | undefined
  onRemove: () => void
  tp: ReturnType<typeof useTranslations<"chat.runPanel">>
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    // A row being rewritten must not also be draggable: the editor owns the
    // pointer (selection, caret) and the arrow keys for as long as it is open.
    disabled: editing !== null,
  })

  const attachments = entry.blocks?.length ?? 0
  const label = entry.text.trim() || tp("queueAttachmentsOnly", { count: attachments })

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="run-panel-queue-row"
      className={cn(
        "group/queue flex items-start gap-1 rounded px-1 py-0.5 hover:bg-muted/50",
        isDragging && "z-10 bg-muted/70 opacity-80"
      )}
    >
      <button
        type="button"
        aria-label={tp("ariaReorderQueued", { index: index + 1 })}
        className={cn(
          "mt-0.5 shrink-0 touch-none rounded text-muted-foreground/50 hover:text-foreground",
          editing !== null ? "cursor-default opacity-30" : "cursor-grab active:cursor-grabbing"
        )}
        data-testid="run-panel-queue-grip"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3" aria-hidden />
      </button>

      <span className="mt-1 w-3 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
        {index + 1}
      </span>

      {editing !== null ? (
        <Textarea
          autoFocus
          value={editing}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onEditCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              onEditCommit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              onEditCancel()
            }
          }}
          aria-label={tp("ariaEditQueued")}
          className="min-h-14 flex-1 resize-none py-1 text-[12px]"
          data-testid="run-panel-queue-edit"
        />
      ) : (
        <button
          type="button"
          onClick={onLocate}
          disabled={!onLocate}
          title={entry.text}
          aria-label={tp("ariaLocateSteer")}
          className="min-w-0 flex-1 truncate text-left text-[12px] leading-5 text-foreground/80 enabled:hover:text-foreground disabled:cursor-default"
          data-testid="run-panel-queue-locate"
        >
          {label}
        </button>
      )}

      {attachments > 0 && (
        <span
          className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
          title={tp("queueAttachments", { count: attachments })}
        >
          <PaperclipIcon className="size-3" aria-hidden />
          {attachments}
        </span>
      )}

      {/* Always visible, only dimmed: this list IS the queue editor, and a
          hover-revealed row of controls is unreachable on the mobile shell,
          which mounts the same panel. */}
      <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground/70 focus-within:text-muted-foreground group-hover/queue:text-muted-foreground">
        <button
          type="button"
          onClick={onEditOpen}
          aria-label={tp("ariaEditQueued")}
          className="rounded p-0.5 hover:text-foreground"
          data-testid="run-panel-queue-edit-open"
        >
          <PencilIcon className="size-3" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={tp("ariaRemoveQueued")}
          className="rounded p-0.5 hover:text-destructive"
          data-testid="run-panel-queue-remove"
        >
          <XIcon className="size-3" aria-hidden />
        </button>
      </div>
    </li>
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

  // Scroll back to a still-undelivered follow-up. Queued entries live in the
  // transcript now, and a long turn scrolls them away; the queue section is the
  // way back. It resolves the message from the entry id rather than trusting
  // one, so a row stays inert when no matching bubble is mounted.
  const queueDepth = steerQueue.length
  const locateSteerEntry = jumpToMessage
    ? (entryId: string) => {
        const hit = messages.find((message) => steerMetaOf(message.metadata)?.entryId === entryId)
        if (hit) jumpToMessage(hit.id)
      }
    : undefined

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
  // The queue is a section of the expanded body, so a queue alone is enough to
  // make the panel expandable — a turn can have follow-ups before its first tool.
  const expandable = hasWork || queueDepth > 0
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
        "@container/runpanel flex flex-col gap-1 border-t border-border/50 bg-background/60 py-1.5 text-xs",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {expandable && (
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
          {queueDepth > 0 && (
            <SteerQueueChip
              count={queueDepth}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
            />
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

      {expanded && expandable && (
        <div
          id={PANEL_BODY_ID}
          data-testid="run-panel-body"
          className="mt-1 flex max-h-[40vh] flex-col gap-2 overflow-y-auto border-t border-border/40 pt-2"
        >
          {sessionId && queueDepth > 0 && (
            <SteerQueueSection
              sessionId={sessionId}
              queue={steerQueue}
              onLocate={locateSteerEntry}
            />
          )}

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

          {hasWork && (
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
          )}
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
