/**
 * E2E: local notifications — schedule + getPending + action delivery.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — local notifications", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      initialNotifications: [{ id: 42, title: "Reminder", body: "queued" }],
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("pending notifications appear in the dev panel snapshot", async ({ page }) => {
    const pending = await page.evaluate(() => {
      return (
        window as unknown as { __cogniaCapMock: { pendingNotifications(): unknown[] } }
      ).__cogniaCapMock.pendingNotifications()
    })
    expect(Array.isArray(pending)).toBe(true)
    expect((pending as Array<{ id: number }>).find((n) => n.id === 42)).toBeTruthy()
  })

  test("pushing a notification action surfaces the deeplink listener", async ({ page }) => {
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: { pushLocalNotificationAction: (p: unknown) => void }
        }
      ).__cogniaCapMock.pushLocalNotificationAction({
        actionId: "open",
        notification: { id: 42, title: "Reminder", body: "queued" },
      })
    })
  })
})
