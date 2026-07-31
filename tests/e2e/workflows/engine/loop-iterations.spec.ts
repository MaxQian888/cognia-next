/**
 * E2E: `flow.loop` actually runs its body once per iteration.
 *
 * The existing `nodes/flow/loop.spec.ts` only checks the seeded node renders and
 * that *a* run lands `succeeded`. It never proves the body ran the right number
 * of times — a regression that ran the body once (or zero times) would pass it.
 *
 * Here we seed a `times: 3` container loop (`flow.loop` typeVersion 2 with a
 * `flow.set` child whose `parentId` points at the loop) and read the real
 * per-step timeline from Dexie. The loop stamps `iterationIndex` into each
 * child event payload (`lib/workflow/runtime/loop-container.ts:179`), so we
 * assert the body produced exactly 3 distinct iterations. Runs in chromium PR CI.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { readLatestRun } from "../../helpers/workflow-spec-helpers"

const TIMES = 3

function loopGraph() {
  return {
    name: "E2E loop iterations",
    nodes: [
      {
        id: "n_trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 60, y: 120 },
        data: { label: "Manual", params: {} },
      },
      {
        id: "n_loop",
        type: "flow.loop",
        typeVersion: 2,
        position: { x: 300, y: 120 },
        data: { label: "Loop", params: { mode: "times", times: TIMES } },
      },
      {
        // Container child — found by `parentId`, not by edge.
        id: "n_body",
        type: "flow.set",
        typeVersion: 1,
        parentId: "n_loop",
        position: { x: 40, y: 40 },
        data: { label: "Body", params: { variable: "i", value: "{{ $loop.index }}" } },
      },
    ],
    edges: [{ id: "e0", source: "n_trigger", target: "n_loop" }],
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
  }, loopGraph())
}

test.describe("workflow engine — loop iterations", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("a times:3 loop runs the body exactly 3 times", async ({ page }) => {
    const id = await seed(page)
    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await page.getByTestId("workflow-run").click()

    await expect
      .poll(async () => (await readLatestRun(page, id))?.status, { timeout: 30_000 })
      .toBe("succeeded")

    const run = await readLatestRun(page, id)
    const bodyCompletions = (run?.events ?? []).filter(
      (e) => e.type === "step_completed" && e.stepId === "n_body"
    )
    // Exactly one completion per iteration.
    expect(bodyCompletions).toHaveLength(TIMES)

    // And the iterations are distinct (0, 1, 2) — not the same index logged 3×.
    const indices = new Set(
      bodyCompletions
        .map((e) => (e.payload as { iterationIndex?: number } | undefined)?.iterationIndex)
        .filter((i): i is number => typeof i === "number")
    )
    expect(indices.size).toBe(TIMES)
  })
})
