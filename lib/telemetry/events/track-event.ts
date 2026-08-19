import { hasNoLeakingPii } from "@cognia/redact"
import { appendBehaviorEvent } from "@/lib/db/behavior-events"
import { getBehaviorTelemetrySettings } from "./settings"
import {
  TELEMETRY_EVENT_CATALOG,
  type TelemetryEventCatalog,
  type TelemetryEventName,
} from "./catalog"

type EventAttributes = Record<string, string | number | boolean>
type LegacyEventExporter = (body: string) => Promise<void>

export interface BehaviorEventEnvelope {
  name: TelemetryEventName
  category: (typeof TELEMETRY_EVENT_CATALOG)[TelemetryEventName]["category"]
  at: number
  attributes: EventAttributes
}

export interface BehaviorEventExporter {
  id: string
  export: (event: BehaviorEventEnvelope) => Promise<void>
  /** The legacy generic OTLP sink remains gated by `destinations.remote`. */
  requiresRemoteConsent?: boolean
  /** Withdraw consent immediately and discard any destination-owned queue. */
  close?: () => void | Promise<void>
}

let exporters: BehaviorEventExporter[] = []

export function configureBehaviorEventExporter(next: LegacyEventExporter | null): void {
  for (const exporter of exporters) void exporter.close?.()
  exporters = next
    ? [
        {
          id: "otlp",
          requiresRemoteConsent: true,
          export: (event) => next(toOtlpLogBody(event.name, event.attributes, event.at)),
        },
      ]
    : []
}

export function configureBehaviorEventExporters(next: BehaviorEventExporter[]): void {
  for (const exporter of exporters) void exporter.close?.()
  exporters = [...next]
}

export function createOtlpBehaviorEventExporter(
  exportBody: LegacyEventExporter
): BehaviorEventExporter {
  return {
    id: "otlp",
    requiresRemoteConsent: true,
    export: (event) => exportBody(toOtlpLogBody(event.name, event.attributes, event.at)),
  }
}

function normalizeEventAttributes(value: unknown): EventAttributes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length > 32) return null

  const normalized: EventAttributes = {}
  for (const [key, attribute] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return null
    if (typeof attribute === "number") {
      if (!Number.isFinite(attribute)) return null
      normalized[key] = attribute
      continue
    }
    if (typeof attribute === "string") {
      if (attribute.length > 512) return null
      normalized[key] = attribute
      continue
    }
    if (typeof attribute === "boolean") {
      normalized[key] = attribute
      continue
    }
    return null
  }
  return normalized
}

function toOtlpLogBody(name: TelemetryEventName, attributes: EventAttributes, at: number): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "cognia-ai" } }] },
        scopeLogs: [
          {
            scope: { name: "cognia.behavior" },
            logRecords: [
              {
                timeUnixNano: `${at}000000`,
                body: { stringValue: name },
                attributes: [
                  { key: "event.name", value: { stringValue: name } },
                  ...Object.entries(attributes).map(([key, value]) => ({
                    key,
                    value:
                      typeof value === "boolean"
                        ? { boolValue: value }
                        : typeof value === "number"
                          ? { doubleValue: value }
                          : { stringValue: value },
                  })),
                ],
              },
            ],
          },
        ],
      },
    ],
  })
}

export async function trackEvent<Name extends TelemetryEventName>(
  name: Name,
  attributes: TelemetryEventCatalog[Name]
): Promise<boolean> {
  const settings = getBehaviorTelemetrySettings()
  if (!settings.enabled) return false
  const definition = TELEMETRY_EVENT_CATALOG[name]
  if (!definition || !settings.categories[definition.category]) return false
  if (
    settings.sampleRate <= 0 ||
    (settings.sampleRate < 1 && Math.random() >= settings.sampleRate)
  ) {
    return false
  }
  const normalized = normalizeEventAttributes(attributes)
  if (!normalized) return false
  if (!hasNoLeakingPii(JSON.stringify({ name, attributes: normalized }))) return false

  const at = Date.now()
  const envelope: BehaviorEventEnvelope = {
    name,
    category: definition.category,
    at,
    attributes: normalized,
  }
  const sessionId = "sessionId" in normalized ? String(normalized.sessionId) : undefined
  const writes: Promise<unknown>[] = []
  if (settings.destinations.local) {
    writes.push(
      appendBehaviorEvent(
        { eventName: name, at, sessionId, attributes: normalized },
        { maxEntries: settings.maxStoredEvents, maxAgeDays: settings.retentionDays }
      )
    )
  }
  for (const eventExporter of exporters) {
    if (eventExporter.requiresRemoteConsent && !settings.destinations.remote) continue
    writes.push(eventExporter.export(envelope))
  }
  const results = await Promise.allSettled(writes)
  return results.some((result) => result.status === "fulfilled")
}

export const __TESTING__ = { toOtlpLogBody }
