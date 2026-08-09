/**
 * Workflow-source adapter: surfaces every row in the `workflowTriggers`
 * Dexie table as a unified scheduled item.
 *
 * Read parity is full. Mutations are scoped:
 *
 *   - `pause` / `resume` — flip `enabled` on the row AND on the trigger node
 *     inside the parent workflow's snapshot (so the next workflow save
 *     doesn't revert the change). The Rust `cron_daemon` re-syncs via
 *     `syncWorkflowTriggers` after the write.
 *   - `runNow` — invoke the active deployment through `ExecutionAuthority`
 *     with a synthetic `manual` trigger payload.
 *   - `create` / `update` / `delete` — NOT supported at this layer. The
 *     canonical write path is the workflow editor; the UI deep-links to
 *     `/workflows/<id>` when the user wants to add or remove a trigger node.
 *
 * Capabilities reflect that scope so the UI hides the disabled actions
 * automatically.
 */

import { liveQuery } from "dexie"
import { getDb } from "@/lib/db/schema"
import { syncWorkflowTriggers } from "@/lib/workflow/runtime/webhook-bridge"
import { executeDeployedWorkflow } from "@/lib/workflow/runtime/execution-authority"
import type {
  VisualWorkflow,
  WorkflowNode,
  WorkflowRunRow,
  WorkflowTriggerRow,
} from "@/types/workflow/visual"
import {
  makeUnifiedId,
  type UnifiedScheduledItem,
  type UnifiedItemStatus,
} from "@/types/scheduler/unified"
import type {
  ScheduledItemSource,
  ScheduledItemSourceObserver,
  ScheduledItemSubscription,
} from "./types"
import { toUnifiedFromWorkflowRun } from "./run-mappers"

export class WorkflowSourceWriteNotSupportedError extends Error {
  constructor(action: string) {
    super(
      `Workflow trigger ${action} is not supported from the scheduler page — open the workflow editor.`
    )
    this.name = "WorkflowSourceWriteNotSupportedError"
  }
}

interface WorkflowSourceDb {
  workflowTriggers: {
    toArray(): Promise<WorkflowTriggerRow[]>
    get(id: string): Promise<WorkflowTriggerRow | undefined>
    update(id: string, changes: Partial<WorkflowTriggerRow>): Promise<number>
  }
  workflows: {
    get(id: string): Promise<VisualWorkflow | undefined>
    put(workflow: VisualWorkflow): Promise<unknown>
  }
}

export interface WorkflowRunInput {
  workflowId: string
  triggerId: string
}

export interface WorkflowRawObservable {
  subscribe(observer: { next(rows: WorkflowTriggerRow[]): void; error?(err: unknown): void }): {
    unsubscribe(): void
  }
}

export interface WorkflowSourceDeps {
  db?: WorkflowSourceDb
  sync?: (workflow: VisualWorkflow) => Promise<void>
  run?: (input: WorkflowRunInput) => Promise<unknown>
  observe?: (querier: () => Promise<WorkflowTriggerRow[]>) => WorkflowRawObservable
  listRuns?: (limit: number) => Promise<WorkflowRunRow[]>
}

