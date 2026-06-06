/**
 * Tests for the unified recent-runs mappers. The hook itself is thin glue
 * around `useLiveQuery` and Dexie; the value of these tests is in the
 * normalisation logic from five different row shapes into one.
 */

import {
  toUnifiedFromTaskExecution,
  toUnifiedFromWorkflowRun,
  toUnifiedFromBackupHistory,
  toUnifiedFromPluginJob,
  toUnifiedFromAudit,
} from "./use-unified-recent-runs"
import type { TaskExecution } from "@/types/scheduler"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { BackupHistoryRow } from "@/lib/db/backup-history"
import type { PluginScheduledJobRow } from "@/lib/db/plugin-types"
import type { ConnectorAuditRow } from "@/lib/db/connector-types"

describe("toUnifiedFromTaskExecution", () => {
  const baseExec: TaskExecution = {
    id: "exec-1",
    taskId: "task-1",
    taskName: "Daily summary",
    taskType: "chat",
    status: "completed",
    retryAttempt: 0,
    startedAt: new Date("2026-05-10T09:00:00Z"),
    completedAt: new Date("2026-05-10T09:00:05Z"),
    duration: 5_000,
    input: { prompt: "hi" },
    output: { reply: "ok" },
    logs: [
      {
        id: "l-1",
        timestamp: new Date("2026-05-10T09:00:01Z"),
        level: "info",
        message: "started",
      },
    ],
  }

  it("maps a completed app-kind task execution", () => {
    const run = toUnifiedFromTaskExecution(baseExec)
    expect(run.kind).toBe("app")
    expect(run.unifiedId).toBe("app:exec-1")
    expect(run.itemUnifiedId).toBe("app:task-1")
    expect(run.status).toBe("succeeded")
    expect(run.startedAt).toBe(baseExec.startedAt.getTime())
    expect(run.finishedAt).toBe(baseExec.completedAt!.getTime())
    expect(run.durationMs).toBe(5_000)
    expect(run.logs).toHaveLength(1)
    expect(run.logs![0]).toMatchObject({ level: "info", message: "started" })
  })

  it("carries the execution's trigger provenance through", () => {
    expect(
      toUnifiedFromTaskExecution({ ...baseExec, triggerSource: "backfill" }).triggerSource
    ).toBe("backfill")
    expect(toUnifiedFromTaskExecution(baseExec).triggerSource).toBeUndefined()
  })

  it("routes connection:* task types to the connector kind", () => {
    const run = toUnifiedFromTaskExecution({
      ...baseExec,
      id: "exec-conn",
      taskType: "connection:scheduled:digest",
    })
    expect(run.kind).toBe("connector")
    expect(run.unifiedId).toBe("connector:exec-conn")
    expect(run.itemUnifiedId).toBe("connector:task-1")
  })

  it("collapses pending and running statuses both to 'running'", () => {
    expect(toUnifiedFromTaskExecution({ ...baseExec, status: "pending" }).status).toBe("running")
    expect(toUnifiedFromTaskExecution({ ...baseExec, status: "running" }).status).toBe("running")
  })

  it("emits an error block when the execution failed", () => {
    const run = toUnifiedFromTaskExecution({
      ...baseExec,
      status: "failed",
      error: "boom",
    })
    expect(run.status).toBe("failed")
    expect(run.error).toEqual({ message: "boom" })
  })

  it("leaves finishedAt / durationMs undefined when the run is still in flight", () => {
    const run = toUnifiedFromTaskExecution({
      ...baseExec,
      status: "running",
      completedAt: undefined,
      duration: undefined,
    })
    expect(run.finishedAt).toBeUndefined()
    expect(run.durationMs).toBeUndefined()
  })
})

describe("toUnifiedFromWorkflowRun", () => {
  const baseRow: WorkflowRunRow = {
    id: "wf-run-1",
    workflowId: "wf-1",
    status: "succeeded",
    triggerKind: "trigger.cron",
    triggerPayload: { cron: "0 9 * * *" },
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_500,
    workflowSnapshot: { id: "wf-1", name: "Test workflow", nodes: [], edges: [] } as never,
  }

  it("maps a succeeded workflow run with computed duration", () => {
    const run = toUnifiedFromWorkflowRun(baseRow)
    expect(run.kind).toBe("workflow")
    expect(run.unifiedId).toBe("workflow:wf-run-1")
    expect(run.itemUnifiedId).toBe("workflow:wf-1")
    expect(run.itemName).toBe("Test workflow")
    expect(run.status).toBe("succeeded")
    expect(run.durationMs).toBe(1_500)
  })

  it("surfaces error block when the run failed", () => {
    const run = toUnifiedFromWorkflowRun({
      ...baseRow,
      status: "failed",
      error: { message: "Step blew up", code: "timeout" },
    })
    expect(run.status).toBe("failed")
    expect(run.error).toMatchObject({ message: "Step blew up", code: "timeout" })
  })

  it("collapses waiting + pending + paused into 'running' for the UI", () => {
    for (const s of ["waiting", "pending", "paused"] as const) {
      expect(toUnifiedFromWorkflowRun({ ...baseRow, status: s }).status).toBe("running")
    }
  })

  it("falls back to the workflowId when the snapshot has no name", () => {
    expect(
      toUnifiedFromWorkflowRun({
        ...baseRow,
        workflowSnapshot: { id: "wf-1", nodes: [], edges: [] } as never,
      }).itemName
    ).toBe("wf-1")
  })
})

