import { hasNoLeakingPii } from "@cognia/redact"
import { appendBehaviorEvent } from "@/lib/db/behavior-events"
import { isBehaviorTelemetryEnabled } from "./settings"
import type { TelemetryEventCatalog, TelemetryEventName } from "./catalog"

type EventAttributes = Record<string, string | number | boolean>
type EventExporter = (body: string) => Promise<void>

let exporter: EventExporter | null = null

export function configureBehaviorEventExporter(next: EventExporter | null): void {
  exporter = next
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
  if (!isBehaviorTelemetryEnabled()) return false
  const normalized = attributes as EventAttributes
  if (!hasNoLeakingPii(JSON.stringify({ name, attributes: normalized }))) return false

  const at = Date.now()
  const sessionId = "sessionId" in normalized ? String(normalized.sessionId) : undefined
  const writes: Promise<unknown>[] = [
    appendBehaviorEvent({ eventName: name, at, sessionId, attributes: normalized }),
  ]
  if (exporter) writes.push(exporter(toOtlpLogBody(name, normalized, at)))
  const results = await Promise.allSettled(writes)
  return results.some((result) => result.status === "fulfilled")
}

export const __TESTING__ = { toOtlpLogBody }
