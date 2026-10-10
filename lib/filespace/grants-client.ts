/**
 * Typed calls to a host's live file-share service (ADR-0222 §7.5).
 *
 * Thirteen commands, one module, so the wire names live in exactly one place:
 * `crates/cognia-file-share/src/rpc.rs` is the authority on shape, and the
 * desktop's `#[tauri::command]` shells take the same arguments, so one call
 * works over Tauri IPC and over the companion RPC alike.
 *
 * # Which host
 *
 * A conversation's files live on the host its FileSpace names (`hostId`). On
 * the desktop that is either this machine (`"local"`), reached through
 * `localTransport` even while a remote host is being driven, or the active
 * remote host, reached through `transport`. Everywhere else there is only
 * `transport`. {@link fileShareTransport} is that rule.
 *
 * # Errors
 *
 * Every refusal carries a stable code ({@link FILE_SHARE_ERROR_CODES}); the UI
 * maps it to a sentence and never parses the message.
 */

import { isTauri } from "@/lib/platform/detect"
import { parseInvokeError } from "@/lib/tauri/command-error"
import { collectPages, type Page, type PageRequest } from "@/lib/tauri/companion-paging"
import { localTransport, transport } from "@/lib/tauri/transport-instance"
import type { Transport } from "@/lib/tauri/transport-types"
import type {
  CreatedLiveGrant,
  CreateLiveGrantRequest,
  FileShareAuditQuery,
  FileShareAuditRow,
  FileShareStatus,
  FileSpaceSyncReport,
  HostFileSharingPolicy,
  IssuedLiveCredential,
  LiveGrantView,
  LiveListenerConfigInput,
  LiveListenerStatus,
  SessionMountsInput,
  SftpgoConfigInput,
  SftpgoStatus,
} from "@/types/filespace/live"
import type { FileSharingPolicy } from "@/lib/filespace/policy"
import { LOCAL_FILESPACE_HOST_ID } from "@/lib/filespace/resolve"

/** Every code the host answers with, as `cognia-file-share` spells them. */
export const FILE_SHARE_ERROR_CODES = [
  "file_share_unavailable",
  "file_share_locked",
  "invalid_request",
  "invalid_path",
  "not_found",
  "store_failed",
  "unknown_command",
  "policy_live_disabled",
  "policy_credentials_disabled",
  "policy_write_disabled",
  "policy_exceeded",
  "ttl_exceeds_policy",
  "session_inactive",
  "mount_not_synced",
  "mount_unavailable",
  "mount_read_only",
  "sensitive_path",
  "grant_expired",
  "grant_not_active",
  "grant_not_resumable",
  "credential_revoked",
  "credential_conflict",
  "credential_hash_failed",
  "provider_failed",
  "sftpgo_unconfigured",
  "sftpgo_path_unmapped",
  "secret_store_unavailable",
  "listener_bind_failed",
  "listener_tls_failed",
  "host_key_failed",
] as const

export type FileShareErrorCode = (typeof FILE_SHARE_ERROR_CODES)[number]

/** The host refused or failed; `code` is one of {@link FILE_SHARE_ERROR_CODES} or `unknown`. */
export function fileShareErrorCode(error: unknown): FileShareErrorCode | "unknown" {
  const { code } = parseInvokeError(error)
  return (FILE_SHARE_ERROR_CODES as readonly string[]).includes(code)
    ? (code as FileShareErrorCode)
    : "unknown"
}

/** The code and the host's own words, for a sentence that can quote them. */
export function fileShareErrorDetails(error: unknown): {
  code: FileShareErrorCode | "unknown"
  message: string
} {
  return { code: fileShareErrorCode(error), message: parseInvokeError(error).message }
}

/** The transport that reaches the host a conversation's files live on. */
export function fileShareTransport(hostId?: string): Transport {
  if (isTauri() && (hostId === undefined || hostId === LOCAL_FILESPACE_HOST_ID)) {
    return localTransport
  }
  return transport
}

/** Where to send a call: a host id, or a transport for tests and the brain. */
export type FileShareTarget = { hostId?: string } | { transport: Transport }

