"use client"

/**
 * "Wakeups" section of the issue detail panel.
 *
 * Lists the rules that belong to this issue (a wakeup is a scheduler task, so
 * the list is a live read of the `issue-wakeup` rows), says what each one is
 * waiting for and why a stopped one stopped, and lets the user pause, resume,
 * delete and add them. Every write goes through `lib/issues/wakeups/service.ts`
 * as the user, the same door the `issue.wakeup_*` skills use as an agent.
 *
 * The platform "sub-issues finished" rule's instruction is editable in place:
 * what a person writes applies to this issue only, and an empty box falls
 * back to the project's default and then the built-in text, which the box
 * shows as its placeholder so the fallback is never a guess.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlarmClockIcon, PauseIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useClientLiveQuery } from "@/hooks/data"
import { getIssue } from "@/lib/db/issues"
import { getIssueProject } from "@/lib/db/issue-projects"
import {
  decompileWakeupTrigger,
  effectiveWakeupInstruction,
  readWakeupPayload,
} from "@/lib/issues/wakeups/model"
import {
  deleteIssueWakeup,
  listIssueWakeups,
  setChildrenDoneInstruction,
  setIssueWakeupEnabled,
} from "@/lib/issues/wakeups/service"
import { formatNextRun } from "@/lib/scheduler/format-utils"
import { wakeupPauseReasonOf } from "@/types/issues"
import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedIssueItem } from "@/types/issues/unified"

import { IssueTextEditor } from "../editors/issue-text-editor"
import { WakeupCreateDialog, describeWakeupWriteError } from "./wakeup-create-dialog"

export interface IssueWakeupsSectionProps {
  issueId: string
  identifier: string
  /** Board items, to name watched issues and offer them as targets. */
  items?: readonly UnifiedIssueItem[]
  /** The issue is finished: rules are listed but none can be added or resumed. */
  finished?: boolean
}

/** Human text for a rule's trigger. Shared with the board cue's tooltip. */
export function useWakeupTriggerText(items: readonly UnifiedIssueItem[] = []) {
  const t = useTranslations("issues.wakeups")
  const tStatus = useTranslations("issues.status")
  const tKind = useTranslations("issues.wakeups.kind")
  return (task: ScheduledTask): string => {
    const spec = decompileWakeupTrigger(task)
    switch (spec.on) {
      case "event": {
        const kinds = spec.kinds?.length
          ? spec.kinds.map((kind) => tKind(kind)).join(", ")
          : t("trigger.anyActivity")
        const statuses = spec.toStatuses?.length
          ? spec.toStatuses.map((status) => tStatus(status)).join(", ")
          : null
        const base = statuses ? t("trigger.statusTo", { statuses }) : t("trigger.event", { kinds })
        return spec.actorKinds?.length === 1 && spec.actorKinds[0] === "human"
          ? t("trigger.byPeople", { base })
          : base
      }
      case "children-done":
        return spec.stage !== undefined
          ? t("trigger.childrenDoneStage", { stage: spec.stage })
          : t("trigger.childrenDone")
      case "issue-finished": {
        const target = items.find(
          (item) => item.kind === "local" && item.unifiedId === `local:${spec.targetIssueId}`
        )
        return t("trigger.issueFinished", { issue: target?.identifier ?? spec.targetIssueId })
      }
      case "pr-merged":
        return t("trigger.prMerged")
      case "cron":
        return t("trigger.cron", { expression: spec.cronExpression })
      case "interval":
        return t("trigger.interval", {
          hours: Math.max(1, Math.round(spec.intervalMs / 3_600_000)),
        })
      case "at":
        return t("trigger.at", { at: spec.runAt.toLocaleString() })
    }
  }
}

/** The status line of one rule: running state, or why it stopped. */
function useWakeupStateText() {
  const t = useTranslations("issues.wakeups")
  return (task: ScheduledTask): { label: string; tone: "default" | "warning" | "muted" } => {
    if (task.status === "active") return { label: t("state.active"), tone: "default" }
    if (task.status === "expired") {
      return {
        label:
          task.lastTerminalReason === "max-runs-reached"
            ? t("state.budgetSpent")
            : task.lastTerminalReason === "ended"
              ? t("state.ended")
              : t("state.consumed"),
        tone: "muted",
      }
    }
    const reason = wakeupPauseReasonOf(
      typeof task.lastTerminalReason === "string" ? task.lastTerminalReason : undefined
    )
    if (reason) return { label: t(`pauseReason.${reason}`), tone: "warning" }
    if (task.lastTerminalReason === "auto-paused") {
      return { label: t("state.autoPaused"), tone: "warning" }
    }
    return { label: t("state.paused"), tone: "muted" }
  }
}

