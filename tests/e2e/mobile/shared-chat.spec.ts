import { expect, test } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { installCollabScenario } from "../helpers/shared-chat"

// Keep the mock collaboration transport owned by Playwright: the production
// service worker otherwise forwards requests outside page.route interception.
test.use({ serviceWorkers: "block" })

test.describe("mobile — shared AI chat", () => {
  test("@critical keeps conversion explicit and blocked while offline", async ({ page, context }) => {
    await injectCapacitor(page, { platform: "android" })
    await installCollabScenario(page)
    await page.goto("/")
    const mockBaseUrl = process.env.E2E_ANTHROPIC_BASE_URL
    if (!mockBaseUrl) throw new Error("Anthropic mock must be started by global setup")
    await bootstrapCogniaMobile(page, "standalone", {
      onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-07T00:00:00.000Z" },
      defaultProvider: "anthropic",
      providerSettings: { anthropic: { enabled: true, apiKey: "test-e2e-key", baseURL: `${mockBaseUrl}/v1` } },
    })
    await page.getByTestId("mobile-quick-action-newChat").click()
    const composer = page.getByTestId("welcome-composer").getByRole("textbox", { name: /message/i })
    await composer.fill("Private mobile history before sharing")
    await composer.press("Enter")
    await expect(page.getByText(/mock-anthropic-echo.*Private mobile history before sharing/i).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Send", exact: true }).first()).toBeVisible()

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
    // Re-open after reconnect: the mobile shell may remount its connection
    // boundary. Close any surviving drawer before opening the same controls.
    await expect(privateControls).toBeVisible()
    await page.keyboard.press("Escape")
    await privateControls.click()
    await expect(page.getByRole("button", { name: "Convert and share full history" })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Open shared conversation controls" })).toHaveCount(0)
  })
})
