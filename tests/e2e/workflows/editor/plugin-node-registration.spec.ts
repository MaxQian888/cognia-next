/**
 * E2E: a plugin-contributed node kind shows up in the sidebar after the
 * plugin registers a workflow node descriptor.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"

test.describe("workflow editor — plugin node registration", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("sidebar lists at least one plugin-prefixed node when an enabled plugin contributes one", async ({
    page,
  }) => {
    await seedAndOpenWorkflow(page, "manual-ai")
    await expect(page.getByTestId("workflow-node-sidebar")).toBeVisible()

    // We don't assert a specific plugin id — the dev seed wires the
    // computer-use, clipboard-history, screenshot, and web-tools plugins
    // which each declare at least one node. We accept any
    // sidebar entry whose kind starts with one of those prefixes.
    const pluginEntry = page
      .locator(
        "[data-testid^=wf-sidebar-computer-use\\.], [data-testid^=wf-sidebar-clipboard-history\\.], [data-testid^=wf-sidebar-screenshot\\.], [data-testid^=wf-sidebar-web-tools\\.]"
      )
      .first()
    await expect(pluginEntry).toBeVisible({ timeout: 15_000 })
  })
})