export function IssueWakeupsSection({
  issueId,
  identifier,
  items = [],
  finished = false,
}: IssueWakeupsSectionProps) {
  const t = useTranslations("issues.wakeups")
  const tScheduler = useTranslations("scheduler")
  const [createOpen, setCreateOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const wakeups = useClientLiveQuery(
    () => listIssueWakeups(issueId),
    [issueId],
    [] as ScheduledTask[]
  )
  const container = useClientLiveQuery(
    async () => {
      const issue = await getIssue(issueId)
      return issue ? ((await getIssueProject(issue.issueProjectId)) ?? null) : null
    },
    [issueId],
    null
  )
  const triggerText = useWakeupTriggerText(items)
  const stateText = useWakeupStateText()

  const act = async (taskId: string, action: () => Promise<unknown>, done: string) => {
    setPending(taskId)
    try {
      await action()
      toast.success(done)
    } catch (error) {
      toast.error(describeWakeupWriteError(error, t))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="issue-detail-wakeups">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("section")}
        </h3>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          disabled={finished}
          onClick={() => setCreateOpen(true)}
          data-testid="issue-wakeup-add"
        >
          <PlusIcon className="size-3.5" />
          {t("add")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {finished ? t("finishedHint") : t("sectionHint")}
      </p>
      {(wakeups ?? []).length > 0 ? (
        <ol className="flex flex-col gap-2" data-testid="issue-wakeup-list">
          {(wakeups ?? []).map((task) => {
            const payload = readWakeupPayload(task.payload)
            if (!payload) return null
            const state = stateText(task)
            const held = payload.deferred?.length ?? 0
            const busy = pending === task.id
            return (
              <li
                key={task.id}
                className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs"
                data-testid={`issue-wakeup-${task.id}`}
                data-status={task.status}
              >
                <span className="flex items-center gap-2">
                  <AlarmClockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate font-medium">{triggerText(task)}</span>
                  {payload.system ? (
                    <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                      {t("system")}
                    </Badge>
                  ) : null}
                  <Badge
                    variant={state.tone === "warning" ? "destructive" : "secondary"}
                    className="h-4 px-1 text-[10px]"
                    data-testid="issue-wakeup-state"
                  >
                    {state.label}
                  </Badge>
                </span>
                {payload.system === "children-done" ? (
                  <div className="flex flex-col gap-0.5">
                    <IssueTextEditor
                      value={payload.instructionOverride ?? ""}
                      multiline
                      disabled={busy || finished}
                      placeholder={effectiveWakeupInstruction(
                        { ...payload, instructionOverride: undefined },
                        container ?? undefined
                      )}
                      onCommit={(text) =>
                        void act(
                          task.id,
                          () =>
                            setChildrenDoneInstruction(issueId, text.trim() ? text : null, {
                              source: "user",
                            }),
                          t("instructionSavedToast")
                        )
                      }
                      ariaLabel={t("systemInstruction")}
                      testId="issue-wakeup-system-instruction"
                      className="-mx-2 text-muted-foreground"
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {t("systemInstructionHint")}
                    </span>
                  </div>
                ) : (
                  <p className="line-clamp-2 text-muted-foreground">{payload.instruction}</p>
                )}
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <span>{t("fires", { count: task.runCount, max: task.config.maxRuns ?? 0 })}</span>
                  {task.status === "active" && task.nextRunAt ? (
                    <span>
                      {t("next", {
                        when: formatNextRun(task.nextRunAt, {
                          noSchedule: tScheduler("noSchedule"),
                          overdue: tScheduler("overdue"),
                          lessThanMinute: tScheduler("lessThanMinute"),
                        }),
                      })}
                    </span>
                  ) : null}
                  {held > 0 ? (
                    <span data-testid="issue-wakeup-held">{t("held", { count: held })}</span>
                  ) : null}
                  {task.status === "active" && task.endAt ? (
                    <span data-testid="issue-wakeup-expires">
                      {t("expires", {
                        when: new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(task.endAt),
                      })}
                      {payload.onTimeout === "wake" ? ` · ${t("wakesOnTimeout")}` : ""}
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  {task.status === "active" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-[10px]"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          task.id,
                          () => setIssueWakeupEnabled(task.id, false, { source: "user" }),
                          t("pausedToast")
                        )
                      }
                      data-testid="issue-wakeup-pause"
                    >
                      <PauseIcon className="size-3" />
                      {t("pause")}
                    </Button>
                  ) : task.status === "paused" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5 text-[10px]"
                      disabled={busy || finished}
                      onClick={() =>
                        void act(
                          task.id,
                          () => setIssueWakeupEnabled(task.id, true, { source: "user" }),
                          t("resumedToast")
                        )
                      }
                      data-testid="issue-wakeup-resume"
                    >
                      <PlayIcon className="size-3" />
                      {t("resume")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-[10px] text-destructive hover:text-destructive"
                    disabled={busy}
                    aria-label={t("delete")}
                    title={t("delete")}
                    onClick={() =>
                      void act(
                        task.id,
                        () => deleteIssueWakeup(task.id, { source: "user" }),
                        t("deletedToast")
                      )
                    }
                    data-testid="issue-wakeup-delete"
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="issue-wakeup-empty">
          {t("empty")}
        </p>
      )}
      {createOpen ? (
        <WakeupCreateDialog
          open
          onOpenChange={(next) => {
            if (!next) setCreateOpen(false)
          }}
          issueId={issueId}
          identifier={identifier}
          items={items}
        />
      ) : null}
    </section>
  )
}