describe("toUnifiedFromBackupHistory", () => {
  const baseRow: BackupHistoryRow = {
    id: "bh-1",
    completedAt: 1_700_000_000_000,
    type: "auto",
    success: true,
    encryption: "auto-key",
    sizeBytes: 1234,
    filename: "backup-2026.json",
    schemaVersion: 3,
  }

  it("maps a successful backup row", () => {
    const run = toUnifiedFromBackupHistory(baseRow)
    expect(run.kind).toBe("backup")
    expect(run.unifiedId).toBe("backup:bh-1")
    expect(run.itemUnifiedId).toBe("backup:default")
    expect(run.status).toBe("succeeded")
    expect(run.itemName).toBe("backup-2026.json")
    expect(run.error).toBeUndefined()
  })

  it("emits a failure run with the recorded error message", () => {
    const run = toUnifiedFromBackupHistory({
      ...baseRow,
      success: false,
      errorMessage: "disk full",
    })
    expect(run.status).toBe("failed")
    expect(run.error?.message).toBe("disk full")
  })

  it("falls back to a generic name when the filename is missing", () => {
    expect(toUnifiedFromBackupHistory({ ...baseRow, filename: undefined }).itemName).toBe("Backup")
  })
})

describe("toUnifiedFromPluginJob", () => {
  const baseJob: PluginScheduledJobRow = {
    id: "pj-1",
    pluginId: "vendor.plugin",
    cron: "0 9 * * *",
    handler: "dailyDigest",
    args: { topic: "ops" },
    status: "active",
    lastRunAt: 1_700_000_000_000,
    nextRunAt: 1_700_000_086_400,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_700_000_000_000,
  }

  it("emits a single synthetic run keyed by lastRunAt", () => {
    const runs = toUnifiedFromPluginJob(baseJob)
    expect(runs).toHaveLength(1)
    expect(runs[0].unifiedId).toBe("plugin:pj-1:1700000000000")
    expect(runs[0].itemUnifiedId).toBe("plugin:pj-1")
    expect(runs[0].status).toBe("succeeded")
  })

  it("flags error status when the plugin job is in 'error' state", () => {
    expect(toUnifiedFromPluginJob({ ...baseJob, status: "error" })[0].status).toBe("failed")
  })

  it("emits no runs when the job has never executed", () => {
    expect(toUnifiedFromPluginJob({ ...baseJob, lastRunAt: undefined })).toEqual([])
  })
})

describe("toUnifiedFromAudit", () => {
  const baseRow: ConnectorAuditRow = {
    id: "audit-1",
    adapterId: "adapter-tg",
    kind: "delivery.success",
    at: 1_700_000_000_000,
    conversationKey: "tg:42",
    idempotencyKey: "idem-1",
  }

  it("maps a delivery.success row to a succeeded connector run", () => {
    const run = toUnifiedFromAudit(baseRow)
    expect(run.kind).toBe("connector")
    expect(run.unifiedId).toBe("connector:audit-1")
    expect(run.itemUnifiedId).toBe("connector:adapter-tg")
    expect(run.status).toBe("succeeded")
    expect(run.error).toBeUndefined()
  })

  it("maps delivery.error + deadlettered to failed with an error block", () => {
    const errRun = toUnifiedFromAudit({
      ...baseRow,
      id: "audit-err",
      kind: "delivery.error",
      reason: "network",
      message: "timeout",
    })
    expect(errRun.status).toBe("failed")
    expect(errRun.error).toMatchObject({ code: "network", message: "timeout" })

    const dlRun = toUnifiedFromAudit({ ...baseRow, id: "audit-dl", kind: "delivery.deadlettered" })
    expect(dlRun.status).toBe("failed")
  })

  it("treats rate_limit + circuit + downgrade events as 'skipped' (non-failures)", () => {
    for (const k of [
      "rate_limit.tripped",
      "circuit.opened",
      "circuit.half_opened",
      "circuit.closed",
      "delivery.downgraded",
    ] as const) {
      expect(toUnifiedFromAudit({ ...baseRow, kind: k }).status).toBe("skipped")
    }
  })

  it("treats inbound.* events as 'succeeded'", () => {
    expect(toUnifiedFromAudit({ ...baseRow, kind: "inbound.received" }).status).toBe("succeeded")
  })
})
