/**
 * Typed wrappers around the connectors_* Tauri commands.
 *
 * By default all functions call `invoke` from `@tauri-apps/api/core` — in
 * web mode (no Tauri host) these will throw. Callers should guard with
 * `isTauri()` from `@/lib/tauri` before invoking.
 *
 * The transport is swappable via `setConnectorCommandInvoker` so the
 * headless brain (ADR-0059 T-A5) can route the SAME wrappers over the
 * companion `_rpc` arms instead of Tauri IPC — one implementation of every
 * command wrapper, two hosts.
 */
import { invoke } from "@tauri-apps/api/core"
import type { MatrixEncryptedFile } from "@/types/connectors/segment"
import type { RuntimeLeaseAcquireResult } from "@/lib/connectors/runtime-lease"

/**
 * Transport for the connectors_* command surface. `name` is always the
 * Tauri command name; a non-Tauri invoker owns any name remapping and
 * host-specific no-op semantics.
 */
export type ConnectorCommandInvoker = <T>(
  name: string,
  args?: Record<string, unknown>
) => Promise<T>

// Preserve call arity — `invoke(name)` and `invoke(name, undefined)` must
// stay distinguishable so the default path is byte-identical to the
// pre-seam direct calls.
const tauriInvoker: ConnectorCommandInvoker = (name, args) =>
  args === undefined ? invoke(name) : invoke(name, args)

let invoker: ConnectorCommandInvoker = tauriInvoker

/**
 * Swap the transport behind every connectors_* wrapper. Pass `null` to
 * restore the default Tauri `invoke`. Returns the previously-active invoker
 * so callers can restore it on teardown.
 */
export function setConnectorCommandInvoker(
  fn: ConnectorCommandInvoker | null
): ConnectorCommandInvoker {
  const previous = invoker
  invoker = fn ?? tauriInvoker
  return previous
}

// ---------------------------------------------------------------------------
// Shared types (mirror src-tauri/src/connectors/types.rs)
// ---------------------------------------------------------------------------

export interface AdapterRegistration {
  adapterId: string
  adapterType: string
  webhookPath?: string
}

export interface ConnectorsHealth {
  serverRunning: boolean
  boundAddr: string | null
  registeredAdapterCount: number
}

export interface TauriHttpRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Explicit opt-in for a user-configured self-signed endpoint. */
  allowInvalidCertificates?: boolean
}

export interface TauriHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Metadata for one cached attachment, as reported by Rust.
 *
 * There is deliberately no local file path: the cache holds encrypted
 * envelopes only, and `connectorsAttachmentRead` is the sole way to get the
 * bytes back. Sizes and expiry come from the envelope, so the renderer never
 * has to guess either one.
 */
export interface AttachmentRef {
  /** Hex SHA-256 of `"<adapterId>:<remoteRef>"` — the handle for deletes. */
  cacheKey: string
  remoteRef: string
  /** Real decrypted byte count. */
  sizeBytes: number
  createdAt: number
  lastAccessedAt: number
  /** Absent means the entry only ages out via the LRU budget. */
  expiresAt?: number
  /** True when Rust served the entry from cache without a network fetch. */
  cached: boolean
}

/** One envelope in a cache listing — the input to orphan sweeps. */
export interface AttachmentEntry {
  cacheKey: string
  sizeBytes: number
  createdAt: number
  lastAccessedAt: number
  expiresAt?: number
  /** On-disk size including envelope header and AEAD tags. */
  diskBytes: number
}

export interface AttachmentCleanupFailure {
  cacheKey: string
  error: string
}

/**
 * Outcome of a batch delete / evict / budget sweep. A key in `deleted` is
 * gone from disk (or was already absent); anything in `failed` must go to the
 * cleanup ledger for retry rather than having its Dexie row dropped.
 */
export interface AttachmentCleanupReport {
  deleted: string[]
  freedBytes: number
  failed: AttachmentCleanupFailure[]
}

export interface ConnectorMediaUploadRequest {
  uploadUrl: string
  headers?: Record<string, string>
  sourceUrl?: string
  localPath?: string
  contentType?: string
}

export interface DiscordUploadFile {
  sourceUrl: string
  filename: string
  contentType?: string
  description?: string
  /** Voice-message duration in seconds (audio attachments only). */
  durationSecs?: number
  /** Base64 waveform for voice messages. */
  waveform?: string
}

