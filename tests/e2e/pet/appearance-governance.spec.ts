/** Browser settings cannot mutate native Pet preferences; native persistence lives in tauri/pet. */
import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"

test("browser Pet settings explain their local-desktop boundary", async ({ page }) => {
  await page.goto("/")
  await resetCogniaDb(page)
  // Settings returns through browser history; enter from the completed chat shell.
  await page.goto("/")
  await page.goto("/settings?section=pet", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Settings Pet", exact: true })).toBeVisible()
  await expect(page.getByText("Desktop app only", { exact: true })).toBeVisible()
  await expect(page.getByText(/Pairing a host does not open it/)).toBeVisible()
  await expect(page.getByRole("switch", { name: "Follow pointer" })).toHaveCount(0)
  await page.getByRole("button", { name: "Back to chat", exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
})
