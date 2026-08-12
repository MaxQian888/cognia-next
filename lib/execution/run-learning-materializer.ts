import {
  GOVERNANCE_CONTRACT_VERSION,
  type ResourceRefV1,
} from "@cognia/agent-config-types/governance"
import { redactText } from "@cognia/redact"

import {
  appendDecisionEvent,
  governanceRefKey,
  recordDecision,
  recordLineageEdge,
} from "@/lib/db/governance-ledger"
import { getExecutionRun } from "@/lib/db/execution-runs"
import {
  getRunRetrospectiveBundle,
  transitionRunLearningProposal,
} from "@/lib/db/run-retrospectives"
import { getDb } from "@/lib/db/schema"
import type { RunLearningProposal } from "@/types/execution/retrospective"

export interface RunLearningApplyContext {
  apply(proposal: RunLearningProposal): Promise<ResourceRefV1>
  now?: () => number
}

function proposalRef(proposal: RunLearningProposal): ResourceRefV1 {
  return { namespace: "cognia", type: "run-learning-proposal", id: proposal.id }
}

async function recordApproval(
  proposal: RunLearningProposal,
  outcome: "approved" | "rejected",
  at: number
): Promise<void> {
  const bundle = await getRunRetrospectiveBundle(proposal.retrospectiveId)
  const decisionId = `run-learning:${proposal.id}`
  await recordDecision({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: decisionId,
    mode: "control",
    kind: "human-approval",
    subjectRef: proposalRef(proposal),
    question: { code: "run-learning.apply" },
    basis: {
      evidenceRefs: [
        ...proposal.evidenceRefs.map(governanceRefKey),
        ...(bundle ? [`sha256:${bundle.retrospective.contentHash}`] : []),
      ],
      policyRefs: [],
      parentDecisionRefs: [],
    },
    lifecycle: { state: "proposed", proposedAt: at, recordedAt: at },
    correlation: { runId: proposal.runId },
    privacy: {
      classification: "internal",
      retentionClass: "governance",
      contentCaptured: false,
      removedFields: ["title", "before", "after"],
    },
  })
  await appendDecisionEvent({
    id: `${decisionId}:resolved:${outcome}`,
    decisionId,
    type: "resolved",
    at,
    outcome,
    reasonCode: `user_${outcome}`,
    correlation: { runId: proposal.runId },
  })
}

async function recordEffect(proposal: RunLearningProposal, effectRef: ResourceRefV1, at: number) {
  const decisionId = `run-learning:${proposal.id}`
  await appendDecisionEvent({
    id: `${decisionId}:executed`,
    decisionId,
    type: "executed",
    at,
    effectRef,
    correlation: { runId: proposal.runId },
  })
  await recordLineageEdge({
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    id: `run-learning-effect:${proposal.id}`,
    from: proposalRef(proposal),
    to: effectRef,
    relation: "resulted-in",
    assertion: "explicit",
    recordedAt: at,
  })
}

async function recordApplyFailure(proposal: RunLearningProposal, at: number): Promise<void> {
  await appendDecisionEvent({
    id: `run-learning:${proposal.id}:failed:${at}`,
    decisionId: `run-learning:${proposal.id}`,
    type: "failed",
    at,
    reasonCode: "materialization_failed",
    correlation: { runId: proposal.runId },
  })
}

async function getProposal(proposalId: string): Promise<RunLearningProposal> {
  const proposal = await getDb().runLearningProposals.get(proposalId)
  if (!proposal) throw new Error(`Unknown run learning proposal: ${proposalId}`)
  return proposal
}

async function materialize(
  proposal: RunLearningProposal,
  context: RunLearningApplyContext
): Promise<RunLearningProposal> {
  if (proposal.status === "applied" || proposal.status === "rejected") return proposal
  const now = context.now ?? Date.now
  try {
    const effectRef = await context.apply(proposal)
    const at = now()
    await recordEffect(proposal, effectRef, at)
    return transitionRunLearningProposal(
      proposal.id,
      ["approved_pending_apply", "apply_failed"],
      { status: "applied", effectRef, applyError: undefined, resolvedAt: at },
      at
    )
  } catch (error) {
    const at = now()
    const applyError = redactText(error instanceof Error ? error.message : String(error)).redacted
    await recordApplyFailure(proposal, at)
    return transitionRunLearningProposal(
      proposal.id,
      ["approved_pending_apply", "apply_failed"],
      { status: "apply_failed", applyError },
      at
    )
  }
}

export async function approveRunLearningProposal(
  proposalId: string,
  context?: RunLearningApplyContext
): Promise<RunLearningProposal> {
  const current = await getProposal(proposalId)
  if (current.status === "applied" || current.status === "rejected") return current
  if (current.targetKind === "observation") {
    throw new Error("Observation proposals cannot be applied")
  }
  if (current.status === "apply_failed") {
    return retryRunLearningProposal(proposalId, context)
  }
  if (current.status !== "pending" && current.status !== "approved_pending_apply") {
    throw new Error(`Run learning proposal is ${current.status}`)
  }
  const resolvedContext = context ?? { apply: applyRunLearningProposalEffect }
  if (current.status === "pending") {
    const at = (resolvedContext.now ?? Date.now)()
    await recordApproval(current, "approved", at)
    await transitionRunLearningProposal(
      current.id,
      ["pending"],
      { status: "approved_pending_apply" },
      at
    )
  }
  return materialize(await getProposal(proposalId), resolvedContext)
}

