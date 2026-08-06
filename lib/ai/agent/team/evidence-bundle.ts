import {
  listAgentTeamEvidence,
  putAgentTeamContent,
  putAgentTeamEvidence,
} from "@/lib/db/agent-team-runtime"
import type {
  AgentTeamEvidence,
  AgentTeamEvidenceKind,
  AgentTeamEvidencePolicy,
} from "@/types/agent/agent-team-runtime"

export interface EvidenceBundleOptions {
  runId: string
  taskId: string
  childRunId?: string
  policy?: Partial<AgentTeamEvidencePolicy>
  now?: () => number
}

const DEFAULT_POLICY: AgentTeamEvidencePolicy = {
  requireActivity: true,
  requireOutcome: true,
  requireCodeDiff: true,
  requireVerification: true,
  requireVisualForUi: true,
}

function id(): string {
  return `team-evidence-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

export function createEvidenceBundle(options: EvidenceBundleOptions) {
  const now = options.now ?? Date.now
  const policy = { ...DEFAULT_POLICY, ...options.policy }

  return {
    async record(input: {
      kind: AgentTeamEvidenceKind
      title: string
      content?: string | Uint8Array
      mimeType?: string
      url?: string
      metadata?: Record<string, unknown>
    }): Promise<AgentTeamEvidence> {
      const createdAt = now()
      const object =
        input.content !== undefined
          ? await putAgentTeamContent(input.content, input.mimeType ?? "text/plain", createdAt)
          : undefined
      const evidence: AgentTeamEvidence = {
        id: id(),
        runId: options.runId,
        ...(options.childRunId ? { childRunId: options.childRunId } : {}),
        taskId: options.taskId,
        kind: input.kind,
        title: input.title,
        ...(object ? { contentHash: object.hash } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        createdAt,
      }
      await putAgentTeamEvidence(evidence)
      return evidence
    },

    async validate(input: {
      taskKind: "general" | "code" | "ui"
      visualSupported: boolean
    }): Promise<{ complete: boolean; missing: string[] }> {
      const evidence = (await listAgentTeamEvidence(options.runId)).filter(
        (item) => item.taskId === options.taskId
      )
      const kinds = new Set(evidence.map((item) => item.kind))
      const missing: string[] = []
      if (policy.requireActivity && !kinds.has("activity")) missing.push("activity")
      if (policy.requireOutcome && !kinds.has("outcome")) missing.push("outcome")
      if (input.taskKind === "code" || input.taskKind === "ui") {
        if (policy.requireCodeDiff && !kinds.has("diff") && !kinds.has("commit")) {
          missing.push("code_diff")
        }
        if (policy.requireVerification && !kinds.has("test") && !kinds.has("ci")) {
          missing.push("verification")
        }
      }
      if (
        input.taskKind === "ui" &&
        input.visualSupported &&
        policy.requireVisualForUi &&
        !kinds.has("screenshot") &&
        !kinds.has("recording")
      ) {
        missing.push("visual")
      }
      return { complete: missing.length === 0, missing }
    },
  }
}

export type EvidenceBundle = ReturnType<typeof createEvidenceBundle>
