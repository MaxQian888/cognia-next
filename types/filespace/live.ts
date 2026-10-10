/**
 * Live file shares (ADR-0222 §7): the wire shapes of `crates/cognia-file-share`.
 *
 * A live grant gives credential holders revocable WebDAV/SFTP access to chosen
 * paths of one conversation's FileSpace, served by the host that holds the
 * files. These types mirror the Rust structs field for field (serde
 * `camelCase`); the host is the authority, the renderer and the brain only
 * push mount tables and the policy and manage grants through
 * `lib/filespace/grants-client.ts`.
 */

import type { SessionRole } from "@cognia/agent-config-types"
import type { FileSharingPolicy } from "@/lib/filespace/policy"

/** What a credential may do. `download` is needed for file bytes, `read` for listings. */
export type LivePermission = "read" | "download" | "write"

/** The network-drive protocols a credential speaks. */
export type LiveProtocol = "webdav" | "sftp"

/**
 * Who serves a grant: the host's own listener, or a separately deployed
 * SFTPGo the host provisions users in.
 */
export type LiveProvider = "builtin" | "sftpgo"

/** `stale`: a granted mount moved or changed; resuming rebinds it. */
export type LiveGrantStatus = "active" | "suspended" | "stale" | "expired" | "revoked"

/** Why a grant is in its status. */
export type LiveGrantStatusReason =
  | "owner"
  | "policy"
  | "session_archived"
  | "session_deleted"
  | "mount_changed"
  | "expired"
  | "revoked"
  | "provider_failed"
  /** A members' share whose host registration ended (replaced, removed, refused). */
  | "collab_host_removed"
  /** The collaboration server's org policy refused to publish it. */
  | "org_policy"

export interface LiveGrantPath {
  mountId: string
  /** `/`-separated, relative to the mount; `""` is the mount itself. */
  relPath: string
  isDir: boolean
  mountFingerprint: string
  /** Where the credential sees it, e.g. `/workspace/src`. */
  virtualPath: string
}

/**
 * Who made a grant. `agent`: an agent's `filespace_share` /
 * `filespace_enable_webdav` call the person approved (ADR-0222 §9); the host
 * refuses and suspends those unless the policy allows agent sharing.
 */
export type LiveGrantCreator = "user" | "agent"

/**
 * Who a grant is for (ADR-0222 §6).
 *
 * - `credentials`: whoever holds one of its WebDAV/SFTP credentials.
 * - `collab`: members of the shared conversation this host is registered for
 *   on the collaboration server (`orgId`, `collabSessionId`): the named ones
 *   (`userIds`), or everyone at `minRole` or above. They reach the files
 *   through requests the server relays to this host; no credential exists, and
 *   a viewer only ever reads.
 */
export type LiveGrantAudience =
  | { kind: "credentials" }
  | {
      kind: "collab"
      orgId: string
      collabSessionId: string
      userIds: string[] | null
      minRole: SessionRole
    }

/** The audience a create request asks for; a members' share binds to the host's registration. */
export type LiveGrantAudienceRequest =
  { kind: "credentials" } | { kind: "collab"; userIds?: string[] | null; minRole: SessionRole }

export interface LiveGrant {
  id: string
  sessionId: string
  label: string | null
  createdBy: LiveGrantCreator
  creatorPrincipal: string
  audience: LiveGrantAudience
  /** The credentials' protocols; empty for a members' share. */
  protocols: LiveProtocol[]
  provider: LiveProvider
  permissions: LivePermission[]
  status: LiveGrantStatus
  statusReason: LiveGrantStatusReason | string | null
  expiresAt: number
  policyRevision: number
  createdAt: number
  updatedAt: number
  revokedAt: number | null
  paths: LiveGrantPath[]
}

/** A credential as listed: never its secret. */
export interface LiveCredential {
  id: string
  grantId: string
  protocol: LiveProtocol
  provider: LiveProvider
  username: string
  sshKeyFingerprint: string | null
  createdAt: number
  rotatedAt: number | null
  revokedAt: number | null
}

/** A credential with its password, shown exactly once. */
export interface IssuedLiveCredential {
  credential: LiveCredential
  password: string
}

export interface LiveGrantView {
  grant: LiveGrant
  credentials: LiveCredential[]
}

/** Why a host offers no endpoint for a grant's provider. */
export const LIVE_UNAVAILABLE_REASONS = [
  "listener_off",
  "sftpgo_unconfigured",
  "sftpgo_no_public_endpoint",
] as const

export interface LiveSftpEndpoint {
  host: string
  port: number
}

/** Where a credential's protocols are reachable right now. */
export interface LiveEndpoints {
  webdavUrls: string[]
  sftp: LiveSftpEndpoint[]
  sftpHostKeyFingerprint: string | null
  tlsFingerprint: string | null
  /** Why nothing is reachable: {@link LIVE_UNAVAILABLE_REASONS}. */
  unavailableReason: string | null
}

export interface CreatedLiveGrant {
  grant: LiveGrant
  credentials: IssuedLiveCredential[]
  endpoints: LiveEndpoints
}

