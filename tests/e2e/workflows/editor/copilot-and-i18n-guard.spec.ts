/**
 * E2E: the editor's copilot (chat) tab hydrates its OWN session, and the editor
 * surfaces no missing-i18n-key errors.
 *
 * Two regressions this guards:
 *  1. The workflow editor is self-contained — it does NOT mount the app-wide
 *     `useSessions`, so the copilot tab must hydrate its own workflow-scoped
 *     session (see the `workflow-editor-chat-self-contained` note). A regression
 *     that left the tab stuck on its loading/empty state would break the copilot
 *     in the editor while the main chat still worked.
 *  2. Workflow node/form strings are i18n-wired; a missing key surfaces as a
 *     next-intl `MISSING_MESSAGE` / `IntlError` (e.g. an unresolved
 *     `workflows.nodes.*` / `workflows.forms.*` dotted key). We register console
 *     + pageerror listeners and assert none fire for the editor's i18n.
 *
 * Drives the real editor route (chromium PR CI). Seeds `multi-step` so several
 * node families (trigger / ai / data / flow) render their translated labels and
 * inspector forms.
 */

import { expect, test, type ConsoleMessage } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"
import { openNodeInspector } from "../../helpers/workflow-spec-helpers"

/** True for a console/page message that signals an unresolved i18n key. */
function isI18nKeyError(text: string): boolean {
  return (
    /MISSING_MESSAGE|IntlError|INSUFFICIENT_PATH/.test(text) &&
    /workflows?\.|forms?\.|nodes?\./.test(text)
  )
}

test.describe("workflow editor — copilot tab + i18n guard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("editor + copilot render with no missing-i18n-key errors", async ({ page }) => {
    const i18nErrors: string[] = []
    const collect = (text: string) => {
      if (isI18nKeyError(text)) i18nErrors.push(text)
    }
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() === "error") collect(m.text())
    })
    page.on("pageerror", (e) => collect(e.message))

    await seedAndOpenWorkflow(page, "multi-step")
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()

    // Render an inspector form (translated field labels) for a real node.
    await openNodeInspector(page, "ai.prompt")

    // Open the copilot tab — it must hydrate its own session, not stay stuck on
    // the loading/empty placeholder.
    await page
      .getByTestId("context-workbench-activity-rail")
      .getByRole("button", { name: "Chat" })
      .click()
    await expect(page.getByTestId("workflow-chat-tab")).toBeVisible({ timeout: 15_000 })

    // Settle a tick so any deferred translation calls flush.
    await page.waitForTimeout(300)

    expect(i18nErrors, `Unexpected missing-i18n-key errors:\n${i18nErrors.join("\n")}`).toEqual([])
  })
})
