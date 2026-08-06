/**
 * Type definitions for collaborative terminal sessions.
 *
 * Uses the existing WebRTC signaling infrastructure to relay terminal
 * PTY data between peers. One peer is the "controller" (owns the PTY),
 * others are "viewers" (read-only) or "editors" (can type).
 */

/** Role of a participant in a shared session. */
export type ParticipantRole = "controller" | "editor" | "viewer"

/** Share invite state. */
export type InviteStatus = "pending" | "active" | "expired" | "revoked"

/** A participant in a shared terminal session. */
export interface SharedParticipant {
  /** Unique peer id. */
  peerId: string
  /** Display name. */
  name: string
  /** Participant role. */
  role: ParticipantRole
  /** When they joined (ms since epoch). */
  joinedAt: number
  /** Whether they are currently connected. */
  connected: boolean
}

/** Invite metadata for a shared terminal session. */
export interface TerminalShareInvite {
  /** Unique invite id. */
  id: string
  /** The terminal session being shared. */
  sessionId: string
  /** Secret token for the invite link. */
  token: string
  /** Role granted to users who accept the invite. */
  grantedRole: ParticipantRole
  /** Current invite status. */
  status: InviteStatus
  /** When the invite was created (ms since epoch). */
  createdAt: number
  /** When the invite expires (ms since epoch, null = never). */
  expiresAt: number | null
  /** Maximum number of participants (null = unlimited). */
  maxParticipants: number | null
  /** Current participant count. */
  participantCount: number
}

/** State of a shared session. */
export interface SharedSessionState {
  /** Whether sharing is active. */
  active: boolean
  /** The invite (if sharing is active). */
  invite: TerminalShareInvite | null
  /** Currently connected participants. */
  participants: SharedParticipant[]
}

/** Message types for the terminal collaboration data channel. */
export type CollabMessageType =
  | "terminal_data" // PTY output → viewers
  | "terminal_input" // editor input → controller
  | "terminal_resize" // size change → all
  | "participant_join" // someone joined
  | "participant_leave" // someone left
  | "role_change" // role updated
  | "session_end" // controller ended the share

/** Wire message for the WebRTC data channel. */
export interface CollabMessage {
  type: CollabMessageType
  /** Sender peer id. */
  from: string
  /** Message payload — shape depends on type. */
  payload: unknown
  /** Timestamp (ms since epoch). */
  ts: number
}

/** Terminal data payload (controller → viewers). */
export interface TerminalDataPayload {
  data: string
}

/** Terminal input payload (editor → controller). */
export interface TerminalInputPayload {
  data: string
}

/** Terminal resize payload. */
export interface TerminalResizePayload {
  cols: number
  rows: number
}

/** Participant event payload. */
export interface ParticipantEventPayload {
  peerId: string
  name: string
  role: ParticipantRole
}
