import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "./helpers/db-reset"

test("browser Integrations explains the desktop management boundary", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await resetCogniaDb(page)
  await page.goto("/integrations", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible()
  await expect(page.getByText("Integration management requires the desktop app.")).toBeVisible()
  await expect(
    page.getByText(
      /Accounts, event subscriptions, approvals and the audit trail live in the Cognia desktop app/
    )
  ).toBeVisible()
  for (const name of ["Accounts", "Subscriptions", "Approvals and jobs", "Audit"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0)
  }
})
