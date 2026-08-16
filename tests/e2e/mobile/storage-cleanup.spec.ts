/**
 * Mobile E2E: targeted storage cleanup.
 *
 * The storage page must report real account-scoped Dexie content and delete
 * only the category the user confirms. This contract uses a durable skill row
 * and verifies the runtime-mode settings singleton survives the cleanup.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import {
  bootstrapCogniaMobile,
  readDexieRow,
  waitForTestGlobals,
} from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — Storage cleanup", () => {
  test("clears the selected skill category without deleting settings", async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "standalone")
    await waitForTestGlobals(page, 30_000)

    const skillId = await page.evaluate(async () => {
      const seed = (
        window as unknown as {
          __cogniaSeedSkill?: (draft: { name: string; body?: string }) => Promise<string>
        }
      ).__cogniaSeedSkill
      if (!seed) throw new Error("__cogniaSeedSkill is unavailable")
      return seed({
        name: "E2E removable storage skill",
        body: "Temporary content used to verify category-scoped cleanup.",
      })
    })

    await page.goto("/me/storage", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-storage-page")).toBeVisible()
    await expect(page.getByTestId("storage-category-skill")).toBeVisible()

    await page.getByTestId("storage-clear-skill").click()
    await expect(page.getByRole("alertdialog")).toBeVisible()
    await page.getByTestId("storage-clear-confirm").click()

    await expect
      .poll(() => readDexieRow(page, { table: "skills", key: skillId }))
      .toBeUndefined()
    await expect(page.getByTestId("storage-category-skill")).toHaveCount(0)

    await expect
      .poll(() => readDexieRow(page, { table: "settings", key: "singleton" }))
      .toMatchObject({ mobileRuntimeMode: "standalone" })
  })
})
