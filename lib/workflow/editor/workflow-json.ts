/**
 * Workflow JSON import/export helpers — shared by the desktop canvas toolbar
 * and the mobile editor top bar so the file-download + parse/validate logic
 * lives in one place.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "_") || "workflow"
}

/** Trigger a browser download of the workflow as pretty-printed JSON. */
export function downloadWorkflowJson(wf: VisualWorkflow): void {
  const blob = new Blob([JSON.stringify(wf, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${safeFileName(wf.name)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Parse + shallow-validate imported workflow JSON. Throws with a readable
 * message on malformed input. Returns the parsed partial; callers merge it
 * onto the current workflow (preserving the existing id).
 */
export function parseWorkflowImport(jsonText: string): Partial<VisualWorkflow> {
  const parsed = JSON.parse(jsonText) as Partial<VisualWorkflow>
  return validateWorkflowShape(parsed)
}

function validateWorkflowShape(parsed: unknown): Partial<VisualWorkflow> {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Top-level must be an object")
  }
  const wf = parsed as Partial<VisualWorkflow>
  if (!Array.isArray(wf.nodes) || !Array.isArray(wf.edges)) {
    throw new Error("Missing 'nodes' or 'edges' array")
  }
  return wf
}

/** Bundle envelope produced by {@link downloadWorkflowsBundle}. */
interface WorkflowsBundle {
  version: 1
  workflows: VisualWorkflow[]
}

function isBundle(value: unknown): value is WorkflowsBundle {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { workflows?: unknown }).workflows)
  )
}

/**
 * Parse imported JSON that holds EITHER a single workflow OR a
 * `{ workflows: [...] }` bundle (as written by the library's bulk export).
 * Each workflow is shallow-validated; throws on the first malformed entry.
 * Always returns an array (length 1 for the single-workflow case).
 */
export function parseWorkflowsImport(jsonText: string): Partial<VisualWorkflow>[] {
  const parsed = JSON.parse(jsonText) as unknown
  if (isBundle(parsed)) {
    if (parsed.workflows.length === 0) {
      throw new Error("Bundle contains no workflows")
    }
    return parsed.workflows.map((wf) => validateWorkflowShape(wf))
  }
  return [validateWorkflowShape(parsed)]
}

/** Download several workflows as one `{ version, workflows }` bundle file. */
export function downloadWorkflowsBundle(workflows: VisualWorkflow[]): void {
  const bundle: WorkflowsBundle = { version: 1, workflows }
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `workflows-${workflows.length}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
