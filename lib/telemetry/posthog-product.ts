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

export interface PostHogDestination {
  enabled: boolean
  host: string
  projectToken: string
}

/** Injected transport. Rejects when the destination did not accept the batch. */
export type PostHogPostJson = (url: string, body: string) => Promise<void>

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
}

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_FLUSH_INTERVAL_MS = 2_000
const DEFAULT_MAX_QUEUED_EVENTS = 200

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

function normalizeHost(host: string): string | null {
  try {
    const url = new URL(host)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password) return null
    return url.origin
  } catch {
    return null
  }
}

function isValidDestination(destination: PostHogDestination): boolean {
  return (
    destination.enabled &&
    normalizeHost(destination.host) !== null &&
    destination.projectToken.trim().startsWith("phc_")
  )
}

/** PostHog's batch capture endpoint for a host. Empty when the host is unusable. */
export function postHogCaptureEndpoint(host: string): string {
  const origin = normalizeHost(host)
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
      "installationId" | "appVersion" | "runtime" | "batchSize" | "flushIntervalMs"
    >
  > & { maxQueuedEvents: number }
  private readonly postJson: PostHogPostJson
  private queue: QueuedEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
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
    }
    this.postJson =
      options.postJson ??
      (async (url, body) => {
        const response = await globalThis.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        })
        if (!response.ok) {
          throw new Error(`PostHog capture failed with ${response.status}`)
        }
      })
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
        this.queue.shift()?.reject(new Error("PostHog queue overflow"))
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

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batch = this.queue
    this.queue = []
    if (batch.length === 0) return
    const body = JSON.stringify({
      api_key: this.projectToken,
      sent_at: new Date().toISOString(),
      batch: batch.map((item) => item.wire),
    })
    try {
      await this.postJson(this.endpoint, body)
      for (const item of batch) item.resolve()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      // Best-effort telemetry: a failed batch is dropped rather than retried
      // forever, exactly like the OTLP transport's terminal failure path.
      for (const item of batch) item.reject(failure)
    }
  }

  /** True once `close()` ran; a closed exporter can never send again. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Consent withdrawal: stop the timer and drop everything still queued. */
  close(): void {
    this.closed = true
    if (this.flushOnPageHide) window.removeEventListener("pagehide", this.flushOnPageHide)
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const dropped = this.queue
    this.queue = []
    for (const item of dropped) item.reject(new Error("PostHog destination is closed"))
  }
}

/**
 * Live exporters, keyed by everything that changes their wire output.
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
    normalizeHost(destination.host),
    destination.projectToken.trim(),
    options.installationId,
    options.appVersion,
    options.runtime,
    options.requiresRemoteConsent === true ? "remote-consent" : "own-consent",
  ].join("|")
}

export function buildPostHogProductExporters(
  options: BuildPostHogProductExportersOptions
): BehaviorEventExporter[] {
  const wanted = new Map<string, { id: "managed" | "byo"; destination: PostHogDestination }>()
  for (const id of ["managed", "byo"] as const) {
    const destination = options[id]
    if (!isValidDestination(destination)) continue
    wanted.set(destinationKey(id, destination, options), { id, destination })
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
