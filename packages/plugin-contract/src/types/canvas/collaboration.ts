/**
 * Canvas Collaboration Types — real-time editing, comments, sharing.
 * Direct port from D:\Project\Cognia\types\canvas\collaboration.ts.
 */

export interface LineRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface CursorPosition {
  line: number
  column: number
}

export interface Participant {
  id: string
  name: string
  email?: string
  avatarUrl?: string
  color: string
  cursor?: CursorPosition
  selection?: LineRange
  lastActive: Date
  isOnline: boolean
}

export interface CollaborativeSession {
  id: string
  documentId: string
  ownerId: string
  participants: Participant[]
  createdAt: Date
  updatedAt: Date
  isActive: boolean
  shareLink?: string
  permissions: SessionPermissions
}

export interface SessionPermissions {
  canEdit: boolean
  canComment: boolean
  canShare: boolean
  canExport: boolean
}

/**
 * A text range named by two Yjs relative positions, base64 for transport.
 *
 * Lives here rather than beside the encoder so the comment types can name it
 * without pulling `yjs` into a module that only describes shapes.
 */
export interface CanvasCrdtAnchor {
  anchor: string
  /** Named `head` to match the editor convention for the moving end. */
  head: string
}

export interface CanvasComment {
  id: string
  documentId: string
  authorId: string
  authorName: string
  authorAvatarUrl?: string
  range: LineRange
  content: string
  createdAt: Date
  updatedAt?: Date
  resolvedAt?: Date
  resolvedBy?: string
  reactions: CommentReaction[]
  parentId?: string
}

export interface CommentReaction {
  emoji: string
  users: string[]
}

export interface CommentThread {
  id: string
  rootComment: CanvasComment
  replies: CanvasComment[]
  isResolved: boolean
}

export interface RemoteCursor {
  participantId: string
  position: CursorPosition
  selection?: LineRange
  color: string
  name: string
}

export interface CollaborationUpdate {
  type: "cursor" | "selection" | "content" | "comment" | "participant"
  participantId: string
  timestamp: Date
  data: unknown
}

export interface ContentUpdate {
  type: "insert" | "delete" | "replace"
  position: number
  text?: string
  length?: number
  origin: string
}

export interface ShareOptions {
  expiresAt?: Date
  maxParticipants?: number
  requireAuth: boolean
  permissions: SessionPermissions
}

export interface CollaborationState {
  isConnected: boolean
  isConnecting: boolean
  connectionError?: string
  session?: CollaborativeSession
  localParticipant?: Participant
  remoteCursors: RemoteCursor[]
  pendingUpdates: CollaborationUpdate[]
}

export type CollaborationConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "reconnecting"
  | "error"
  | "degraded-local"
  | "ended"

export type CanvasCollaborationRecoveryState =
  "live" | "local-copy" | "snapshot-only" | "degraded-local"

/**
 * Snapshot of a collaboration session attached to a CanvasDocument.
 * cognia-next's slim artifact module drops the field on `CanvasDocument`,
 * but the panel + collab hook still need the shape — define it here.
 */
export interface CanvasCollaborationSessionState {
  sessionId: string | null
  documentId?: string | null
  connectionState: CollaborationConnectionState
  recoveryState: CanvasCollaborationRecoveryState
  recoveryReason?: string
  sharePayload?: string | null
  shareUrl?: string | null
  localParticipant?: Participant | null
  participants: Participant[]
  remoteCursors: RemoteCursor[]
  lastSyncedAt?: Date
  lastEventAt?: Date
}

export type CollaborationEventType =
  | "connected"
  | "disconnected"
  | "participant-joined"
  | "participant-left"
  | "cursor-moved"
  | "selection-changed"
  | "content-updated"
  | "comment-added"
  | "comment-resolved"
  | "error"

export interface CollaborationEvent {
  type: CollaborationEventType
  timestamp: Date
  participantId?: string
  data?: unknown
}
