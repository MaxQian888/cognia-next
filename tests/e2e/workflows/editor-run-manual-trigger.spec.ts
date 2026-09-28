/**
 * E2E: clicking Run executes the workflow + a workflowRuns row appears.
 *
 * A manual trigger writes a variable with flow.set. The real orchestrator
 * and run-status bridge execute without a provider or mocked run outcome.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { readLatestRun } from "../helpers/workflow-spec-helpers"

test.describe("workflow editor — manual trigger run", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("@critical Run drives the orchestrator and persists a run row", async ({ page }) => {
    // Seed a minimal workflow that doesn't require network calls: a single
    // flow.set + manual trigger. ai.prompt would require credentials.
    const id = await page.evaluate(async () => {
      if (!window.__cogniaSeedRawWorkflow) throw new Error("Workflow seed bridge unavailable")
      return window.__cogniaSeedRawWorkflow({
        name: "E2E manual run",
        nodes: [
          {
            id: "n_trigger",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 60, y: 80 },
            data: { label: "Manual", params: {} },
          },
          {
            id: "n_set",
            type: "flow.set",
            typeVersion: 1,
            position: { x: 320, y: 80 },
            data: { label: "Set value", params: { variable: "result", value: "ok" } },
          },
        ],
        edges: [{ id: "e1", source: "n_trigger", target: "n_set" }],
      })
    })
    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await expect(page.getByTestId("wf-node-flow.set").first()).toBeVisible()

    await page.getByTestId("workflow-run").click()
    await expect
      .poll(async () => (await readLatestRun(page, id))?.status, { timeout: 15_000 })
      .toBe("succeeded")
    const run = await readLatestRun(page, id)
    expect(run?.events.some((event) => event.stepId === "n_set")).toBe(true)
  })
})
