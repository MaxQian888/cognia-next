import { emitFinishedSpan, recordEvent } from "@cognia/agent-trace/emitter"
import { runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import type { ResourceChange, TaskResourceSummary } from "./types"

type ProjectedResource = Pick<
  ResourceChange,
  "path" | "oldPath" | "kind" | "captureClass" | "origin" | "sensitive"
>

export interface ProjectTaskWorkspaceRunInput {
  executionRunId?: string
  taskWorkspaceRunId: string
  traceSpanId?: string
  traceId?: string
  sessionId?: string
  surface?: string
  resources: ProjectedResource[]
  summary: TaskResourceSummary
}

/**
 * Project the local Task Workspace fact source into the semantic run journal
 * and Agent Trace. Paths are private journal data; trace events are aggregate
 * only so remote transports cannot receive workspace details.
 */
export async function projectTaskWorkspaceRun({
  executionRunId,
  taskWorkspaceRunId,
  traceSpanId,
  traceId,
  sessionId,
  surface,
  resources,
  summary,
}: ProjectTaskWorkspaceRunInput): Promise<void> {
  if (executionRunId) {
    for (const resource of resources) {
      await runEventJournal.append(
        executionRunId,
        semanticRunEvent(
          "resource.changed",
          {
            taskWorkspaceRunId,
            path: resource.path,
            ...(resource.oldPath ? { oldPath: resource.oldPath } : {}),
            kind: resource.kind,
            captureClass: resource.captureClass,
            origin: resource.origin,
            sensitive: resource.sensitive,
          },
          { visibility: "private" }
        )
      )
    }
    await runEventJournal.append(
      executionRunId,
      semanticRunEvent(
        "resource.summary",
        {
          taskWorkspaceRunId,
          counts: summary.counts,
          eventCount: summary.eventCount,
          overflowCount: summary.overflowCount,
          completeness: summary.completeness,
        },
        { visibility: "summary" }
      )
    )
  }

  if (traceSpanId) {
    const traceEvent = {
      name: "workspace.resources.changed",
      at: Date.now(),
      attributes: {
        taskWorkspaceRunId,
        created: summary.counts.created,
        modified: summary.counts.modified,
        deleted: summary.counts.deleted,
        renamed: summary.counts.renamed,
        source: summary.counts.source,
        generated: summary.counts.generated,
        eventCount: summary.eventCount,
        overflowCount: summary.overflowCount,
        completeness: summary.completeness,
      },
    }
    const attached = recordEvent(traceSpanId, traceEvent)
    if (!attached && traceId) {
      const traceSurface =
        surface === "chat"
          ? "chat"
          : surface === "team"
            ? "agent-team"
            : surface === "plugin"
              ? "plugin-hook"
              : "workflow"
      emitFinishedSpan({
        operationName: "invoke_agent",
        providerName: "cognia.workflow",
        sessionId: sessionId ?? executionRunId ?? taskWorkspaceRunId,
        surface: traceSurface,
        traceId,
        parentSpanId: traceSpanId,
        startTime: traceEvent.at,
        endTime: traceEvent.at,
        events: [traceEvent],
        metadata: { taskWorkspaceRunId },
      })
    }
  }
}
