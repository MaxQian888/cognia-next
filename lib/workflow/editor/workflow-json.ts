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
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Top-level must be an object")
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("Missing 'nodes' or 'edges' array")
  }
  return parsed
}
