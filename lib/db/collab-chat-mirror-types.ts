import type {
  ApprovalRequest,
  SessionEvent,
  SessionInvite,
  SessionMembership,
  SharedSession,
} from "@cognia/agent-config-types"

export interface CollabChatSessionMirrorRow extends SharedSession {
  fetchedAt: number
}

export interface CollabChatMembershipMirrorRow extends SessionMembership {
  orgId: string
  fetchedAt: number
}

export interface CollabChatEventMirrorRow extends SessionEvent {
  orgId: string
  fetchedAt: number
}

export interface CollabChatInviteMirrorRow extends SessionInvite {
  orgId: string
  fetchedAt: number
}

export interface CollabChatApprovalMirrorRow extends ApprovalRequest {
  orgId: string
  fetchedAt: number
}

export interface CollabChatSyncStateRow {
  sessionId: string
  orgId: string
  lastSequence: number
  policyRevision: number
  connected: boolean
  lastError?: string
  updatedAt: number
}
