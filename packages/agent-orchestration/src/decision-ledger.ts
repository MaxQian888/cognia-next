/**
 * The decision ledger of a durable team run (ADR-0217): user constraints,
 * evidence-backed proposals with conflict classification, and lead-only
 * acceptance that advances the run's decision version in the same atomic
 * unit. Teammates read accepted decisions through `context()`.
 */

import type { AgentTeamDecision } from "./records"
import { sortDecisions } from "./rules"
import type { TeamRunStore } from "./store"

export interface DecisionLedgerOptions<TConstraints = unknown> {
  store: TeamRunStore<TConstraints>
  runId: string
  leadId: string
  now?: () => number
}

function id(): string {
  return `team-decision-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

export function createDecisionLedger<TConstraints>(options: DecisionLedgerOptions<TConstraints>) {
  const { store } = options
  const now = options.now ?? Date.now

  const requireRun = async () => {
    const run = await store.getRun(options.runId)
    if (!run) throw new Error(`Unknown durable AgentTeam run: ${options.runId}`)
    return run
  }

  const addUserConstraint = async (input: {
    title: string
    detail: string
  }): Promise<AgentTeamDecision> => {
    const run = await requireRun()
    const decision: AgentTeamDecision = {
      id: id(),
      runId: options.runId,
      version: run.decisionVersion,
      status: "constraint",
      title: input.title,
      detail: input.detail,
      authorId: "user",
      evidenceIds: [],
      immutable: true,
      createdAt: now(),
    }
    await store.putDecision(decision)
    return decision
  }

  const propose = async (input: {
    authorId: string
    title: string
    detail: string
    evidenceIds: string[]
    impacts?: AgentTeamDecision["impacts"]
    compatibilityScopes?: string[]
  }): Promise<AgentTeamDecision> => {
    const run = await requireRun()
    if (input.evidenceIds.length === 0) {
      throw new Error("Decision proposals require durable evidence")
    }
    const evidence = await store.getEvidence(input.evidenceIds)
    if (
      evidence.some((item) => !item || item.runId !== options.runId) ||
      new Set(input.evidenceIds).size !== input.evidenceIds.length
    ) {
      throw new Error("Decision proposal evidence must exist in the same durable run")
    }
    const at = now()
    const baseDecision: AgentTeamDecision = {
      id: id(),
      runId: options.runId,
      version: run.decisionVersion + 1,
      status: "proposed",
      title: input.title,
      detail: input.detail,
      authorId: input.authorId,
      evidenceIds: input.evidenceIds,
      ...(input.impacts ? { impacts: input.impacts } : {}),
      ...(input.compatibilityScopes ? { compatibilityScopes: input.compatibilityScopes } : {}),
      immutable: false,
      createdAt: at,
    }
    const accepted = (await store.listDecisions(options.runId)).filter(
      (item) => item.status === "constraint" || item.status === "accepted"
    )
    const classifications = accepted.map((item) => ({
      decisionId: item.id,
      ...classifyDecisionConflict(baseDecision, item),
    }))
    const escalations = classifications.filter((item) => item.resolution === "escalate")
    const mechanical = classifications.filter((item) => item.resolution === "mechanical")
    const selected = escalations[0] ?? mechanical[0]
    const decision: AgentTeamDecision = selected
      ? {
          ...baseDecision,
          conflict: {
            resolution: selected.resolution,
            reason: selected.reason,
            withDecisionIds: classifications
              .filter((item) => item.resolution === selected.resolution)
              .map((item) => item.decisionId),
          },
        }
      : baseDecision
    await store.putDecision(decision)
    await store.appendTrajectory({
      runId: options.runId,
      kind: "decision_proposed",
      correlationId: decision.id,
      payload: {
        authorId: input.authorId,
        evidenceIds: input.evidenceIds,
        ...(decision.conflict ? { conflict: decision.conflict } : {}),
      },
      createdAt: at,
    })
    return decision
  }

  const resolve = async (
    decisionId: string,
    actorId: string,
    status: "accepted" | "rejected"
  ): Promise<AgentTeamDecision> => {
    if (actorId !== options.leadId)
      throw new Error("Only the team lead may accept or reject decisions")
    const at = now()
    const resolved = await store.atomically(async (tx) => {
      const run = await tx.getRun(options.runId)
      if (!run) throw new Error(`Unknown durable AgentTeam run: ${options.runId}`)
      const proposal = await tx.getDecision(decisionId)
      if (!proposal || proposal.runId !== options.runId || proposal.status !== "proposed") {
        throw new Error("Decision proposal is not pending for this run")
      }
      const version = status === "accepted" ? run.decisionVersion + 1 : proposal.version
      const next: AgentTeamDecision = {
        ...proposal,
        status,
        version,
        immutable: true,
        resolvedAt: at,
      }
      await tx.putDecision(next)
      if (status === "accepted") {
        await tx.updateRun(run.id, { decisionVersion: version, updatedAt: at })
      }
      return next
    })
    if (status === "accepted") {
      await store.appendTrajectory({
        runId: options.runId,
        kind: "decision_accepted",
        correlationId: resolved.id,
        payload: { version: resolved.version, actorId },
        createdAt: at,
      })
    }
    return resolved
  }

  const context = async (): Promise<string> => {
    const decisions = (await store.listDecisions(options.runId)).filter(
      (decision) => decision.status === "constraint" || decision.status === "accepted"
    )
    return sortDecisions(decisions)
      .map(
        (decision) =>
          `[${decision.status === "constraint" ? "USER CONSTRAINT" : `DECISION v${decision.version}`}] ${decision.title}\n${decision.detail}`
      )
      .join("\n\n")
  }

  return {
    addUserConstraint,
    propose,
    accept: (decisionId: string, actorId: string) => resolve(decisionId, actorId, "accepted"),
    reject: (decisionId: string, actorId: string) => resolve(decisionId, actorId, "rejected"),
    context,
  }
}

export function classifyDecisionConflict(
  left: AgentTeamDecision,
  right: AgentTeamDecision
): { resolution: "compatible" | "mechanical" | "escalate"; reason: string } {
  if (left.detail === right.detail) {
    return { resolution: "mechanical", reason: "identical_change" }
  }
  const highRisk = new Set(["public_api", "migration", "security", "user_constraint"])
  if (
    left.status === "constraint" ||
    right.status === "constraint" ||
    left.impacts?.some((impact) => highRisk.has(impact)) ||
    right.impacts?.some((impact) => highRisk.has(impact))
  ) {
    return { resolution: "escalate", reason: "high_risk_semantic_conflict" }
  }
  const leftScopes = new Set(left.compatibilityScopes ?? [])
  const overlaps = (right.compatibilityScopes ?? []).some((scope) => leftScopes.has(scope))
  return overlaps
    ? { resolution: "escalate", reason: "unresolved_scope_overlap" }
    : { resolution: "compatible", reason: "disjoint_scopes" }
}

export type DecisionLedger = ReturnType<typeof createDecisionLedger>
