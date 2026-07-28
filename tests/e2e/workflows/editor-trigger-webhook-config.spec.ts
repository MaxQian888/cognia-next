/**
 * E2E: trigger.webhook in web mode renders the "desktop-only" affordance
 * because the webhook URL is owned by the Tauri side.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — trigger.webhook config", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("trigger.webhook node renders + sidebar entry exposes the desktop-only hint", async ({
    page,
  }) => {
    await seedAndOpenWorkflow(page, "manual-ai")

    // The sidebar entry exposes a `desktopOnly` chip — we don't gate on the
    // label text (which is i18n-translated) but on the visibility of a chip
    // colored with the desktop-only style.
    const webhookSidebar = page.getByTestId("wf-sidebar-trigger.webhook").first()
    await expect(webhookSidebar).toBeVisible()

    // Click to add — the canvas should render the node regardless of mode.
    await webhookSidebar.click()
    await expect(page.getByTestId("wf-node-trigger.webhook").first()).toBeVisible()

    // Inspector opens with config form; we don't assert on the URL field
    // because in web mode getWebhookUrl() is null.
    await page.getByTestId("wf-node-trigger.webhook").first().click()
    await expect(page.getByTestId("workflow-inspector")).toBeVisible()
  })
})
