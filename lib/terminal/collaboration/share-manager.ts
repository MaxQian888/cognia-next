/**
 * Share manager for collaborative terminal sessions.
 *
 * Handles the lifecycle of sharing: creating invites, accepting them,
 * managing participants, and revoking access. Integrates with the
 * existing signaling infrastructure.
 */

import type {
  TerminalShareInvite,
  SharedSessionState,
  SharedParticipant,
  ParticipantRole,
  InviteStatus,
} from "./types"

/** Default invite expiry: 1 hour. */
export const DEFAULT_INVITE_EXPIRY_MS = 60 * 60 * 1000

/** Maximum participants per shared session. */
export const MAX_PARTICIPANTS = 10

/** Dependencies injected for testability. */
export interface ShareManagerDeps {
  /** Generate a unique id. */
  generateId?: () => string
  /** Generate a secret token. */
  generateToken?: () => string
  /** Clock function. */
  now?: () => number
}

let idCounter = 0
function defaultGenerateId(): string {
  return `share-${Date.now()}-${++idCounter}`
}

function defaultGenerateToken(): string {
  // In production this would be crypto.randomUUID() or similar
  return `tok-${Math.random().toString(36).slice(2, 14)}`
}

/**
 * Create a share invite for a terminal session.
 */
export function createInvite(
  sessionId: string,
  options?: {
    role?: ParticipantRole
    expiryMs?: number
    maxParticipants?: number
  },
  deps?: ShareManagerDeps
): TerminalShareInvite {
  const generateId = deps?.generateId ?? defaultGenerateId
  const generateToken = deps?.generateToken ?? defaultGenerateToken
  const now = (deps?.now ?? Date.now)()

  const expiryMs = options?.expiryMs ?? DEFAULT_INVITE_EXPIRY_MS

  return {
    id: generateId(),
    sessionId,
    token: generateToken(),
    grantedRole: options?.role ?? "viewer",
    status: "pending",
    createdAt: now,
    expiresAt: expiryMs > 0 ? now + expiryMs : null,
    maxParticipants: options?.maxParticipants ?? MAX_PARTICIPANTS,
    participantCount: 0,
  }
}

/**
 * Check if an invite is still valid (not expired, not revoked, not full).
 */
export function isInviteValid(invite: TerminalShareInvite, now?: number): boolean {
  const currentTime = now ?? Date.now()

  if (invite.status === "revoked" || invite.status === "expired") return false
  if (invite.expiresAt !== null && currentTime >= invite.expiresAt) return false
  if (invite.maxParticipants !== null && invite.participantCount >= invite.maxParticipants) {
    return false
  }
  return true
}

/**
 * Revoke an invite.
 */
export function revokeInvite(invite: TerminalShareInvite): TerminalShareInvite {
  return { ...invite, status: "revoked" as InviteStatus }
}

/**
 * Accept an invite — creates a new participant entry.
 */
export function acceptInvite(
  invite: TerminalShareInvite,
  peerId: string,
  name: string,
  deps?: ShareManagerDeps
): { participant: SharedParticipant; updatedInvite: TerminalShareInvite } | null {
  const now = (deps?.now ?? Date.now)()

  if (!isInviteValid(invite, now)) return null

  const participant: SharedParticipant = {
    peerId,
    name,
    role: invite.grantedRole,
    joinedAt: now,
    connected: true,
  }

  const updatedInvite: TerminalShareInvite = {
    ...invite,
    status: "active",
    participantCount: invite.participantCount + 1,
  }

  return { participant, updatedInvite }
}

/**
 * Create the initial shared session state.
 */
export function createSharedState(invite: TerminalShareInvite): SharedSessionState {
  return {
    active: true,
    invite,
    participants: [],
  }
}

/**
 * Add a participant to the shared state.
 */
export function addParticipant(
  state: SharedSessionState,
  participant: SharedParticipant
): SharedSessionState {
  return {
    ...state,
    participants: [...state.participants, participant],
  }
}

/**
 * Remove a participant from the shared state.
 */
export function removeParticipant(state: SharedSessionState, peerId: string): SharedSessionState {
  return {
    ...state,
    participants: state.participants.filter((p) => p.peerId !== peerId),
  }
}

/**
 * Update a participant's role.
 */
export function changeParticipantRole(
  state: SharedSessionState,
  peerId: string,
  newRole: ParticipantRole
): SharedSessionState {
  return {
    ...state,
    participants: state.participants.map((p) =>
      p.peerId === peerId ? { ...p, role: newRole } : p
    ),
  }
}

/**
 * Mark a participant as disconnected (without removing them).
 */
export function markDisconnected(state: SharedSessionState, peerId: string): SharedSessionState {
  return {
    ...state,
    participants: state.participants.map((p) =>
      p.peerId === peerId ? { ...p, connected: false } : p
    ),
  }
}

/**
 * End the shared session — marks inactive and revokes invite.
 */
export function endSharedSession(state: SharedSessionState): SharedSessionState {
  return {
    active: false,
    invite: state.invite ? revokeInvite(state.invite) : null,
    participants: state.participants.map((p) => ({ ...p, connected: false })),
  }
}

/**
 * Build a share URL from an invite.
 */
export function buildShareUrl(invite: TerminalShareInvite, baseUrl: string): string {
  return `${baseUrl}/terminal/share?id=${invite.id}&token=${invite.token}`
}

/** Reset the id counter (for testing). */
export function __resetShareIdCounterForTesting(): void {
  idCounter = 0
}