export interface ConnectorDiscordUploadRequest {
  botToken: string
  channelId: string
  content?: string
  files: DiscordUploadFile[]
  replyToMessageId?: string
  /** Message flags bitfield (e.g. IS_VOICE_MESSAGE = 1 << 13). */
  flags?: number
  /**
   * Deterministic idempotency nonce (≤25 chars). When present the Rust side
   * emits `nonce` + `enforce_nonce: true` in `payload_json` so a retried
   * upload returns the original message instead of a duplicate.
   */
  nonce?: string
}

export interface MatrixCryptoInitRequest {
  adapterId: string
  userId: string
  deviceId: string
  storeDir?: string
  storePassphrase?: string
}

export interface MatrixCryptoOutgoingRequest {
  requestId: string
  kind: string
  method: string
  path: string
  body: unknown
}

export interface MatrixCryptoMarkSentRequest {
  adapterId: string
  requestId: string
  kind: string
  response: unknown
}

export interface MatrixCryptoReceiveSyncRequest {
  adapterId: string
  toDeviceEvents?: unknown[]
  changedDevices?: string[]
  leftDevices?: string[]
  oneTimeKeyCounts?: Record<string, number>
  unusedFallbackKeys?: string[]
  nextBatchToken?: string | null
}

export interface MatrixCryptoDecryptRequest {
  adapterId: string
  roomId: string
  event: unknown
}

export interface MatrixCryptoDecryptResponse {
  event: unknown
}

export interface MatrixCryptoEncryptRequest {
  adapterId: string
  roomId: string
  eventType: string
  content: unknown
}

export interface MatrixCryptoEncryptResponse {
  content: unknown
}

export interface MatrixCryptoShareRoomKeyRequest {
  adapterId: string
  roomId: string
  userIds: string[]
}

export interface MatrixCryptoTrackUsersRequest {
  adapterId: string
  userIds: string[]
}

export interface MatrixCryptoMissingSessionsRequest {
  adapterId: string
  userIds: string[]
}

export type MatrixEncryptedMediaUploadRequest = ConnectorMediaUploadRequest

export interface MatrixEncryptedMediaUploadResponse {
  contentUri: string
  file: MatrixEncryptedFile
}

export interface MatrixEncryptedMediaFetchRequest {
  adapterId: string
  remoteRef: string
  sourceUrl: string
  headers?: Record<string, string>
  file: MatrixEncryptedFile
}

// ---------------------------------------------------------------------------
// Task 19 — adapter registry commands
// ---------------------------------------------------------------------------

export async function connectorsRegisterAdapter(reg: AdapterRegistration): Promise<void> {
  await invoker("connectors_register_adapter", { reg })
}

export async function connectorsUnregisterAdapter(adapterId: string): Promise<void> {
  await invoker("connectors_unregister_adapter", { adapterId })
}

/**
 * Single-owner runtime lease (`lib/connectors/runtime-lease.ts`).
 *
 * Registered as Tauri commands AND exposed over the companion RPC surface, on
 * purpose: both bind the same `ConnectorsState`, so a desktop webview and a
 * brain process attached to that desktop's companion contend for one slot.
 * `ownerId` carries its priority class as a prefix (`desktop:` / `brain:`).
 */
export async function connectorsRuntimeLeaseAcquire(
  ownerId: string,
  ttlMs: number
): Promise<RuntimeLeaseAcquireResult | boolean> {
  return invoker<RuntimeLeaseAcquireResult | boolean>("connectors_runtime_lease_acquire", {
    ownerId,
    ttlMs,
    handoffAware: true,
  })
}

export async function connectorsRuntimeLeaseRenew(
  ownerId: string,
  ttlMs: number
): Promise<boolean> {
  return invoker<boolean>("connectors_runtime_lease_renew", { ownerId, ttlMs })
}

export async function connectorsRuntimeLeaseRelease(ownerId: string): Promise<boolean> {
  return invoker<boolean>("connectors_runtime_lease_release", { ownerId })
}

export async function connectorsHealth(): Promise<ConnectorsHealth> {
  return invoker<ConnectorsHealth>("connectors_health")
}

// ---------------------------------------------------------------------------
// Task 20 — server lifecycle commands
// ---------------------------------------------------------------------------

/**
 * Start the connectors HTTP/WS server.
 * @returns The bound address (e.g. `"127.0.0.1:8080"`) on success.
 */
