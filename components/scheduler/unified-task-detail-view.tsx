"use client"

/**
 * UnifiedTaskDetailView — dispatches on `item.kind` and renders the right
 * detail surface for that kind. Mirrors the established `UnifiedTaskSidebarItem`
 * convention: one component handles every kind so the page doesn't have to
 * branch on type.
 *
 * Layout:
 *   - For `app`: defer entirely to the existing `TaskDetailView` (it has its
 *     own header and tests; do not double-render a header).
 *   - For `system`: read-only `SystemTaskInspectBody`, framed by the shared
 *     `DetailHeader`.
 *   - For `workflow` / `backup` / `plugin` / `connector`: per-kind body
 *     framed by `DetailHeader`.
 *   - Fallback: a small `UnknownKindDetail` placeholder.
 */

import { useTranslations } from "next-intl"
import { TaskDetailView, type TaskDetailViewProps } from "./task-detail-view"
import { SystemTaskInspectBody } from "./system-task-inspect-sheet"
import { DetailHeader } from "./details/_shared/detail-header"
import { WorkflowDetail } from "./details/workflow-detail"
import { BackupDetail } from "./details/backup-detail"
import { PluginDetail } from "./details/plugin-detail"
import { ConnectorDigestDetail } from "./details/connector-digest-detail"
import { ConnectorQueueDetail } from "./details/connector-queue-detail"
import { CONNECTOR_QUEUE_SOURCE_ID } from "@/lib/scheduler/sources/connector-source"
import { useSystemScheduler } from "@/hooks/scheduler/use-system-scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

export interface UnifiedTaskDetailViewProps {
  item: UnifiedScheduledItem
  /** Provided by the page for the `app` kind so we don't have to refetch. */
  appTaskDetail?: Omit<TaskDetailViewProps, "task"> & { task: TaskDetailViewProps["task"] }
  onRunNow?: (item: UnifiedScheduledItem) => void
  onPause?: (item: UnifiedScheduledItem) => void
  onResume?: (item: UnifiedScheduledItem) => void
  onEdit?: (item: UnifiedScheduledItem) => void
  onDelete?: (item: UnifiedScheduledItem) => void
  onSelectRun?: (run: UnifiedExecutionRun) => void
}

export function UnifiedTaskDetailView(props: UnifiedTaskDetailViewProps) {
  const { item } = props

  if (item.kind === "app" && props.appTaskDetail) {
    return <TaskDetailView {...props.appTaskDetail} />
  }

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        item={item}
        onRunNow={props.onRunNow}
        onPause={props.onPause}
        onResume={props.onResume}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        <KindBody item={item} onSelectRun={props.onSelectRun} />
      </div>
    </div>
  )
}

function KindBody({
  item,
  onSelectRun,
}: {
  item: UnifiedScheduledItem
  onSelectRun?: (run: UnifiedExecutionRun) => void
}) {
  switch (item.kind) {
    case "workflow":
      return <WorkflowDetail workflowTriggerId={item.sourceId} onSelectRun={onSelectRun} />
    case "backup":
      return <BackupDetail onSelectRun={onSelectRun} />
    case "plugin":
      return <PluginDetail jobId={item.sourceId} onSelectRun={onSelectRun} />
    case "system":
      return <SystemKindBody sourceId={item.sourceId} />
    case "connector":
      return item.sourceId === CONNECTOR_QUEUE_SOURCE_ID ? (
        <ConnectorQueueDetail onSelectRun={onSelectRun} />
      ) : (
        <ConnectorDigestDetail taskId={item.sourceId} onSelectRun={onSelectRun} />
      )
    case "app":
      return <UnknownKindDetail label="App tasks render via TaskDetailView." />
    default:
      return <UnknownKindDetail />
  }
}

function SystemKindBody({ sourceId }: { sourceId: string }) {
  const { tasks } = useSystemScheduler()
  // Pure derivation from props/store — no need for separate state.
  const resolved = tasks.find((t) => t.id === sourceId) ?? null

  if (!resolved) {
    return <div className="p-5 text-sm text-muted-foreground">System task not found.</div>
  }
  return (
    <div className="p-5">
      <SystemTaskInspectBody task={resolved} />
    </div>
  )
}

function UnknownKindDetail({ label }: { label?: string }) {
  const t = useTranslations("scheduler")
  return (
    <div className="p-5 text-sm text-muted-foreground" data-testid="unknown-kind-detail">
      {label ?? t("unknownKind") ?? "No detail view for this kind."}
    </div>
  )
}
