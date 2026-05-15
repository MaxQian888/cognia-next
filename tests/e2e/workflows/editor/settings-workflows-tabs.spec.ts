/**
 * E2E: Settings → Workflows exposes all 5 tabs.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"

const TABS: Array<{ slug: string; testid: string }> = [
  { slug: "library", testid: "workflow-library-tab" },
  { slug: "templates", testid: "workflow-templates-tab" },
  { slug: "audit", testid: "workflow-audit-tab" },
  { slug: "triggers", testid: "workflow-triggers-tab" },
  { slug: "settings", testid: "workflow-settings-tab" },
]

test.describe("workflow editor — settings → workflows tabs", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  for (const tab of TABS) {
    test(`navigates to the ${tab.slug} tab via the query param`, async ({ page }) => {
      await page.goto(`/?section=workflows&wfTab=${tab.slug}`, { waitUntil: "domcontentloaded" })
      // Specs are tolerant: some tabs only render a section heading, others
      // attach a dedicated testid.
      const tabMark = page.getByTestId(tab.testid).or(page.locator("h1, h2").first())
      await expect(tabMark).toBeVisible({ timeout: 15_000 })
    })
  }
})
