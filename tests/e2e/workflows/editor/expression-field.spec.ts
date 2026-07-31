/**
 * E2E: expression field shows {{ }} autosuggestions when typing.
 *
 * The field is a CodeMirror editor whose completion tooltip renders with
 * role="listbox" — bind to that. An earlier version added an
 * `.or([data-testid=expression-suggestions])` fallback, a testid no product
 * code renders, and used fill(), which replaces the document without the
 * typing transactions CodeMirror's activateOnTyping listens for.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"
import { openNodeInspector } from "../../helpers/workflow-spec-helpers"

test.describe("workflow editor — expression field", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("typing {{ $ in an expression field opens the suggestion popover", async ({ page }) => {
    await seedAndOpenWorkflow(page, "data-transform")
    await openNodeInspector(page, "data.transform")

    // Focus CodeMirror's contenteditable surface — clicking the field
    // wrapper doesn't hand the editor focus.
    const cmContent = page
      .locator("#ins-expression .cm-content, [data-field=expression] .cm-content")
      .first()
    await cmContent.click()
    // Type character-by-character so CodeMirror's completion source sees
    // real input transactions. The source's matchBefore requires a `$`
    // inside the mustache (`{{ $` / `$…`) — a bare `{{ ` offers nothing.
    await page.keyboard.type("{{ $", { delay: 40 })
    // CodeMirror's autocomplete tooltip is a real listbox with option rows.
    const listbox = page.getByRole("listbox").first()
    await expect(listbox).toBeVisible({ timeout: 5_000 })
    await expect(listbox.getByRole("option").first()).toBeVisible()
  })
})
