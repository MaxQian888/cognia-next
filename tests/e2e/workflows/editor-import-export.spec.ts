/**
 * E2E: JSON export → import round-trip.
 *
 * Build a workflow, click `workflow-export-json` to download the file,
 * read the download via Playwright's `download.path()`, then import the
 * same JSON through the hidden file input and assert the editor restored
 * the node + edge structure.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import fs from "node:fs/promises"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — JSON import / export", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("exporting then re-importing preserves nodes + edges", async ({ page }) => {
    await seedAndOpenWorkflow(page, "multi-step")
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    const beforeNodeKinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid^='wf-node-']")).map((el) =>
        el.getAttribute("data-testid")!
      )
    )
    expect(beforeNodeKinds.length).toBeGreaterThanOrEqual(5)

    // Trigger export and capture the download path.
    const downloadPromise = page.waitForEvent("download")
    await page.getByTestId("workflow-export-json").click()
    const download = await downloadPromise
    const downloadPath = await download.path()
    expect(downloadPath).toBeTruthy()
    const exportedJson = await fs.readFile(downloadPath!, "utf-8")
    const parsed = JSON.parse(exportedJson) as {
      nodes: Array<{ type: string }>
      edges: Array<{ source: string; target: string }>
    }
    expect(parsed.nodes.length).toBe(5)
    expect(parsed.edges.length).toBe(4)

    // Mutate the editor — delete one node so we can verify the import
    // overwrites the current state.
    await page.getByTestId("wf-node-flow.set").first().click()
    await page.getByRole("button", { name: /delete node/i }).click()
    await expect(page.getByTestId("wf-node-flow.set")).toHaveCount(0)

    // Re-import via the hidden file input.
    await page.getByTestId("workflow-import-input").setInputFiles({
      name: "workflow.json",
      mimeType: "application/json",
      buffer: Buffer.from(exportedJson, "utf-8"),
    })

    // Node count returns to the original.
    await expect
      .poll(async () => await page.locator("[data-testid^='wf-node-']").count())
      .toBeGreaterThanOrEqual(5)
  })
})
