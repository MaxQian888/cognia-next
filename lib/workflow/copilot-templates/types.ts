/**
 * Workflow Copilot templates — slotted scaffolds applied inline inside an
 * open editor via the proposal flow (NOT to be confused with the Dexie-
 * seeded starter workflows in `lib/workflow/definition/templates/`, which
 * are full graphs surfaced via Settings → Workflows → Templates).
 *
 * A copilot template declares user-fillable slots and a `build(slots)`
 * function that returns the resulting `VisualWorkflow`. The Templates tab
 * (right sidebar) and the `wf_apply_template` MCP tool both call into
 * `materializeTemplate(id, slots)` to obtain the graph, then route the
 * generated nodes/edges through `wf_propose_batch` so the user reviews +
 * applies via the proposal card.
 */

export type {
  CopilotI18n,
  CopilotSlotType,
  CopilotSlotValues,
  CopilotTemplateSlot,
  WorkflowCopilotTemplate,
} from "@cognia/plugin-contract/lib/workflow/copilot-templates/types"
