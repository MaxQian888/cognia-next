/**
 * PostHog product-analytics sink for behavior events (ADR-0074 / ADR-0102).
 *
 * The events this module ships are *manual captures* — no autocapture, no
 * pageviews, no session recording, no person profiles, no feature flags. That
 * is exactly PostHog's documented batch capture API, so this talks to
 * `POST {host}/batch/` directly instead of embedding `posthog-js`.
 *
 * The direct-HTTP shape is not an optimisation, it is a correctness
 * requirement: in the Tauri shell the renderer's CSP (`connect-src` in
 * `src-tauri/tauri.conf.json`) only allows `'self'`, the IPC origin and two
 * pinned hosts, so any SDK that opens its own XHR/fetch to PostHog is silently
 * blocked. Every outbound leg in this app goes through Rust, and so does this
 * one — `bootstrap.ts` injects `postJson` accordingly (Rust `reqwest` on
 * desktop, `fetch` on web/mobile).
 *
 * Wire format mirrors `@posthog/core`'s stateless batch sender:
 *   { api_key, sent_at, batch: [{ event, distinct_id, timestamp, uuid, properties }] }
 */

import type {
  BehaviorEventEnvelope,
  BehaviorEventExporter,
} from "@/lib/telemetry/events/track-event"
import type { TransportHealthSnapshot } from "@/types/logging"
import { hasNoLeakingPii } from "@cognia/redact"
import { recordDrop, type LogDropCounts, type LogDropReason } from "@cognia/logging/types/transport"

export interface PostHogDestination {
  enabled: boolean
  host: string
  projectToken: string
}

/** Injected transport. Rejects when the destination did not accept the batch. */
export type PostHogPostJson = (url: string, body: string, signal?: AbortSignal) => Promise<void>

export interface BuildPostHogProductExportersOptions {
  installationId: string
  appVersion: string
  runtime: string
  managed: PostHogDestination
  byo: PostHogDestination
  postJson?: PostHogPostJson
  /**
   * Gate the destination on `destinations.remote` instead of its own switch.
   *
   * The renderer has a per-destination consent toggle in Settings, so its
   * PostHog exporters carry their own permission and this stays off. A host
   * with no such UI — the headless brain, configured entirely from env — has
   * only the account-wide remote-destination consent to honour, and must not
   * treat an operator's env var as the user's permission to send off-device.
   */
  requiresRemoteConsent?: boolean
  /** Events buffered before an eager flush. */
  batchSize?: number
  /** Idle delay before a partial batch is flushed. `0` flushes synchronously. */
  flushIntervalMs?: number
  /** Hard cap on the pending queue; the oldest events are dropped past it. */
  maxQueuedEvents?: number
  /** Hard UTF-8 byte limit for one serialized `/batch/` request. */
  maxBatchBytes?: number
  /** Retries after the initial request for network, 408, 429, and 5xx failures. */
  maxRetries?: number
  /** Base delay for exponential retry backoff. */
  retryBaseMs?: number
  /** Test seam for retry timing. */
  sleepImpl?: (ms: number) => Promise<void>
}

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_FLUSH_INTERVAL_MS = 2_000
const DEFAULT_MAX_QUEUED_EVENTS = 200
const DEFAULT_MAX_BATCH_BYTES = 19 * 1024 * 1024
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 500

/**
 * Attribute names that could denote user-authored payload. A backstop under the
 * reviewed catalog, mirroring the sidecar's span-attribute gate.
 */
const CONTENT_ATTRIBUTE_PATTERN =
  /(?:prompt|completion|content|system|schema|argument|result|input|output|message|exception|stack|error|body|file|path|url|referrer)/i

/**
 * …but a name ending in one of these denotes a classifier or a measure, never
 * the payload itself. Without this carve-out the substring match above silently
 * ate `errorType`, `errorCode` and `resultCount` — so `chat.turn.failed` and
 * `workflow.run.failed` reached PostHog carrying no failure reason at all,
 * which is the one thing those events exist to report.
 */
const CLASSIFIER_SUFFIX_PATTERN = /(?:type|code|count|length|id|ms|tokens|bytes)$/i

function isContentAttributeName(key: string): boolean {
  return CONTENT_ATTRIBUTE_PATTERN.test(key) && !CLASSIFIER_SUFFIX_PATTERN.test(key)
}

interface PostHogWireEvent {
  event: string
  distinct_id: string
  timestamp: string
  uuid: string
  properties: Record<string, unknown>
}

interface QueuedEvent {
  wire: PostHogWireEvent
  resolve: () => void
  reject: (error: Error) => void
}

