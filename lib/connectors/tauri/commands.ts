/**
 * Typed wrappers around the connectors_* Tauri commands.
 *
 * All functions call `invoke` from `@tauri-apps/api/core` — in web mode
 * (no Tauri host) these will throw. Callers should guard with `isTauri()`
 * from `@/lib/tauri` before invoking.
 */
import { invoke } from "@tauri-apps/api/core"

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
}

export interface TauriHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface AttachmentRef {
  localUrl: string
  remoteRef: string
}

// ---------------------------------------------------------------------------
// Task 19 — adapter registry commands
// ---------------------------------------------------------------------------

export async function connectorsRegisterAdapter(reg: AdapterRegistration): Promise<void> {
  await invoke("connectors_register_adapter", { reg })
}

export async function connectorsUnregisterAdapter(adapterId: string): Promise<void> {
  await invoke("connectors_unregister_adapter", { adapterId })
}

export async function connectorsHealth(): Promise<ConnectorsHealth> {
  return invoke<ConnectorsHealth>("connectors_health")
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
  return invoke<string>("connectors_start_server", { port, bindLoopbackOnly })
}

export async function connectorsStopServer(): Promise<void> {
  await invoke("connectors_stop_server")
}

// ---------------------------------------------------------------------------
// Task 21 — keyring commands
// ---------------------------------------------------------------------------

export async function connectorsKeyringSet(
  adapterId: string,
  credential: string,
  value: string
): Promise<void> {
  await invoke("connectors_keyring_set", { adapterId, credential, value })
}

export async function connectorsKeyringGet(
  adapterId: string,
  credential: string
): Promise<string | null> {
  return invoke<string | null>("connectors_keyring_get", { adapterId, credential })
}

export async function connectorsKeyringDelete(
  adapterId: string,
  credential: string
): Promise<void> {
  await invoke("connectors_keyring_delete", { adapterId, credential })
}

/**
 * Probe which of the supplied `accounts` have an entry in the keyring.
 * Returns only the names that are set.
 */
export async function connectorsKeyringList(
  adapterId: string,
  accounts: string[]
): Promise<string[]> {
  return invoke<string[]>("connectors_keyring_list", { adapterId, accounts })
}

// ---------------------------------------------------------------------------
// Task 22 — outbound HTTP
// ---------------------------------------------------------------------------

export async function connectorsHttpRequest(req: TauriHttpRequest): Promise<TauriHttpResponse> {
  return invoke<TauriHttpResponse>("connectors_http_request", { req })
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
  return invoke<string>("connectors_ws_open", { url, headers })
}

/**
 * Send a text message on an open WebSocket identified by `handleId`.
 */
export async function connectorsWsSend(handleId: string, data: string): Promise<void> {
  await invoke("connectors_ws_send", { handleId, data })
}

export async function connectorsWsClose(handleId: string): Promise<void> {
  await invoke("connectors_ws_close", { handleId })
}

// ---------------------------------------------------------------------------
// Task 24 — attachment cache
// ---------------------------------------------------------------------------

export async function connectorsAttachmentFetch(
  adapterId: string,
  remoteRef: string,
  sourceUrl: string
): Promise<AttachmentRef> {
  return invoke<AttachmentRef>("connectors_attachment_fetch", { adapterId, remoteRef, sourceUrl })
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
  return invoke<string>("connectors_lark_upload_file", {
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
  return invoke<string>("connectors_lark_upload_image", {
    accessToken: req.accessToken,
    sourceUrl: req.sourceUrl,
    imageType: req.imageType,
  })
}
