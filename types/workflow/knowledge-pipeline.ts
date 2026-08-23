import type { EncryptedContentEnvelopeV1 } from "@cognia/rag"

export type WorkflowKnowledgeStage = "parsed" | "transformed" | "chunked" | "embedded" | "indexed"

/** Content-bearing stage state is encrypted and referenced from run outputs by id only. */
export interface WorkflowKnowledgeArtifactRow {
  id: string
  accountId: string
  runId: string
  stepId: string
  stage: WorkflowKnowledgeStage
  envelope: EncryptedContentEnvelopeV1
  createdAt: number
  expiresAt: number
}

export interface WorkflowKnowledgeArtifactRef {
  artifactId: string
  stage: WorkflowKnowledgeStage
}
