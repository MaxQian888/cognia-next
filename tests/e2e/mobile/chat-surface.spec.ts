/**
 * E2E: mobile chat surface — composer + scroll + send.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — chat surface", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    // The reset also clears `mobileRuntimeMode` and `onboardingProgress`, and
    // the ADR-0122 gate routes a session-less account into the first-run flow —
    // the chat home only renders once both say "already set up".
    await setCogniaSettings(page, {
      mobileRuntimeMode: "standalone",
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    })
  })

  test("composer is reachable + send button enables once text is present", async ({ page }) => {
    await page.goto("/")
    // The chat tab lands on the welcome home, whose live composer is the
    // conversation's entry point (its first send creates the session).
    const composer = page.getByTestId("welcome-composer").getByRole("textbox", { name: /message/i })
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill("Hello from mobile")
    const sendBtn = page.getByRole("button", { name: /send|发送/i }).first()
    await expect(sendBtn).toBeEnabled()
  })
})
