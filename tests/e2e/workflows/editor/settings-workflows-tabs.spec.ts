/**
 * E2E: Settings → Workflows tab shell — `?wfTab=` drives the active tab.
 *
 * The section's real tabs are `library` / `runs` / `templates` / `defaults`
 * / `audit` (components/settings/workflows/workflows-section.tsx). An earlier
 * version of this spec listed two tabs that never existed ("triggers",
 * "settings") and asserted `.or(page.locator("h1, h2"))` — a fallback every
 * page satisfies, so all five tests passed even against phantom tabs. The
 * assertions below bind to the tablist itself: the trigger matching the URL
 * param must be the selected one.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"

const TABS: Array<{ slug: string; name: string }> = [
  { slug: "library", name: "Library" },
  { slug: "runs", name: "Runs" },
  { slug: "templates", name: "Templates" },
  { slug: "defaults", name: "Defaults" },
  { slug: "audit", name: "Audit" },
]

test.describe("workflow editor — settings → workflows tabs", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  for (const tab of TABS) {
    test(`?wfTab=${tab.slug} selects the ${tab.slug} tab`, async ({ page }) => {
      await page.goto(`/settings?section=workflows&wfTab=${tab.slug}`, {
        waitUntil: "domcontentloaded",
      })
      const trigger = page.getByRole("tab", { name: tab.name })
      await expect(trigger).toBeVisible({ timeout: 15_000 })
      // The URL param must actually win — a silent fallback to the default
      // tab keeps every trigger visible, so visibility alone can't fail.
      await expect(trigger).toHaveAttribute("aria-selected", "true")
      for (const other of TABS.filter((t) => t.slug !== tab.slug)) {
        await expect(page.getByRole("tab", { name: other.name })).toHaveAttribute(
          "aria-selected",
          "false"
        )
      }
    })
  }

  test("an unknown wfTab value falls back to the library tab", async ({ page }) => {
    await page.goto("/settings?section=workflows&wfTab=does-not-exist", {
      waitUntil: "domcontentloaded",
    })
    await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 15_000 }
    )
  })
})
