/**
 * E2E: canonical revision-bound desktop nodes render in the editor and survive
 * persistence. Native execution is covered by the co-located executor tests.
 */

import { test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

const CASES = [
  {
    fixture: "action-desktop-list-apps",
    kind: "action.desktop.listApps",
    label: "List apps",
  },
  {
    fixture: "action-desktop-get-app-state",
    kind: "action.desktop.getAppState",
    label: "Get app state",
  },
  {
    fixture: "action-desktop-query-elements",
    kind: "action.desktop.queryElements",
    label: "Query elements",
  },
  {
    fixture: "action-desktop-expand-element",
    kind: "action.desktop.expandElement",
    label: "Expand element",
  },
  {
    fixture: "action-desktop-perform-action",
    kind: "action.desktop.performAction",
    label: "Perform action",
  },
] as const

test.describe("workflow nodes — canonical desktop automation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  for (const { fixture, kind, label } of CASES) {
    test(`${kind} renders and survives reload`, async ({ page }) => {
      const workflowId = await seedAndOpenWorkflow(page, fixture)
      await assertNodeOnCanvas(page, { kind, label })
      await openNodeInspector(page, kind)
      await saveWorkflow(page)
      await reopenAndAssertNode(page, workflowId, { kind })
    })
  }
})
