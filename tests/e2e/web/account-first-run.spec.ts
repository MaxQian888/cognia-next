import { expect, test } from "@/tests/e2e/fixtures/test"

test.describe("web — first-run Vault", () => {
  test("creates a browser account and requires recovery-key acknowledgement", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" })

    const form = page.getByRole("form", { name: "Create local account" })
    await expect(form).toBeVisible({ timeout: 30_000 })
    await form.getByLabel("Account name").fill("Browser E2E")
    await form.getByLabel("Password").fill("correct horse battery")
    await form.getByRole("button", { name: "Create account" }).click()

    const recovery = page.getByTestId("account-vault-recovery")
    await expect(recovery).toBeVisible({ timeout: 30_000 })
    await expect(recovery.locator("code")).toHaveText(/^[A-Za-z0-9_-]{40,}$/)
    const continueButton = recovery.getByTestId("account-vault-recovery-continue")
    await expect(continueButton).toBeDisabled()

    await recovery.getByRole("checkbox").check()
    await continueButton.click()

    await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible({
      timeout: 30_000,
    })
  })
})
