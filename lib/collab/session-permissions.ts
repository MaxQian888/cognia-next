import type {
  AuthorizationDecision,
  SessionAction,
  SessionMembership,
  SessionRole,
} from "@cognia/agent-config-types"

const ROLE_ACTIONS: Record<SessionRole, ReadonlySet<SessionAction>> = {
  viewer: new Set([
    "session.discover",
    "session.read",
    "session.readHistory",
    "attachment.read",
    "files.readLive",
  ]),
  member: new Set([
    "session.discover",
    "session.read",
    "session.readHistory",
    "session.post",
    "session.startRun",
    "message.correctOwn",
    "message.redactOwn",
    "run.approveOrdinary",
    "attachment.read",
    "attachment.write",
    "files.readLive",
    "files.writeLive",
  ]),
  maintainer: new Set([
    "session.discover",
    "session.read",
    "session.readHistory",
    "session.post",
    "session.startRun",
    "session.steer",
    "session.manageMembers",
    "session.manageSettings",
    "message.correctOwn",
    "message.redactOwn",
    "message.redactAny",
    "run.approveOrdinary",
    "run.approveHighRisk",
    "session.export",
    "session.auditMetadata",
    "attachment.read",
    "attachment.write",
    "files.share",
    "files.readLive",
    "files.writeLive",
  ]),
  owner: new Set([
    "session.discover",
    "session.read",
    "session.readHistory",
    "session.post",
    "session.startRun",
    "session.steer",
    "session.manageMembers",
    "session.manageSettings",
    "session.delete",
    "message.correctOwn",
    "message.redactOwn",
    "message.redactAny",
    "run.approveOrdinary",
    "run.approveHighRisk",
    "session.export",
    "session.auditMetadata",
    "attachment.read",
    "attachment.write",
    "files.share",
    "files.readLive",
    "files.writeLive",
  ]),
}

const GUEST_DENIED = new Set<SessionAction>([
  "session.manageMembers",
  "session.manageSettings",
  "session.delete",
  "message.redactAny",
  "run.approveHighRisk",
  "session.export",
  "session.auditMetadata",
  "session.breakGlassRead",
  "files.share",
  "files.writeLive",
])

export function authorizeSessionAction(
  membership: Pick<SessionMembership, "role" | "approver" | "guest"> | null,
  action: SessionAction,
  policyRevision: number
): AuthorizationDecision {
  if (!membership) return { allowed: false, reason: "not_a_session_member", policyRevision }
  if (membership.guest && GUEST_DENIED.has(action)) {
    return { allowed: false, reason: "guest_capability_ceiling", policyRevision }
  }
  // The approver flag is an overlay on a member, as on the server
  // (`crates/cognia-collab-server/src/chat.rs`): a viewer marked approver
  // still cannot approve, and owners and maintainers already can.
  if (action === "run.approveHighRisk" && membership.approver && membership.role === "member") {
    return { allowed: true, reason: "explicit_approver", policyRevision }
  }
  if (ROLE_ACTIONS[membership.role].has(action)) {
    return { allowed: true, reason: `session_role:${membership.role}`, policyRevision }
  }
  return { allowed: false, reason: "insufficient_session_role", policyRevision }
}
