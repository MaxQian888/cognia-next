// What may leave the process in a span sent to a generic OTLP collector or
// PostHog: an allowlist of attribute keys, bounded values, no content, no
// exception text, and a final PII scan that drops the whole span if anything
// still leaks.

import type { Attributes } from "@opentelemetry/api"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { overlay } from "../../shared/overlay.ts"

type SpanResource = ReadableSpan["resource"]
type ExportCallback = Parameters<SpanExporter["export"]>[1]

/** An attribute value after bounding: strings cut to 512 characters, arrays to 16 items. */
export type BoundedValue = string | number | boolean | BoundedValue[]

const PRIVATE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "ai.prompt",
  "ai.response",
  "exception.message",
  "exception.stacktrace",
])

const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.conversation.id",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "openinference.span.kind",
  "posthog.distinct_id",
  "error.type",
  "http.response.status_code",
  "server.address",
])

const ALLOWED_RESOURCE_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "service.name",
  "service.version",
  "deployment.environment.name",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
])

function isAllowedAttributeKey(key: string): boolean {
  return (
    ALLOWED_ATTRIBUTE_KEYS.has(key) ||
    /^gen_ai\.usage\./.test(key) ||
    /^cognia\.(?:trace_id|cost\.|surface$|span\.status$|usage\.|(?:run|turn|attempt|project|plugin)\.id$)/.test(
      key
    )
  )
}

export function boundedAttributeValue(value: unknown): BoundedValue | undefined {
  if (typeof value === "string") return value.slice(0, 512)
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value
      .slice(0, 16)
      .map(boundedAttributeValue)
      .filter((item) => item !== undefined)
  }
  return undefined
}

function sanitizeAttributes(attributes: Attributes = {}): Record<string, BoundedValue> {
  return Object.fromEntries(
    Object.entries(attributes)
      .slice(0, 32)
      .flatMap(([key, value]): [string, BoundedValue][] => {
        if (PRIVATE_ATTRIBUTE_KEYS.has(key)) return []
        if (
          /(?:^|\.)(?:prompt|completion|content|system_prompt|schema|arguments?|results?|inputs?|outputs?|exception|stack|message|body|file|path|url|referrer)(?:$|\.)/i.test(
            key
          ) ||
          !isAllowedAttributeKey(key)
        ) {
          return []
        }
        const bounded = boundedAttributeValue(value)
        return bounded === undefined ? [] : [[key, bounded]]
      })
  )
}

/** The span resource with only the allowlisted service/SDK attributes. */
export function sanitizeResource(resource: SpanResource): SpanResource {
  if (!resource || typeof resource !== "object") return resource
  const attributes = Object.fromEntries(
    Object.entries(resource.attributes ?? {}).flatMap(([key, value]): [string, BoundedValue][] => {
      if (!ALLOWED_RESOURCE_ATTRIBUTE_KEYS.has(key)) return []
      const bounded = boundedAttributeValue(value)
      return bounded === undefined ? [] : [[key, bounded]]
    })
  )
  return overlay(resource, { attributes })
}

export function sanitizeReadableSpan(span: ReadableSpan): ReadableSpan {
  return overlay(span, {
    attributes: sanitizeAttributes(span.attributes),
    resource: sanitizeResource(span.resource),
    status: span.status ? { code: span.status.code } : span.status,
    links: [],
    events: (span.events ?? [])
      .filter((event) => !/(?:exception|error|message|prompt|content)/i.test(event.name))
      .slice(0, 8)
      .map((event) => ({
        ...event,
        attributes: sanitizeAttributes(event.attributes),
      })),
  })
}

export function isPrivacySafeReadableSpan(span: ReadableSpan): boolean {
  return hasNoLeakingPiiDeep({
    name: span.name,
    attributes: span.attributes,
    resourceAttributes: span.resource?.attributes,
    instrumentationScope: span.instrumentationScope,
    events: span.events,
  })
}

/** Wraps a remote exporter so only sanitized, PII-free spans reach it. */
export class PrivacyFilteringSpanExporter implements SpanExporter {
  readonly delegate: SpanExporter

  constructor(delegate: SpanExporter) {
    this.delegate = delegate
  }

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    const safeSpans = spans.map(sanitizeReadableSpan).filter(isPrivacySafeReadableSpan)
    if (safeSpans.length === 0) {
      resultCallback({ code: 0 })
      return
    }
    this.delegate.export(safeSpans, resultCallback)
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown()
  }

  forceFlush(): Promise<void> {
    return typeof this.delegate.forceFlush === "function"
      ? this.delegate.forceFlush()
      : Promise.resolve()
  }
}
