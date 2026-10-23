/**
 * The plugin contract's share of `lib/workflow/copilot-templates/index.ts`, which re-exports these.
 */
import type { VisualWorkflow } from "../../../types/workflow/visual"
import type { WorkflowCopilotTemplate } from "./types"

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
