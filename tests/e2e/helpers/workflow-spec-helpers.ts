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

/**
 * Fill an inspector input by its `params` key.
 *
 * Inspector forms do NOT share a single id convention — each node-config form
 * picks its own prefix (`#http-method`, `#wh-status`, …) and the SchemaForm
 * fallback uses a random `useId()`. The one form-agnostic anchor is the
 * `data-field="<param>"` attribute that `Field` stamps on every field wrapper
 * (`components/.../forms/shared.tsx`). We scope to that wrapper and target the
 * inner editable control. `#ins-<param>` is kept as a first guess for the rare
 * field that does id by param name.
 */
export async function fillInspectorField(
  page: Page,
  paramId: string,
  value: string
): Promise<void> {
  const direct = page.locator(`#ins-${paramId}`)
  const scoped = page
    .locator(`[data-field="${paramId}"]`)
    .locator("input, textarea, [contenteditable='true']")
  const locator = (await direct.count()) ? direct.first() : scoped.first()
  await expect(locator).toBeVisible()
  await locator.fill(value)
}

/** Assert an inspector field currently holds `value` (same locator strategy
 *  as {@link fillInspectorField}). The read-back half of a persist
 *  round-trip: fill → save → reopen → expectInspectorFieldValue.
 *
 *  Input/textarea fields are read with toHaveValue; several inspector params
 *  (expression-capable ones like `tag`) render as a CodeMirror
 *  contenteditable instead, where value semantics don't exist — those are
 *  read as text content. */
export async function expectInspectorFieldValue(
  page: Page,
  paramId: string,
  value: string
): Promise<void> {
  const directInput = page.locator(`input#ins-${paramId}, textarea#ins-${paramId}`).first()
  const wrapper = page.locator(`[data-field="${paramId}"]`)
  const scopedInput = wrapper.locator("input, textarea").first()
  const scopedEditable = wrapper.locator("[contenteditable='true']").first()

  if (await directInput.count()) {
    await expect(directInput).toHaveValue(value)
    return
  }
  if (await scopedInput.count()) {
    await expect(scopedInput).toHaveValue(value)
    return
  }
  await expect(scopedEditable).toBeVisible()
  await expect(scopedEditable).toContainText(value)
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

/** A run record read straight from Dexie, including the embedded per-step
 *  event log. Mirrors the shape `editor-multi-step-orchestration.spec.ts`
 *  reads (`run.events[].stepId`). */
export interface RunRecord {
  id: string
  status: "succeeded" | "failed" | "running" | string
  startedAt?: number
  completedAt?: number
  /** Run-level error (set when `status === "failed"`), read from the run row. */
  error?: unknown
  /** Per-step timeline, read from the `workflowRunEvents` table (oldest → newest). */
  events: Array<{
    stepId?: string
    type?: string
    status?: string
    [key: string]: unknown
  }>
}

/** Read every run for a workflow (oldest → newest) directly from Dexie,
 *  including the embedded events. Use this to assert REAL run outcomes —
 *  status, output, which branch arm ran, iteration counts — instead of the
 *  weak "some status pill is visible somewhere" check. Reuses the proven
 *  `import("@/lib/db/schema")` page-context pattern. */
export async function readRuns(page: Page, workflowId: string): Promise<RunRecord[]> {
  // Routes through the `__cogniaReadRuns` bridge (runs in the app bundle).
  // A raw `page.evaluate(import("@/lib/db/schema"))` does NOT resolve the `@/`
  // alias under Turbopack dev, so the bridge is the only reliable reader.
  return page.evaluate(async (wfId) => {
    const w = window as Window & {
      __cogniaReadRuns?: (id: string) => Promise<RunRecord[]>
    }
    if (typeof w.__cogniaReadRuns !== "function") {
      throw new Error("window.__cogniaReadRuns is not wired")
    }
    return w.__cogniaReadRuns(wfId)
  }, workflowId)
}

/** The most recently started run for a workflow, or null if none has landed. */
export async function readLatestRun(page: Page, workflowId: string): Promise<RunRecord | null> {
  const runs = await readRuns(page, workflowId)
  return runs.length ? runs[runs.length - 1] : null
}

/** Navigate to the workflow's runs page and assert the most recent run row
 *  matches the expected status.
 *
 *  Binds to the ACTUAL latest run row read from Dexie (not "any matching pill
 *  is visible"), so a node that silently stops running — leaving a stale
 *  succeeded pill on screen — is now caught. */
export async function assertLatestRunStatus(
  page: Page,
  workflowId: string,
  status: "succeeded" | "failed" | "running" = "succeeded"
): Promise<void> {
  // Reads the actual latest run row from the account-scoped Dexie db via the
  // bridge — no dependency on navigating to (and cold-compiling) the runs page,
  // and binds to the real run status rather than "some pill is visible".
  // On a terminal mismatch the poll surfaces the run's error so a failure
  // reads as "failed: <executor error>" instead of a bare status diff.
  await expect
    .poll(
      async () => {
        const run = await readLatestRun(page, workflowId)
        if (!run) return undefined
        if (run.status === status) return status
        const terminal = run.status === "succeeded" || run.status === "failed"
        return terminal && run.error
          ? `${run.status}: ${JSON.stringify(run.error).slice(0, 400)}`
          : run.status
      },
      { timeout: 30_000 }
    )
    .toBe(status)
}

/** Reload the editor route and confirm the canvas comes back with the same node. */
export async function reopenAndAssertNode(
  page: Page,
  workflowId: string,
  node: NodeAssertion
): Promise<void> {
  await page.goto(`/workflows/editor?id=${workflowId}`)
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
