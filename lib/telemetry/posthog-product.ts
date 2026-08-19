import type {
  BehaviorEventEnvelope,
  BehaviorEventExporter,
} from "@/lib/telemetry/events/track-event"
import { loadPostHogBrowser } from "@/lib/telemetry/posthog-loader"

interface PostHogDestination {
  enabled: boolean
  host: string
  projectToken: string
}

interface PostHogCaptureEvent {
  event: string
  properties?: Record<string, unknown>
  [key: string]: unknown
}

interface PostHogClient {
  capture: (event: string, properties: Record<string, unknown>) => void
  opt_out_capturing?: () => void
  _requestQueue?: {
    _queue?: unknown[]
    _clearFlushTimeout?: () => void
  }
}

interface PostHogModule {
  init: (
    projectToken: string,
    config: Record<string, unknown>,
    instanceName: string
  ) => PostHogClient
}

interface BuildPostHogProductExportersOptions {
  installationId: string
  appVersion: string
  runtime: string
  managed: PostHogDestination
  byo: PostHogDestination
  loadPostHog?: () => Promise<PostHogModule>
}

const SAFE_TRANSPORT_PROPERTIES = new Set([
  "token",
  "distinct_id",
  "$insert_id",
  "$time",
  "$lib",
  "$lib_version",
  "$process_person_profile",
  "$ip",
])

const PRIVATE_PROPERTY_PATTERN =
  /(?:prompt|completion|content|system|schema|argument|result|input|output|message|exception|stack|error|body|file|path|url|referrer)/i

function normalizeHost(host: string): string | null {
  try {
    const url = new URL(host)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
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

export function sanitizePostHogCapturedEvent(
  capturedEvent: PostHogCaptureEvent | null
): PostHogCaptureEvent | null {
  if (!capturedEvent) return null
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(capturedEvent.properties ?? {})) {
    if (SAFE_TRANSPORT_PROPERTIES.has(key)) {
      properties[key] = value
      continue
    }
    if (!key.startsWith("cognia.") || PRIVATE_PROPERTY_PATTERN.test(key)) continue
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      properties[key] = value
    }
  }
  return { event: capturedEvent.event, properties }
}

function createExporter(
  id: "managed" | "byo",
  destination: PostHogDestination,
  options: BuildPostHogProductExportersOptions
): BehaviorEventExporter {
  let clientPromise: Promise<PostHogClient> | null = null
  const host = normalizeHost(destination.host)!
  const loadPostHog =
    options.loadPostHog ??
    (async () => {
      return (await loadPostHogBrowser()) as PostHogModule
    })

  const getClient = () => {
    clientPromise ??= loadPostHog().then((posthog) =>
      posthog.init(
        destination.projectToken.trim(),
        {
          api_host: host,
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: false,
          capture_exceptions: false,
          disable_persistence: true,
          persistence: "memory",
          disable_session_recording: true,
          disable_surveys: true,
          advanced_disable_feature_flags: true,
          advanced_disable_decide: true,
          person_profiles: "never",
          request_batching: true,
          bootstrap: { distinctID: options.installationId },
          before_send: sanitizePostHogCapturedEvent,
        },
        `cognia_${id}`
      )
    )
    return clientPromise
  }

  return {
    id: `posthog-${id}`,
    async close(): Promise<void> {
      if (!clientPromise) return
      const client = await clientPromise
      client.opt_out_capturing?.()
      // posthog-js has no public "discard pending batch" API. This pinned-version
      // seam is contract-tested so withdrawing consent cannot flush old events.
      client._requestQueue?._clearFlushTimeout?.()
      if (client._requestQueue?._queue) client._requestQueue._queue.length = 0
    },
    async export(event: BehaviorEventEnvelope): Promise<void> {
      const client = await getClient()
      const properties: Record<string, unknown> = {
        "cognia.schema_version": 1,
        "cognia.category": event.category,
        "cognia.runtime": options.runtime,
        "cognia.app_version": options.appVersion,
        $process_person_profile: false,
        $ip: null,
      }
      for (const [key, value] of Object.entries(event.attributes)) {
        if (!PRIVATE_PROPERTY_PATTERN.test(key)) properties[`cognia.${key}`] = value
      }
      client.capture(event.name, properties)
    },
  }
}

export function buildPostHogProductExporters(
  options: BuildPostHogProductExportersOptions
): BehaviorEventExporter[] {
  const exporters: BehaviorEventExporter[] = []
  if (isValidDestination(options.managed)) {
    exporters.push(createExporter("managed", options.managed, options))
  }
  if (isValidDestination(options.byo)) {
    exporters.push(createExporter("byo", options.byo, options))
  }
  return exporters
}