export function normalizePostHogOrigin(host: string): string | null {
  try {
    const url = new URL(host)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

export function isValidPostHogProject(host: string, projectToken: string): boolean {
  const token = projectToken.trim()
  return (
    normalizePostHogOrigin(host) !== null &&
    token.length > "phc_".length &&
    token.startsWith("phc_") &&
    !/\s/.test(token)
  )
}

function isValidPostHogDistinctId(value: string): boolean {
  return value.trim().length > 0 && value.length <= 200 && hasNoLeakingPii(value)
}

function isValidDestination(destination: PostHogDestination): boolean {
  return destination.enabled && isValidPostHogProject(destination.host, destination.projectToken)
}

/** PostHog's batch capture endpoint for a host. Empty when the host is unusable. */
export function postHogCaptureEndpoint(host: string): string {
  const origin = normalizePostHogOrigin(host)
  return origin ? `${origin}/batch/` : ""
}

function randomEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`
}

/**
 * Project one behavior envelope onto PostHog properties.
 *
 * Everything the app contributes is namespaced `cognia.*`; the `$`-prefixed
 * keys are PostHog's own ingestion controls. `$process_person_profile: false`
 * keeps the install anonymous (no person row), `$geoip_disable: true` is the
 * documented way to stop server-side IP enrichment.
 */
export function buildPostHogEventProperties(
  event: BehaviorEventEnvelope,
  options: Pick<BuildPostHogProductExportersOptions, "appVersion" | "runtime">
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    "cognia.schema_version": 1,
    "cognia.category": event.category,
    "cognia.runtime": options.runtime,
    "cognia.app_version": options.appVersion,
    $lib: "cognia",
    $lib_version: options.appVersion,
    $process_person_profile: false,
    $geoip_disable: true,
  }
  for (const [key, value] of Object.entries(event.attributes)) {
    if (isContentAttributeName(key)) continue
    properties[`cognia.${key}`] = value
  }
  return properties
}

class PostHogBatchExporter implements BehaviorEventExporter {
  readonly id: string
  readonly requiresRemoteConsent: boolean
  private readonly endpoint: string
  private readonly projectToken: string
  private readonly options: Required<
    Pick<
      BuildPostHogProductExportersOptions,
      | "installationId"
      | "appVersion"
      | "runtime"
      | "batchSize"
      | "flushIntervalMs"
      | "maxBatchBytes"
    >
  > & { maxQueuedEvents: number; maxRetries: number; retryBaseMs: number }
  private readonly postJson: PostHogPostJson
  private readonly sleepImpl: (ms: number) => Promise<void>
  private queue: QueuedEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private discardEpoch = 0
  private flushChain: Promise<void> = Promise.resolve()
  private inFlightCount = 0
  private lastSuccessAt: string | undefined
  private lastFailureAt: string | undefined
  private lastError: string | undefined
  private droppedEntries = 0
  /** The same losses, attributed — see `LOG_DROP_REASONS`. */
  private droppedByReason: LogDropCounts = {}

  /**
   * The ONLY way this transport loses an entry. Keeping the total and the
   * per-reason breakdown in one place is what makes them agree — two
   * separate `+=` sites is how they drift.
   */
  private recordDropped(reason: LogDropReason, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.droppedEntries += count
    recordDrop(this.droppedByReason, reason, count)
  }

  private retryCount = 0
  private discardReason = new Error("PostHog consent was withdrawn")
  private readonly activeControllers = new Set<AbortController>()
  private readonly flushOnPageHide: (() => void) | null

  constructor(
    id: "managed" | "byo",
    destination: PostHogDestination,
    options: BuildPostHogProductExportersOptions
  ) {
    this.id = `posthog-${id}`
    this.requiresRemoteConsent = options.requiresRemoteConsent === true
    this.endpoint = postHogCaptureEndpoint(destination.host)
    this.projectToken = destination.projectToken.trim()
    this.options = {
      installationId: options.installationId,
      appVersion: options.appVersion,
      runtime: options.runtime,
      batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxQueuedEvents: options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
      maxBatchBytes: options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    }
    this.postJson =
      options.postJson ??
      (async (url, body, signal) => {
        const response = await globalThis.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
          signal,
        })
        if (!response.ok) {
          throw new Error(`PostHog capture failed with ${response.status}`)
        }
      })
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    // Without this the last events of a session die in the buffer. `keepalive`
    // on the web fetch lets the request outlive the document; on desktop the
    // Rust leg is already out-of-process.
    // `typeof window` is not the test: the headless brain shims `window` onto
    // the bare Node global (lib/headless/node-indexeddb.ts), which has no
    // `addEventListener`. Probe the method itself.
    const canListen = typeof window !== "undefined" && typeof window.addEventListener === "function"
    this.flushOnPageHide = canListen
      ? () => {
          void this.flush()
        }
      : null
    if (this.flushOnPageHide) window.addEventListener("pagehide", this.flushOnPageHide)
  }

  export(event: BehaviorEventEnvelope): Promise<void> {
    if (this.closed) return Promise.reject(new Error("PostHog destination is closed"))
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        wire: {
          event: event.name,
          distinct_id: this.options.installationId,
          timestamp: new Date(event.at).toISOString(),
          uuid: randomEventId(),
          properties: buildPostHogEventProperties(event, this.options),
        },
        resolve,
        reject,
      })
      while (this.queue.length > this.options.maxQueuedEvents) {
        const dropped = this.queue.shift()
        if (dropped) {
          this.recordDropped("overflow-evicted", 1)
          this.lastFailureAt = new Date().toISOString()
          this.lastError = "PostHog queue overflow"
          dropped.reject(new Error(this.lastError))
        }
      }
      if (this.queue.length >= this.options.batchSize || this.options.flushIntervalMs <= 0) {
        void this.flush()
        return
      }
      this.timer ??= setTimeout(() => {
        this.timer = null
        void this.flush()
      }, this.options.flushIntervalMs)
    })
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const next = this.flushChain.then(() => this.flushQueuedBatches())
    this.flushChain = next.catch(() => {})
    return next
  }

  private async flushQueuedBatches(): Promise<void> {
    while (this.queue.length > 0) await this.flushNextBatch()
  }

  private async flushNextBatch(): Promise<void> {
    const batch = this.queue.splice(0, this.options.batchSize)
    if (batch.length === 0) return
    this.inFlightCount = batch.length
    const batchEpoch = this.discardEpoch
    try {
      await this.deliverBatch(batch, batchEpoch)
    } finally {
      if (batchEpoch === this.discardEpoch) this.inFlightCount = 0
    }
  }

  private async deliverBatch(batch: QueuedEvent[], batchEpoch: number): Promise<void> {
    if (batchEpoch !== this.discardEpoch) {
      for (const item of batch) item.reject(this.discardReason)
      return
    }
    const body = JSON.stringify({
      api_key: this.projectToken,
      sent_at: new Date().toISOString(),
      batch: batch.map((item) => item.wire),
    })
    if (utf8ByteLength(body) > this.options.maxBatchBytes) {
      if (batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2)
        await this.deliverBatch(batch.slice(0, midpoint), batchEpoch)
        await this.deliverBatch(batch.slice(midpoint), batchEpoch)
        return
      }
      this.rejectBatch(
        batch,
        new Error(`PostHog payload exceeds ${this.options.maxBatchBytes} byte limit`),
        batchEpoch
      )
      return
    }
    if (!hasNoLeakingPii(body)) {
      this.rejectBatch(batch, new Error("PostHog payload rejected by privacy gate"), batchEpoch)
      return
    }
    let failure: Error | null = null
    let shouldSplit = false
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (batchEpoch !== this.discardEpoch) {
        failure = this.discardReason
        break
      }
      const controller = new AbortController()
      this.activeControllers.add(controller)
      try {
        await abortable(this.postJson(this.endpoint, body, controller.signal), controller.signal)
        if (batchEpoch !== this.discardEpoch) {
          failure = this.discardReason
          break
        }
        this.lastSuccessAt = new Date().toISOString()
        this.lastError = undefined
        this.inFlightCount = Math.max(0, this.inFlightCount - batch.length)
        for (const item of batch) item.resolve()
        return
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        if (batchEpoch !== this.discardEpoch) {
          failure = this.discardReason
          break
        }
        if (postHogFailureStatus(failure) === 413 && batch.length > 1) {
          shouldSplit = true
          break
        }
        if (attempt >= this.options.maxRetries || !isRetryablePostHogFailure(failure)) {
          break
        }
        try {
          this.retryCount += 1
          await abortable(
            this.sleepImpl(Math.min(30_000, this.options.retryBaseMs * 2 ** attempt)),
            controller.signal
          )
        } catch (error) {
          failure =
            batchEpoch !== this.discardEpoch
              ? this.discardReason
              : error instanceof Error
                ? error
                : new Error(String(error))
          break
        }
      } finally {
        this.activeControllers.delete(controller)
      }
    }
    if (shouldSplit) {
      const midpoint = Math.ceil(batch.length / 2)
      await this.deliverBatch(batch.slice(0, midpoint), batchEpoch)
      await this.deliverBatch(batch.slice(midpoint), batchEpoch)
      return
    }
    // Best-effort telemetry: retry transient failures, then drop rather than
    // back-pressure the app or retain analytics after consent changes.
    this.rejectBatch(batch, failure ?? new Error("PostHog capture failed"), batchEpoch)
  }

  private rejectBatch(batch: QueuedEvent[], failure: Error, batchEpoch: number): void {
    const reason = batchEpoch === this.discardEpoch ? failure : this.discardReason
    if (batchEpoch === this.discardEpoch) {
      this.inFlightCount = Math.max(0, this.inFlightCount - batch.length)
      this.recordDropped("ship-failed", batch.length)
      this.lastFailureAt = new Date().toISOString()
      this.lastError = reason.message
    }
    for (const item of batch) item.reject(reason)
  }

  /** True once close or shutdown ran; a closed exporter can never send again. */
  get isClosed(): boolean {
    return this.closed
  }

  getHealth(): TransportHealthSnapshot {
    const queueDepth = this.queue.length + this.inFlightCount
    return {
      transport: this.id,
      status: this.lastError || queueDepth > 0 ? "degraded" : "healthy",
      queueDepth,
      retryCount: this.retryCount,
      droppedEntries: this.droppedEntries,
      droppedByReason: { ...this.droppedByReason },
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    }
  }

  /** Consent withdrawal: stop the timer and drop everything still queued. */
  close(): void {
    this.closed = true
    this.stopTimerAndListener()
    this.dropQueuedEvents(new Error("PostHog destination is closed"))
  }

  /** Master-consent withdrawal: discard this epoch but keep the config reusable. */
  discardPending(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.dropQueuedEvents(new Error("PostHog consent was withdrawn"))
  }

  /** Normal runtime teardown: stop accepting events and drain queued batches. */
  async shutdown(): Promise<void> {
    this.closed = true
    this.stopTimerAndListener()
    await this.flush()
  }

  private stopTimerAndListener(): void {
    if (this.flushOnPageHide) window.removeEventListener("pagehide", this.flushOnPageHide)
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private dropQueuedEvents(reason: Error): void {
    this.discardReason = reason
    this.discardEpoch += 1
    const dropped = this.queue
    this.queue = []
    this.recordDropped("shutdown-discarded", dropped.length + this.inFlightCount)
    this.inFlightCount = 0
    for (const controller of this.activeControllers) controller.abort(reason)
    this.activeControllers.clear()
    if (dropped.length > 0) {
      this.lastFailureAt = new Date().toISOString()
      this.lastError = reason.message
    }
    for (const item of dropped) item.reject(reason)
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRetryablePostHogFailure(error: Error): boolean {
  const status = postHogFailureStatus(error)
  return status === null || status === 408 || status === 429 || status >= 500
}

function postHogFailureStatus(error: Error): number | null {
  const explicitStatus = (error as Error & { status?: unknown }).status
  const status =
    typeof explicitStatus === "number"
      ? explicitStatus
      : Number(error.message.match(/\b([45]\d{2})\b/)?.[1] ?? Number.NaN)
  return Number.isFinite(status) ? status : null
}

/**
 * Live exporters, keyed by everything that changes their wire output or
 * delivery contract.
 *
 * `applyTransportSettings()` runs on every settings save, not only when the
 * PostHog config changed. Rebuilding the exporter each time would drop the
 * pending batch (and, under the old SDK integration, permanently opt the shared
 * client out), so an unchanged destination keeps its instance.
 */
const liveExporters = new Map<string, PostHogBatchExporter>()

function destinationKey(
  id: "managed" | "byo",
  destination: PostHogDestination,
  options: BuildPostHogProductExportersOptions
): string {
  return [
    id,
    normalizePostHogOrigin(destination.host),
    destination.projectToken.trim(),
    options.installationId,
    options.appVersion,
    options.runtime,
    options.requiresRemoteConsent === true ? "remote-consent" : "own-consent",
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
    options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES,
    options.maxRetries ?? DEFAULT_MAX_RETRIES,
    options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
  ].join("|")
}

export function buildPostHogProductExporters(
  options: BuildPostHogProductExportersOptions
): BehaviorEventExporter[] {
  const wanted = new Map<string, { id: "managed" | "byo"; destination: PostHogDestination }>()
  if (isValidPostHogDistinctId(options.installationId)) {
    for (const id of ["managed", "byo"] as const) {
      const destination = options[id]
      if (!isValidDestination(destination)) continue
      wanted.set(destinationKey(id, destination, options), { id, destination })
    }
  }
  for (const [key, exporter] of liveExporters) {
    if (wanted.has(key)) continue
    exporter.close()
    liveExporters.delete(key)
  }
  return [...wanted].map(([key, { id, destination }]) => {
    const existing = liveExporters.get(key)
    // A closed instance can never export again. It reaches this map when a
    // host tears its destinations down and starts them back up in the same
    // process — the headless brain's runtime lifecycle, and every test that
    // exercises it — so reusing one would silently discard every later event.
    if (existing && !existing.isClosed) return existing
    const created = new PostHogBatchExporter(id, destination, options)
    liveExporters.set(key, created)
    return created
  })
}

/** Test seam — drops the process-wide exporter registry. */
export function resetPostHogProductExporters(): void {
  for (const exporter of liveExporters.values()) exporter.close()
  liveExporters.clear()
}
