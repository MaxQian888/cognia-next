/**
 * Loads account-scoped behavior telemetry consent before headless workflow,
 * connector, and agent-team runtimes start emitting lifecycle events.
 * Remote OTLP still requires an exporter configured by the host; the brain's
 * durable local sink remains independently available.
 */
import { getSettings } from "@/lib/db/settings"
import { getDb } from "@/lib/db/schema"
import { liveQuery } from "dexie"
import {
  configureBehaviorTelemetrySettings,
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
} from "@/lib/telemetry/events/settings"
import { configureBehaviorEventExporter } from "@/lib/telemetry/events/track-event"
import { registerHeadlessRuntime } from "../registry"

function parseOtlpHeaders(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => {
        const separator = entry.indexOf("=")
        if (separator <= 0) return null
        const key = entry.slice(0, separator).trim()
        const encodedValue = entry.slice(separator + 1).trim()
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(encodedValue)) {
          return null
        }
        try {
          const decodedValue = decodeURIComponent(encodedValue)
          return /[\r\n]/.test(decodedValue) ? null : ([key, decodedValue] as const)
        } catch {
          return null
        }
      })
      .filter((entry): entry is readonly [string, string] => entry !== null)
  )
}

function configureHeadlessExporter(): boolean {
  const environment = typeof process === "undefined" ? undefined : process.env
  const logsEndpoint = (environment?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? "").trim()
  const baseEndpoint = (environment?.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim()
  const endpoint =
    logsEndpoint || (baseEndpoint ? `${baseEndpoint.replace(/\/$/, "")}/v1/logs` : "")
  if (!endpoint) {
    configureBehaviorEventExporter(null)
    return false
  }
  configureBehaviorEventExporter(async (body) => {
    const configuredHeaders = parseOtlpHeaders(
      environment?.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? environment?.OTEL_EXPORTER_OTLP_HEADERS ?? ""
    )
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...configuredHeaders, "content-type": "application/json" },
      body,
    })
    if (!response.ok) {
      throw new Error(`OTLP logs export failed with ${response.status}`)
    }
  })
  return true
}

registerHeadlessRuntime({
  name: "behavior-telemetry",
  hosts: ["brain"],
  start: async (ctx) => {
    const remoteExporterConfigured = configureHeadlessExporter()
    let warnedMissingRemoteExporter = false
    const loadPolicy = async () => {
      const settings = await getSettings()
      const persisted = await getDb().settings.get("singleton")
      const policy = persisted?.behaviorTelemetry ?? {
        ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
        enabled: settings.telemetryEnabled ?? false,
      }
      if (
        policy.enabled &&
        policy.destinations.remote &&
        !remoteExporterConfigured &&
        !warnedMissingRemoteExporter
      ) {
        warnedMissingRemoteExporter = true
        ctx.log(
          "warn",
          "behavior telemetry remote destination requires OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
        )
      }
      return policy
    }

    configureBehaviorTelemetrySettings(await loadPolicy())
    const subscription = liveQuery(loadPolicy).subscribe({
      next: (policy) => configureBehaviorTelemetrySettings(policy),
      error: (error) =>
        ctx.log(
          "warn",
          `behavior telemetry settings refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
    })
    return () => {
      subscription.unsubscribe()
      configureBehaviorTelemetrySettings(null)
      configureBehaviorEventExporter(null)
    }
  },
})
