/**
 * Browser E2E: durable skill management lifecycle.
 *
 * Runtime prompt injection remains a separate configured-model contract. This
 * spec owns the portable product boundary: author a real skill, toggle its
 * availability, survive a full document reload, edit metadata in the shared
 * workspace, and prove the updated row remains durable.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"

import { ensureCogniaAccount } from "../helpers/db-reset"

const SKILL_NAME = "E2E Release Evidence"
const INITIAL_DESCRIPTION = "Collects release verification evidence"
const UPDATED_DESCRIPTION = "Collects durable release verification evidence"

function skillRow(page: import("@playwright/test").Page) {
  return page.getByTestId("skill-list").getByRole("button", { name: new RegExp(SKILL_NAME) })
}

function skillHeading(page: import("@playwright/test").Page) {
  return page.getByRole("heading", { name: SKILL_NAME, level: 2 })
}

test.describe("skills — management lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await ensureCogniaAccount(page)
    await page.goto("about:blank")
    await page.goto("/skills", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible()
  })

  test("@critical creates, disables, restores, enables, and edits a skill", async ({ page }) => {
    await page.getByRole("button", { name: "New", exact: true }).click()

    const createSheet = page.getByRole("dialog", { name: "Create" })
    await createSheet.getByPlaceholder("Cite sources").fill(SKILL_NAME)
    await createSheet.getByPlaceholder("(optional) one-line summary").fill(INITIAL_DESCRIPTION)
    await createSheet
      .getByPlaceholder(
        "Append-only system-prompt augmentation. The user can disable this per session."
      )
      .fill("Gather test, build, and governance evidence before declaring a release ready.")
    await createSheet.getByRole("button", { name: "Create", exact: true }).click()

    await expect(createSheet).toBeHidden()
    await expect(skillRow(page)).toHaveCount(1)
    await skillRow(page).click()
    await expect(skillHeading(page)).toBeVisible()
    await expect(skillHeading(page).locator("..")).toContainText(INITIAL_DESCRIPTION)

    await page.getByRole("button", { name: "Disable", exact: true }).click()
    await expect(page.getByRole("button", { name: "Enable", exact: true })).toBeVisible()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible()
    await skillRow(page).click()
    const enableButton = page.getByRole("button", { name: "Enable", exact: true })
    await expect(enableButton).toBeVisible()
    await enableButton.click()
    await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible()

    await page.getByTestId("skill-open-in-editor").click()
    await page.getByRole("button", { name: "Skill settings", exact: true }).click()

    const settingsSheet = page.getByRole("dialog", { name: "Skill settings" })
    const description = settingsSheet.getByPlaceholder("(optional) one-line summary")
    await expect(description).toHaveValue(INITIAL_DESCRIPTION)
    await description.fill(UPDATED_DESCRIPTION)
    await settingsSheet.getByRole("button", { name: "Save", exact: true }).click()
    await expect(settingsSheet).toBeHidden()

    await page.getByRole("tab", { name: "My Skills", exact: true }).click()
    await skillRow(page).click()
    await expect(skillHeading(page).locator("..")).toContainText(UPDATED_DESCRIPTION)

    await page.reload({ waitUntil: "domcontentloaded" })
    await skillRow(page).click()
    await expect(skillHeading(page).locator("..")).toContainText(UPDATED_DESCRIPTION)
    await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible()
  })
})
