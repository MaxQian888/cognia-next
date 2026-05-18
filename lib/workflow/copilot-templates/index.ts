/**
 * Workflow Copilot template registry + materialization helper.
 *
 * Used by:
 *   • `wf_list_templates` / `wf_apply_template` MCP tools — list & build
 *     a graph from agent-supplied slot values.
 *   • Right-sidebar Templates tab — same `listTemplates` / `getTemplate`
 *     surface, the tab fills slots via a form and stages the resulting
 *     graph via the proposal flow.
 *
 * Each template is its own module — adding one means importing it here and
 * appending to `TEMPLATES`. The order of the array is the display order in
 * the Templates tab.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import type { WorkflowCopilotTemplate, CopilotSlotValues } from "./types"
import { githubPrCopilotTemplate } from "./github-pr"
import { cronReportCopilotTemplate } from "./cron-report"
import { webhookAiConnectorCopilotTemplate } from "./webhook-ai-connector"

export type {
  WorkflowCopilotTemplate,
  CopilotTemplateSlot,
  CopilotSlotValues,
  CopilotI18n,
} from "./types"

const TEMPLATES: WorkflowCopilotTemplate[] = [
  githubPrCopilotTemplate,
  cronReportCopilotTemplate,
  webhookAiConnectorCopilotTemplate,
]

const TEMPLATE_BY_ID: Map<string, WorkflowCopilotTemplate> = new Map(
  TEMPLATES.map((t) => [t.id, t])
)

/** List every registered template in display order. */
export function listCopilotTemplates(): readonly WorkflowCopilotTemplate[] {
  return TEMPLATES
}

/** Look up one template by id, or undefined if not registered. */
export function getCopilotTemplate(id: string): WorkflowCopilotTemplate | undefined {
  return TEMPLATE_BY_ID.get(id)
}

export interface MaterializeFailure {
  ok: false
  code: "unknown-template" | "missing-required-slot"
  message: string
  missing?: string[]
}

export interface MaterializeSuccess {
  ok: true
  template: WorkflowCopilotTemplate
  workflow: VisualWorkflow
}

export type MaterializeResult = MaterializeSuccess | MaterializeFailure

/**
 * Build the graph for a template id + slot bag, after enforcing the
 * template's `required` slots. Returns a tagged union so callers (tool +
 * Templates tab) can render the same i18n-friendly errors.
 */
export function materializeCopilotTemplate(
  templateId: string,
  slots: CopilotSlotValues
): MaterializeResult {
  const template = TEMPLATE_BY_ID.get(templateId)
  if (!template) {
    return {
      ok: false,
      code: "unknown-template",
      message: `Unknown workflow copilot template: "${templateId}".`,
    }
  }
  const missing: string[] = []
  for (const slot of template.slots) {
    if (!slot.required) continue
    // A required slot with a defaultValue is *suggested but auto-filled* —
    // omitting it from the caller bag is fine; the default takes over.
    if (slot.defaultValue !== undefined) continue
    const value = slots[slot.key]
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      missing.push(slot.key)
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing-required-slot",
      missing,
      message: `Missing required slot(s): ${missing.join(", ")}.`,
    }
  }
  // Pass `slots` plus any per-slot `defaultValue` fallbacks so templates
  // don't have to re-implement the same default resolution.
  const merged: CopilotSlotValues = {}
  for (const slot of template.slots) {
    const v = slots[slot.key]
    if (v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "")) {
      merged[slot.key] = v
    } else if (slot.defaultValue !== undefined) {
      merged[slot.key] = slot.defaultValue
    }
  }
  return { ok: true, template, workflow: template.build(merged) }
}
