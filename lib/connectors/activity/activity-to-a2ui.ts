/**
 * Build the live-activity A2UI surface (Feature A card + Feature B diff).
 * Pure function — mirrors `buildCumulativeStatusSurface` in
 * `workflow-to-a2ui.ts`: one `Card` whose children are `Text` lines while
 * running and `Collapsible`-per-edit at the terminal state.
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
import { diffHunksToUnifiedText } from "./diff-producer"
import type { ActivityI18n } from "./i18n"
import type { TurnActivitySnapshot } from "./turn-activity-tracker"
import {
  safeActivityTarget,
  safeStableActivityId,
  sanitizeActivityLabel,
} from "@/lib/execution/run-activity"

/** Max unified-diff lines per file in the terminal expandable body. */
const DIFF_MAX_LINES = 30

function seconds(elapsedMs: number): number {
  return Math.max(0, Math.round(elapsedMs / 1000))
}

/**
 * Render the activity snapshot as an A2UI surface.
 *
 *   - `running` — title shows tool count · edit count · elapsed, plus a
 *     current-tool line. Edits are NOT detailed (keep the live card compact).
 *   - `done` / `failed` — title shows the verb + elapsed; every accumulated
 *     file edit becomes a `Collapsible` whose label is the `+N −M` summary
 *     and whose body is the truncated unified diff (or a "too large" note).
 */
export function buildActivitySurface(
  snapshot: TurnActivitySnapshot,
  i18n: ActivityI18n
): A2UISegmentContent {
  const secs = seconds(snapshot.elapsedMs)
  const isRunning = snapshot.status === "running"
  const headerIcon = snapshot.status === "done" ? "✓" : snapshot.status === "failed" ? "✗" : "🔧"
  const title = isRunning
    ? `${headerIcon} ${i18n.tools(snapshot.toolCount)} · ${i18n.edits(snapshot.editCount)} · ${i18n.elapsed(secs)}`
    : `${headerIcon} ${
        snapshot.status === "done" ? i18n.done : i18n.failed
      } · ${i18n.elapsed(secs)}`

  const components: Record<string, unknown> = {
    root: { component: "Card", title, children: [] as string[] },
  }
  const childIds: string[] = []
  const mirrorLines: string[] = [`# ${title}`]

  if (isRunning) {
    if (snapshot.currentTool) {
      const line = i18n.currentTool(snapshot.currentTool)
      components.currentTool = { component: "Text", text: line }
      childIds.push("currentTool")
      mirrorLines.push(line)
    }
  } else {
    for (let i = 0; i < snapshot.edits.length; i++) {
      const edit = snapshot.edits[i]
      const label =
        edit.kind === "write"
          ? i18n.fileCreated(edit.filePath, edit.added)
          : i18n.fileEdited(edit.filePath, edit.added, edit.removed)
      const bodyText =
        edit.tooLarge || edit.hunks.length === 0
          ? i18n.diffSkipped
          : diffHunksToUnifiedText(edit.hunks, edit.filePath, DIFF_MAX_LINES).text
      const bodyId = `edit_${i}_body`
      const collId = `edit_${i}`
      components[bodyId] = { component: "Text", text: bodyText }
      components[collId] = {
        component: "Collapsible",
        label: `✏️ ${label}`,
        children: [bodyId],
      }
      childIds.push(collId)
      mirrorLines.push(`✏️ ${label}`)
      mirrorLines.push(bodyText)
    }
  }

  ;(components.root as { children: string[] }).children = childIds

  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

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
  return [
    `**${markdownText(runTitleForPresentation(snapshot, i18n))}** · ${i18n.runStatus(snapshot.status)} · ${elapsed}`,
    progress,
    snapshot.connectorQueueDepth && snapshot.connectorQueueDepth > 0
      ? i18n.queuedTurns(snapshot.connectorQueueDepth)
      : undefined,
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
