/**
 * Subagents bundled with the host (Phase C.5).
 *
 * Each entry exports an `AgentDefinition` matching the shape declared
 * at `sidecar/.../claude-agent-sdk/sdk.d.ts:38`. They are passed to the
 * SDK via `SendOptions.agents` (keyed by the value the dispatcher
 * agent uses to invoke them).
 *
 * Workflow-editor sessions get all four loaded automatically via
 * `resolveSendOptions` (see `lib/claude/build-options.ts`). Other
 * session kinds are unaffected.
 */

export { workflowDesignerAgent } from "./workflow-designer"
export { workflowDebuggerAgent } from "./workflow-debugger"
export { workflowRefactorerAgent } from "./workflow-refactorer"
export { workflowDocWriterAgent } from "./workflow-doc-writer"
export type { AgentDefinition } from "./types"

import { workflowDesignerAgent } from "./workflow-designer"
import { workflowDebuggerAgent } from "./workflow-debugger"
import { workflowRefactorerAgent } from "./workflow-refactorer"
import { workflowDocWriterAgent } from "./workflow-doc-writer"

/**
 * Single map keyed by the dispatcher-agent name (lowercase-with-dashes)
 * so the build-options branch can spread it directly into
 * `SendOptions.agents` (typed `Record<string, Record<string, unknown>>`
 * upstream by claude-agent-sdk).
 */
export function workflowEditorSubagents(): Record<string, Record<string, unknown>> {
  return {
    "workflow-designer": workflowDesignerAgent as unknown as Record<string, unknown>,
    "workflow-debugger": workflowDebuggerAgent as unknown as Record<string, unknown>,
    "workflow-refactorer": workflowRefactorerAgent as unknown as Record<string, unknown>,
    "workflow-doc-writer": workflowDocWriterAgent as unknown as Record<string, unknown>,
  }
}
