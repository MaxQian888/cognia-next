/**
 * First-run flow, Capacitor mobile shell (ADR-0122).
 *
 * Mobile is the shell where the flow changed shape most: the standalone/paired
 * mode chooser that used to be its own route (`/welcome`) is now the flow's
 * welcome step, and that choice is what decides the rest of the sequence — a
 * paired phone gets pairing where the desktop gets a machine scan, and never
 * gets a provider step at all, because it borrows the desktop's credentials.
 *
 * None of that is reachable by unit tests: the fork writes a device-local
 * setting, and the sequence is recomputed from it.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — first-run onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await ensureCogniaAccount(page)
    await resetCogniaDb(page)
  })

  test("@critical carries the mode fork absorbed from the old /welcome route", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("onboarding-welcome")).toBeVisible({ timeout: 30_000 })

    // The plain CTA is replaced by the fork — this choice decides the sequence.
    await expect(page.getByTestId("onboarding-welcome-cta")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-mode-standalone")).toBeVisible()
    await expect(page.getByTestId("onboarding-mode-paired")).toBeVisible()
  })

  test("a paired phone gets pairing instead of a scan, and no provider step", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-mode-paired").click()

    // There is no local runtime to find — the compute lives on the desktop.
    await expect(page.getByTestId("onboarding-scan-paired")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("onboarding-rail-provider")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-open-pairing")).toBeVisible()
  })

  test("a standalone phone reaches the provider step and the universal card", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-mode-standalone").click()

    await expect(page.getByTestId("onboarding-provider")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("onboarding-continue").click()

    await expect(page.getByTestId("onboarding-first-run")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("onboarding-card-summarize-web")).toBeVisible()
    // No filesystem on a phone.
    await expect(page.getByTestId("onboarding-card-read-folder")).toHaveCount(0)
  })
})
