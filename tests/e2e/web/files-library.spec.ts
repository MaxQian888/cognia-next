import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import { ensureAppMounted, setCogniaSettings, waitForTestGlobals } from "../helpers/db-reset"

/**
 * The Files page as a managed space (ADR-0223), on the plain web shell: files
 * uploaded straight into Files, managed end to end through the page itself —
 * no seeding, so every write goes through the same writers a person's clicks do.
 */

const NOTES = { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n") }
const BUDGET = { name: "budget.csv", mimeType: "text/csv", buffer: Buffer.from("item,cost\n") }

async function openFiles(page: Page) {
  await page.goto("/")
  await ensureAppMounted(page)
  await setCogniaSettings(page, {
    onboardingProgress: { version: 2, path: "completed", completedAt: "2026-10-10T00:00:00.000Z" },
  })
  await page.goto("/files")
  await waitForTestGlobals(page, 30_000)
  await expect(page.getByTestId("files-sidebar")).toBeVisible()
}

function card(page: Page, title: string) {
  return page.getByTestId("files-body").getByRole("button", { name: `Open ${title}`, exact: true })
}

async function itemAction(page: Page, title: string, action: string | RegExp) {
  await page.getByRole("button", { name: `More actions for ${title}`, exact: true }).click()
  await page.getByRole("menuitem", { name: action, exact: typeof action === "string" }).click()
}

function place(page: Page, testId: string) {
  return page.getByTestId("files-sidebar").getByTestId(testId)
}

test("@smoke files: upload, find, favorite, file, rename, trash, restore and delete for good", async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFiles(page)

  // Plain web has no task-workspace ledger: the Workspace files group stays
  // listed, inert, and says where those files are (ADR-0223 §8, rule 7).
  const workspace = place(page, "files-place-group-workspace")
  await expect(workspace).toHaveAttribute("aria-disabled", "true")
  await expect(workspace).toHaveAttribute("data-held-back", "no-fs-backend")
  await expect(workspace).toContainText("Desktop app")

  await expect(page.getByText("Nothing here yet", { exact: true })).toBeVisible()

  // Upload through New → Upload files.
  await page.getByTestId("files-upload-input").setInputFiles([NOTES, BUDGET])
  await expect(page.getByText("Uploaded 2 files.", { exact: true })).toBeVisible()
  await expect(card(page, "notes.md")).toBeVisible()
  await expect(card(page, "budget.csv")).toBeVisible()
  // Both are under Uploads, and made by the person, not an agent.
  await place(page, "files-place-group-uploads").click()
  await expect(card(page, "notes.md")).toBeVisible()
  await page.getByTestId("files-lens-ai").click()
  await expect(card(page, "notes.md")).toHaveCount(0)
  await page.getByTestId("files-lens-mine").click()
  await expect(card(page, "budget.csv")).toBeVisible()
  await page.getByTestId("files-lens-suggested").click()
  await place(page, "files-place-all").click()

  // Search by name.
  const search = page.getByTestId("files-search")
  await search.fill("budget")
  await expect(card(page, "budget.csv")).toBeVisible()
  await expect(card(page, "notes.md")).toHaveCount(0)
  await search.fill("")
  await expect(card(page, "notes.md")).toBeVisible()

  // Preview, and favorite from the preview.
  await card(page, "notes.md").click()
  const preview = page.getByTestId("files-preview")
  await expect(preview).toBeVisible()
  await preview.getByTestId("files-preview-favorite").click()
  await expect(page.getByText("Added “notes.md” to favorites.", { exact: true })).toBeVisible()
  await page.getByTestId("files-preview-close").click()
  await page.getByTestId("files-lens-favorites").click()
  await expect(card(page, "notes.md")).toBeVisible()
  await expect(card(page, "budget.csv")).toHaveCount(0)
  await page.getByTestId("files-lens-suggested").click()

  // A folder, and an item moved into it.
  await place(page, "files-sidebar-new-folder").click()
  await page.getByTestId("files-folder-name").fill("Reports")
  await page.getByTestId("files-folder-submit").click()
  const reports = page
    .getByTestId("files-sidebar")
    .getByRole("button", { name: "Reports", exact: true })
  await expect(reports).toBeVisible()
  await itemAction(page, "budget.csv", "Move to folder…")
  const moveDialog = page.getByTestId("files-move-dialog")
  await moveDialog.getByRole("radio", { name: "Reports" }).click()
  await moveDialog.getByTestId("files-move-confirm").click()
  await expect(page.getByText("Moved 1 item.", { exact: true })).toBeVisible()
  await reports.click()
  await expect(card(page, "budget.csv")).toBeVisible()
  await expect(card(page, "notes.md")).toHaveCount(0)
  await place(page, "files-place-all").click()

  // Rename: a Files upload is renamed at its source. The item's name carries
  // its F2 shortcut hint.
  await itemAction(page, "notes.md", /^Rename…/)
  const name = page.getByTestId("files-rename-name")
  await name.fill("meeting-notes.md")
  await page.getByTestId("files-rename-submit").click()
  await expect(page.getByText("Renamed to “meeting-notes.md”.", { exact: true })).toBeVisible()
  await expect(card(page, "meeting-notes.md")).toBeVisible()

  // The list view shows the same items as rows.
  await page.getByTestId("files-view-list").click()
  const list = page.getByTestId("files-list")
  await expect(list.getByRole("row", { name: "Open meeting-notes.md", exact: true })).toBeVisible()
  await expect(list.getByRole("row", { name: "Open budget.csv", exact: true })).toBeVisible()
  await page.getByTestId("files-view-grid").click()

  // Favorites, folders and names outlive a reload.
  await page.reload()
  await waitForTestGlobals(page, 30_000)
  await expect(card(page, "meeting-notes.md")).toBeVisible()
  await page.getByTestId("files-lens-favorites").click()
  await expect(card(page, "meeting-notes.md")).toBeVisible()
  await page.getByTestId("files-lens-suggested").click()
  await expect(
    page.getByTestId("files-sidebar").getByRole("button", { name: "Reports", exact: true })
  ).toBeVisible()

  // Trash leaves the item restorable; it no longer shows anywhere else.
  await itemAction(page, "meeting-notes.md", "Move to Trash")
  await expect(
    page.getByText("Moved “meeting-notes.md” to the Trash.", { exact: true })
  ).toBeVisible()
  await expect(card(page, "meeting-notes.md")).toHaveCount(0)
  await page.getByTestId("files-lens-favorites").click()
  await expect(card(page, "meeting-notes.md")).toHaveCount(0)
  await page.getByTestId("files-lens-suggested").click()
  const trash = place(page, "files-place-trash")
  await expect(trash).toContainText("1")
  await trash.click()
  await card(page, "meeting-notes.md").click()
  await page.getByTestId("files-preview-restore").click()
  await expect(page.getByText("Restored 1 item.", { exact: true })).toBeVisible()
  await place(page, "files-place-all").click()
  await expect(card(page, "meeting-notes.md")).toBeVisible()

  // Deleting for good from the Trash: gone from the page and from the Trash.
  await itemAction(page, "budget.csv", "Move to Trash")
  await expect(page.getByText("Moved “budget.csv” to the Trash.", { exact: true })).toBeVisible()
  await trash.click()
  await card(page, "budget.csv").click()
  await page.getByTestId("files-preview-delete-forever").click()
  await page.getByTestId("files-delete-forever-confirm").click()
  await expect(page.getByText("Deleted 1 item forever.", { exact: true })).toBeVisible()
  await expect(card(page, "budget.csv")).toHaveCount(0)
  await place(page, "files-place-all").click()
  await expect(card(page, "budget.csv")).toHaveCount(0)
  await expect(card(page, "meeting-notes.md")).toBeVisible()
})
