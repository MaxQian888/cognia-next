import { hasNoLeakingPii, redactText } from "@cognia/redact"
import {
  listAgentTeamTrajectory,
  putAgentTeamContent,
  putAgentTeamRetrospective,
} from "@/lib/db/agent-team-runtime"
import { getDb } from "@/lib/db/schema"
import type {
  AgentTeamLearningKind,
  AgentTeamLearningProposal,
  AgentTeamRetrospective,
} from "@/types/agent/agent-team-runtime"

export interface RetrospectiveModelResult {
  issueTimeline: AgentTeamRetrospective["issueTimeline"]
  proposals: Array<{
    kind: AgentTeamLearningKind
    title: string
    before?: string
    after: string
  }>
}

export interface RetrospectiveServiceOptions {
  runModel(prompt: string): Promise<RetrospectiveModelResult>
  now?: () => number
}

function id(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function modelPrompt(raw: string): string {
  const redacted = redactText(raw).redacted
  if (!hasNoLeakingPii(redacted)) {
    throw new Error("AgentTeam retrospective still contains PII after redaction")
  }
  return [
    "Analyze this local AgentTeam trajectory.",
    "Return an issue timeline and approval-required learning proposals.",
    "Do not claim that any proposal was applied.",
    redacted,
  ].join("\n\n")
}

export function createRetrospectiveService(options: RetrospectiveServiceOptions) {
  const now = options.now ?? Date.now

  return {
    async generate(runId: string): Promise<AgentTeamRetrospective> {
      const trajectory = await listAgentTeamTrajectory(runId)
      const result = await options.runModel(modelPrompt(JSON.stringify(trajectory)))
      const createdAt = now()
      const proposals: AgentTeamLearningProposal[] = result.proposals.map((proposal) => ({
        id: id("team-learning"),
        ...proposal,
        status: "pending",
      }))
      const stored = await putAgentTeamContent(
        JSON.stringify({ issueTimeline: result.issueTimeline, proposals }),
        "application/json",
        createdAt
      )
      const retrospective: AgentTeamRetrospective = {
        id: id("team-retrospective"),
        runId,
        status: "pending_approval",
        issueTimeline: result.issueTimeline,
        proposals,
        contentHash: stored.hash,
        createdAt,
        updatedAt: createdAt,
      }
      await putAgentTeamRetrospective(retrospective)
      return retrospective
    },

    async resolveProposal(
      retrospectiveId: string,
      proposalId: string,
      status: "approved" | "rejected",
      apply: (proposal: AgentTeamLearningProposal) => Promise<void>
    ): Promise<AgentTeamRetrospective> {
      const db = getDb()
      const retrospective = await db.agentTeamRetrospectives.get(retrospectiveId)
      if (!retrospective) throw new Error(`Unknown AgentTeam retrospective: ${retrospectiveId}`)
      const proposal = retrospective.proposals.find((candidate) => candidate.id === proposalId)
      if (!proposal || proposal.status !== "pending") {
        throw new Error("Learning proposal is not pending")
      }
      if (status === "approved") {
        // Applying is intentionally outside the database mutation: a failed
        // adapter leaves the proposal pending and therefore safe to retry.
        await apply({ ...proposal, status: "approved" })
      }
      const resolvedAt = now()
      const proposals = retrospective.proposals.map((candidate) =>
        candidate.id === proposalId ? { ...candidate, status, resolvedAt } : candidate
      )
      const allResolved = proposals.every((candidate) => candidate.status !== "pending")
      const next: AgentTeamRetrospective = {
        ...retrospective,
        proposals,
        status: allResolved
          ? proposals.some((candidate) => candidate.status === "approved")
            ? "applied"
            : "rejected"
          : "pending_approval",
        updatedAt: resolvedAt,
      }
      await db.agentTeamRetrospectives.put(next)
      return next
    },
  }
}

/** Generate a terminal retrospective with the configured renderer utility model. */
export async function generateConfiguredRetrospective(
  runId: string
): Promise<AgentTeamRetrospective> {
  const [{ buildUtilityLlmClient }, { useSettingsStore }, { extractJson }] = await Promise.all([
    import("@/lib/ai/generation/utility-client"),
    import("@/stores/settings"),
    import("@/lib/twin/distill/llm"),
  ])
  const client = buildUtilityLlmClient({
    session: null,
    appSettings: useSettingsStore.getState().settings,
    featureId: "agent-team-retrospective",
  })
  const service = createRetrospectiveService({
    runModel: async (prompt) => {
      if (!client) {
        return {
          issueTimeline: [],
          proposals: [
            {
              kind: "environment",
              title: "Configure a utility model for retrospective analysis",
              after: JSON.stringify({ actions: [] }),
            },
          ],
        }
      }
      const response = await client.complete(prompt, {
        system:
          "Return JSON only: {issueTimeline:[{at,summary,childRunId?}],proposals:[{kind,title,before?,after}]}. " +
          "Allowed proposal kinds: prompt, environment, memory_useful, memory_misleading, decomposition.",
        temperature: 0.1,
        maxTokens: 1600,
      })
      return extractJson<RetrospectiveModelResult>(response)
    },
  })
  return service.generate(runId)
}

export type RetrospectiveService = ReturnType<typeof createRetrospectiveService>
