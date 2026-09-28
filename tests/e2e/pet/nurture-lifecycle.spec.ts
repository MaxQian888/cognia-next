/** Browser Pet entry preserves the desktop-only boundary; native lifecycle lives in tauri/pet. */
import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"

test("the browser explains the desktop Pet boundary and returns to chat", async ({ page }) => {
  await page.goto("/")
  await resetCogniaDb(page)
  await page.goto("/pet", { waitUntil: "domcontentloaded" })
  await expect(
    page.getByText(
      "The pet is only available in the Cognia desktop app. Open the desktop app to look after it."
    )
  ).toBeVisible()
  await expect(page.getByTestId("pet-hatch")).toHaveCount(0)
  await expect(page.getByTestId("pet-action-grid")).toHaveCount(0)
  await page.getByRole("link", { name: "Back to chat", exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
})
