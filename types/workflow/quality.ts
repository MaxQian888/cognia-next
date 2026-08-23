import type { EncryptedContentEnvelopeV1 } from "@cognia/rag"

export type WorkflowFeedbackRating = "like" | "dislike"
export type WorkflowFeedbackStatus = "candidate" | "confirmed" | "rejected" | "promoted"

export interface WorkflowFeedbackPayload {
  input: string
  output: string
  correction?: string
  tags: string[]
}

export interface WorkflowFeedbackCandidate {
  id: string
  accountId: string
  appId: string
  appReleaseId: string
  runId?: string
  conversationId?: string
  messageId?: string
  externalSubjectKey: string
  rating: WorkflowFeedbackRating
  status: WorkflowFeedbackStatus
  fingerprint: string
  envelope: EncryptedContentEnvelopeV1
  createdAt: number
  updatedAt: number
  expiresAt: number
  reviewedBy?: string
  reviewReason?: string
  promotedDatasetId?: string
  promotedCaseId?: string
}

export interface WorkflowAnnotationEntry {
  id: string
  question: string
  answer: string
  tags: string[]
  sourceFeedbackId?: string
  vector: number[]
}

export interface WorkflowAnnotationSet {
  id: string
  accountId: string
  appId: string
  name: string
  currentRevisionId?: string
  createdAt: number
  updatedAt: number
  createdBy: string
}

export interface WorkflowAnnotationSetRevision {
  id: string
  accountId: string
  appId: string
  setId: string
  sequence: number
  digest: string
  entryCount: number
  dimensions: number
  embeddingProfileId: string
  embeddingProvider: string
  embeddingModel: string
  vectorBackend: "native" | "qdrant" | "pinecone" | "weaviate" | "milvus" | "chroma"
  validation: {
    valid: boolean
    errors: string[]
    validatedAt: number
  }
  envelope: EncryptedContentEnvelopeV1
  createdAt: number
  createdBy: string
}

export interface WorkflowAnnotationMatch {
  revisionId: string
  setId: string
  entryId: string
  answer: string
  tags: string[]
  score: number
}
