// The scheduled-due functional toast — "Agenda+" (variant D of the design
// prototype, now retired). A readout, not a decision box: live "due
// now" eyebrow, kind plate, a last→now→next occurrence timeline, and the one
// action a recurring reminder actually needs (Mute) beside Open.
//
// The record's persisted `actions` drive the footer — the same row the
// notification center renders, dispatched through the command registry — so
// the toast can never offer a button the center row doesn't have.

import { BellOffIcon, CheckIcon, ClockIcon, XIcon } from "lucide-react"

import { KindPlate } from "@/components/scheduler/kind-visuals"
import { SCHEDULED_DUE_MUTE_COMMAND } from "@/lib/scheduler/notification-commands"
import { cn } from "@/lib/utils"
import type { NotificationRecord } from "@/types/notifications"
import type { ScheduledTask } from "@/types/scheduler"
import type { ScheduledItemKind, UnifiedTriggerSummary } from "@/types/scheduler/unified"

import { relativeCompact } from "./relative-time"
import type { FunctionalToastContext, FunctionalToastSpec } from "./types"

/* ------------------------------------------------------------------ */
/* meta                                                                 */
/* ------------------------------------------------------------------ */

/** `record.meta[SCHEDULED_DUE_META_KEY]` — everything the card draws. */
export const SCHEDULED_DUE_META_KEY = "scheduledDue"

export interface ScheduledDueMeta {
  taskId: string
  kind: ScheduledItemKind
  name: string
  triggerSummary: UnifiedTriggerSummary
  nextRunAtMs?: number
  lastRunAtMs?: number
  /**
   * Last terminal outcome when known (`completed` vs anything else). Absent
   * on rows that predate `lastTerminalReason` — the timeline node then reads
   * neutral instead of guessing.
   */
  lastRunOk?: boolean
  runCount: number
  consecutiveFailures: number
  workspaceName?: string
}

export function buildScheduledDueMeta(
  task: ScheduledTask,
  workspaceName?: string
): ScheduledDueMeta {
  return {
    taskId: task.id,
    kind: task.type === "plugin" ? "plugin" : "app",
    name: task.name,
    triggerSummary: {
      type: task.trigger.type,
      cron: task.trigger.cronExpression,
      intervalMs: task.trigger.intervalMs,
      runAtMs: task.trigger.runAt ? task.trigger.runAt.getTime() : undefined,
      eventType: task.trigger.eventType,
      timezone: task.trigger.timezone,
    },
    nextRunAtMs: task.nextRunAt ? task.nextRunAt.getTime() : undefined,
    lastRunAtMs: task.lastRunAt ? task.lastRunAt.getTime() : undefined,
    lastRunOk:
      task.lastTerminalReason === undefined ? undefined : task.lastTerminalReason === "completed",
    runCount: task.runCount,
    consecutiveFailures: task.consecutiveFailures ?? 0,
    ...(workspaceName ? { workspaceName } : {}),
  }
}

export function readScheduledDueMeta(rec: NotificationRecord): ScheduledDueMeta | null {
  const raw = rec.meta?.[SCHEDULED_DUE_META_KEY]
  if (!raw || typeof raw !== "object") return null
  const meta = raw as Partial<ScheduledDueMeta>
  if (typeof meta.taskId !== "string" || typeof meta.name !== "string") return null
  if (!meta.triggerSummary || typeof meta.triggerSummary !== "object") return null
  return meta as ScheduledDueMeta
}

/* ------------------------------------------------------------------ */
/* accent                                                               */
/* ------------------------------------------------------------------ */

/** Solid kind accent — the color half of `KIND_PLATE` in kind-visuals. */
const KIND_ACCENT: Record<ScheduledItemKind, string> = {
  app: "bg-primary",
  workflow: "bg-violet-500",
  backup: "bg-orange-500",
  plugin: "bg-emerald-500",
  system: "bg-slate-500",
  connector: "bg-cyan-500",
}

/* ------------------------------------------------------------------ */
/* timeline                                                             */
/* ------------------------------------------------------------------ */

type TimelineTone = "ok" | "fail" | "now" | "now-alert" | "next" | "idle"

