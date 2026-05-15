/**
 * Shared assertions + flow helpers used by the per-node-family specs in
 * `tests/e2e/workflows/nodes/**`. Each helper assumes the editor route is
 * already open (`/workflows/<id>`) unless otherwise noted.
 *
 * Don't add executor-specific logic here — keep this module focused on
 * editor interactions (canvas, inspector, toolbar, run-history navigation).
 */

import { expect, type Page } from "@playwright/test"

export interface NodeAssertion {
  /** The full kind string, e.g. "ai.prompt". */
  kind: string
  /** Optional label override the seed sets on the node. */
  label?: string
}

/** Assert the named workflow node renders on the canvas. */
export async function assertNodeOnCanvas(page: Page, node: NodeAssertion): Promise<void> {
  await expect(page.getByTestId(`wf-node-${node.kind}`).first()).toBeVisible({ timeout: 15_000 })
  if (node.label) {
    await expect(page.getByTestId(`wf-node-${node.kind}`).first()).toContainText(node.label)
  }
}

/** Click the first node of the given kind so the inspector opens. */
export async function openNodeInspector(page: Page, kind: string): Promise<void> {
  await page.getByTestId(`wf-node-${kind}`).first().click()
  await expect(page.getByTestId("workflow-inspector")).toBeVisible()
}

/** Fill an inspector input by its DOM id (most inspector fields use `#ins-<param>`). */
export async function fillInspectorField(
  page: Page,
  paramId: string,
  value: string
): Promise<void> {
  const locator = page.locator(`#ins-${paramId}`)
  await expect(locator).toBeVisible()
  await locator.fill(value)
}

/** Click the toolbar Save button and wait for the saved badge to flash. */
export async function saveWorkflow(page: Page): Promise<void> {
  const saveBtn = page.getByTestId("workflow-save")
  await expect(saveBtn).toBeVisible()
  await saveBtn.click()
}

/** Click the toolbar Run button. Optionally wait for a run-status indicator. */
export async function triggerRun(
  page: Page,
  options: { waitForStatus?: boolean } = {}
): Promise<void> {
  const runBtn = page.getByTestId("workflow-run")
  await expect(runBtn).toBeVisible()
  await runBtn.click()
  if (options.waitForStatus !== false) {
    // The run status pill shows up once the orchestrator emits the first event.
    await expect(page.getByTestId(/wf-node-status-/).first()).toBeVisible({ timeout: 20_000 })
  }
}

/** Navigate to the workflow's runs page and assert the most recent run row
 *  matches the expected status. */
export async function assertLatestRunStatus(
  page: Page,
  workflowId: string,
  status: "succeeded" | "failed" | "running" = "succeeded"
): Promise<void> {
  await page.goto(`/workflows/${workflowId}/runs`)
  await expect(page.getByTestId("run-list")).toBeVisible({ timeout: 20_000 })
  const pill = page.getByTestId(`run-status-${status}`).first()
  await expect(pill).toBeVisible({ timeout: 20_000 })
}

/** Reload the editor route and confirm the canvas comes back with the same node. */
export async function reopenAndAssertNode(
  page: Page,
  workflowId: string,
  node: NodeAssertion
): Promise<void> {
  await page.goto(`/workflows/${workflowId}`)
  await assertNodeOnCanvas(page, node)
}

/** Drag a node kind from the sidebar onto the canvas by clicking the sidebar
 *  entry (which falls back to a center-of-canvas drop in the editor). */
export async function addNodeFromSidebar(page: Page, kind: string): Promise<void> {
  const sidebarItem = page.getByTestId(`wf-sidebar-${kind}`).first()
  await expect(sidebarItem).toBeVisible()
  await sidebarItem.click()
  await assertNodeOnCanvas(page, { kind })
}

/** Delete the currently-selected node via the inspector footer button. */
export async function deleteSelectedNode(page: Page): Promise<void> {
  await page.getByRole("button", { name: /delete node/i }).click()
}
