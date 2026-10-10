/**
 * E2E: Files on a standalone phone (ADR-0223 §9) — the phone layout over the
 * device's own library: 2-line rows with 44px targets, selection mode with a
 * bottom bulk bar, and places in a sheet. No seeding: files arrive through the
 * page's own upload, so every write is one a person's taps make.
 */

import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

const NOTES = { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n") }
const BUDGET = { name: "budget.csv", mimeType: "text/csv", buffer: Buffer.from("item,cost\n") }

function list(page: Page) {
  return page.getByTestId("files-mobile-list")
}

function row(page: Page, title: string) {
  return list(page).getByRole("button", { name: `Open ${title}`, exact: true })
}

function selectable(page: Page, title: string) {
  return list(page).getByRole("button", { name: `Select ${title}`, exact: true })
}

async function openPlace(page: Page, testId: string) {
  await page.getByTestId("files-mobile-places").click()
  const sheet = page.getByTestId("files-mobile-places-sheet")
  await expect(sheet).toBeVisible()
  await sheet.getByTestId(testId).click()
  await expect(sheet).toBeHidden()
}

test.describe("mobile — files", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone", {
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-10-10T00:00:00.000Z",
      },
    })
  })

  test("manages the phone's own library: upload, select, favorite, trash and restore", async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await page.goto("/files")
    await expect(page.getByTestId("files-mobile")).toBeVisible({ timeout: 20_000 })

    await page.getByTestId("files-upload-input").setInputFiles([NOTES, BUDGET])
    await expect(page.getByText("Uploaded 2 files.", { exact: true })).toBeVisible()
    await expect(row(page, "notes.md")).toBeVisible()
    await expect(row(page, "budget.csv")).toBeVisible()
    // Rows are touch targets.
    const box = await row(page, "notes.md").boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)

    // Selection mode: tap rows to pick them, act from the bottom bar.
    await page.getByTestId("files-mobile-select").click()
    const bar = page.getByTestId("files-mobile-bulk-bar")
    await expect(bar).toBeVisible()
    await selectable(page, "notes.md").click()
    await selectable(page, "budget.csv").click()
    await expect(page.getByTestId("files-mobile-bulk-count")).toHaveText("2 selected")
    await bar.getByTestId("files-mobile-bulk-favorite").click()
    await expect(page.getByText("Added 2 items to favorites.", { exact: true })).toBeVisible()
    await page.getByTestId("files-mobile-select-done").click()
    await expect(bar).toBeHidden()
    await page.getByTestId("files-lens-favorites").click()
    await expect(row(page, "notes.md")).toBeVisible()
    await expect(row(page, "budget.csv")).toBeVisible()
    await page.getByTestId("files-lens-suggested").click()

    // Places live in a sheet. The phone has no workspace to list, and says so.
    await page.getByTestId("files-mobile-places").click()
    const sheet = page.getByTestId("files-mobile-places-sheet")
    const workspace = sheet.getByTestId("files-place-group-workspace")
    await expect(workspace).toHaveAttribute("aria-disabled", "true")
    await expect(workspace).toHaveAttribute("data-held-back", "no-fs-backend")
    await sheet.getByTestId("files-place-group-uploads").click()
    await expect(sheet).toBeHidden()
    await expect(page.getByTestId("files-mobile-places")).toContainText("Uploads")
    await expect(row(page, "notes.md")).toBeVisible()

    // Trash one from the bulk bar; it leaves the list for the Trash.
    await page.getByTestId("files-mobile-select").click()
    await selectable(page, "budget.csv").click()
    await bar.getByTestId("files-mobile-bulk-trash").click()
    await expect(page.getByText("Moved “budget.csv” to the Trash.", { exact: true })).toBeVisible()
    await expect(row(page, "budget.csv")).toHaveCount(0)
    await openPlace(page, "files-place-trash")
    await expect(row(page, "budget.csv")).toBeVisible()

    // Restore it from the Trash.
    await page.getByTestId("files-mobile-select").click()
    await selectable(page, "budget.csv").click()
    await bar.getByTestId("files-mobile-bulk-restore").click()
    await expect(page.getByText("Restored 1 item.", { exact: true })).toBeVisible()
    await expect(row(page, "budget.csv")).toHaveCount(0)
    await openPlace(page, "files-place-all")
    await expect(row(page, "budget.csv")).toBeVisible()
    await expect(row(page, "notes.md")).toBeVisible()
  })
})
