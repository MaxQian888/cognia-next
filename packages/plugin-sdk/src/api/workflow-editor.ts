/**
 * Plugin SDK — `workflow-editor` capability surface.
 *
 * A copilot that edits a workflow has to edit the LIVE editor, not a copy of
 * the graph. Two properties fall out of that and neither is optional:
 *
 *  - **One history stack.** Every mutation goes through the editor store's own
 *    undoable actions, so an AI edit and a hand edit are undone by the same
 *    Cmd-Z. A plugin that wrote the graph some other way would produce edits
 *    the user cannot take back.
 *  - **One open editor, addressed explicitly.** `getEditorStore(id)` /
 *    `listEditorStores()` are how a tool handler — which runs outside React,
 *    dispatched from the sidecar — finds the store. With several editors open,
 *    a tool that guesses mutates the wrong workflow.
 *
 * Proposals are the review seam: an agent stages ops, the user sees a diff and
 * accepts or rejects. `summarizeOps` renders that diff, so the summary the
 * user reads is the one the host generates rather than the agent's own account
 * of what it did.
 */

export {
  getEditorStore,
  listEditorStores,
  registerEditorStore,
  subscribeEditorStores,
  unregisterEditorStore,
} from "@/lib/workflow/editor/store-registry"

export { createEditorStore } from "@/lib/workflow/editor/store"
export type { EditorStore } from "@/lib/workflow/editor/store"

export { useProposalStore } from "@/lib/workflow/editor/proposal-store"
export type { ProposalPayload } from "@/lib/workflow/editor/proposal-store"

export { summarizeOps } from "@/lib/workflow/editor/proposal-types"
export type { ProposalOp } from "@/lib/workflow/editor/proposal-types"

export { coerceProposalOp, KNOWN_PROPOSAL_OP_TYPES } from "@/lib/workflow/editor/proposal-schema"

/** Bumped on every graph edit — a cheap "did anything change?" for a poller. */
export { workflowEditorRevision } from "@/lib/workflow/editor/editor-revision"

/**
 * Layout. An agent that adds nodes leaves them stacked at the origin unless it
 * lays them out; running the host's ELK pass is what keeps a generated graph
 * readable and identical to what the toolbar's Auto-layout button produces.
 */
export {
  applyAutoLayoutPositions,
  autoLayout,
  ELK_DIRECTIONS,
} from "@/lib/workflow/editor/auto-layout"

export type { AutoLayoutDirection } from "@/lib/workflow/editor/auto-layout"

/** Turn a failed run or a failed validation into something worth showing. */
export { explainLastRun, explainValidation } from "@/lib/workflow/runtime/error-explainer"

/** Slot-filled starting points a copilot can offer instead of a blank canvas. */
export {
  getCopilotTemplate,
  listCopilotTemplates,
  materializeCopilotTemplate,
} from "@/lib/workflow/copilot-templates"

export type { CopilotSlotValues } from "@/lib/workflow/copilot-templates"
