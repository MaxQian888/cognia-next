import { getDb } from "@/lib/db/schema"
import {
  decryptContentEnvelope,
  encryptContentEnvelope,
  type CompactionCheckpointV1,
} from "@cognia/rag"

const REINJECTION_ORDER = [
  "policy",
  "verified_instruction",
  "working_set",
  "selected_skill",
  "memory",
  "rag",
] as const

export interface CheckpointCrypto {
  profileId: string
  sessionId: string
  keyId: string
  key: CryptoKey
}

function aad(input: Pick<CheckpointCrypto, "profileId" | "sessionId">, checkpointId: string) {
  return `compaction-checkpoint-v1:${input.profileId}:${input.sessionId}:${checkpointId}`
}

export function orderCheckpointReinjection(
  checkpoint: CompactionCheckpointV1
): CompactionCheckpointV1["reinjection"] {
  const order = new Map<string, number>(REINJECTION_ORDER.map((kind, index) => [kind, index]))
  return [...checkpoint.reinjection].sort(
    (left, right) =>
      (order.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.kind) ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id) ||
      left.version.localeCompare(right.version)
  )
}

function validateCheckpoint(checkpoint: CompactionCheckpointV1): void {
  if (checkpoint.schemaVersion !== 1 || !checkpoint.id || !checkpoint.goal.trim()) {
    throw new Error("A versioned checkpoint id and goal are required")
  }
  if (
    !Number.isInteger(checkpoint.tokensBefore) ||
    !Number.isInteger(checkpoint.tokensAfter) ||
    checkpoint.tokensBefore < checkpoint.tokensAfter ||
    checkpoint.tokensAfter < 0
  ) {
    throw new Error("Checkpoint token counts are invalid")
  }
  const refs = new Set<string>()
  for (const item of checkpoint.reinjection) {
    const key = `${item.kind}:${item.id}`
    if (!item.kind || !item.id || !item.version || refs.has(key)) {
      throw new Error("Checkpoint reinjection references must be unique and versioned")
    }
    refs.add(key)
  }
}

export async function storeCompactionCheckpoint(
  checkpoint: CompactionCheckpointV1,
  cryptoInput: CheckpointCrypto
): Promise<void> {
  validateCheckpoint(checkpoint)
  const envelope = await encryptContentEnvelope(JSON.stringify(checkpoint), {
    key: cryptoInput.key,
    keyId: cryptoInput.keyId,
    additionalData: aad(cryptoInput, checkpoint.id),
  })
  await getDb().retrievalEncryptedContent.put({
    id: `compaction-checkpoint:${checkpoint.id}`,
    entityType: "compaction_checkpoint",
    entityId: checkpoint.id,
    corpusId: `session:${cryptoInput.sessionId}`,
    kind: "canonical",
    envelope,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.createdAt,
  })
}

export async function loadCompactionCheckpoint(
  checkpointId: string,
  cryptoInput: CheckpointCrypto
): Promise<CompactionCheckpointV1 | undefined> {
  const row = await getDb().retrievalEncryptedContent.get(`compaction-checkpoint:${checkpointId}`)
  if (!row) return undefined
  const plainText = await decryptContentEnvelope(row.envelope, {
    key: cryptoInput.key,
    additionalData: aad(cryptoInput, checkpointId),
  })
  const checkpoint = JSON.parse(plainText) as CompactionCheckpointV1
  validateCheckpoint(checkpoint)
  return { ...checkpoint, reinjection: orderCheckpointReinjection(checkpoint) }
}

/** Deterministic post-compaction state block; input is already encrypted-at-rest and PII-safe. */
export function renderCompactionCheckpointForRecovery(checkpoint: CompactionCheckpointV1): string {
  const lines = [
    `Compaction checkpoint ${checkpoint.id} (version ${checkpoint.schemaVersion}):`,
    `Goal: ${checkpoint.goal}`,
  ]
  const append = (label: string, values: string[]) => {
    if (values.length > 0) lines.push(`${label}:`, ...values.map((value) => `- ${value}`))
  }
  append("Completed work", checkpoint.completedWork)
  append("Active state", checkpoint.activeState)
  append(
    "Decisions",
    checkpoint.decisions.map((item) => `${item.decision} — ${item.rationale}`)
  )
  append("Evidence", checkpoint.evidenceRefs)
  append("Blockers", checkpoint.blockers)
  append("Next steps", checkpoint.nextSteps)
  append("Constraints", checkpoint.constraints)
  append("Do not repeat", checkpoint.doNotRepeat)
  append(
    "Reinjection versions",
    orderCheckpointReinjection(checkpoint).map((item) => `${item.kind}:${item.id}@${item.version}`)
  )
  lines.push(`Token transition: ${checkpoint.tokensBefore} -> ${checkpoint.tokensAfter}`)
  return lines.join("\n")
}