export async function connectorsStartServer(
  port: number,
  bindLoopbackOnly = true
): Promise<string> {
  return invoker<string>("connectors_start_server", { port, bindLoopbackOnly })
}

/**
 * Start the connectors HTTP/WS server if it is not already up, and return the
 * bound address either way. Always binds loopback-only.
 *
 * Unlike {@link connectorsStartServer} this never errors on "already running" —
 * it is for callers that need the loopback listener to EXIST (the remote
 * document providers' OAuth redirect target, ADR-0134) and cannot know whether
 * a webhook adapter already started one.
 */
export async function connectorsEnsureServer(port: number): Promise<string> {
  return invoker<string>("connectors_ensure_server", { port })
}

export async function connectorsStopServer(): Promise<void> {
  await invoker("connectors_stop_server")
}

// ---------------------------------------------------------------------------
// Task 21 — keyring commands
// ---------------------------------------------------------------------------

export async function connectorsKeyringSet(
  adapterId: string,
  credential: string,
  value: string
): Promise<void> {
  await invoker("connectors_keyring_set", { adapterId, credential, value })
}

export async function connectorsKeyringGet(
  adapterId: string,
  credential: string
): Promise<string | null> {
  return invoker<string | null>("connectors_keyring_get", { adapterId, credential })
}

export async function connectorsKeyringDelete(
  adapterId: string,
  credential: string
): Promise<void> {
  await invoker("connectors_keyring_delete", { adapterId, credential })
}

/**
 * Probe which of the supplied `accounts` have an entry in the keyring.
 * Returns only the names that are set.
 */
export async function connectorsKeyringList(
  adapterId: string,
  accounts: string[]
): Promise<string[]> {
  return invoker<string[]>("connectors_keyring_list", { adapterId, accounts })
}

// ---------------------------------------------------------------------------
// Task 22 — outbound HTTP
// ---------------------------------------------------------------------------

export async function connectorsHttpRequest(req: TauriHttpRequest): Promise<TauriHttpResponse> {
  return invoker<TauriHttpResponse>("connectors_http_request", { req })
}

// ---------------------------------------------------------------------------
// Task 23 — WebSocket client
// ---------------------------------------------------------------------------

/**
 * Open a WebSocket connection. Returns the stable handle id.
 * Incoming messages arrive as Tauri events at `connectors://ws/<id>/message`.
 */
export async function connectorsWsOpen(
  url: string,
  headers?: Record<string, string>
): Promise<string> {
  return invoker<string>("connectors_ws_open", { url, headers })
}

/**
 * Send a text message on an open WebSocket identified by `handleId`.
 */
export async function connectorsWsSend(handleId: string, data: string): Promise<void> {
  await invoker("connectors_ws_send", { handleId, data })
}

export async function connectorsWsClose(handleId: string): Promise<void> {
  await invoker("connectors_ws_close", { handleId })
}

/** Send a serialized OneBot API call to the live reverse-WS client. */
export async function connectorsOnebotSend(adapterId: string, callJson: string): Promise<void> {
  await invoker("connectors_onebot_send", { adapterId, callJson })
}

/**
 * Close every leaked connector WS / Lark long-connection socket and return the
 * count reaped.
 *
 * A webview hard reload keeps the Rust core process (and its sockets) alive
 * while discarding the renderer that owned their handle ids, so the per-handle
 * close never runs and the sockets — plus Lark's self-reconnect loop — pile up,
 * delivering duplicate inbound events. The connector bootstrap calls this once,
 * before opening any adapter, to reap the previous load's leaked sockets.
 */
export async function connectorsResetAllWs(): Promise<number> {
  return invoker<number>("connectors_reset_all_ws")
}

// ---------------------------------------------------------------------------
// Lark long-connection (protobuf-framed WS)
//
// Dedicated path: the generic `connectors_ws_*` passthrough can't decode
// Feishu's binary protobuf frames. Rust does the handshake (reading appId /
// appSecret from the keyring), protobuf framing, chunk reassembly, ack and
// keepalive, then emits complete event envelopes (JSON strings) on
// `connectors://lark-ws/<handleId>/event` and a terminal
// `connectors://lark-ws/<handleId>/close`.
// ---------------------------------------------------------------------------

