/**
 * E2E: push notifications — register + token callback + delivery.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — push notifications", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android", pushToken: "test-fcm-token" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("simulated push delivery dispatches to the listener", async ({ page }) => {
    const received = await page.evaluate(async () => {
      let value: unknown = null
      const cap = (
        window as unknown as {
          Capacitor: {
            Plugins: {
              PushNotifications: {
                addListener: (e: string, cb: (v: unknown) => void) => Promise<unknown>
              }
            }
          }
        }
      ).Capacitor
      await cap.Plugins.PushNotifications.addListener("pushNotificationReceived", (v) => {
        value = v
      })
      ;(
        window as unknown as { __cogniaCapMock: { pushPushNotification: (n: unknown) => void } }
      ).__cogniaCapMock.pushPushNotification({
        id: "msg-1",
        title: "Hi",
        body: "Push body",
      })
      return value
    })
    expect(received).toBeTruthy()
  })
})
