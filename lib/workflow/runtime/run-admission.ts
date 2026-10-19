import { getDb } from "@/lib/db/schema"

export class WorkflowRunCapacityError extends Error {
  readonly code = "workflow_concurrency_limit"

  constructor(
    readonly workflowId: string,
    readonly limit: number
  ) {
    super(
      `Workflow ${workflowId} already has ${limit} active runs; wait for one to finish before starting another.`
    )
    this.name = "WorkflowRunCapacityError"
  }
}

/**
 * Must run in the same workflowRuns write transaction as the new row insert.
 * The durable rows arbitrate across editor, published, and resumed processes;
 * a process-local semaphore would let independent callers sharing a DB race.
 */
export async function assertWorkflowRunCapacity(workflowId: string, limit: number): Promise<void> {
  const active = await getDb()
    .workflowRuns.where("workflowId")
    .equals(workflowId)
    .filter((run) => ["pending", "running", "waiting", "paused"].includes(run.status))
    .count()
  if (active >= Math.max(1, limit))
    throw new WorkflowRunCapacityError(workflowId, Math.max(1, limit))
}