export interface CreateLiveGrantRequest {
  sessionId: string
  /** FileSpace virtual paths, e.g. `/workspace/src`; at most 50. */
  paths: string[]
  permissions: LivePermission[]
  /** At least one for a credential audience; empty for conversation members. */
  protocols: LiveProtocol[]
  provider?: LiveProvider
  expiresInSeconds: number
  label?: string
  /** OpenSSH public key for SFTP key authentication. */
  sshPublicKey?: string
  /** `agent` for an agent's tool call; omitted for the person's own grant. */
  createdBy?: LiveGrantCreator
  /** Omitted: credential holders. */
  audience?: LiveGrantAudienceRequest
}

/** A conversation registered as the file host of its shared counterpart. */
export interface CollabHostRecord {
  sessionId: string
  orgId: string
  collabSessionId: string
  serverUrl: string
  hostLabel: string
  registeredAt: number
  updatedAt: number
}

/** What the app hands the host after registering it; the token is write-only. */
export interface CollabHostInput {
  orgId: string
  collabSessionId: string
  serverUrl: string
  hostLabel: string
  hostToken: string
}

/** One conversation's registration and how serving its members fares. */
export interface CollabHostStatus {
  sessionId: string
  registration: CollabHostRecord | null
  tokenPresent: boolean
  /** A loop is answering the members' requests. */
  running: boolean
  lastContactAt: number | null
  /** `host_unregistered`, `host_token_missing`, `replaced`, `unregistered`, `session_deleted`, or a transport failure. */
  lastError: string | null
  unmirroredGrants: number
}

export type LiveExposure = "loopback" | "lan" | "tunnel"
export type LiveTunnelMode = "quick" | "named"

export interface LiveListenerConfig {
  enabled: boolean
  exposure: LiveExposure
  webdav: boolean
  sftp: boolean
  webdavPort: number
  sftpPort: number
  tunnelMode: LiveTunnelMode
  tunnelHostname: string | null
}

/** What the settings surface sends; the token is write-only. */
export interface LiveListenerConfigInput extends LiveListenerConfig {
  tunnelToken?: string
}

export interface LiveListenerStatus {
  config: LiveListenerConfig
  webdavPort: number | null
  sftpPort: number | null
  tunnelUrl: string | null
  tunnelPid: number | null
  tunnelTokenSet: boolean
  errors: { component: string; message: string }[]
  endpoints: LiveEndpoints
}

export interface SftpgoPathMapping {
  hostPrefix: string
  sftpgoPrefix: string
}

export interface SftpgoConfig {
  baseUrl: string
  homeBase: string
  pathMappings: SftpgoPathMapping[]
  publicSftpHost?: string | null
  publicSftpPort?: number | null
  publicWebdavUrl?: string | null
}

/** What the settings surface sends; the admin API key is write-only. */
export interface SftpgoConfigInput extends SftpgoConfig {
  apiKey?: string
}

export interface SftpgoStatus {
  configured: boolean
  config: SftpgoConfig | null
  apiKeySet: boolean
  healthy: boolean | null
  error: string | null
  /** Where SFTPGo-served credentials dial, as a grant's card would show it. */
  endpoints: LiveEndpoints
}

/** The effective policy as the host holds it, stamped with its own revision. */
export interface HostFileSharingPolicy extends FileSharingPolicy {
  orgId: string | null
  orgRevision: number | null
  revision: number
  updatedAt: number
}

export interface FileShareStatus {
  active: boolean
  accountId: string | null
  policy: HostFileSharingPolicy
  listener: LiveListenerStatus
  sftpgo: SftpgoStatus
  /** Conversations whose mount tables the app keeps pushing. */
  sessionsWithGrants: string[]
  activeGrants: number
  liveConnections: number
  pendingProviderOps: number
}

export interface FileSpaceSyncReport {
  synced: number
  sessionsWithGrants: string[]
}

/** One conversation's mounts as the host needs them. */
export interface SessionMountsInput {
  sessionId: string
  state: "active" | "archived" | "deleted"
  mounts: {
    mountId: string
    virtualPath: string
    backing: "disk" | "dexie"
    hostPath?: string
    writable: boolean
    status: string
  }[]
  /** The files of the Dexie-backed mounts (`/uploads`, `/artifacts`). */
  assets: {
    mountId: string
    name: string
    size: number
    mediaType: string
    modifiedAt: number
    sourceId: string
  }[]
}

/** Which audit rows to list; pages are requested with `pageSize`/`pageToken`. */
export interface FileShareAuditQuery {
  sessionId?: string
  grantId?: string
}

export interface FileShareAuditRow {
  id: number
  at: number
  sessionId: string | null
  grantId: string | null
  /** `owner`, `device:<id>`, `credential:<username>`, `member:<user id>`, `system`. */
  principal: string
  channel: "app" | "webdav" | "sftp" | "sftpgo" | "collab"
  action: string
  path: string | null
  bytes: number | null
  outcome: "allowed" | "denied" | "failed" | string
  reason: string | null
  remote: string | null
}