function via(target: FileShareTarget | undefined): Transport {
  if (target && "transport" in target) return target.transport
  return fileShareTransport(target?.hostId)
}

// ── Host-owned state (the app pushes it; devices cannot) ───────────────────

/** Serve `accountId`'s grants on this host, or nothing with `null`. */
export function activateFileShare(
  accountId: string | null,
  target?: FileShareTarget
): Promise<FileShareStatus> {
  return via(target).call<FileShareStatus>("file_share_activate", { accountId })
}

/** Push the mount tables of these conversations. */
export function syncFileSpaces(
  sessions: SessionMountsInput[],
  target?: FileShareTarget
): Promise<FileSpaceSyncReport> {
  return via(target).call<FileSpaceSyncReport>("file_space_sync", { sessions })
}

/** Push the effective file-sharing policy. */
export function pushFileSharingPolicy(
  push: { policy: FileSharingPolicy; orgId?: string | null; orgRevision?: number | null },
  target?: FileShareTarget
): Promise<HostFileSharingPolicy> {
  return via(target).call<HostFileSharingPolicy>("file_share_policy_set", { push })
}

// ── Reads ──────────────────────────────────────────────────────────────────

export function getFileShareStatus(target?: FileShareTarget): Promise<FileShareStatus> {
  return via(target).call<FileShareStatus>("file_share_status", {})
}

export function listLiveGrantsPage(
  query: { sessionId?: string } & PageRequest = {},
  target?: FileShareTarget
): Promise<Page<LiveGrantView>> {
  return via(target).call<Page<LiveGrantView>>("file_grant_list", { ...query })
}

/** Every grant (of one conversation, or all), newest first. */
export function listLiveGrants(
  query: { sessionId?: string } = {},
  target?: FileShareTarget
): Promise<LiveGrantView[]> {
  return collectPages((pageToken) =>
    listLiveGrantsPage({ ...query, ...(pageToken ? { pageToken } : {}) }, target)
  )
}

export function listFileShareAuditPage(
  query: FileShareAuditQuery & PageRequest = {},
  target?: FileShareTarget
): Promise<Page<FileShareAuditRow>> {
  return via(target).call<Page<FileShareAuditRow>>("file_audit_list", { ...query })
}

// ── Grant lifecycle ────────────────────────────────────────────────────────

/** Create a grant. The answer carries each credential's password exactly once. */
export function createLiveGrant(
  request: CreateLiveGrantRequest,
  target?: FileShareTarget
): Promise<CreatedLiveGrant> {
  return via(target).call<CreatedLiveGrant>("file_grant_create", { request })
}

export function revokeLiveGrant(grantId: string, target?: FileShareTarget): Promise<LiveGrantView> {
  return via(target).call<LiveGrantView>("file_grant_revoke", { grantId })
}

export function suspendLiveGrant(
  grantId: string,
  target?: FileShareTarget
): Promise<LiveGrantView> {
  return via(target).call<LiveGrantView>("file_grant_suspend", { grantId })
}

export function resumeLiveGrant(grantId: string, target?: FileShareTarget): Promise<LiveGrantView> {
  return via(target).call<LiveGrantView>("file_grant_resume", { grantId })
}

/** Issue a new password for one credential; sessions on the old one end. */
export function rotateLiveCredential(
  credentialId: string,
  target?: FileShareTarget
): Promise<IssuedLiveCredential> {
  return via(target).call<IssuedLiveCredential>("file_credential_rotate", { credentialId })
}

// ── Host configuration ─────────────────────────────────────────────────────

export function setFileShareListener(
  config: LiveListenerConfigInput,
  target?: FileShareTarget
): Promise<LiveListenerStatus> {
  return via(target).call<LiveListenerStatus>("file_share_listener_set", { config })
}

/** Configure (or, with `null`, remove) the SFTPGo provider. */
export function setSftpgoProvider(
  config: SftpgoConfigInput | null,
  target?: FileShareTarget
): Promise<SftpgoStatus> {
  return via(target).call<SftpgoStatus>("file_share_sftpgo_set", { config })
}
