/**
 * First-run flow, Tauri desktop shell (ADR-0122, revised by ADR-0141).
 *
 * The desktop is the only shell that probes the machine, so it is where both
 * paths differ most. The step-by-step one runs the full sequence — welcome →
 * scan → provider → first run — and the recommended one folds the same
 * material into a single confirm-and-run screen.
 *
 * Three behaviours here have no unit-test equivalent: the scan's soft/hard
 * timeout policy resolving against a real probe, the provider step
 * disappearing when that probe reports credentials that already work, and the
 * recommended screen's plan being built from that same live probe.
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

    await page.getByTestId("onboarding-welcome-customise").click()
    await expect(page.getByTestId("onboarding-scan")).toBeVisible({ timeout: 15_000 })
    // Desktop is the only shell that carries the scan step.
    await expect(page.getByTestId("onboarding-rail-scan")).toBeVisible()

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
    await page.getByTestId("onboarding-welcome-customise").click()
    await expect(page.getByTestId("onboarding-scan")).toBeVisible({ timeout: 25_000 })

    // Asking someone with working credentials to authenticate again is the kind
    // of step that makes a first run feel like paperwork.
    await expect(page.getByTestId("onboarding-rail-provider")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-rail-first-run")).toBeVisible()
  })

  test("@critical the recommended path confirms before it writes anything", async ({ page }) => {
    await setCogniaSettings(page, { apiKey: "sk-ant-e2e" })
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("onboarding-welcome")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("onboarding-welcome-cta").click()

    await expect(page.getByTestId("onboarding-express")).toBeVisible({ timeout: 30_000 })
    // The plan is built from the same live probe the scan step renders, and it
    // always ends by naming what the first task will actually be able to do.
    await expect(page.getByTestId("onboarding-express-item-capabilities")).toBeVisible()
    // Credentials already work, so nothing is outstanding and the run is armed.
    await expect(page.getByTestId("onboarding-express-apply")).toBeEnabled()
  })

  test("the recommended path runs the plan and hands over in place", async ({ page }) => {
    await setCogniaSettings(page, { apiKey: "sk-ant-e2e" })
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-cta").click()
    await expect(page.getByTestId("onboarding-express-apply")).toBeEnabled({ timeout: 30_000 })

    await page.getByTestId("onboarding-express-apply").click()

    // The terminal step renders into the same screen rather than replacing it,
    // which is what makes this path two screens end to end.
    await expect(page.getByTestId("onboarding-express-ready")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("onboarding-card-summarize-web")).toBeVisible()
    await expect(page).toHaveURL(/\/onboarding/)
  })

  test("reaches a first real output and lands in that conversation", async ({ page }) => {
    await setCogniaSettings(page, { apiKey: "sk-ant-e2e" })
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-customise").click()
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
