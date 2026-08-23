import { pruneExpiredSharedLinks } from "@/lib/db/shared-links"
import { pruneExpiredWorkflowConversations } from "@/lib/db/workflow-conversations"
import { pruneExpiredHumanInputFiles } from "@/lib/db/workflow-human-input-files"
import { pruneExpiredHumanInputSensitiveValues } from "@/lib/db/workflow-human-input"
import { pruneExpiredWorkflowWaitEvents } from "@/lib/db/workflow-waitpoints"
import { pruneWorkflowKnowledgeArtifacts } from "@/lib/workflow/knowledge/artifacts"
import { pruneExpiredWorkflowFeedback } from "@/lib/workflow/quality/quality-service"
import { pruneExpiredWorkflowBatches } from "./batch-service"

/** Runs every row-expiry policy owned by the published Workflow App surface. */
export async function pruneExpiredWorkflowAppData(now = Date.now()): Promise<number> {
  const removed = await Promise.all([
    pruneExpiredWorkflowConversations(now),
    pruneExpiredWorkflowBatches(now),
    pruneExpiredHumanInputFiles(now),
    pruneExpiredHumanInputSensitiveValues(now),
    pruneExpiredWorkflowWaitEvents(now),
    pruneWorkflowKnowledgeArtifacts(now),
    pruneExpiredWorkflowFeedback(now),
    pruneExpiredSharedLinks(now),
  ])
  return removed.reduce((total, count) => total + count, 0)
}
