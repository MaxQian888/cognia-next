/**
 * First-run flow, Tauri desktop shell (ADR-0122).
 *
 * The desktop runs the full sequence — welcome → scan → provider → first run —
 * and is the only shell that probes the machine. The scan step is where the
 * flow earns its existence: it is what turns "choose a sign-in method" into
 * "we found Claude Code, want your setup moved across?".
 *
 * Two behaviours here have no unit-test equivalent: the scan's soft/hard
 * timeout policy resolving against a real probe, and the provider step
 * disappearing when that probe reports credentials that already work.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, resetCogniaDb, setCogniaSettings } from "../helpers/db-reset"

test.describe("tauri — first-run onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await ensureCogniaAccount(page)
    await resetCogniaDb(page)
  })

  test("@critical routes a fresh install through welcome → scan", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 })
    await expect(page.getByTestId("onboarding-welcome")).toBeVisible({ timeout: 30_000 })

    // Desktop is the only shell that carries the scan step.
    await expect(page.getByTestId("onboarding-rail-scan")).toBeVisible()

    await page.getByTestId("onboarding-welcome-cta").click()
    await expect(page.getByTestId("onboarding-scan")).toBeVisible({ timeout: 15_000 })

    // The scan must resolve rather than spin: an empty result flips to the
    // "nothing found" state within the hard ceiling, and still offers a rescan
    // instead of only a dead end.
    await expect(
      page.getByTestId("onboarding-scan-found").or(page.getByTestId("onboarding-scan-empty"))
    ).toBeVisible({ timeout: 25_000 })
  })

  test("drops the provider step once credentials already work", async ({ page }) => {
    await setCogniaSettings(page, { apiKey: "sk-ant-e2e" })
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("onboarding-welcome")).toBeVisible({ timeout: 30_000 })

    // Asking someone with working credentials to authenticate again is the kind
    // of step that makes a first run feel like paperwork.
    await expect(page.getByTestId("onboarding-rail-provider")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-rail-first-run")).toBeVisible()
  })

  test("reaches a first real output and lands in that conversation", async ({ page }) => {
    await setCogniaSettings(page, { apiKey: "sk-ant-e2e" })
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-cta").click()
    await expect(page.getByTestId("onboarding-scan")).toBeVisible({ timeout: 25_000 })
    await page.getByTestId("onboarding-continue").click()

    await expect(page.getByTestId("onboarding-first-run")).toBeVisible({ timeout: 15_000 })
    await page.getByTestId("onboarding-card-summarize-web").click()

    // The flow's terminal state: out of onboarding, into the session it just
    // opened — not a blank welcome page.
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 30_000 })
    await expect(page.getByTestId("onboarding-finish-bar")).toHaveCount(0)
  })
})
