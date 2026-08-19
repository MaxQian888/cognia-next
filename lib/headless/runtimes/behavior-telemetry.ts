/**
 * Loads account-scoped behavior telemetry consent before headless workflow,
 * connector, and agent-team runtimes start emitting lifecycle events, and
 * installs the brain's remote sinks.
 *
 * The brain has no Settings UI, so every remote destination is configured from
 * the environment and every one of them is gated on `destinations.remote` —
 * an operator setting an env var expresses the *deployment's* intent, never
 * the account holder's consent to send events off-device. The durable local
 * sink stays independently available.
 */
import { getSettings } from "@/lib/db/settings"
import { getDb } from "@/lib/db/schema"
import { liveQuery } from "dexie"
import { APP_VERSION } from "@/lib/app-version"
import {
  configureBehaviorTelemetrySettings,
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
} from "@/lib/telemetry/events/settings"
import {
  configureBehaviorEventExporters,
  createOtlpBehaviorEventExporter,
  type BehaviorEventExporter,
} from "@/lib/telemetry/events/track-event"
import { buildPostHogProductExporters } from "@/lib/telemetry/posthog-product"
import { registerHeadlessRuntime } from "../registry"

type Env = Record<string, string | undefined> | undefined

function readEnv(): Env {
  return typeof process === "undefined" ? undefined : process.env
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim()
}

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

function buildOtlpExporter(environment: Env): BehaviorEventExporter | null {
  const logsEndpoint = trimmed(environment?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
  const baseEndpoint = trimmed(environment?.OTEL_EXPORTER_OTLP_ENDPOINT)
  const endpoint =
    logsEndpoint || (baseEndpoint ? `${baseEndpoint.replace(/\/$/, "")}/v1/logs` : "")
  if (!endpoint) return null
  return createOtlpBehaviorEventExporter(async (body) => {
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
}

/** Why the PostHog destination could not be installed, for a one-shot warning. */
type PostHogSkipReason = "unconfigured" | "missing-installation-id"

export interface HeadlessPostHogResolution {
  exporters: BehaviorEventExporter[]
  skipped: PostHogSkipReason | null
}

/**
 * Resolve the brain's PostHog destination from the environment.
 *
 * `COGNIA_POSTHOG_*` is the headless form; `NEXT_PUBLIC_POSTHOG_*` is accepted
 * as a fallback so a deployment that already carries the renderer's managed
 * project does not need the values twice.
 *
 * The installation id is deliberately NOT auto-generated here. The brain's
 * `localStorage` is the in-memory shim from `lib/headless/node-indexeddb.ts`,
 * so a minted id would be new on every restart and PostHog would count one
 * install as a fresh person per process — worse than no data. Without a pinned
 * `COGNIA_OBSERVABILITY_INSTALLATION_ID` (the same variable the desktop already
 * passes to its sidecar) the destination stays off and says so.
 */
export function resolveHeadlessPostHogExporters(environment: Env): HeadlessPostHogResolution {
  const host =
    trimmed(environment?.COGNIA_POSTHOG_HOST) || trimmed(environment?.NEXT_PUBLIC_POSTHOG_HOST)
  const projectToken =
    trimmed(environment?.COGNIA_POSTHOG_PROJECT_TOKEN) ||
    trimmed(environment?.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN)
  if (!host || !projectToken) return { exporters: [], skipped: "unconfigured" }

  const installationId = trimmed(environment?.COGNIA_OBSERVABILITY_INSTALLATION_ID)
  if (!installationId) return { exporters: [], skipped: "missing-installation-id" }

  const exporters = buildPostHogProductExporters({
    installationId,
    appVersion: trimmed(environment?.COGNIA_APP_VERSION) || APP_VERSION,
    runtime: "brain",
    // No per-destination switch exists off-desktop, so the account-wide remote
    // consent is the gate.
    requiresRemoteConsent: true,
    managed: { enabled: false, host: "", projectToken: "" },
    byo: { enabled: true, host, projectToken },
  })
  // A host or token the shared validator rejects (wrong scheme, a Personal API
  // Key) yields no exporter; report it the same way as an absent one.
  return { exporters, skipped: exporters.length > 0 ? null : "unconfigured" }
}

interface HeadlessExporters {
  remoteConfigured: boolean
  posthogSkipped: PostHogSkipReason | null
}

function configureHeadlessExporters(environment: Env): HeadlessExporters {
  const otlp = buildOtlpExporter(environment)
  const posthog = resolveHeadlessPostHogExporters(environment)
  const exporters = [...(otlp ? [otlp] : []), ...posthog.exporters]
  configureBehaviorEventExporters(exporters)
  return {
    remoteConfigured: exporters.length > 0,
    posthogSkipped: posthog.skipped,
  }
}

registerHeadlessRuntime({
  name: "behavior-telemetry",
  hosts: ["brain"],
  start: async (ctx) => {
    const { remoteConfigured: remoteExporterConfigured, posthogSkipped } =
      configureHeadlessExporters(readEnv())
    let warnedMissingRemoteExporter = false
    let warnedPostHogSkipped = false
    const loadPolicy = async () => {
      const settings = await getSettings()
      const persisted = await getDb().settings.get("singleton")
      const policy = persisted?.behaviorTelemetry ?? {
        ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
        enabled: settings.telemetryEnabled ?? false,
      }
      const wantsRemote = policy.enabled && policy.destinations.remote
      if (wantsRemote && !remoteExporterConfigured && !warnedMissingRemoteExporter) {
        warnedMissingRemoteExporter = true
        ctx.log(
          "warn",
          "behavior telemetry remote destination requires OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
        )
      }
      // A misconfigured PostHog destination is only worth a warning once the
      // account actually asked for remote export — an operator who never
      // intended to use PostHog should not see this at all.
      if (wantsRemote && posthogSkipped === "missing-installation-id" && !warnedPostHogSkipped) {
        warnedPostHogSkipped = true
        ctx.log(
          "warn",
          "PostHog behavior export is configured but disabled: set COGNIA_OBSERVABILITY_INSTALLATION_ID to a stable value, or the brain would report a new person on every restart"
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
      // Closes every destination, which for PostHog drops whatever is still
      // buffered rather than flushing it after consent context is gone.
      configureBehaviorEventExporters([])
    }
  },
})
