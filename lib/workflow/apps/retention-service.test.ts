jest.mock("@/lib/db/shared-links", () => ({ pruneExpiredSharedLinks: jest.fn() }))
jest.mock("@/lib/db/workflow-conversations", () => ({
  pruneExpiredWorkflowConversations: jest.fn(),
}))
jest.mock("@/lib/db/workflow-human-input-files", () => ({
  pruneExpiredHumanInputFiles: jest.fn(),
}))
jest.mock("@/lib/db/workflow-human-input", () => ({
  pruneExpiredHumanInputSensitiveValues: jest.fn(),
}))
jest.mock("@/lib/db/workflow-waitpoints", () => ({
  pruneExpiredWorkflowWaitEvents: jest.fn(),
}))
jest.mock("@/lib/workflow/knowledge/artifacts", () => ({
  pruneWorkflowKnowledgeArtifacts: jest.fn(),
}))
jest.mock("@/lib/workflow/quality/quality-service", () => ({
  pruneExpiredWorkflowFeedback: jest.fn(),
}))
jest.mock("./batch-service", () => ({ pruneExpiredWorkflowBatches: jest.fn() }))

import { pruneExpiredSharedLinks } from "@/lib/db/shared-links"
import { pruneExpiredWorkflowConversations } from "@/lib/db/workflow-conversations"
import { pruneExpiredHumanInputFiles } from "@/lib/db/workflow-human-input-files"
import { pruneExpiredHumanInputSensitiveValues } from "@/lib/db/workflow-human-input"
import { pruneExpiredWorkflowWaitEvents } from "@/lib/db/workflow-waitpoints"
import { pruneWorkflowKnowledgeArtifacts } from "@/lib/workflow/knowledge/artifacts"
import { pruneExpiredWorkflowFeedback } from "@/lib/workflow/quality/quality-service"
import { pruneExpiredWorkflowBatches } from "./batch-service"
import { pruneExpiredWorkflowAppData } from "./retention-service"

it("runs every independent Workflow App expiry policy at the same cutoff", async () => {
  const pruners = [
    pruneExpiredWorkflowConversations,
    pruneExpiredWorkflowBatches,
    pruneExpiredHumanInputFiles,
    pruneExpiredHumanInputSensitiveValues,
    pruneExpiredWorkflowWaitEvents,
    pruneWorkflowKnowledgeArtifacts,
    pruneExpiredWorkflowFeedback,
    pruneExpiredSharedLinks,
  ]
  pruners.forEach((pruner, index) => jest.mocked(pruner).mockResolvedValue(index + 1))

  await expect(pruneExpiredWorkflowAppData(42_000)).resolves.toBe(36)
  for (const pruner of pruners) expect(pruner).toHaveBeenCalledWith(42_000)
})
