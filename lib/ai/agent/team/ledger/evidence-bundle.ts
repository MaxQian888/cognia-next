import {
  listAgentTeamEvidence,
  getAgentTeamContent,
  putAgentTeamEvidenceContent,
} from "@/lib/db/agent-team-runtime"
import type {
  AgentTeamEvidence,
  AgentTeamEvidenceKind,
  AgentTeamEvidencePolicy,
} from "@/types/agent/agent-team-runtime"
import type { ResourceChange } from "@/lib/task-workspace/types"
import { sha256Hex } from "@/lib/data/crypto"

/** Bind code evidence to captured source changes; generated rows carry metadata only. */
export async function workspaceEvidenceRevision(
  changes: readonly ResourceChange[]
): Promise<string | undefined> {
  const source = changes.filter((change) => change.captureClass !== "generated")
  if (
    source.length === 0 ||
    source.some((change) => change.kind !== "deleted" && !change.hash?.trim())
  )
    return undefined
  const resources = source
    .map((change) =>
      JSON.stringify({
        runId: change.runId,
        path: change.path,
        oldPath: change.oldPath,
        kind: change.kind,
        hash: change.hash,
        beforeHash: change.beforeHash,
        revision: change.revision,
        resourceKind: change.resourceKind,
        beforeMode: change.beforeMode,
        afterMode: change.afterMode,
      })
    )
    .sort()
  return `workspace:sha256:${await sha256Hex(JSON.stringify(resources))}`
}

export interface EvidenceBundleOptions {
  runId: string
  taskId: string
  childRunId?: string
  attempt?: number
  revision?: string
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
      return putAgentTeamEvidenceContent(evidence, input.content, input.mimeType)
    },

    async validate(input: {
      taskKind: "general" | "code" | "ui"
      visualSupported: boolean
      revision?: string
      requireRevision?: boolean
    }): Promise<{ complete: boolean; missing: string[] }> {
      const candidates = await listAgentTeamEvidence(options.runId, {
        taskId: options.taskId,
        childRunId: options.childRunId,
        attempt: options.attempt,
      })
      const contentChecks = new Map<string, Promise<boolean>>()
      const validContent = (hash: string): Promise<boolean> => {
        let check = contentChecks.get(hash)
        if (!check) {
          check = getAgentTeamContent(hash).then((content) => content !== undefined)
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
