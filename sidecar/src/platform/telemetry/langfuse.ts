// The Langfuse destination. Unlike generic OTLP and PostHog it may record
// model and tool content, but only the classes the user consented to, each
// value PII-scanned and bounded, and the span dropped if anything still leaks.

import type { Context } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { overlay } from "../../shared/overlay.ts"
import type { TelemetryEnv } from "./config.ts"
import { isPrivacySafeReadableSpan, sanitizeResource } from "./privacy.ts"
import { telemetrySession } from "./state.ts"

type ContentKind = "model" | "tool"

const LANGFUSE_CONTENT_ATTRIBUTE =
  /(?:^|[._])(?:input|output|inputs|outputs|prompt|completion|content|messages|instructions|arguments|result|tool_calls?)$/i

/** A JSON-like value with PII-bearing strings and keys removed; strings cut to `maxStringBytes`. */
export function sanitizeLangfuseValue(value: unknown, maxStringBytes = 512): unknown {
  if (typeof value === "string") {
    if (!hasNoLeakingPiiDeep(value)) return undefined
    return value.slice(0, maxStringBytes)
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((item) => sanitizeLangfuseValue(item, maxStringBytes))
      .filter((item) => item !== undefined)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .flatMap(([key, item]): [string, unknown][] => {
          if (!hasNoLeakingPiiDeep(key)) return []
          const safe = sanitizeLangfuseValue(item, maxStringBytes)
          return safe === undefined ? [] : [[key, safe]]
        })
    )
  }
  return undefined
}

function contentAllowed(kind: ContentKind): boolean {
  return kind === "tool" ? telemetrySession.consent.tool : telemetrySession.consent.model
}

function semanticContentKind(
  value: unknown,
  inherited: ContentKind | undefined
): ContentKind | undefined {
  if (!value || typeof value !== "object") return inherited
  const part = value as { role?: unknown; type?: unknown }
  const role = String(part.role ?? "").toLowerCase()
  const type = String(part.type ?? "").toLowerCase()
  if (role === "tool" || type.includes("tool")) return "tool"
  if (["system", "user", "assistant"].includes(role)) return "model"
  if (/(?:text|reasoning|image|audio)/.test(type)) return "model"
  return inherited
}

function sanitizeSemanticContent(value: unknown, inheritedKind: ContentKind | undefined): unknown {
  const kind = semanticContentKind(value, inheritedKind)
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return kind && contentAllowed(kind) ? sanitizeLangfuseValue(value, 4096) : undefined
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((item) => sanitizeSemanticContent(item, kind))
      .filter((item) => item !== undefined)
  }
  if (!value || typeof value !== "object") return undefined
  const safeObject = Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .flatMap(([key, item]): [string, unknown][] => {
        if (!hasNoLeakingPiiDeep(key)) return []
        const fieldKind: ContentKind | undefined =
          /(?:arguments?|args|results?|toolCallId|toolName)/i.test(key)
            ? "tool"
            : /(?:text|content|instructions?|prompt|completion)/i.test(key)
              ? (kind ?? "model")
              : kind
        const safe = sanitizeSemanticContent(item, fieldKind)
        return safe === undefined ? [] : [[key, safe]]
      })
  )
  return Object.keys(safeObject).length > 0 ? safeObject : undefined
}

function sanitizeMixedLangfuseContent(value: unknown): unknown {
  const { model, tool } = telemetrySession.consent
  let decoded = value
  let wasJsonString = false
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value)
      wasJsonString = true
    } catch {
      // An opaque input/output string cannot prove it excludes the other
      // consent class. Fail closed unless both classes were authorized.
      return model && tool ? sanitizeLangfuseValue(value, 4096) : undefined
    }
  }
  const safe = sanitizeSemanticContent(decoded, undefined)
  if (safe === undefined || !hasNoLeakingPiiDeep(safe)) return undefined
  return wasJsonString ? JSON.stringify(safe) : safe
}

