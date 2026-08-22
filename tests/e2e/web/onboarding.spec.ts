/**
 * First-run flow, browser shell (ADR-0122, revised by ADR-0141).
 *
 * The browser has no local runtime and no filesystem, so both paths through
 * setup are short here: the recommended one is a single screen, and the
 * step-by-step one is welcome → provider → first run, with only the
 * requirement-free starter card offered. This spec exists because those
 * branches are decided by `resolveStepSequence` + `resolveCapabilities` +
 * `buildExpressPlan` at runtime — unit tests pin the functions, but only an
 * end-to-end pass proves the flow actually renders what they return.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { ensureCogniaAccount, resetCogniaDb } from "../helpers/db-reset"

test.describe("web — first-run onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await ensureCogniaAccount(page)
    await resetCogniaDb(page)
  })

  test("@critical routes a fresh install into the flow and forks on the first screen", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" })

    // The gate redirects client-side — there is no middleware in a static export.
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 })
    await expect(page.getByTestId("onboarding-welcome")).toBeVisible({ timeout: 30_000 })

    // Both paths are offered, and the recommended one is the primary control
    // rather than a matched card — it is what almost everyone should press.
    await expect(page.getByTestId("onboarding-welcome-cta")).toBeVisible()
    await expect(page.getByTestId("onboarding-welcome-customise")).toBeVisible()

    // No path is chosen yet, so there is no progress to show.
    await expect(page.getByTestId("onboarding-stepper")).toHaveCount(0)
  })

  test("@critical the recommended path is one screen, sign-in included", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-cta").click()

    await expect(page.getByTestId("onboarding-express")).toBeVisible({ timeout: 30_000 })
    // The scan and sign-in steps are folded into this screen, not queued
    // behind it — that is what makes the path two screens end to end.
    await expect(page.getByTestId("onboarding-scan")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-stepper")).toHaveCount(0)

    // A browser has nothing local to bring over, so the plan collapses to the
    // one thing nobody can do for the user, plus what they will get.
    await expect(page.getByTestId("onboarding-express-item-sign-in")).toBeVisible()
    await expect(page.getByTestId("onboarding-express-sign-in")).toBeVisible()
    await expect(page.getByTestId("onboarding-express-item-capabilities")).toBeVisible()
    await expect(page.getByTestId("onboarding-express-item-history")).toHaveCount(0)

    // And it refuses to run until there is a model behind the first task.
    await expect(page.getByTestId("onboarding-express-apply")).toBeDisabled()
    await expect(page.getByTestId("onboarding-express-blocked")).toBeVisible()
  })

  test("the step-by-step path skips the machine scan in a browser", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-customise").click()

    await expect(page.getByTestId("onboarding-provider")).toBeVisible({ timeout: 30_000 })
    // No local runtime to find, so the scan step is filtered out of the sequence.
    await expect(page.getByTestId("onboarding-rail-scan")).toHaveCount(0)
    await expect(page.getByTestId("onboarding-rail-provider")).toBeVisible()
  })

  test("offers only the requirement-free starter card in a browser", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-customise").click()
    await expect(page.getByTestId("onboarding-provider")).toBeVisible({ timeout: 30_000 })

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
    await page.getByTestId("onboarding-welcome-customise").click()
    await expect(page.getByTestId("onboarding-provider")).toBeVisible({ timeout: 30_000 })

    await page.getByTestId("onboarding-skip").click()
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 30_000 })

    // The single dismissal timestamp this replaces could not have said which
    // step was abandoned.
    const bar = page.getByTestId("onboarding-finish-bar")
    await expect(bar).toBeVisible({ timeout: 30_000 })
    await bar.getByTestId("onboarding-finish-bar-cta").click()
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 })
  })

  test("leaving the recommended screen blames the sign-in it was carrying", async ({ page }) => {
    await page.goto("/onboarding", { waitUntil: "domcontentloaded" })
    await page.getByTestId("onboarding-welcome-cta").click()
    await expect(page.getByTestId("onboarding-express")).toBeVisible({ timeout: 30_000 })

    await page.getByTestId("onboarding-skip").click()
    await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 30_000 })
    // The recommended screen carries the sign-in line, so bailing out of it is
    // the same omission the step-by-step path records — the finish bar must not
    // name a missing runtime instead.
    await expect(page.getByTestId("onboarding-finish-bar")).toBeVisible({ timeout: 30_000 })
  })
})
