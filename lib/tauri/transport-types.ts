/**
 * Unified transport contract for Rust/server-side calls from the React UI.
 *
 * The same interface backs three runtime contexts:
 * - Tauri desktop  → `TauriTransport` (invoke/listen via `@tauri-apps/api`)
 * - Capacitor mobile → `CompanionTransport` (HTTP/WS to the desktop's axum server)
 * - Plain web      → `WebStubTransport` (rejects every call with a clear error)
 *
 * Pinning the contract here lets `lib/tauri.ts` swap implementations at module
 * load time without touching any consumer of the named-export wrappers.
 */
export interface TransportCallOptions {
  /**
   * Stable key owned by a durable queue row. Remote transports must reuse it
   * across retries and channel fallback so the host can deduplicate writes.
   */
  idempotencyKey?: string
}

/** Keep command deadlines identical across HTTPS, WebRTC and encrypted relay. */
export function transportCommandTimeoutMs(command: string): number {
  // First launch can install the broker (60s) and language pack (120s) before
  // the startup probe (30s). Leave download/proxy-install headroom, bounded so
  // a lost response still settles. Other RPCs retain their normal deadline.
  if (command === "codeserver_ensure") return 300_000
  // Native media operations run bounded FFmpeg jobs. Include metadata probes
  // and reply transfer headroom so every remote transport waits for the same job.
  if (command === "plugin_media_get_video_frame") return 180_000
  if (command === "video_analyze") return 660_000
  if (command === "video_trim") return 1_260_000
  if (command === "plugin_media_concatenate_videos" || command === "plugin_media_export_video")
    return 3_300_000
  if (command === "video_get_info" || command === "plugin_media_add_transition") return 90_000
  return 30_000
}

export type TransportBinaryResource = {
  kind: "session-media"
  sessionId: string
  /** Lower-case SHA-256 content hash. */
  hash: string
  variant: "thumbnail" | "canonical" | "original"
}

export interface TransportBinaryResponse {
  bytes: Uint8Array
  mediaType: string
  etag?: string
}

export interface Transport {
  /**
   * Invoke a named command on the underlying runtime and wait for its result.
   *
   * Implementations MUST reject (not throw synchronously) so callers can rely
   * on `await transport.call(...)` semantics regardless of the backend.
   */
  call<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: TransportCallOptions
  ): Promise<T>

  /**
   * Subscribe to a named event channel; `handler` runs for every payload the
   * runtime emits on that channel. The returned function detaches the handler;
   * implementations MUST make repeat calls to it safe (idempotent).
   */
  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void

  /**
   * Read a bounded binary resource without expanding it through JSON/base64.
   * Optional for legacy/local transports; callers capability-detect it and
   * retain the existing message URL path when unavailable.
   */
  readBinary?(resource: TransportBinaryResource): Promise<TransportBinaryResponse>
}
