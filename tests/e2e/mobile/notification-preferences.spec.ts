/**
 * Mobile E2E: notification preference persistence and desktop-sync intent.
 *
 * ADR-0056 keeps OS permission device-local, while portable notification
 * preferences persist on the phone and enqueue `app_settings_update` for a
 * paired desktop. This contract verifies both durable local state and the
 * queued command without coupling to the runner's transient delivery status.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import {
  bootstrapCogniaMobile,
  readDexieRow,
  readDexieRows,
} from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

interface SettingsRow {
  notificationPreferences?: {
    globalDefaultChannels: string[]
    quietHours: { enabled: boolean; start: string; end: string }
    perSource: Record<string, { enabled: boolean } | undefined>
  }
}

interface QueueRow {
  command: string
  payload: {
    patch?: {
      notificationPreferences?: SettingsRow["notificationPreferences"]
    }
  }
}

test.describe("mobile — Notification preferences", () => {
  test("persists portable preferences and queues desktop synchronization", async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/welcome")
    await bootstrapCogniaMobile(page, "standalone")

    await page.goto("/me/notifications", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("mobile-notifications-page")).toBeVisible()

    const osChannel = page.getByTestId("notification-channel-os")
    await expect(osChannel).not.toBeChecked()
    await osChannel.click()
    await expect
      .poll(async () => {
        const row = await readDexieRow<SettingsRow>(page, {
          table: "settings",
          key: "singleton",
        })
        return row?.notificationPreferences?.globalDefaultChannels
      })
      .toContain("os")

    const quietHours = page.getByTestId("notification-quiet-hours")
    await expect(quietHours).not.toBeChecked()
    await quietHours.click()
    await expect(page.getByTestId("notification-quiet-hours-start")).toBeVisible()
    await page.getByTestId("notification-quiet-hours-start").fill("21:30")
    await expect
      .poll(async () => {
        const row = await readDexieRow<SettingsRow>(page, {
          table: "settings",
          key: "singleton",
        })
        return row?.notificationPreferences?.quietHours
      })
      .toMatchObject({ enabled: true, start: "21:30", end: "08:00" })

    const connectorSource = page.getByTestId("notification-source-connector")
    await expect(connectorSource).toBeChecked()
    await connectorSource.click()
    await expect
      .poll(async () => {
        const row = await readDexieRow<SettingsRow>(page, {
          table: "settings",
          key: "singleton",
        })
        return row?.notificationPreferences?.perSource.connector?.enabled
      })
      .toBe(false)

    await expect
      .poll(async () => {
        const queued = await readDexieRows<QueueRow>(page, { table: "mobileOutboundQueue" })
        return queued
          .filter((row) => row.command === "app_settings_update")
          .some(
            (row) =>
              row.payload.patch?.notificationPreferences?.perSource.connector?.enabled === false
          )
      })
      .toBe(true)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("notification-channel-os")).toBeChecked()
    await expect(page.getByTestId("notification-quiet-hours")).toBeChecked()
    await expect(page.getByTestId("notification-quiet-hours-start")).toHaveValue("21:30")
    await expect(page.getByTestId("notification-source-connector")).not.toBeChecked()
  })
})
