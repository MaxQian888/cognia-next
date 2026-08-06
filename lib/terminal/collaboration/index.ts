/**
 * Terminal collaboration — barrel export.
 */

export type {
  ParticipantRole,
  InviteStatus,
  SharedParticipant,
  TerminalShareInvite,
  SharedSessionState,
  CollabMessageType,
  CollabMessage,
  TerminalDataPayload,
  TerminalInputPayload,
  TerminalResizePayload,
  ParticipantEventPayload,
} from "./types"

export {
  createInvite,
  isInviteValid,
  revokeInvite,
  acceptInvite,
  createSharedState,
  addParticipant,
  removeParticipant,
  changeParticipantRole,
  markDisconnected,
  endSharedSession,
  buildShareUrl,
  DEFAULT_INVITE_EXPIRY_MS,
  MAX_PARTICIPANTS,
} from "./share-manager"
export type { ShareManagerDeps } from "./share-manager"
