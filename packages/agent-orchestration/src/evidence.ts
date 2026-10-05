/**
 * The evidence bundle of one teammate attempt (ADR-0217): records activity,
 * outcome, diffs, verification and visuals with their content, and validates
 * the attempt against the team's evidence policy. Evidence whose content no
 * longer matches its hash does not count.
 */

import type { AgentTeamEvidence, AgentTeamEvidenceKind, AgentTeamEvidencePolicy } from "./records"
import type { TeamRunStore } from "./store"

export interface EvidenceBundleOptions<TConstraints = unknown> {
  store: TeamRunStore<TConstraints>
  runId: string
  taskId: string
  childRunId?: string
  attempt?: number
  revision?: string
  policy?: Partial<AgentTeamEvidencePolicy>
  now?: () => number
}

export const DEFAULT_EVIDENCE_POLICY: Readonly<AgentTeamEvidencePolicy> = Object.freeze({
  requireActivity: true,
  requireOutcome: true,
  requireCodeDiff: true,
  requireVerification: true,
  requireVisualForUi: true,
})

function id(): string {
  return `team-evidence-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

export function createEvidenceBundle<TConstraints>(options: EvidenceBundleOptions<TConstraints>) {
  const { store } = options
  const now = options.now ?? Date.now
  const policy = { ...DEFAULT_EVIDENCE_POLICY, ...options.policy }

  return {
    async record(input: {
      kind: AgentTeamEvidenceKind
      title: string
      content?: string | Uint8Array
      mimeType?: string
      url?: string
      metadata?: Record<string, unknown>
      status?: AgentTeamEvidence["status"]
      revision?: string
    }): Promise<AgentTeamEvidence> {
      const createdAt = now()
      const evidence: AgentTeamEvidence = {
        id: id(),
        runId: options.runId,
        ...(options.childRunId ? { childRunId: options.childRunId } : {}),
        taskId: options.taskId,
        ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
        ...((input.revision ?? options.revision)
          ? { revision: input.revision ?? options.revision }
          : {}),
        ...(input.status ? { status: input.status } : {}),
        kind: input.kind,
        title: input.title,
        ...(input.url ? { url: input.url } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        createdAt,
      }
      return store.putEvidence(
        evidence,
        input.content === undefined
          ? undefined
          : { data: input.content, mimeType: input.mimeType ?? "text/plain" }
      )
    },

    async validate(input: {
      taskKind: "general" | "code" | "ui"
      visualSupported: boolean
      revision?: string
      requireRevision?: boolean
    }): Promise<{ complete: boolean; missing: string[] }> {
      const candidates = await store.listEvidence(options.runId, {
        taskId: options.taskId,
        childRunId: options.childRunId,
        attempt: options.attempt,
      })
      const contentChecks = new Map<string, Promise<boolean>>()
      const validContent = (hash: string): Promise<boolean> => {
        let check = contentChecks.get(hash)
        if (!check) {
          check = store.getContent(hash).then((content) => content !== undefined)
          contentChecks.set(hash, check)
        }
        return check
      }
      const evidence = (
        await Promise.all(
          candidates.map(async (item) =>
            item.contentHash && !(await validContent(item.contentHash)) ? null : item
          )
        )
      ).filter((item): item is AgentTeamEvidence => item !== null)
      const revision = input.revision ?? options.revision
      const kinds = new Set(evidence.map((item) => item.kind))
      const current = evidence.filter((item) => !revision || item.revision === revision)
      const missing: string[] = []
      if (policy.requireActivity && !kinds.has("activity")) missing.push("activity")
      if (policy.requireOutcome && !kinds.has("outcome")) missing.push("outcome")
      if (input.taskKind === "code" || input.taskKind === "ui") {
        if (
          input.requireRevision &&
          (policy.requireCodeDiff || policy.requireVerification) &&
          !revision
        ) {
          missing.push("revision")
        }
        if (
          policy.requireCodeDiff &&
          !current.some((item) => item.kind === "diff" || item.kind === "commit")
        ) {
          missing.push("code_diff")
        }
        if (
          policy.requireVerification &&
          !current.some(
            (item) => (item.kind === "test" || item.kind === "ci") && item.status === "passed"
          )
        ) {
          missing.push("verification")
        }
      }
      if (
        input.taskKind === "ui" &&
        input.visualSupported &&
        policy.requireVisualForUi &&
        !current.some((item) => item.kind === "screenshot" || item.kind === "recording")
      ) {
        missing.push("visual")
      }
      return { complete: missing.length === 0, missing }
    },
  }
}

export type EvidenceBundle = ReturnType<typeof createEvidenceBundle>
