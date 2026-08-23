import type { WorkflowAnswer } from "./answer"

export type WorkflowConversationOwner =
  | { kind: "member"; subjectId: string; externalSubjectKey: string }
  | { kind: "anonymous"; externalSubjectKey: string }

export interface WorkflowConversation {
  id: string
  accountId: string
  appId: string
  appReleaseId: string
  versionId: string
  owner: WorkflowConversationOwner
  status: "active" | "deleted"
  title?: string
  variables: Record<string, unknown>
  revision: number
  nextMessageSequence: number
  summaryRevision: number
  summarizedThroughSequence: number
  favorite: boolean
  createdAt: number
  updatedAt: number
  expiresAt?: number
  deletedAt?: number
  deletionRequestedAt?: number
}

export interface WorkflowConversationMessageContent {
  text?: string
  answer?: WorkflowAnswer
  data?: unknown
}

export interface WorkflowConversationMessage {
  id: string
  accountId: string
  conversationId: string
  sequence: number
  role: "user" | "assistant" | "system"
  content: WorkflowConversationMessageContent
  idempotencyKey?: string
  runId?: string
  createdAt: number
  expiresAt?: number
}

export interface WorkflowConversationSummary {
  id: string
  accountId: string
  conversationId: string
  revision: number
  throughSequence: number
  content: string
  model?: string
  createdAt: number
}

export interface WorkflowConversationReleaseEvent {
  id: string
  accountId: string
  conversationId: string
  fromReleaseId: string
  toReleaseId: string
  operatedBy: string
  reason: string
  at: number
}
