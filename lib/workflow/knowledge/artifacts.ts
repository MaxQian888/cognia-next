import {
  decryptContentEnvelope,
  encryptContentEnvelope,
  type EncryptedContentEnvelopeV1,
} from "@cognia/rag"
import { loadOrCreateAccountArtifactKey } from "@/lib/ai/eval/artifact-crypto"
import { getDb } from "@/lib/db/schema"
import type {
  WorkflowKnowledgeArtifactRef,
  WorkflowKnowledgeArtifactRow,
  WorkflowKnowledgeStage,
} from "@/types/workflow/knowledge-pipeline"

const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1_000
const KEY_ID = "workflow-knowledge-v1"

export interface WorkflowKnowledgeArtifactCryptoDeps {
  loadKey?: (accountId: string) => Promise<Uint8Array>
}

function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

async function key(accountId: string, usage: KeyUsage, deps: WorkflowKnowledgeArtifactCryptoDeps) {
  const raw = deps.loadKey
    ? await deps.loadKey(accountId)
    : await loadOrCreateAccountArtifactKey(accountId, "workflow-knowledge")
  return crypto.subtle.importKey("raw", bytes(raw), { name: "AES-GCM" }, false, [usage])
}

function aad(
  row: Pick<WorkflowKnowledgeArtifactRow, "id" | "accountId" | "runId" | "stepId" | "stage">
) {
  return `workflow-knowledge-v1:${row.accountId}:${row.runId}:${row.stepId}:${row.stage}:${row.id}`
}

export async function storeWorkflowKnowledgeArtifact(
  input: {
    accountId: string
    runId: string
    stepId: string
    stage: WorkflowKnowledgeStage
    value: unknown
    now?: number
  },
  deps: WorkflowKnowledgeArtifactCryptoDeps = {}
): Promise<WorkflowKnowledgeArtifactRef> {
  const id = `wfka_${crypto.randomUUID()}`
  const identity = { ...input, id }
  const envelope = await encryptContentEnvelope(JSON.stringify(input.value), {
    key: await key(input.accountId, "encrypt", deps),
    keyId: KEY_ID,
    additionalData: aad(identity),
  })
  const now = input.now ?? Date.now()
  await getDb().workflowKnowledgeArtifacts.add({
    id,
    accountId: input.accountId,
    runId: input.runId,
    stepId: input.stepId,
    stage: input.stage,
    envelope,
    createdAt: now,
    expiresAt: now + ARTIFACT_TTL_MS,
  })
  return { artifactId: id, stage: input.stage }
}

export async function openWorkflowKnowledgeArtifact<T>(
  input: {
    accountId: string
    runId: string
    artifactId: string
    expectedStage: WorkflowKnowledgeStage
    now?: number
  },
  deps: WorkflowKnowledgeArtifactCryptoDeps = {}
): Promise<T> {
  const row = await getDb().workflowKnowledgeArtifacts.get(input.artifactId)
  if (
    !row ||
    row.accountId !== input.accountId ||
    row.runId !== input.runId ||
    row.stage !== input.expectedStage ||
    row.expiresAt <= (input.now ?? Date.now())
  ) {
    throw new Error("Knowledge pipeline artifact was not found or has expired")
  }
  const plaintext = await decryptContentEnvelope(row.envelope as EncryptedContentEnvelopeV1, {
    key: await key(input.accountId, "decrypt", deps),
    additionalData: aad(row),
  })
  return JSON.parse(plaintext) as T
}

export async function pruneWorkflowKnowledgeArtifacts(now = Date.now()): Promise<number> {
  return getDb().workflowKnowledgeArtifacts.where("expiresAt").belowOrEqual(now).delete()
}
