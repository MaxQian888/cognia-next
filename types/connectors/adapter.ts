import type { PlatformKind } from "./platform-kind"
import type { A2UICapabilityMatrix, Capability } from "./capability"
import type { NormalizedInboundEvent } from "./event"
import type { OutboundRequest, OutboundResult } from "./outbound"

export type TransportMode = "longpoll" | "webhook" | "reverse-ws" | "gateway" | "imap-smtp" | "stub" // tests only

export interface AdapterMeta {
  type: PlatformKind
  displayName: string
  version: string
  capabilities: readonly Capability[]
  transportModes: readonly TransportMode[]
  /** JSON Schema (draft-07) describing the per-instance settings shape. Drives the auto-generated form. */
  configSchema: object
}

export type AdapterHealthState = "starting" | "running" | "degraded" | "down"

export interface AdapterHealth {
  state: AdapterHealthState
  reason?: string
  /** Wall-clock timestamp of the last successful inbound or outbound. */
  lastActivityAt?: number
}

export interface AdapterLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

/** Keyring helpers scoped to one adapter instance. Backed by Tauri keyring on desktop, refused on web. */
export interface AdapterSecrets {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  list(): Promise<string[]>
}

export interface AdapterAttachmentRef {
  /** Local file URL — the renderer can resolve via a Tauri convertFileSrc. */
  localUrl: string
  /** Original platform-side reference (e.g. Telegram file_id). */
  remoteRef: string
}

export interface AttachmentDescriptor {
  url: string
  name?: string
  mimeType?: string
  sizeBytes?: number
}

export interface HistoryFetchOpts {
  before?: string
  after?: string
  max?: number
}

export interface AdapterContext {
  /** Push a normalized inbound event to the bus. */
  emit: (event: NormalizedInboundEvent) => Promise<void>
  /** Reach into Rust-side connectors_* commands. */
  tauri: {
    httpRequest: (req: TauriHttpRequest) => Promise<TauriHttpResponse>
    openWs: (req: TauriWsRequest) => Promise<TauriWsHandle>
    fetchAttachment: (adapterId: string, remoteRef: string) => Promise<AdapterAttachmentRef>
    bindWebhookRoute: (adapterId: string, path: string) => Promise<void>
    unbindWebhookRoute: (adapterId: string, path: string) => Promise<void>
    /** Resolve the public URL prefix the user pasted into the platform. */
    publicBaseUrl: () => Promise<string | null>
  }
  secrets: AdapterSecrets
  logger: AdapterLogger
  /** Aborts when the adapter stops; long-running loops should respect this. */
  signal: AbortSignal
  /** This instance's id; convenience accessor. */
  adapterId: string
}

export interface TauriHttpRequest {
  url: string
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface TauriHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface TauriWsRequest {
  url: string
  headers?: Record<string, string>
}

export interface TauriWsHandle {
  /** Stable handle id. Renderer subscribes to `connectors://ws/<id>` events. */
  id: string
  send: (data: string) => Promise<void>
  close: () => Promise<void>
}

export interface PlatformAdapter {
  readonly meta: AdapterMeta
  readonly id: string

  start(ctx: AdapterContext): Promise<void>
  stop(): Promise<void>
  health(): AdapterHealth

  send(req: OutboundRequest): Promise<OutboundResult>
  edit?(messageId: string, patch: OutboundRequest): Promise<OutboundResult>
  delete?(messageId: string): Promise<void>
  setTyping?(conversationKey: string, on: boolean): Promise<void>
  uploadFile?(file: AttachmentDescriptor): Promise<AdapterAttachmentRef>
  fetchHistory?(
    conversationKey: string,
    opts: HistoryFetchOpts
  ): AsyncIterable<NormalizedInboundEvent>
  refreshCredentials?(): Promise<void>
  /**
   * Per-adapter A2UI projection matrix. Returned synchronously so
   * `build-options.ts:resolveSendOptions` can inject a capability-aware
   * system prompt without an async fan-out at every send.
   *
   * Adapters that do not implement any native A2UI projection should still
   * return a matrix where everything defaults to `"fallback"` — the
   * assistant remains free to emit A2UI, but every component will degrade
   * to `plainTextMirror`. Returning `undefined` is reserved for the `stub`
   * adapter used in tests.
   */
  a2uiCapability(): A2UICapabilityMatrix
  /**
   * Declare which built-in skill families this adapter can serve in v1
   * (ADR-0026). Read at adapter start and cached on
   * `AdapterInstanceRow.lastKnownSkillCapabilities` so the hot send
   * path (build-options) doesn't pay for a registry walk per turn.
   *
   * Adapters that don't expose any built-in skill family return `[]`.
   * The return shape lives in `types/connectors/skill-capability.ts`.
   *
   * Optional for backward compat — adapters that haven't been updated
   * are treated as "no built-in skill capabilities" by the resolver.
   */
  platformSkillCapabilities?(): readonly import("./skill-capability").PlatformSkillCapability[]
}
