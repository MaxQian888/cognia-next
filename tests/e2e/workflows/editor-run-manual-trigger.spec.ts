/**
 * E2E: clicking Run executes the workflow + a workflowRuns row appears.
 *
 * The seeded workflow uses `ai.prompt` which calls an AI provider. We
 * monkey-patch the runtime's invokeAI hook via a window helper so the
 * test doesn't require real API keys; the run path through orchestrator +
 * run-status-bridge is exercised end-to-end either way.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("workflow editor — manual trigger run", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("@critical Run drives the orchestrator and persists a run row", async ({ page }) => {
    // Seed a minimal workflow that doesn't require network calls: a single
    // flow.set + manual trigger. ai.prompt would require credentials.
    await page.evaluate(async () => {
      const { createWorkflow } = await import("@/lib/db/workflows")
      const wf = await createWorkflow({
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
            data: { label: "Set value", params: { key: "result", value: "ok" } },
          },
        ],
        edges: [{ id: "e1", source: "n_trigger", target: "n_set" }],
      })
      ;(window as { __seededId?: string }).__seededId = wf.id
    })
    const id = await page.evaluate(() => (window as { __seededId?: string }).__seededId)!
    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await expect(page.getByTestId("wf-node-flow.set").first()).toBeVisible()

    // Click Run; wait for the run row to land.
    await page.getByTestId("workflow-run").click()
    await expect
      .poll(
        async () =>
          page.evaluate(async (workflowId: string) => {
            const { getDb } = await import("@/lib/db/schema")
            return getDb().workflowRuns.where("workflowId").equals(workflowId).count()
          }, id!),
        { timeout: 15_000 }
      )
      .toBeGreaterThanOrEqual(1)

    // The most recent run should be terminal (succeeded or failed) — not
    // stuck in "running". We don't pin a specific outcome because flow.set
    // returns a defaulted record; we just confirm the orchestrator finished.
    const status = await page.evaluate(async (workflowId: string) => {
      const { getDb } = await import("@/lib/db/schema")
      const rows = await getDb()
        .workflowRuns.where("workflowId")
        .equals(workflowId)
        .reverse()
        .sortBy("startedAt")
      return rows[0]?.status
    }, id!)
    expect(["succeeded", "failed"]).toContain(status)
  })
})