function sanitizeLangfuseContentAttribute(
  key: string,
  value: unknown,
  isToolObservation: boolean
): unknown {
  const { model, tool } = telemetrySession.consent
  if (isToolObservation || /(?:arguments?|args|results?|tool_calls?)(?:$|\.)/i.test(key)) {
    return tool ? sanitizeLangfuseValue(value, 4096) : undefined
  }
  if (/(?:instructions?|prompt|completion)(?:$|\.)/i.test(key)) {
    return model ? sanitizeLangfuseValue(value, 4096) : undefined
  }
  return sanitizeMixedLangfuseContent(value)
}

/** The span as Langfuse may see it, or undefined when it cannot be made PII-free. */
export function sanitizeLangfuseReadableSpan(span: ReadableSpan): ReadableSpan | undefined {
  const { model, tool } = telemetrySession.consent
  const source = span.attributes ?? {}
  const observationType = String(source["langfuse.observation.type"] ?? "").toLowerCase()
  const operation = String(source["gen_ai.operation.name"] ?? "").toLowerCase()
  const isTool = observationType === "tool" || operation === "execute_tool"
  const captureContent = isTool ? tool : model
  const attributes = Object.fromEntries(
    Object.entries(source).flatMap(([key, value]): [string, unknown][] => {
      const isContent = LANGFUSE_CONTENT_ATTRIBUTE.test(key)
      if (isContent && !captureContent && !(model || tool)) return []
      const safe = isContent
        ? sanitizeLangfuseContentAttribute(key, value, isTool)
        : sanitizeLangfuseValue(value, 512)
      return safe === undefined ? [] : [[key, safe]]
    })
  )
  const sanitized = overlay(span, {
    name: sanitizeLangfuseValue(span.name, 128) ?? "llm.generate",
    attributes,
    resource: sanitizeResource(span.resource),
    status: span.status ? { code: span.status.code } : span.status,
    links: [],
    events: [],
    instrumentationScope: span.instrumentationScope
      ? {
          name: sanitizeLangfuseValue(span.instrumentationScope.name, 128) ?? "cognia.ai-sdk",
          version: sanitizeLangfuseValue(span.instrumentationScope.version, 64),
        }
      : span.instrumentationScope,
  })
  return isPrivacySafeReadableSpan(sanitized) ? sanitized : undefined
}

/**
 * The Langfuse span processor, loaded on first use: `@langfuse/otel` is a
 * sidecar-only dependency, and every ended span is sanitized before it is
 * handed over.
 */
export class LazyLangfuseSpanProcessor implements SpanProcessor {
  private readonly processor: Promise<SpanProcessor>

  constructor(env: TelemetryEnv) {
    const config = {
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
      environment: env.LANGFUSE_ENVIRONMENT,
      release: env.LANGFUSE_RELEASE,
    }
    this.processor = import("@langfuse/otel").then(
      ({ LangfuseSpanProcessor }) =>
        new LangfuseSpanProcessor({
          ...config,
          exportMode: "batched",
          mediaUploadEnabled: false,
          mask: ({ data }) => sanitizeLangfuseValue(data, 4096),
        })
    )
  }

  onStart(span: Span, parentContext: Context): void {
    void this.processor.then((processor) => processor.onStart(span, parentContext))
  }

  onEnd(span: ReadableSpan): void {
    const sanitized = sanitizeLangfuseReadableSpan(span)
    if (sanitized) void this.processor.then((processor) => processor.onEnd(sanitized))
  }

  forceFlush(): Promise<void> {
    return this.processor.then((processor) => processor.forceFlush())
  }

  shutdown(): Promise<void> {
    return this.processor.then((processor) => processor.shutdown())
  }
}

/** Drop the Langfuse secret from the process env once the processor holds it, so no child inherits it. */
export function scrubLangfuseSecretEnvironment(env: TelemetryEnv | undefined): void {
  if (!env || typeof env !== "object") return
  delete env.LANGFUSE_SECRET_KEY
}
