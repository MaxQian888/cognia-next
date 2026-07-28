/**
 * E2E: `flow.split` fans out to every branch and `flow.join` waits for all.
 *
 * The existing `nodes/flow/split.spec.ts` + `join.spec.ts` only assert the
 * seeded node renders and that *a* run succeeds. Neither proves the fan-out
 * actually ran BOTH arms, nor that the join waited for them. A regression that
 * ran one arm (or let the join proceed early) would pass them.
 *
 * Here we seed trigger → split → {n_a, n_b} → join and read the real per-step
 * timeline from Dexie. We assert both arms AND the join all emit
 * `step_completed`, and that the join completes after both arms (ordering proves
 * it actually joined rather than racing ahead). Runs in the chromium PR CI job.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { readLatestRun } from "../../helpers/workflow-spec-helpers"

function splitJoinGraph() {
  return {
    name: "E2E split/join fan-out",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 60, y: 120 },
        data: { label: "Manual", params: {} },
      },
      {
        id: "n_split",
        type: "flow.split",
        typeVersion: 1,
        position: { x: 300, y: 120 },
        data: { label: "Split", params: { branchLabels: ["alpha", "beta"] } },
      },
      {
        id: "n_a",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 560, y: 40 },
        data: { label: "A", params: { variable: "a", value: "1" } },
      },
      {
        id: "n_b",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 560, y: 220 },
        data: { label: "B", params: { variable: "b", value: "2" } },
      },
      {
        id: "n_join",
        type: "flow.join",
        typeVersion: 1,
        position: { x: 820, y: 120 },
        data: { label: "Join", params: { joinPolicy: "all" } },
      },
    ],
    edges: [
      { id: "e0", source: "n_trigger", target: "n_split" },
      { id: "e_a", source: "n_split", sourceHandle: "alpha", target: "n_a" },
      { id: "e_b", source: "n_split", sourceHandle: "beta", target: "n_b" },
      { id: "e_aj", source: "n_a", target: "n_join" },
      { id: "e_bj", source: "n_b", target: "n_join" },
    ],
  }
}

async function seed(page: Page): Promise<string> {
  return page.evaluate(async (graph) => {
    const w = window as Window & {
      __cogniaSeedRawWorkflow?: (draft: unknown) => Promise<string>
    }
    if (typeof w.__cogniaSeedRawWorkflow !== "function") {
      throw new Error("window.__cogniaSeedRawWorkflow is not wired")
    }
    return w.__cogniaSeedRawWorkflow(graph)
  }, splitJoinGraph())
}

test.describe("workflow engine — split / join", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("split fans out to both arms and join waits for all", async ({ page }) => {
    const id = await seed(page)
    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await page.getByTestId("workflow-run").click()

    await expect
      .poll(async () => (await readLatestRun(page, id))?.status, { timeout: 30_000 })
      .toBe("succeeded")

    const run = await readLatestRun(page, id)
    const completions = (run?.events ?? []).filter((e) => e.type === "step_completed")
    const completedIds = new Set(completions.map((e) => e.stepId))

    // Both fan-out arms ran, and the join ran.
    expect(completedIds.has("n_a")).toBe(true)
    expect(completedIds.has("n_b")).toBe(true)
    expect(completedIds.has("n_join")).toBe(true)

    // The join completed AFTER both arms — proves it joined rather than racing.
    const tsOf = (stepId: string) => completions.find((e) => e.stepId === stepId)?.ts as number
    expect(tsOf("n_join")).toBeGreaterThanOrEqual(tsOf("n_a"))
    expect(tsOf("n_join")).toBeGreaterThanOrEqual(tsOf("n_b"))
  })
})
