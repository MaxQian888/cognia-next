/**
 * E2E: action.mcp.invokeTool — Phase 6+ stub. Editor + form only.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.mcp.invokeTool (stub)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded mcp invoke renders + serverId + tool + args persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-mcp-invoke")
    await assertNodeOnCanvas(page, { kind: "action.mcp.invokeTool", label: "MCP" })
    await openNodeInspector(page, "action.mcp.invokeTool")
    await expect(page.locator("#ins-serverId, [data-field=serverId]").first()).toBeVisible()
    await expect(page.locator("#ins-toolName, [data-field=toolName]").first()).toBeVisible()
    await expect(page.locator("#ins-argsJson, [data-field=argsJson]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.mcp.invokeTool" })
  })
})
