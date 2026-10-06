import type { KnowledgeBaseSource } from "@/types/knowledge-base"
import type { WorkflowEntrypoint } from "@/types/workflow/deployment"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { StepExecutionContext } from "@/types/workflow/visual"
import type { KnowledgeReadingAccess } from "@/lib/knowledge-base/runtime/progressive-reading"

/** Verified workflow authority is shared by Agent turns and nested Team runs. */
export async function resolveWorkflowKnowledgeAccess(
  ctx: Pick<StepExecutionContext, "executionBinding" | "runId">
): Promise<KnowledgeReadingAccess | undefined> {
  if (!ctx.executionBinding) return undefined
  const { getDb } = await import("@/lib/db/schema")
  const run = await getDb().workflowRuns.get(ctx.runId)
  const revisionBindings: Record<string, string[]> = {}
  for (const [key, generationId] of Object.entries(
    ctx.executionBinding.dependencyLock?.indexes ?? {}
  )) {
    const parts = key.split(":")
    if (parts[0] !== "knowledge" || !parts[1]) continue
    const revisions = revisionBindings[parts[1]] ?? []
    if (!revisions.includes(generationId)) revisions.push(generationId)
    revisionBindings[parts[1]] = revisions
  }
  return {
    entrypoint: ctx.executionBinding.entrypoint,
    triggeredBy: run?.triggeredBy,
    revisionBindings,
    allowedKnowledgeBaseIds: Object.keys(revisionBindings),
  }
}

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
