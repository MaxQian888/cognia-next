import type { ChatSession, SendOptions } from "@cognia/agent-config-types"
import type { CompactionCheckpointV1 } from "@cognia/rag"
import type { UIMessage } from "ai"

import { getSession } from "@/lib/db/sessions"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { createProfileDekStore } from "@/lib/rag/profile-dek-store"
import { storeCompactionCheckpoint } from "@/lib/rag/compaction-checkpoint"
import type { Goal } from "@/types/goal"

export interface CompactionBoundaryMetadata {
  pre_tokens?: number
  post_tokens?: number
}

export interface CompactionCheckpointCaptureResult {
  checkpointId: string
  state: "stored" | "locked" | "failed"
}

interface CaptureDependencies {
  getSession: typeof getSession
  getActiveGoal: (sessionId: string) => Promise<Goal | undefined>
  getDek: ReturnType<typeof createProfileDekStore>["getOrCreate"]
  store: typeof storeCompactionCheckpoint
  now: () => number
}

const defaultDependencies: CaptureDependencies = {
  getSession,
  getActiveGoal: (sessionId) => getGoalRuntime().getActiveGoalForSession(sessionId),
  getDek: (profileId) => createProfileDekStore().getOrCreate(profileId),
  store: storeCompactionCheckpoint,
  now: Date.now,
}

function reinjectionRefs(
  session: ChatSession,
  options: SendOptions | undefined
): CompactionCheckpointV1["reinjection"] {
  const refs: CompactionCheckpointV1["reinjection"] = []
  for (const policy of options?.compactionCheckpointContext?.policyVersions ?? []) {
    refs.push({ kind: "policy", ...policy })
  }
  if (session.workingSet) {
    refs.push({
      kind: "working_set",
      id: session.id,
      version: String(session.workingSet.revision),
    })
  }
  for (const skill of options?.compactionCheckpointContext?.selectedSkills ?? []) {
    refs.push({ kind: "selected_skill", ...skill })
  }
  for (const memory of options?.memoryContext?.retrievedMemories ?? []) {
    refs.push({
      kind:
        memory.type === "procedural" && memory.reviewStatus === "verified"
          ? "verified_instruction"
          : "memory",
      id: memory.id,
      version: memory.evidenceState ?? "unknown",
    })
  }
  for (const item of options?.twinContext?.retrievedChunks ?? []) {
    refs.push({ kind: "rag", id: `twin:${item.chunk.id}`, version: item.chunk.vectorDocId })
  }
  for (const item of options?.projectKnowledgeContext?.retrievedChunks ?? []) {
    refs.push({ kind: "rag", id: `project:${item.fileId}`, version: "active-generation" })
  }
  for (const item of options?.agentKnowledgeContext?.retrievedChunks ?? []) {
    refs.push({ kind: "rag", id: `kb:${item.chunk.id}`, version: item.chunk.vectorDocId })
  }
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildCheckpoint(input: {
  boundaryId: string
  session: ChatSession
  goal?: Goal
  options?: SendOptions
  metadata: CompactionBoundaryMetadata
  now: number
}): CompactionCheckpointV1 {
  const workingSet = input.session.workingSet?.entries ?? []
  const completedWork = [
    ...(input.goal?.subgoals?.filter((item) => item.done).map((item) => item.text) ?? []),
    ...workingSet.filter((item) => item.status === "resolved").map((item) => item.summary),
  ]
  const active = workingSet.filter((item) => item.status === "active")
  const tokensBefore = Math.max(0, Math.trunc(input.metadata.pre_tokens ?? 0))
  const tokensAfter = Math.min(
    tokensBefore,
    Math.max(0, Math.trunc(input.metadata.post_tokens ?? 0))
  )
  return {
    schemaVersion: 1,
    id: input.boundaryId,
    createdAt: input.now,
    goal: input.goal?.safeObjective ?? "No active goal recorded",
    completedWork,
    activeState: active
      .filter((item) => item.kind !== "open-question" && item.kind !== "subtask")
      .map((item) => item.summary),
    decisions: active
      .filter((item) => item.kind === "decision")
      .map((item) => ({ decision: item.summary, rationale: "Working set decision" })),
    evidenceRefs: reinjectionRefs(input.session, input.options)
      .filter((item) => item.kind === "memory" || item.kind === "rag")
      .map((item) => `${item.kind}:${item.id}:${item.version}`),
    blockers: active.filter((item) => item.kind === "open-question").map((item) => item.summary),
    nextSteps: active.filter((item) => item.kind === "subtask").map((item) => item.summary),
    constraints: (input.options?.compactionCheckpointContext?.policyVersions ?? []).map(
      (item) => `${item.id}@${item.version}`
    ),
    doNotRepeat: completedWork,
    reinjection: reinjectionRefs(input.session, input.options),
    tokensBefore,
    tokensAfter,
  }
}

export async function captureCompactionCheckpoint(
  input: {
    boundaryId: string
    sessionId: string
    metadata: CompactionBoundaryMetadata
    options?: SendOptions
  },
  dependencies: CaptureDependencies = defaultDependencies
): Promise<CompactionCheckpointCaptureResult> {
  const session = await dependencies.getSession(input.sessionId)
  if (!session) return { checkpointId: input.boundaryId, state: "failed" }
  try {
    const [goal, dek] = await Promise.all([
      dependencies.getActiveGoal(input.sessionId),
      dependencies.getDek("chat-shared"),
    ])
    const checkpoint = buildCheckpoint({
      boundaryId: input.boundaryId,
      session,
      goal,
      options: input.options,
      metadata: input.metadata,
      now: dependencies.now(),
    })
    await dependencies.store(checkpoint, {
      profileId: dek.profileId,
      sessionId: input.sessionId,
      keyId: dek.keyId,
      key: dek.key,
    })
    return { checkpointId: checkpoint.id, state: "stored" }
  } catch (error) {
    const code = (error as { code?: string }).code
    return {
      checkpointId: input.boundaryId,
      state: code === "retrieval_vault_locked" ? "locked" : "failed",
    }
  }
}

export function attachCheckpointCapture(
  messages: UIMessage[],
  result: CompactionCheckpointCaptureResult
): UIMessage[] {
  const index = messages.findIndex((message) => message.id === result.checkpointId)
  if (index < 0) return messages
  const message = messages[index]
  const part = message.parts[0] as unknown as { type?: string }
  if (part?.type !== "compact-boundary") return messages
  const next = messages.slice()
  next[index] = {
    ...message,
    parts: [
      {
        ...part,
        checkpointId: result.checkpointId,
        checkpointState: result.state,
      } as unknown as UIMessage["parts"][number],
    ],
  }
  return next
}

export async function loadCapturedCompactionCheckpoint(
  checkpointId: string,
  sessionId: string
): Promise<CompactionCheckpointV1 | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  const row = await getDb().retrievalEncryptedContent.get(`compaction-checkpoint:${checkpointId}`)
  if (!row) return undefined
  const dek = await createProfileDekStore().load("chat-shared", row.envelope.keyId)
  if (!dek) return undefined
  const { loadCompactionCheckpoint } = await import("@/lib/rag/compaction-checkpoint")
  return loadCompactionCheckpoint(checkpointId, {
    profileId: dek.profileId,
    sessionId,
    keyId: dek.keyId,
    key: dek.key,
  })
}
