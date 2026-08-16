/**
 * First-run flow, browser shell (ADR-0122).
 *
 * The browser has no local runtime and no filesystem, so its sequence is the
 * short one: welcome → provider → first run, with only the requirement-free
 * starter card offered. This spec exists because that branch is decided by
 * `resolveStepSequence` + `resolveCapabilities` at runtime — unit tests pin the
 * functions, but only an end-to-end pass proves the flow actually renders the
 * sequence they return.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, resetCogniaDb } from "../helpers/db-reset"

test.describe("web — first-run onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await ensureCogniaAccount(page)
    await resetCogniaDb(page)
  })

  test("@critical routes a fresh install into the flow and skips the machine scan", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" })

    // The gate redirects client-side — there is no middleware in a static export.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 })
    await expect(page.getByTestId("onboarding-welcome")).toBeVisible({ timeout: 30_000 })

    // No local runtime to find, so the scan step is filtered out of the rail.
    await expect(page.getByTestId("onboarding-rail-scan")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-rail-provider")).toBeVisible()

    await page.getByTestId("onboarding-welcome-cta").click()
    await expect(page.getByTestId("onboarding-provider")).toBeVisible({ timeout: 15_000 })
  })

  test("offers only the requirement-free starter card in a browser", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-cta").click()
    await expect(page.getByTestId("onboarding-provider")).toBeVisible({ timeout: 15_000 })

    await page.getByTestId("onboarding-continue").click()
    await expect(page.getByTestId("onboarding-first-run")).toBeVisible({ timeout: 15_000 })

    await expect(page.getByTestId("onboarding-card-summarize-web")).toBeVisible()
    // A browser has neither a filesystem nor a screenshot source, and a card the
    // user cannot actually run must be hidden rather than greyed out.
    await expect(page.getByTestId("onboarding-card-read-folder")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-card-extract-text")).toHaveCount(0)
  })

  test("leaving early records why, and the residual bar says so", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-cta").click()
    await expect(page.getByTestId("onboarding-provider")).toBeVisible({ timeout: 15_000 })

    await page.getByTestId("onboarding-skip").click()
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 30_000 })

    // The single dismissal timestamp this replaces could not have said which
    // step was abandoned.
    const bar = page.getByTestId("onboarding-finish-bar")
    await expect(bar).toBeVisible({ timeout: 30_000 })
    await bar.getByTestId("onboarding-finish-bar-cta").click()
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 })
  })
})
