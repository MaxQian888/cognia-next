/**
 * The plugin contract's share of `lib/knowledge-base/runtime/progressive-reading.ts`, which re-exports these.
 */
import type { WorkflowEntrypoint } from "../../../types/workflow/deployment"
import type { WorkflowTriggeredFrom } from "../../../types/workflow/visual"

export interface KnowledgeReadingAccess {
  /** Parent execution ceiling; capabilities and child characters can only narrow it. */
  allowedKnowledgeBaseIds?: readonly string[]
  entrypoint?: WorkflowEntrypoint
  triggeredBy?: WorkflowTriggeredFrom
  revisionBindings?: Readonly<Record<string, readonly string[]>>
}
