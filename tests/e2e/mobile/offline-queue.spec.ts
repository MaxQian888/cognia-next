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
import { resetCogniaDb, waitForTestGlobals } from "../helpers/db-reset"

test.describe("mobile — offline banner + outbound queue", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      network: { connected: true, connectionType: "wifi" },
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("banner appears offline, hides when back online with no pending rows", async ({ page }) => {
    await page.goto("/")
    await waitForTestGlobals(page)

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
    await page.goto("/")
    await waitForTestGlobals(page)

    // Insert a pending row into mobileOutboundQueue via Dexie.
    await page.evaluate(async () => {
      const { getDb } = await import("@/lib/db/schema")
      await getDb().mobileOutboundQueue.put({
        id: "q_test_pending_1",
        accountId: "acct_e2e",
        targetId: "mobile-companion",
        // Must be a live MOBILE_OUTBOUND_COMMANDS member — "rpc_generic" was
        // trimmed from the command surface in the 2026-05-17 audit.
        command: "app_settings_update",
        payload: {},
        idempotencyKey: "test-idem",
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
        nextAttemptAt: Date.now(),
      })
    })

    // The banner polls every 15s; force a tick by triggering a network
    // listener which is the other update path. Easier: wait for poll.
    await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("offline-banner")).toHaveAttribute("data-offline", "false")

    // Clear the queue and assert the banner hides.
    await page.evaluate(async () => {
      const { getDb } = await import("@/lib/db/schema")
      await getDb().mobileOutboundQueue.clear()
    })
    await expect(page.getByTestId("offline-banner")).toHaveCount(0, { timeout: 20_000 })
  })
})
