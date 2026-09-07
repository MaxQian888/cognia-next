import { expect, test } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { installCollabScenario } from "../helpers/shared-chat"

test.describe("mobile — shared AI chat", () => {
  test("@critical keeps conversion explicit and blocked while offline", async ({ page, context }) => {
    await injectCapacitor(page, { platform: "android" })
    await installCollabScenario(page)
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone", { onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-07T00:00:00.000Z" } })
    await page.goto("/")
    await page.getByTestId("mobile-quick-action-newChat").click()
    const picker = page.getByRole("dialog", { name: /pick a character/i })
    await expect(picker).toBeVisible()
    await picker.getByRole("option").first().click()

    const privateControls = page.getByRole("button", {
      name: "Open private conversation controls",
    })
    await expect(privateControls).toBeVisible({ timeout: 20_000 })

    await context.setOffline(true)
    await privateControls.click()
    await expect(page.getByText("Everyone invited later can read the full history")).toBeVisible()
    await expect(
      page.getByText(
        "Reconnect before converting. Messages and Agent runs are never queued silently."
      )
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Convert and share full history" })).toBeDisabled()
    await context.setOffline(false)
    await expect(page.getByRole("button", { name: "Convert and share full history" })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Open shared conversation controls" })).toHaveCount(0)
  })
})
