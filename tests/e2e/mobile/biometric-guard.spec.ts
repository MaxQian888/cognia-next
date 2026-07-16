/**
 * E2E: biometric guard on backup export (/me/backup).
 *
 * Two things earlier versions of this spec got wrong, which made both tests
 * no-ops: the export button lives on /me/backup (not /me, so the
 * `if (count)` guard always skipped), and the gate only runs when
 * `settings.biometricRequiredFor.exportBackup` is true (default false).
 * Also, "biometric unavailable" does NOT block — the export gate sets
 * `fallthroughWhenUnavailable: true` — so the block case must be
 * "enrolled but verification failed" (mock's setBiometricVerify(false)).
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const PASSPHRASE = "e2e-backup-pass"

test.describe("mobile — biometric guard", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    await setCogniaSettings(page, {
      mobileRuntimeMode: "standalone",
      biometricRequiredFor: { exportBackup: true },
    })
  })

  test("export is blocked when biometric verification fails", async ({ page }) => {
    await page.goto("/me/backup")

    const passphrase = page.getByTestId("backup-passphrase")
    await expect(passphrase).toBeVisible({ timeout: 15_000 })
    // Flip the verify result on THIS document — addInitScript re-injects a
    // fresh mock state on every navigation, so setting it pre-goto is lost.
    await page.evaluate(() => {
      ;(
        window as unknown as { __cogniaCapMock: { setBiometricVerify: (ok: boolean) => void } }
      ).__cogniaCapMock.setBiometricVerify(false)
    })
    // Re-apply the policy through the live store on THIS document — the
    // beforeEach write persisted to Dexie, but the freshly-navigated page's
    // in-memory settings store may not have hydrated it yet when we click.
    await setCogniaSettings(page, { biometricRequiredFor: { exportBackup: true } })
    await passphrase.fill(PASSPHRASE)
    await page.getByTestId("backup-export").click()

    // The guard rejects → the blocked toast, and NO file may be written.
    await expect(page.getByText(/biometric check failed/i)).toBeVisible({ timeout: 10_000 })
    const files = await page.evaluate(() =>
      Object.keys(
        (
          window as unknown as { __cogniaCapMock: { filesystemSnapshot(): Record<string, string> } }
        ).__cogniaCapMock.filesystemSnapshot()
      )
    )
    expect(files.filter((f) => f.includes("backups"))).toHaveLength(0)
  })

  test("export proceeds when biometric verification succeeds", async ({ page }) => {
    await page.goto("/me/backup")

    const passphrase = page.getByTestId("backup-passphrase")
    await expect(passphrase).toBeVisible({ timeout: 15_000 })
    await passphrase.fill(PASSPHRASE)
    await page.getByTestId("backup-export").click()

    // Real outcome: the encrypted backup lands in the mock filesystem under
    // Documents/cognia/backups (the mobile saveExport path).
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            Object.keys(
              (
                window as unknown as {
                  __cogniaCapMock: { filesystemSnapshot(): Record<string, string> }
                }
              ).__cogniaCapMock.filesystemSnapshot()
            ).filter((f) => f.includes("backups")).length
          ),
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0)
  })
})
