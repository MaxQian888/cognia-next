/**
 * E2E: offline banner + outbound queue behavior on mobile.
 *
 * - Inject Capacitor (so OfflineBanner mounts).
 * - Flip the Network plugin to offline → banner appears with offline tone.
 * - Restore online + seed a pending outbound row → banner switches to
 *   "queued" tone (amber, count > 0).
 * - Drain the queue → banner hides.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { injectCapacitor } from "../helpers/inject-capacitor"
import { bootstrapCogniaMobile, waitForTestGlobals } from "../helpers/db-reset"

test.describe("mobile — offline banner + outbound queue", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
    })
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone", {
      onboardingProgress: { version: 2, path: "completed", completedAt: "2026-09-07T00:00:00.000Z" },
    })
    await expect(page.getByTestId("mobile-quick-action-newChat")).toBeVisible()
    await waitForTestGlobals(page)
  })

  test("banner appears offline, hides when back online with no pending rows", async ({ page }) => {
    // Banner hidden when online + no pending.
    await expect(page.getByTestId("offline-banner")).toHaveCount(0)

    // Flip network offline.
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: { setNetwork: (n: { connected: boolean }) => void }
        }
      ).__cogniaCapMock.setNetwork({ connected: false })
    })

    await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("offline-banner")).toHaveAttribute("data-offline", "true")

    // Flip back online.
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: { setNetwork: (n: { connected: boolean }) => void }
        }
      ).__cogniaCapMock.setNetwork({ connected: true })
    })
    await expect(page.getByTestId("offline-banner")).toHaveCount(0, { timeout: 20_000 })
  })

  test("@critical pending outbound work drives the queued state while online", async ({
    page,
  }) => {
    const id = await page.evaluate(async () => {
      if (!window.__cogniaEnqueueOutbound) throw new Error("Outbound fixture bridge unavailable")
      return window.__cogniaEnqueueOutbound({ command: "app_settings_update", payload: {} })
    })

    await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("offline-banner")).toHaveAttribute("data-offline", "false")

    // Withdraw through the product surface so the same scoped repository
    // transaction and live query update the banner as for a real user.
    await page.getByTestId("offline-banner-review").click()
    const queueRow = page.getByTestId(`outbound-queue-row-${id}`)
    await expect(queueRow).toHaveAttribute("data-status", "pending")
    await queueRow.getByRole("button", { name: "Withdraw", exact: true }).click()
    await expect(queueRow).toHaveCount(0)
    await expect(page.getByTestId("offline-banner")).toHaveCount(0, { timeout: 20_000 })
  })
})
