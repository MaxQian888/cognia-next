/**
 * Build the durable run-activity A2UI surface (execution-run card).
 * Pure functions over `RunProjectionSnapshot` — one `Card` whose children
 * are `Text` timeline lines.
 *
 * Component vocabulary (Card / Text / Collapsible) is the same one the
 * A2UI mapper (`adapters/_shared/a2ui-mapper.ts`) projects to platform-native
 * rich content (Lark interactive cards, Slack Block Kit, Telegram, Discord).
 * Adapters that can't render a component fall back to `widget.fallbackText`,
 * which `a2ui-to-segments.ts:buildA2UISegment` bakes into the segment's
 * `plainTextMirror` — so every adapter gets a readable card either way.
 */
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type {
  RunActivityCategory,
  RunActivitySnapshot,
  RunProjectionSnapshot,
  RunStepSnapshot,
} from "@/types/execution/run"
import type { ActivityI18n } from "./i18n"
import {
  safeActivityTarget,
  safeStableActivityId,
  sanitizeActivityLabel,
} from "@/lib/execution/run-activity"

const ACTIVITY_ICON: Record<RunActivityCategory, string> = {
  search: "⌕",
  read: "▤",
  write: "✎",
  command: "</>",
  integration: "◇",
  skill: "◆",
  artifact: "▣",
  approval: "◷",
  status: "•",
}

const ACTIVITY_STATUS_ICON: Record<RunActivitySnapshot["status"], string> = {
  pending: "○",
  running: "◉",
  completed: "✓",
  failed: "✕",
  skipped: "–",
  blocked: "◷",
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_[\]])/g, "\\$1")
}

function activityLine(activity: RunActivitySnapshot, i18n: ActivityI18n): string {
  const target = activity.target
    ? activity.target.kind === "workspace_path"
      ? ` · \`${markdownText(activity.target.label)}\``
      : ` · ${markdownText(activity.target.label)}`
    : ""
  return `${ACTIVITY_STATUS_ICON[activity.status]} ${ACTIVITY_ICON[activity.category]} ${markdownText(i18n.activityLabel(activity))}${target}`
}

function stepActivity(step: RunStepSnapshot): RunActivitySnapshot {
  const status: RunActivitySnapshot["status"] =
    step.status === "in_progress" ? "running" : step.status === "blocked" ? "blocked" : step.status
  return {
    id: `legacy-step:${step.id}`,
    kind: "step",
    category: "status",
    status,
    label: step.title,
    startedAt: step.startedAt ?? step.completedAt ?? 0,
    ...(step.completedAt !== undefined ? { endedAt: step.completedAt } : {}),
  }
}

/** Final defensive boundary shared by every IM presenter, including legacy snapshots. */
export function runActivitiesForPresentation(
  snapshot: RunProjectionSnapshot
): RunActivitySnapshot[] {
  const activities =
    snapshot.activities && snapshot.activities.length > 0
      ? snapshot.activities.slice(0, 12)
      : [...snapshot.activeSteps, ...snapshot.recentSteps, ...snapshot.pendingSteps]
          .slice(0, 12)
          .map(stepActivity)
  return activities.map((activity) => {
    const target = safeActivityTarget(activity.target)
    const kind: RunActivitySnapshot["kind"] = [
      "lifecycle",
      "tool",
      "step",
      "artifact",
      "approval",
    ].includes(activity.kind)
      ? activity.kind
      : "lifecycle"
    const category: RunActivityCategory = Object.hasOwn(ACTIVITY_ICON, activity.category)
      ? activity.category
      : "status"
    const status: RunActivitySnapshot["status"] = Object.hasOwn(
      ACTIVITY_STATUS_ICON,
      activity.status
    )
      ? activity.status
      : "pending"
    return {
      id: safeStableActivityId(activity.id),
      kind,
      category,
      status,
      label: sanitizeActivityLabel(activity.label, kind === "tool" ? "Tool" : "Activity"),
      ...(target ? { target } : {}),
      startedAt: Number.isFinite(activity.startedAt) ? activity.startedAt : 0,
      ...(activity.endedAt !== undefined && Number.isFinite(activity.endedAt)
        ? { endedAt: activity.endedAt }
        : {}),
    }
  })
}

export function runTitleForPresentation(
  snapshot: RunProjectionSnapshot,
  i18n?: ActivityI18n
): string {
  const safeName = sanitizeActivityLabel(snapshot.title, "Execution run")
  if (!i18n) return safeName
  const kind = i18n.runKind(snapshot.kind)
  return safeName === "Execution run" || safeName === "Agent run" ? kind : `${kind} · ${safeName}`
}

const MILESTONE_STATUS_ICON: Record<RunStepSnapshot["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  failed: "✕",
  blocked: "⊘",
  skipped: "–",
}

/** How many milestones the block renders before collapsing the remainder. */
const MILESTONE_WINDOW = 8

/**
 * The plan block — what the run set out to do, and where it has got to.
 *
 * Distinct from the activity timeline on purpose: the timeline is a rolling
 * window of what just happened, and a person watching a long run needs to see
 * the shape of the whole task. This is the `plan_update` / `task_update` split
 * that the Lark and Slack native drivers already emit; every other platform
 * had nothing, because `formatRunActivityTimeline` rendered only
 * `runActivitiesForPresentation` and never read `activeSteps` / `pendingSteps`
 * / `pendingStepCount` at all. Steps reached the card only through the legacy
 * shim, and only when `activities` happened to be empty.
 *
 * Rendered by the shared surface builder, so every card-edit, append and
 * final-only platform inherits it without adapter work.
 */
