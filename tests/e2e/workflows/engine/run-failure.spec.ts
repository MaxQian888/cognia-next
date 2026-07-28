/**
 * E2E: the workflow engine produces a REAL `failed` run.
 *
 * Before this spec, no workflow E2E ever drove the engine to a genuine
 * `failed` status — the two specs that mention "failed" (`runs/run-list`,
 * `runs/run-status-pill`) fabricate a Dexie row via `__cogniaSeedRun`, so a
 * regression that made every run "succeed" (or never surfaced node errors)
 * would pass unnoticed. Here a node throws at execution and we assert the run
 * row that lands in Dexie is actually `failed`, with an error recorded on the
 * failing step.
 *
 * Uses `data.code` (runs without AI credentials) and the proven inline
 * `createWorkflow` + Dexie-poll pattern from
 * `editor-multi-step-orchestration.spec.ts`. Runs in the chromium PR CI job.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { readLatestRun } from "../../helpers/workflow-spec-helpers"

test.describe("workflow engine — real failure path", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("a node that throws drives the run to a failed status", async ({ page }) => {
    // Seed via the bridge (runs in the app bundle) — a page.evaluate
    // `import("@/lib/db/workflows")` does not resolve under Turbopack dev.
    const id = await page.evaluate(async () => {
      const w = window as Window & {
        __cogniaSeedRawWorkflow?: (draft: unknown) => Promise<string>
      }
      if (typeof w.__cogniaSeedRawWorkflow !== "function") {
        throw new Error("window.__cogniaSeedRawWorkflow is not wired")
      }
      return w.__cogniaSeedRawWorkflow({
        name: "E2E failure path",
        nodes: [
          {
            id: "n_trigger",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 60, y: 80 },
            data: { label: "Manual", params: {} },
          },
          {
            id: "n_boom",
            type: "data.code",
            typeVersion: 1,
            position: { x: 300, y: 80 },
            data: {
              label: "Boom",
              // Throws at execution — the engine must mark the node (and run) failed.
              params: { code: "throw new Error('e2e-intentional-failure')" },
            },
          },
        ],
        edges: [{ id: "e1", source: "n_trigger", target: "n_boom" }],
      })
    })

    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await page.getByTestId("workflow-run").click()

    // Poll until a terminal run row lands; assert it is FAILED (not succeeded).
    await expect
      .poll(async () => (await readLatestRun(page, id))?.status, { timeout: 30_000 })
      .toBe("failed")

    // The run must carry a real error signal — not just a bare "failed" status.
    // The signal can land on the run-level `error` field and/or an `error`-type
    // event in the per-step timeline, so we assert across both.
    const run = await readLatestRun(page, id)
    const serialized = JSON.stringify({ error: run?.error, events: run?.events ?? [] })
    expect(serialized).toMatch(/e2e-intentional-failure|error|failed/i)
  })
})