export function createWorkflowSource(
  deps: WorkflowSourceDeps = {}
): ScheduledItemSource<never, Partial<{ enabled: boolean; cron: string }>> {
  const db = deps.db ?? (getDb() as unknown as WorkflowSourceDb)
  const sync = deps.sync ?? syncWorkflowTriggers
  const run =
    deps.run ??
    (async ({ workflowId, triggerId }) =>
      executeDeployedWorkflow({
        workflowId,
        entrypoint: "desktop",
        caller: "scheduler:run-now",
        triggerKind: "trigger.manual",
        payload: { triggerId },
      }))
  const observe = deps.observe ?? ((querier) => liveQuery(querier))
  const listRuns =
    deps.listRuns ??
    ((limit: number) => getDb().workflowRuns.orderBy("startedAt").reverse().limit(limit).toArray())

  async function patchTriggerNode(
    workflowId: string,
    triggerId: string,
    mutator: (node: WorkflowNode) => void
  ): Promise<VisualWorkflow | undefined> {
    const workflow = await db.workflows.get(workflowId)
    if (!workflow) return undefined
    const node = workflow.nodes.find((n) => n.id === triggerId)
    if (!node) return workflow
    mutator(node)
    await db.workflows.put(workflow)
    await sync(workflow)
    return workflow
  }

  return {
    kind: "workflow",

    subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription {
      const sub = observe(() => db.workflowTriggers.toArray()).subscribe({
        next: (rows: WorkflowTriggerRow[]) => observer.next(rows.map(toUnifiedTrigger)),
        error: (err: unknown) => observer.error?.(err),
      })
      return { unsubscribe: () => sub.unsubscribe() }
    },

    async list(): Promise<UnifiedScheduledItem[]> {
      const rows = await db.workflowTriggers.toArray()
      return rows.map(toUnifiedTrigger)
    },

    async listRuns(limit) {
      return (await listRuns(limit)).map(toUnifiedFromWorkflowRun)
    },

    async get(sourceId: string): Promise<UnifiedScheduledItem | undefined> {
      const row = await db.workflowTriggers.get(sourceId)
      return row ? toUnifiedTrigger(row) : undefined
    },

    create(): Promise<UnifiedScheduledItem> {
      return Promise.reject(new WorkflowSourceWriteNotSupportedError("create"))
    },

    async update(sourceId, input): Promise<void> {
      const row = await db.workflowTriggers.get(sourceId)
      if (!row) return
      const changes: Partial<WorkflowTriggerRow> = {}
      if (typeof input.enabled === "boolean") changes.enabled = input.enabled
      if (typeof input.cron === "string") changes.cron = input.cron
      if (Object.keys(changes).length === 0) return
      changes.updatedAt = Date.now()
      await db.workflowTriggers.update(sourceId, changes)

      // Keep the workflow node + Rust registry in sync.
      await patchTriggerNode(row.workflowId, row.id, (node) => {
        if (typeof input.enabled === "boolean") {
          node.data.disabled = !input.enabled
        }
        if (typeof input.cron === "string") {
          node.data.params = { ...(node.data.params ?? {}), cron: input.cron }
        }
      })
    },

    delete(): Promise<void> {
      return Promise.reject(new WorkflowSourceWriteNotSupportedError("delete"))
    },

    async pause(sourceId: string): Promise<void> {
      await this.update(sourceId, { enabled: false })
    },

    async resume(sourceId: string): Promise<void> {
      await this.update(sourceId, { enabled: true })
    },

    async runNow(sourceId: string): Promise<void> {
      const row = await db.workflowTriggers.get(sourceId)
      if (!row) return
      await run({ workflowId: row.workflowId, triggerId: sourceId })
    },
  }
}

export function toUnifiedTrigger(row: WorkflowTriggerRow): UnifiedScheduledItem {
  return {
    unifiedId: makeUnifiedId("workflow", row.id),
    kind: "workflow",
    sourceId: row.id,
    name: workflowTriggerName(row),
    description: row.kind,
    status: mapWorkflowStatus(row),
    triggerSummary: {
      type: row.kind === "trigger.cron" ? "cron" : "event",
      cron: row.cron,
      eventType: row.kind,
      timezone: row.timezone,
    },
    nextRunAt: row.nextFireAt,
    origin: {
      tableName: "workflowTriggers",
      deepLinkHref: `/workflows/editor?id=${encodeURIComponent(row.workflowId)}`,
    },
    capabilities: {
      runNow: true,
      pause: true,
      edit: false, // edit happens in the workflow editor
      delete: false,
    },
  }
}

function workflowTriggerName(row: WorkflowTriggerRow): string {
  const head = row.cron ? row.cron : row.webhookPath ? `webhook ${row.webhookPath}` : row.kind
  return `${row.workflowId} · ${head}`
}

function mapWorkflowStatus(row: WorkflowTriggerRow): UnifiedItemStatus {
  return row.enabled ? "active" : "paused"
}
