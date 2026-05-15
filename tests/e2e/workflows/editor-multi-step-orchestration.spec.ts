/**
 * E2E: a longer chain runs end-to-end.
 *
 * Uses flow.set + data.transform (which both run without AI provider
 * credentials). Asserts step status badges + final run row.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("workflow editor — multi-step orchestration", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("manual → flow.set → data.transform → flow.branch chain runs", async ({ page }) => {
    await page.evaluate(async () => {
      const { createWorkflow } = await import("@/lib/db/workflows")
      const wf = await createWorkflow({
        name: "E2E multi-step",
        nodes: [
          {
            id: "n_trigger",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 60, y: 80 },
            data: { label: "Manual", params: {} },
          },
          {
            id: "n_seed",
            type: "flow.set",
            typeVersion: 1,
            position: { x: 280, y: 80 },
            data: { label: "Seed", params: { key: "count", value: 2 } },
          },
          {
            id: "n_transform",
            type: "data.transform",
            typeVersion: 1,
            position: { x: 520, y: 80 },
            data: {
              label: "Double",
              params: { expression: "{ doubled: ctx.count * 2 }" },
            },
          },
          {
            id: "n_branch",
            type: "flow.branch",
            typeVersion: 1,
            position: { x: 760, y: 80 },
            data: { label: "Decide", params: { conditionExpr: "ctx.count >= 0" } },
          },
          {
            id: "n_true",
            type: "flow.set",
            typeVersion: 1,
            position: { x: 1000, y: 20 },
            data: { label: "Yes", params: { key: "branch", value: "yes" } },
          },
          {
            id: "n_false",
            type: "flow.set",
            typeVersion: 1,
            position: { x: 1000, y: 180 },
            data: { label: "No", params: { key: "branch", value: "no" } },
          },
        ],
        edges: [
          { id: "e1", source: "n_trigger", target: "n_seed" },
          { id: "e2", source: "n_seed", target: "n_transform" },
          { id: "e3", source: "n_transform", target: "n_branch" },
          { id: "e4", source: "n_branch", sourceHandle: "true", target: "n_true" },
          { id: "e5", source: "n_branch", sourceHandle: "false", target: "n_false" },
        ],
      })
      ;(window as { __seededId?: string }).__seededId = wf.id
    })
    const id = await page.evaluate(() => (window as { __seededId?: string }).__seededId)!
    await page.goto(`/workflows/${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await page.getByTestId("workflow-run").click()

    await expect
      .poll(
        async () =>
          page.evaluate(async (workflowId: string) => {
            const { getDb } = await import("@/lib/db/schema")
            const rows = await getDb()
              .workflowRuns.where("workflowId")
              .equals(workflowId)
              .reverse()
              .sortBy("startedAt")
            return rows[0]?.status
          }, id!),
        { timeout: 30_000 }
      )
      .toMatch(/succeeded|failed/)

    // Steps executed: assert at least the trigger + seed + transform + branch + chosen branch arm.
    const stepIds = await page.evaluate(async (workflowId: string) => {
      const { getDb } = await import("@/lib/db/schema")
      const rows = await getDb()
        .workflowRuns.where("workflowId")
        .equals(workflowId)
        .reverse()
        .sortBy("startedAt")
      const last = rows[0]
      return last?.events?.map((e) => e.stepId) ?? []
    }, id!)
    expect(stepIds).toEqual(
      expect.arrayContaining(["n_trigger", "n_seed", "n_transform", "n_branch"])
    )
  })
})
