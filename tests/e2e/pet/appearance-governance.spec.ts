/**
 * Browser E2E: the governed appearance boundary remains user-controlled and
 * durable without requiring native cursor access.
 *
 * Contract: Pet settings → disable local gaze → persisted unchecked state
 * after reload. Native cursor IPC stays in the Windows-only Tauri project.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { ensureCogniaAccount } from "../helpers/db-reset"

test.describe("pet — governed appearance", () => {
  test("persists the local-only gaze preference", async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("/settings?section=pet", { waitUntil: "domcontentloaded" })

    const gaze = page.getByRole("switch", { name: "Follow pointer" })
    await expect(gaze).toBeVisible()
    await expect(gaze).toBeChecked()
    await gaze.click()
    await expect(gaze).not.toBeChecked()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("switch", { name: "Follow pointer" })).not.toBeChecked()
  })
})