/**
 * Open a Lark long connection for `adapterId`. Returns the stable handle id.
 * The connection self-reconnects until `connectorsLarkWsClose` is called.
 */
export async function connectorsLarkWsOpen(adapterId: string): Promise<string> {
  return invoker<string>("connectors_lark_ws_open", { adapterId })
}

export async function connectorsLarkWsClose(handleId: string): Promise<void> {
  await invoker("connectors_lark_ws_close", { handleId })
}

// ---------------------------------------------------------------------------
// OneBot reverse-WS live-client probe (ADR-0036 follow-up)
// ---------------------------------------------------------------------------

export interface OnebotLiveClient {
  adapterId: string
  /** Unix epoch milliseconds when the reverse-WS socket upgraded. */
  connectedAtMs: number
}

/**
 * Probe which OneBot reverse-WS clients currently hold a live connection to
 * the in-app server. Reverse-WS gives no other inbound signal that the QQ
 * client is up, so this is how the settings UI shows per-adapter liveness.
 */
export async function connectorsOnebotProbe(): Promise<OnebotLiveClient[]> {
  return invoker<OnebotLiveClient[]>("connectors_onebot_probe")
}

// ---------------------------------------------------------------------------
// Task 24 — attachment cache
// ---------------------------------------------------------------------------

/**
 * Fetch (or serve from cache) one attachment. Rust owns TTL enforcement: an
 * entry past `expiresAt` is re-fetched rather than served, so callers must not
 * implement their own freshness check.
 *
 * @param ttlMs Lifetime for a freshly written entry. Omit for the 7-day
 *   default; pass `0` for "never expires, LRU only".
 */
export async function connectorsAttachmentFetch(
  adapterId: string,
  remoteRef: string,
  sourceUrl: string,
  headers?: Record<string, string>,
  ttlMs?: number
): Promise<AttachmentRef> {
  return invoker<AttachmentRef>("connectors_attachment_fetch", {
    adapterId,
    remoteRef,
    sourceUrl,
    headers,
    ttlMs,
  })
}

/** List every readable cache envelope, for orphan reconciliation. */
export async function connectorsAttachmentList(): Promise<AttachmentEntry[]> {
  return invoker<AttachmentEntry[]>("connectors_attachment_list")
}

/** Batch-delete cache entries by key. */
export async function connectorsAttachmentDelete(
  cacheKeys: string[]
): Promise<AttachmentCleanupReport> {
  return invoker<AttachmentCleanupReport>("connectors_attachment_delete", { cacheKeys })
}

/** Drop every cached attachment belonging to one adapter instance. */
export async function connectorsAttachmentEvictAdapter(
  adapterId: string
): Promise<AttachmentCleanupReport> {
  return invoker<AttachmentCleanupReport>("connectors_attachment_evict_adapter", { adapterId })
}

/** Reap expired entries and enforce the total-bytes ceiling (LRU first). */
export async function connectorsAttachmentEnforceBudget(
  maxTotalBytes: number
): Promise<AttachmentCleanupReport> {
  return invoker<AttachmentCleanupReport>("connectors_attachment_enforce_budget", {
    maxTotalBytes,
  })
}

/**
 * Read a cached attachment's plaintext bytes as base64. Returns `null` when
 * the attachment is not cached or its size exceeds `maxBytes`. This is the
 * only renderer path into the encrypted connector cache — the webview's fs
 * scope does not cover the cache directory.
 */
export async function connectorsAttachmentRead(
  adapterId: string,
  remoteRef: string,
  maxBytes: number
): Promise<string | null> {
  return invoker<string | null>("connectors_attachment_read", {
    adapterId,
    remoteRef,
    maxBytes,
  })
}

export async function connectorsMediaUpload(req: ConnectorMediaUploadRequest): Promise<string> {
  return invoker<string>("connectors_media_upload", { req })
}

/**
 * Discord multipart media upload — fetches each source URL in Rust and posts the
 * bytes as `multipart/form-data` to `/channels/{id}/messages`, returning the new
 * message id. Handles voice messages via the IS_VOICE_MESSAGE flag.
 */
export async function connectorsDiscordUpload(req: ConnectorDiscordUploadRequest): Promise<string> {
  return invoker<string>("connectors_discord_upload", { req })
}

export async function connectorsMatrixCryptoInit(req: MatrixCryptoInitRequest): Promise<void> {
  await invoker("connectors_matrix_crypto_init", { req })
}

