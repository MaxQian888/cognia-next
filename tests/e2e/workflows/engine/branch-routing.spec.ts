/**
 * E2E: `flow.branch` actually routes the run down ONE arm.
 *
 * The existing `nodes/flow/branch.spec.ts` only asserts the seeded node renders
 * and that *a* run lands `succeeded` — it never checks that the engine took the
 * correct arm. A regression that ran BOTH arms (or the wrong one) would pass it.
 *
 * Here we seed a trigger → branch → {true-arm, false-arm} graph and read the
 * real per-step timeline from Dexie (via `__cogniaReadRuns`). We assert the
 * chosen arm's node has a `step_completed` event and the other arm's node does
 * NOT — for both a truthy and a falsy condition.
 *
 * Routing fact under test (`lib/workflow/runtime/orchestrator.ts:533`): a node
 * returning `decision` skips outgoing edges whose `sourceHandle` ∉ the decision
 * set. `flow.branch` v1 returns `"true"` when the resolved `condition` is
 * truthy, `"false"` when falsy.
 *
 * Picking deterministic conditions is subtle: the expression resolver
 * (`lib/workflow/runtime/expression.ts`) is NOT a JS interpreter — it only does
 * scope lookups, so `{{ true }}` / `{{ 1 }}` resolve to `undefined` (falsy), and
 * a bare `"false"` string is a non-empty string (truthy), and an empty condition
 * is rejected before a run is even persisted. We therefore drive truthy off the
 * always-present trigger object (`{{ $trigger }}`) and falsy off a missing field
 * on it (`{{ $trigger.__absent }}`). Runs in the chromium PR CI job (no AI creds).
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { readLatestRun } from "../../helpers/workflow-spec-helpers"

/** Build a trigger → branch → {n_true, n_false} graph for the given condition. */
function branchGraph(condition: string) {
  return {
    name: `E2E branch routing (${condition || "empty"})`,
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 60, y: 120 },
        data: { label: "Manual", params: {} },
      },
      {
        id: "n_branch",
        type: "flow.branch",
        typeVersion: 1,
        position: { x: 300, y: 120 },
        data: { label: "Branch", params: { condition } },
      },
      {
        id: "n_true",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 560, y: 40 },
        data: { label: "TrueArm", params: { variable: "arm", value: "true-ran" } },
      },
      {
        id: "n_false",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 560, y: 220 },
        data: { label: "FalseArm", params: { variable: "arm", value: "false-ran" } },
      },
    ],
    edges: [
      { id: "e0", source: "n_trigger", target: "n_branch" },
      { id: "e_true", source: "n_branch", sourceHandle: "true", target: "n_true" },
      { id: "e_false", source: "n_branch", sourceHandle: "false", target: "n_false" },
    ],
  }
}

async function seed(page: import("@playwright/test").Page, condition: string): Promise<string> {
  return page.evaluate(async (graph) => {
    const w = window as Window & {
      __cogniaSeedRawWorkflow?: (draft: unknown) => Promise<string>
    }
    if (typeof w.__cogniaSeedRawWorkflow !== "function") {
      throw new Error("window.__cogniaSeedRawWorkflow is not wired")
    }
    return w.__cogniaSeedRawWorkflow(graph)
  }, branchGraph(condition))
}

/** Step ids that emitted a `step_completed` event in the latest run. */
async function completedSteps(
  page: import("@playwright/test").Page,
  workflowId: string
): Promise<Set<string>> {
  const run = await readLatestRun(page, workflowId)
  const ids = (run?.events ?? [])
    .filter((e) => e.type === "step_completed" && typeof e.stepId === "string")
    .map((e) => e.stepId as string)
  return new Set(ids)
}

test.describe("workflow engine — branch routing", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("a truthy condition runs only the true arm", async ({ page }) => {
    const id = await seed(page, "{{ $trigger }}")
    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await page.getByTestId("workflow-run").click()

    await expect
      .poll(async () => (await readLatestRun(page, id))?.status, { timeout: 30_000 })
      .toBe("succeeded")

    const done = await completedSteps(page, id)
    expect(done.has("n_true")).toBe(true)
    expect(done.has("n_false")).toBe(false)
  })

  test("a falsy condition runs only the false arm", async ({ page }) => {
    // A missing field on the trigger resolves to undefined → decision "false".
    const id = await seed(page, "{{ $trigger.__absent }}")
    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await page.getByTestId("workflow-run").click()

    await expect
      .poll(async () => (await readLatestRun(page, id))?.status, { timeout: 30_000 })
      .toBe("succeeded")

    const done = await completedSteps(page, id)
    expect(done.has("n_false")).toBe(true)
    expect(done.has("n_true")).toBe(false)
  })
})
