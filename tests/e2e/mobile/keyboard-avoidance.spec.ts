/** E2E: native keyboard visibility drives the mobile shell avoidance state. */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — keyboard avoidance", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "ios" })
    await page.goto("/onboarding")
    await bootstrapCogniaMobile(page, "standalone")
  })

  test("keyboard events hide and restore the bottom navigation", async ({ page }) => {
    const shell = page.getByTestId("mobile-shell-wrapper")
    const tabBar = page.getByTestId("mobile-tab-bar")
    await expect(shell).toBeVisible()
    await expect(tabBar).toBeVisible()
    await expect(shell).toHaveAttribute("data-keyboard-visible", "false")
    await expect(tabBar).toHaveAttribute("data-keyboard-hidden", "false")

    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: { pushKeyboardEvent: (kind: "show" | "hide", height?: number) => void }
        }
      ).__cogniaCapMock.pushKeyboardEvent("show", 300)
    })
    await expect(shell).toHaveAttribute("data-keyboard-visible", "true")
    await expect(tabBar).toHaveAttribute("data-keyboard-hidden", "true")
    await expect(tabBar).toHaveClass(/translate-y-full/)

    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: { pushKeyboardEvent: (kind: "show" | "hide", height?: number) => void }
        }
      ).__cogniaCapMock.pushKeyboardEvent("hide")
    })
    await expect(shell).toHaveAttribute("data-keyboard-visible", "false")
    await expect(tabBar).toHaveAttribute("data-keyboard-hidden", "false")
    await expect(tabBar).not.toHaveClass(/translate-y-full/)
  })
})