export async function connectorsMatrixCryptoClose(adapterId: string): Promise<void> {
  await invoker("connectors_matrix_crypto_close", { adapterId })
}

export async function connectorsMatrixCryptoOutgoingRequests(
  adapterId: string
): Promise<MatrixCryptoOutgoingRequest[]> {
  return invoker<MatrixCryptoOutgoingRequest[]>("connectors_matrix_crypto_outgoing_requests", {
    adapterId,
  })
}

export async function connectorsMatrixCryptoMarkRequestSent(
  req: MatrixCryptoMarkSentRequest
): Promise<void> {
  await invoker("connectors_matrix_crypto_mark_request_sent", { req })
}

export async function connectorsMatrixCryptoReceiveSyncChanges(
  req: MatrixCryptoReceiveSyncRequest
): Promise<void> {
  await invoker("connectors_matrix_crypto_receive_sync_changes", { req })
}

export async function connectorsMatrixCryptoDecryptEvent(
  req: MatrixCryptoDecryptRequest
): Promise<MatrixCryptoDecryptResponse> {
  return invoker<MatrixCryptoDecryptResponse>("connectors_matrix_crypto_decrypt_event", { req })
}

export async function connectorsMatrixCryptoEncryptEvent(
  req: MatrixCryptoEncryptRequest
): Promise<MatrixCryptoEncryptResponse> {
  return invoker<MatrixCryptoEncryptResponse>("connectors_matrix_crypto_encrypt_event", { req })
}

export async function connectorsMatrixCryptoShareRoomKey(
  req: MatrixCryptoShareRoomKeyRequest
): Promise<MatrixCryptoOutgoingRequest[]> {
  return invoker<MatrixCryptoOutgoingRequest[]>("connectors_matrix_crypto_share_room_key", { req })
}

export async function connectorsMatrixCryptoUpdateTrackedUsers(
  req: MatrixCryptoTrackUsersRequest
): Promise<void> {
  await invoker("connectors_matrix_crypto_update_tracked_users", { req })
}

export async function connectorsMatrixCryptoGetMissingSessions(
  req: MatrixCryptoMissingSessionsRequest
): Promise<MatrixCryptoOutgoingRequest[]> {
  return invoker<MatrixCryptoOutgoingRequest[]>("connectors_matrix_crypto_get_missing_sessions", {
    req,
  })
}

export async function connectorsMatrixEncryptedMediaUpload(
  req: MatrixEncryptedMediaUploadRequest
): Promise<MatrixEncryptedMediaUploadResponse> {
  return invoker<MatrixEncryptedMediaUploadResponse>("connectors_matrix_encrypted_media_upload", {
    req,
  })
}

export async function connectorsMatrixEncryptedMediaFetch(
  req: MatrixEncryptedMediaFetchRequest
): Promise<AttachmentRef> {
  return invoker<AttachmentRef>("connectors_matrix_encrypted_media_fetch", { req })
}

// ---------------------------------------------------------------------------
// Lark media upload — voice / video / file / image
// ---------------------------------------------------------------------------

export interface LarkFileUploadRequest {
  accessToken: string
  sourceUrl: string
  /** Lark file_type discriminator: opus | mp4 | stream | pdf | doc | xls | ppt */
  fileType: string
  fileName: string
  /** Required by Lark for opus voice uploads; ignored otherwise. */
  durationMs?: number
}

/** Returns the opaque Lark `file_key`. */
export async function connectorsLarkUploadFile(req: LarkFileUploadRequest): Promise<string> {
  return invoker<string>("connectors_lark_upload_file", {
    accessToken: req.accessToken,
    sourceUrl: req.sourceUrl,
    fileType: req.fileType,
    fileName: req.fileName,
    durationMs: req.durationMs,
  })
}

export interface LarkImageUploadRequest {
  accessToken: string
  sourceUrl: string
  /** Defaults to "message" (chat-image scope). Use "avatar" for profile pics. */
  imageType?: "message" | "avatar"
}

/** Returns the opaque Lark `image_key`. */
export async function connectorsLarkUploadImage(req: LarkImageUploadRequest): Promise<string> {
  return invoker<string>("connectors_lark_upload_image", {
    accessToken: req.accessToken,
    sourceUrl: req.sourceUrl,
    imageType: req.imageType,
  })
}