export async function retryRunLearningProposal(
  proposalId: string,
  context?: RunLearningApplyContext
): Promise<RunLearningProposal> {
  const current = await getProposal(proposalId)
  if (current.status === "applied") return current
  if (current.status !== "apply_failed" && current.status !== "approved_pending_apply") {
    throw new Error(`Run learning proposal is ${current.status}`)
  }
  const resolvedContext = context ?? { apply: applyRunLearningProposalEffect }
  if (current.status === "apply_failed") {
    await transitionRunLearningProposal(
      current.id,
      ["apply_failed"],
      { status: "approved_pending_apply", applyError: undefined },
      (resolvedContext.now ?? Date.now)()
    )
  }
  return materialize(await getProposal(proposalId), resolvedContext)
}

export async function rejectRunLearningProposal(
  proposalId: string,
  at = Date.now()
): Promise<RunLearningProposal> {
  const current = await getProposal(proposalId)
  if (current.status === "rejected") return current
  if (current.status !== "pending") throw new Error(`Run learning proposal is ${current.status}`)
  await recordApproval(current, "rejected", at)
  return transitionRunLearningProposal(
    proposalId,
    ["pending"],
    { status: "rejected", resolvedAt: at },
    at
  )
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`${label} must be a JSON object`)
  }
}

/** Default materializer adapters; each effect probes a proposal-derived key. */
export async function applyRunLearningProposalEffect(
  proposal: RunLearningProposal
): Promise<ResourceRefV1> {
  if (proposal.targetKind === "team-config") {
    if (!proposal.targetId) throw new Error("Team config proposal requires targetId")
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const store = useAgentTeamStore.getState()
    const team = store.teams[proposal.targetId]
    if (!team) throw new Error(`Unknown AgentTeam: ${proposal.targetId}`)
    let config: typeof team.config = { ...team.config, defaultSystemPrompt: proposal.after }
    try {
      const parsed = parseObject(proposal.after, "Team config proposal")
      config = { ...team.config, ...(parsed.config ?? parsed) } as typeof team.config
    } catch {
      // A plain string remains the existing defaultSystemPrompt update contract.
    }
    store.updateTeam(proposal.targetId, { config })
    return { namespace: "cognia", type: "agent-team", id: proposal.targetId }
  }

  if (proposal.targetKind === "project-environment") {
    if (!proposal.targetId) throw new Error("Environment proposal requires a version targetId")
    const { getProjectEnvironmentVersion, createProjectEnvironmentVersion } =
      await import("@/lib/db/project-environments")
    const current = await getProjectEnvironmentVersion(proposal.targetId)
    if (!current) throw new Error(`Unknown project environment version: ${proposal.targetId}`)
    const patch = parseObject(proposal.after, "Environment proposal")
    const version = await createProjectEnvironmentVersion(
      {
        id: current.environmentId,
        projectId: current.projectId,
        name: typeof patch.name === "string" ? patch.name : current.name,
        isEnabled: true,
        setupScript: (patch.setupScript ?? current.setupScript) as typeof current.setupScript,
        actions: (patch.actions ?? current.actions) as typeof current.actions,
        variables: (patch.variables ?? current.variables) as typeof current.variables,
        keyringReferences: (patch.keyringReferences ??
          current.keyringReferences) as typeof current.keyringReferences,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      },
      (patch.policy ?? current.policy) as typeof current.policy,
      Date.now(),
      proposal.id
    )
    return { namespace: "cognia", type: "project-environment-version", id: version.id }
  }

  if (proposal.targetKind === "memory-candidate") {
    const key = `run-learning:${proposal.id}`
    const existing = await getDb()
      .memories.filter((memory) => memory.key === key)
      .first()
    if (existing) return { namespace: "cognia", type: "memory", id: existing.id }
    const run = await getExecutionRun(proposal.runId)
    const { storeMemoryCore } = await import("@/lib/memory/api/store-memory")
    const result = await storeMemoryCore({
      text: proposal.after,
      scope: run?.projectId ? "workspace" : "global",
      ...(run?.projectId ? { projectId: run.projectId } : {}),
      type: "semantic",
      key,
      tags: ["run-retrospective", proposal.id],
      provenance: "explicit",
      piiGate: "redact",
      source: { sessionId: run?.sessionId },
    })
    if (!result.ok) throw new Error(`Memory materialization blocked: ${result.reason}`)
    const memory = result.memoryId
      ? await getDb().memories.get(result.memoryId)
      : await getDb()
          .memories.filter((row) => row.key === key)
          .first()
    return {
      namespace: "cognia",
      type: memory ? "memory" : "memory-candidate",
      id: memory?.id ?? proposal.id,
    }
  }

  if (proposal.targetKind === "skill-draft") {
    const { upsertSkillByCanonicalId } = await import("@/lib/db/skills")
    const { skill } = await upsertSkillByCanonicalId({
      canonicalId: `run-learning:${proposal.id}`,
      draft: {
        name: proposal.title,
        content: proposal.after,
        status: "disabled",
        source: "custom",
        category: "custom",
        tags: ["run-retrospective"],
      },
    })
    return { namespace: "cognia", type: "skill", id: skill.id }
  }

  throw new Error("Observation proposals cannot be materialized")
}
