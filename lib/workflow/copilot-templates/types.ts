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

import type { VisualWorkflow } from "@/types/workflow/visual"

/** Bilingual surface string used by labels / descriptions / placeholders. */
export interface CopilotI18n {
  en: string
  "zh-CN": string
}

/**
 * Slot input type. Kept intentionally narrow — anything more complex (file
 * picker, key picker, etc.) should be modeled as a string slot for now and
 * upgraded when a concrete need lands.
 */
export type CopilotSlotType = "string" | "number" | "select"

export interface CopilotTemplateSlot {
  key: string
  type: CopilotSlotType
  label: CopilotI18n
  description?: CopilotI18n
  placeholder?: string
  options?: string[]
  required?: boolean
  /**
   * Optional default value rendered into the slot drawer input and used by
   * `build({})` when the caller wants a "preview" graph without filling in
   * anything (e.g., the validate-on-ship test below).
   */
  defaultValue?: string | number
}

/** Strongly typed slot value bag passed to `build`. */
export type CopilotSlotValues = Record<string, string | number>

export interface WorkflowCopilotTemplate {
  /** Stable id used by the MCP tool and Templates tab to address the template. */
  id: string
  label: CopilotI18n
  description: CopilotI18n
  /** Optional lucide icon name for the Templates tab card. */
  iconName?: string
  /** Optional tags shown next to the card to hint at the surfaces touched. */
  tags?: string[]
  slots: CopilotTemplateSlot[]
  /**
   * Pure: given a (possibly partial) slot bag, return the workflow graph
   * this template materializes into. Implementations MUST tolerate missing
   * non-required slots (substitute the slot's `defaultValue` or an empty
   * string) — the caller is responsible for validation against `required`
   * before invoking `build` in real flows. The "ship test" relies on
   * `build({})` returning a schema-valid graph.
   */
  build: (slots: CopilotSlotValues) => VisualWorkflow
}
