/**
 * E2E: `flow.subworkflow` actually runs a nested child workflow.
 *
 * The existing `nodes/flow/subworkflow.spec.ts` seeds a node pointing at a
 * placeholder id and only checks the node renders — it never runs a real child.
 * Here we seed a real child workflow, seed a parent that invokes it by id, run
 * the parent, and assert BOTH run rows land: the parent succeeds AND a separate
 * child run row exists and succeeded, with the parent's subworkflow step output
 * referencing the child's runId. That proves the nesting plumbing
 * (`lib/workflow/nodes/built-ins.ts:2390` → `runWorkflow`) actually executes the
 * child rather than no-op'ing. Runs in the chromium PR CI job (no AI creds).
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { readLatestRun, readRuns } from "../../helpers/workflow-spec-helpers"

async function seedGraph(page: Page, graph: unknown): Promise<string> {
  return page.evaluate(async (g) => {
    const w = window as Window & {
      __cogniaSeedRawWorkflow?: (draft: unknown) => Promise<string>
    }
    if (typeof w.__cogniaSeedRawWorkflow !== "function") {
      throw new Error("window.__cogniaSeedRawWorkflow is not wired")
    }
    return w.__cogniaSeedRawWorkflow(g)
  }, graph)
}

function childGraph() {
  return {
    name: "E2E nested child",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 60, y: 80 },
        data: { label: "Manual", params: {} },
      },
      {
        id: "n_child_set",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 300, y: 80 },
        data: { label: "ChildSet", params: { variable: "fromChild", value: "child-ran" } },
      },
    ],
    edges: [{ id: "e0", source: "n_trigger", target: "n_child_set" }],
  }
}

function parentGraph(childId: string) {
  return {
    name: "E2E nesting parent",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 60, y: 80 },
        data: { label: "Manual", params: {} },
      },
      {
        id: "n_sub",
        type: "flow.subworkflow",
        typeVersion: 1,
        position: { x: 300, y: 80 },
        data: { label: "Sub", params: { workflowId: childId } },
      },
    ],
    edges: [{ id: "e0", source: "n_trigger", target: "n_sub" }],
  }
}

test.describe("workflow engine — subworkflow nesting", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("running a parent executes the nested child and lands both run rows", async ({ page }) => {
    const childId = await seedGraph(page, childGraph())
    const parentId = await seedGraph(page, parentGraph(childId))

    await page.goto(`/workflows/editor?id=${parentId}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await page.getByTestId("workflow-run").click()

    // Parent run succeeds.
    await expect
      .poll(async () => (await readLatestRun(page, parentId))?.status, { timeout: 30_000 })
      .toBe("succeeded")

    // A separate child run row landed and succeeded.
    await expect
      .poll(async () => (await readRuns(page, childId)).map((r) => r.status), { timeout: 30_000 })
      .toContain("succeeded")

    // The parent's subworkflow step output references the actual child run id.
    const childRuns = await readRuns(page, childId)
    expect(childRuns).toHaveLength(1)
    const childRunId = childRuns[0].id

    const parentRun = await readLatestRun(page, parentId)
    const subEvent = (parentRun?.events ?? []).find(
      (e) => e.type === "step_completed" && e.stepId === "n_sub"
    )
    const output = (subEvent?.payload as { output?: { runId?: string } } | undefined)?.output
    expect(output?.runId).toBe(childRunId)
  })
})
