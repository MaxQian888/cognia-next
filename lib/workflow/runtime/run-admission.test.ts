import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { assertWorkflowRunCapacity, WorkflowRunCapacityError } from "./run-admission"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

describe("workflow run admission", () => {
  const row = (id: string, workflowId: string, status: RunStatus): WorkflowRunRow => ({
    id,
    workflowId,
    status,
    triggerKind: "trigger.manual",
    startedAt: 1,
  })

  it.each(["pending", "running", "waiting", "paused"] as const)(
    "counts %s runs against the workflow capacity",
    async (status) => {
      await getDb().workflowRuns.put(row("one", "workflow", status))
      await expect(assertWorkflowRunCapacity("workflow", 1)).rejects.toBeInstanceOf(
        WorkflowRunCapacityError
      )
      await expect(assertWorkflowRunCapacity("workflow", 2)).resolves.toBeUndefined()
      await expect(assertWorkflowRunCapacity("other", 1)).resolves.toBeUndefined()
    }
  )

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "releases capacity for %s runs",
    async (status) => {
      await getDb().workflowRuns.put(row("one", "workflow", status))
      await expect(assertWorkflowRunCapacity("workflow", 1)).resolves.toBeUndefined()
    }
  )
})
