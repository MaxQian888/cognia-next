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
import { bareToolName } from "@/lib/chat/tool-summary"
import {
  foldToolApprovals,
  safeActivityTarget,
  safeStableActivityId,
  safeToolActivityLabel,
  sanitizeActivityCommentary,
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

export function activityStatusForPresentation(
  activity: RunActivitySnapshot
): RunActivitySnapshot["status"] {
  if (activity.approval?.status === "pending") return "blocked"
  if (activity.approval?.status === "denied" || activity.approval?.status === "expired")
    return "failed"
  return activity.status
}

function activityLine(activity: RunActivitySnapshot, i18n: ActivityI18n): string {
  const target = activity.target
    ? activity.target.kind === "workspace_path"
      ? ` · \`${markdownText(activity.target.label)}\``
      : ` · ${markdownText(activity.target.label)}`
    : ""
  const duration =
    activity.endedAt !== undefined && activity.endedAt >= activity.startedAt
      ? ` · ${i18n.elapsed(Math.round((activity.endedAt - activity.startedAt) / 1000))}`
      : ""
  const approval =
    activity.approval && activity.approval.status !== "approved"
      ? ` · ${i18n.approvalStatus(activity.approval.status)}`
      : ""
  const failure =
    activity.status === "failed" && activity.failureReason
      ? ` · ${markdownText(activity.failureReason)}`
      : ""
  return `${ACTIVITY_STATUS_ICON[activityStatusForPresentation(activity)]} ${ACTIVITY_ICON[activity.category]} ${markdownText(i18n.activityLabel(activity))}${approval}${duration}${target}${failure}`
}

function stepActivity(step: RunStepSnapshot): RunActivitySnapshot {
  const status: RunActivitySnapshot["status"] =
    step.status === "in_progress" ? "running" : step.status === "blocked" ? "blocked" : step.status
  return {
    id: step.id.startsWith("tool:") ? step.id : `legacy-step:${step.id}`,
    kind: step.id.startsWith("tool:") ? "tool" : "step",
    category: step.id.startsWith("tool:") ? "integration" : "status",
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
      ? snapshot.activities
      : [...snapshot.activeSteps, ...snapshot.recentSteps, ...snapshot.pendingSteps]
          .slice(0, 12)
          .map(stepActivity)
  const safeActivities: RunActivitySnapshot[] = foldToolApprovals(activities, snapshot.runId).map(
    (activity) => {
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
      const toolName = activity.toolName
        ? sanitizeActivityLabel(bareToolName(activity.toolName), "Tool")
        : undefined
      const rawLabel = sanitizeActivityLabel(activity.label, kind === "tool" ? "Tool" : "Activity")
      const toolLabel =
        kind === "tool" && (toolName || /^[\w.-]+$/.test(rawLabel))
          ? safeToolActivityLabel(toolName ?? rawLabel)
          : rawLabel
      const approval =
        activity.approval &&
        ["pending", "approved", "denied", "expired"].includes(activity.approval.status) &&
        typeof activity.approval.requestId === "string"
          ? {
              requestId: safeStableActivityId(activity.approval.requestId),
              status: activity.approval.status,
            }
          : undefined
      return {
        id: safeStableActivityId(activity.id),
        kind,
        category,
        status,
        label:
          kind === "step" && category === "status"
            ? sanitizeActivityCommentary(activity.label, "Activity")
            : toolLabel,
        ...(toolName ? { toolName } : {}),
        ...(approval ? { approval } : {}),
        ...(activity.failureReason
          ? { failureReason: sanitizeActivityLabel(activity.failureReason, "Tool failed") }
          : {}),
        ...(target ? { target } : {}),
        startedAt: Number.isFinite(activity.startedAt) ? activity.startedAt : 0,
        ...(activity.endedAt !== undefined && Number.isFinite(activity.endedAt)
          ? { endedAt: activity.endedAt }
          : {}),
      }
    }
  )
  return safeActivities.filter((activity) => activity.kind !== "lifecycle").slice(0, 12)
}

export function runTitleForPresentation(
  snapshot: RunProjectionSnapshot,
  i18n?: ActivityI18n
): string {
  const safeName = sanitizeActivityLabel(snapshot.title, "Execution run")
  if (!i18n) return safeName
  const kind = i18n.runKind(snapshot.kind)
  return safeName === "Execution run" || safeName === "Agent run"
    ? kind
    : snapshot.kind === "agent-turn"
      ? safeName
      : `${kind} · ${safeName}`
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

/** Shared selection and counts; platform renderers own only the visual syntax. */
export function runMilestonesForPresentation(
  snapshot: RunProjectionSnapshot,
  excludedStepIds: ReadonlySet<string> = new Set()
):
  | {
      steps: RunStepSnapshot[]
      completed: number
      total: number
      hidden: number
    }
  | undefined {
  const ordered = [
    ...new Map(
      [
        ...snapshot.activeSteps,
        ...snapshot.recentSteps.filter(
          (step) => step.status === "failed" || step.status === "blocked"
        ),
        ...snapshot.pendingSteps,
        ...snapshot.recentSteps,
      ]
        .filter(
          (step) =>
            !excludedStepIds.has(step.id) &&
            !(
              snapshot.kind === "agent-turn" &&
              (step.id.startsWith("tool:") || step.id.startsWith("commentary:"))
            )
        )
        .map((step) => [step.id, step])
    ).values(),
  ]
  if (ordered.length === 0) return undefined
  const total = Math.max(
    ordered.length + Math.max(0, snapshot.pendingStepCount - snapshot.pendingSteps.length),
    snapshot.progress.total || 0
  )
  const completed = snapshot.progress.trustworthy
    ? snapshot.progress.completed
    : ordered.filter((step) => step.status === "completed").length
  const steps = ordered.slice(0, MILESTONE_WINDOW)
  const hidden =
    ordered.length -
    steps.length +
    Math.max(0, snapshot.pendingStepCount - snapshot.pendingSteps.length)
  return { steps, completed, total, hidden }
}

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
  const milestones = runMilestonesForPresentation(snapshot)
  if (!milestones) return undefined
  const { steps: shown, completed, total, hidden } = milestones

  const lines = shown.map((step) => {
    const label = sanitizeActivityLabel(step.title, i18n.milestoneStatus(step.status))
    const duration =
      Number.isFinite(step.startedAt) &&
      Number.isFinite(step.completedAt) &&
      step.completedAt! >= step.startedAt!
        ? ` · ${i18n.elapsed(Math.round((step.completedAt! - step.startedAt!) / 1000))}`
        : ""
    return `${MILESTONE_STATUS_ICON[step.status]} ${markdownText(label)} · ${i18n.milestoneStatus(step.status)}${duration}`
  })
  if (hidden > 0) lines.push(i18n.moreMilestones(hidden))
  const heading =
    snapshot.kind === "workflow"
      ? `**${i18n.runKind("workflow")}** — ${completed}/${total}`
      : i18n.milestones(completed, total)
  return [heading, ...lines].join("\n")
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
  // `waitingReason` is a code since ADR-0169. The two the reducer writes map
  // onto run statuses this i18n already names; anything else is shown as is.
  const code = snapshot.waitingReason
  const reason =
    code === "waiting_review"
      ? i18n.runStatus("waiting")
      : code === "recovery_required"
        ? i18n.runStatus("recovery_required")
        : code
  const notRun = [...snapshot.activeSteps, ...snapshot.pendingSteps].filter(
    (step) =>
      !(
        snapshot.kind === "agent-turn" &&
        (step.id.startsWith("tool:") || step.id.startsWith("commentary:"))
      ) &&
      (step.status === "pending" || step.status === "in_progress")
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
  const timeline = activityLines.length > 0 ? activityLines : [i18n.noPublicActivity]
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
