import {
  formatRunStoppedNote,
  activityStatusForPresentation,
  runActivitiesForPresentation,
  runMilestonesForPresentation,
} from "@/lib/connectors/activity/activity-to-a2ui"
import type { ActivityI18n } from "@/lib/connectors/activity/i18n"
import {
  escapeLarkCardText,
  larkGreyText,
  larkStatusTag,
} from "@/lib/connectors/adapters/lark/card-kit"
import { safeStableActivityId, sanitizeActivityLabel } from "@/lib/execution/run-activity"
import type { RunProjectionSnapshot, RunStepSnapshot } from "@/types/execution/run"

function duration(
  start: number | undefined,
  end: number | undefined,
  i18n: ActivityI18n
): string | undefined {
  return start !== undefined &&
    end !== undefined &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end >= start
    ? i18n.elapsed(Math.round((end - start) / 100) / 10)
    : undefined
}

/** A plan node uses the same native status vocabulary as an activity row. */
export function larkMilestoneLine(step: RunStepSnapshot, i18n: ActivityI18n): string {
  const status = step.status === "in_progress" ? "running" : step.status
  const elapsed = duration(step.startedAt, step.completedAt, i18n)
  return `${larkStatusTag(status, i18n.activityStatus(status))} ${escapeLarkCardText(sanitizeActivityLabel(step.title, i18n.milestoneStatus(step.status)))}${elapsed ? ` ${larkGreyText(`· ${elapsed}`)}` : ""}`
}

/** Count all known activities, including the part outside the rolling window. */
export function larkActivityCount(snapshot: RunProjectionSnapshot): number {
  return runActivitiesForPresentation(snapshot).length + (snapshot.omittedActivityCount ?? 0)
}

/**
 * Card markdown is not the platform-neutral Markdown dialect. Keep selection
 * shared, and escape raw text once as entities at this Lark-only boundary.
 */
export function formatLarkRunTimeline(snapshot: RunProjectionSnapshot, i18n: ActivityI18n): string {
  const lines: string[] = []
  const activities = runActivitiesForPresentation(snapshot)
  const narrationIds = new Set(
    activities
      .filter((activity) => activity.kind === "step" && activity.category === "status")
      .map((activity) => activity.id)
  )
  // Commentary is journaled as a step too. Its source ID and typed activity
  // identify that duplicate even if an earlier IM boundary reduced its title
  // to "Step". Actual plan/workflow nodes still belong in the milestone block.
  const commentaryStepIds = new Set(
    [...snapshot.activeSteps, ...snapshot.recentSteps, ...snapshot.pendingSteps]
      .filter(
        (step) =>
          step.id.startsWith("commentary:") ||
          (snapshot.kind === "agent-turn" &&
            snapshot.planVersion === undefined &&
            narrationIds.has(`step:${safeStableActivityId(step.id)}`))
      )
      .map((step) => step.id)
  )
  if (snapshot.connectorQueueDepth && snapshot.connectorQueueDepth > 0) {
    lines.push(larkGreyText(i18n.queuedTurns(snapshot.connectorQueueDepth)))
  }
  const milestones = runMilestonesForPresentation(snapshot, commentaryStepIds)
  if (milestones) {
    const { steps, completed, total, hidden } = milestones
    lines.push(
      larkGreyText(
        `${i18n.runKind(snapshot.kind === "workflow" ? "workflow" : "plan")} · ${completed}/${total}`
      )
    )
    lines.push(...steps.map((step) => larkMilestoneLine(step, i18n)))
    if (hidden > 0) lines.push(larkGreyText(i18n.moreMilestones(hidden)))
  }
  if (["completed", "failed", "cancelled"].includes(snapshot.status)) {
    const stopped = formatRunStoppedNote(snapshot, i18n)
    if (stopped) lines.push(...stopped.split("\n").map(larkGreyText))
  }
  if (snapshot.omittedActivityCount && snapshot.omittedActivityCount > 0) {
    lines.push(larkGreyText(i18n.omittedActivities(snapshot.omittedActivityCount)))
  }
  let previousCommentary: string | undefined
  for (const activity of activities) {
    const label = i18n.activityLabel(activity)
    if (activity.kind === "step" && activity.category === "status") {
      if (label !== previousCommentary) lines.push(larkGreyText(label))
      previousCommentary = label
      continue
    }
    previousCommentary = undefined
    const approval = activity.approval?.status
    const status = activityStatusForPresentation(activity)
    const statusLabel =
      approval && approval !== "approved"
        ? i18n.approvalStatus(approval)
        : i18n.activityStatus(status)
    const metadata = [
      duration(activity.startedAt, activity.endedAt, i18n),
      activity.target?.label,
    ].filter(Boolean)
    lines.push(
      `${larkStatusTag(status, statusLabel)} ${escapeLarkCardText(label)}${metadata.length ? ` ${larkGreyText(`· ${metadata.join(" · ")}`)}` : ""}${activity.status === "failed" && activity.failureReason ? ` — ${escapeLarkCardText(activity.failureReason)}` : ""}`
    )
  }
  if (!activities.length) lines.push(larkGreyText(i18n.noPublicActivity))
  return lines.join("\n")
}