function TimelineNode({
  side,
  tone,
  label,
}: {
  side: "start" | "center" | "end"
  tone: TimelineTone
  label: string
}) {
  const align = side === "start" ? "items-start" : side === "end" ? "items-end" : "items-center"
  return (
    <div className={cn("flex flex-col gap-1.5", align)}>
      <span className="flex h-3 items-center">
        {tone === "now" || tone === "now-alert" ? (
          <span
            className={cn(
              "size-2.5 rounded-full ring-4",
              tone === "now" ? "bg-primary ring-primary/15" : "bg-amber-500 ring-amber-500/15"
            )}
          />
        ) : tone === "ok" ? (
          <span className="flex size-3 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-2" strokeWidth={3} />
          </span>
        ) : tone === "fail" ? (
          <span className="flex size-3 items-center justify-center rounded-full bg-red-500/15 text-red-600 dark:text-red-400">
            <XIcon className="size-2" strokeWidth={3} />
          </span>
        ) : (
          <span className="size-2 rounded-full border-2 border-muted-foreground/30 bg-popover" />
        )}
      </span>
      <span
        className={cn(
          "whitespace-nowrap text-[9.5px] leading-none",
          tone === "now" && "font-semibold text-foreground",
          tone === "now-alert" && "font-semibold text-amber-600 dark:text-amber-400",
          (tone === "ok" || tone === "next" || tone === "idle") && "text-muted-foreground",
          tone === "fail" && "text-red-600 dark:text-red-400"
        )}
      >
        {label}
      </span>
    </div>
  )
}

function DueTimeline({
  last,
  nowLabel,
  next,
  alert,
}: {
  last: { tone: "ok" | "fail" | "idle"; label: string }
  nowLabel: string
  next: string
  alert?: boolean
}) {
  return (
    <div className="relative mb-1 mt-3" data-testid="due-timeline">
      <div className="absolute inset-x-4 top-[6px] h-px bg-border" aria-hidden="true" />
      <div className="relative grid grid-cols-3">
        <TimelineNode side="start" tone={last.tone} label={last.label} />
        <TimelineNode side="center" tone={alert ? "now-alert" : "now"} label={nowLabel} />
        <TimelineNode side="end" tone="next" label={next} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* factory                                                              */
/* ------------------------------------------------------------------ */

/**
 * Record → Agenda+ spec. Returns null when the record carries no due meta —
 * the host then renders its plain fallback inside the same chrome.
 */
export function scheduledDueToastSpec(
  rec: NotificationRecord,
  ctx: FunctionalToastContext
): FunctionalToastSpec | null {
  const meta = readScheduledDueMeta(rec)
  if (!meta) return null
  const { t, locale, now } = ctx
  const failing = meta.consecutiveFailures > 0

  const last = meta.lastRunAtMs
    ? {
        tone: (meta.lastRunOk === false ? "fail" : meta.lastRunOk === true ? "ok" : "idle") as
          "ok" | "fail" | "idle",
        label:
          meta.lastRunOk === false
            ? t("scheduledDue.lastFailed", {
                ago: relativeCompact(meta.lastRunAtMs, now, locale),
              })
            : t("scheduledDue.lastRan", {
                ago: relativeCompact(meta.lastRunAtMs, now, locale),
              }),
      }
    : { tone: "idle" as const, label: t("scheduledDue.neverRan") }

  return {
    icon: <KindPlate kind={meta.kind} className="mt-0.5 size-7 rounded-md" />,
    eyebrow: {
      text: failing
        ? t("scheduledDue.dueFailed", { count: meta.consecutiveFailures })
        : t("scheduledDue.dueNow"),
      tone: failing ? "warn" : "live",
      pulse: true,
    },
    tray: (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        <ClockIcon className="size-3" />
        {ctx.triggerText(meta.triggerSummary)}
      </span>
    ),
    title: meta.name,
    body: (
      <DueTimeline
        last={last}
        nowLabel={t("scheduledDue.now")}
        next={
          meta.nextRunAtMs
            ? t("scheduledDue.next", {
                relative: relativeCompact(meta.nextRunAtMs, now, locale),
              })
            : t("scheduledDue.nextNone")
        }
        alert={failing}
      />
    ),
    footnote: meta.workspaceName
      ? t("scheduledDue.runStartingIn", {
          count: meta.runCount + 1,
          workspace: meta.workspaceName,
        })
      : t("scheduledDue.runStarting", { count: meta.runCount + 1 }),
    actions: rec.actions?.slice(0, 3).map((action) => ({
      id: action.id,
      label: action.label,
      icon: action.command === SCHEDULED_DUE_MUTE_COMMAND ? BellOffIcon : undefined,
      strong: action.variant === "primary",
      notificationAction: action,
    })),
    accentClass: KIND_ACCENT[meta.kind],
  }
}