export function formatRunMilestones(
  snapshot: RunProjectionSnapshot,
  i18n: ActivityI18n
): string | undefined {
  const ordered = [...snapshot.recentSteps, ...snapshot.activeSteps, ...snapshot.pendingSteps]
  if (ordered.length === 0) return undefined

  const total = Math.max(ordered.length, snapshot.progress.total || 0)
  const completed = ordered.filter((step) => step.status === "completed").length
  const shown = ordered.slice(0, MILESTONE_WINDOW)
  // `pendingStepCount` counts steps the projection knows about but did not
  // include; the window may hide more on top of that.
  const hidden =
    ordered.length -
    shown.length +
    Math.max(0, snapshot.pendingStepCount - snapshot.pendingSteps.length)

  const lines = shown.map((step) => {
    const label = sanitizeActivityLabel(step.title, i18n.milestoneStatus(step.status))
    return `${MILESTONE_STATUS_ICON[step.status]} ${markdownText(label)}`
  })
  if (hidden > 0) lines.push(i18n.moreMilestones(hidden))
  return [i18n.milestones(completed, total), ...lines].join("\n")
}

/**
 * Terminal note: what stopped the run, and what it never got to.
 *
 * Slack's guidance for a blocked agent is "save what it has accomplished,
 * explain where it got stuck, give the user a clear set of options". The first
 * is the milestone block; this is the second.
 *
 * Deliberately does NOT read `snapshot.error`. That field can carry a raw
 * message or stack, and this builder runs on raw snapshots as well as on the
 * IM-safe projection — the connector path substitutes a fixed string for it,
 * but nothing structurally guarantees every caller does. `waitingReason` is a
 * controlled value, and the genuinely useful "where" is already in the
 * milestone block: the step that was in progress when the run stopped, with
 * its title sanitized like every other label.
 */
export function formatRunStoppedNote(
  snapshot: RunProjectionSnapshot,
  i18n: ActivityI18n
): string | undefined {
  const reason = snapshot.waitingReason
  const notRun = [...snapshot.activeSteps, ...snapshot.pendingSteps].filter(
    (step) => step.status === "pending" || step.status === "in_progress"
  ).length
  const lines = [
    reason ? i18n.stoppedBecause(sanitizeActivityLabel(reason, "unknown")) : undefined,
    notRun > 0 ? i18n.notReached(notRun) : undefined,
  ].filter((line): line is string => Boolean(line))
  return lines.length > 0 ? lines.join("\n") : undefined
}

/** Deterministic, platform-neutral Markdown/plain-text projection for one durable run. */
export function formatRunActivityTimeline(
  snapshot: RunProjectionSnapshot,
  i18n: ActivityI18n
): string {
  const elapsed = i18n.elapsed(Math.max(0, Math.round(snapshot.elapsedMs / 1000)))
  const progress =
    snapshot.progress.trustworthy && snapshot.progress.total > 0
      ? i18n.progress(
          snapshot.progress.completed,
          snapshot.progress.total,
          Math.round(
            (snapshot.progress.ratio ?? snapshot.progress.completed / snapshot.progress.total) * 100
          )
        )
      : i18n.completedActivities(snapshot.progress.completed)
  const activityLines = runActivitiesForPresentation(snapshot).map((activity) =>
    activityLine(activity, i18n)
  )
  const timeline =
    activityLines.length > 0
      ? activityLines.flatMap((line, index) =>
          index < activityLines.length - 1 ? [line, "│"] : [line]
        )
      : [i18n.noPublicActivity]
  const terminal = ["completed", "failed", "cancelled"].includes(snapshot.status)
  return [
    `**${markdownText(runTitleForPresentation(snapshot, i18n))}** · ${i18n.runStatus(snapshot.status)} · ${elapsed}`,
    progress,
    snapshot.connectorQueueDepth && snapshot.connectorQueueDepth > 0
      ? i18n.queuedTurns(snapshot.connectorQueueDepth)
      : undefined,
    // The plan block sits ABOVE the rolling activity window: the shape of the
    // task outranks the last few tool calls for someone deciding whether to
    // intervene.
    formatRunMilestones(snapshot, i18n),
    terminal ? formatRunStoppedNote(snapshot, i18n) : undefined,
    snapshot.omittedActivityCount && snapshot.omittedActivityCount > 0
      ? i18n.omittedActivities(snapshot.omittedActivityCount)
      : undefined,
    ...timeline,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .slice(0, 12_000)
}

/** Reuse the canonical A2UI Card/Text vocabulary for non-native platform fallback. */
export function buildRunActivitySurface(
  snapshot: RunProjectionSnapshot,
  i18n: ActivityI18n
): A2UISegmentContent {
  const timeline = formatRunActivityTimeline(snapshot, i18n)
  const title = runTitleForPresentation(snapshot, i18n)
  return {
    components: {
      root: {
        id: "root",
        component: "Card",
        title,
        children: ["timeline"],
      },
      timeline: { id: "timeline", component: "Text", text: timeline },
    },
    dataModel: {
      runId: safeStableActivityId(snapshot.runId),
      revision: snapshot.revision,
      status: snapshot.status,
      activityCount: snapshot.activityCount ?? snapshot.activities?.length ?? 0,
      omittedActivityCount: snapshot.omittedActivityCount ?? 0,
    },
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: timeline },
  }
}
