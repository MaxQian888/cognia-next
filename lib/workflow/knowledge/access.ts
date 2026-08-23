import type { KnowledgeBaseSource } from "@/types/knowledge-base"
import type { WorkflowEntrypoint } from "@/types/workflow/deployment"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

export interface KnowledgeAccessDecision {
  allowed: boolean
  visibility: "private" | "restricted" | "public"
  reason: "trusted-local" | "public" | "principal" | "group" | "private" | "no-match"
}

const PUBLIC_ENTRYPOINTS = new Set<WorkflowEntrypoint>(["portal", "http", "mcp"])

/**
 * Evaluate document ACLs after the workflow node has selected the deployment's
 * allowed Knowledge Bases. Legacy ACL-less sources stay available locally but
 * are never exposed through Portal, HTTP, or MCP.
 */
export function authorizeKnowledgeSource(input: {
  source: KnowledgeBaseSource
  entrypoint?: WorkflowEntrypoint
  triggeredBy?: WorkflowTriggeredFrom
}): KnowledgeAccessDecision {
  if (!input.entrypoint || !PUBLIC_ENTRYPOINTS.has(input.entrypoint)) {
    return {
      allowed: true,
      visibility: input.source.acl?.visibility ?? "private",
      reason: "trusted-local",
    }
  }

  const acl = input.source.acl
  if (acl?.visibility === "public") {
    return { allowed: true, visibility: "public", reason: "public" }
  }
  const initiator = input.triggeredBy?.initiator
  if (!initiator?.authenticated || !initiator.principalId) {
    return { allowed: false, visibility: acl?.visibility ?? "private", reason: "private" }
  }
  if (acl?.principalIds?.includes(initiator.principalId)) {
    return { allowed: true, visibility: acl.visibility, reason: "principal" }
  }
  const groupIds = new Set(initiator.groupIds ?? [])
  if (acl?.visibility === "restricted" && acl.groupIds?.some((id) => groupIds.has(id))) {
    return { allowed: true, visibility: "restricted", reason: "group" }
  }
  return { allowed: false, visibility: acl?.visibility ?? "private", reason: "no-match" }
}
