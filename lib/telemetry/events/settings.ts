export const BEHAVIOR_TELEMETRY_STORAGE_KEY = "cognia-behavior-telemetry-enabled"

export const BEHAVIOR_TELEMETRY_CATEGORIES = [
  "chat",
  "workflow",
  "connector",
  "agentTeam",
  /**
   * Shell-level product usage that belongs to no single AI domain: launches,
   * screen views, command-palette / slash-command use, plugin installs. Kept
   * out of `system` because that bucket means "telemetry's own plumbing" and a
   * user turning it off should not also lose the ability to opt out of usage
   * analytics — or vice versa.
   */
  "app",
  "system",
] as const

export type BehaviorTelemetryCategory = (typeof BEHAVIOR_TELEMETRY_CATEGORIES)[number]

export interface BehaviorTelemetrySettings {
  enabled: boolean
  destinations: {
    local: boolean
    remote: boolean
  }
  categories: Record<BehaviorTelemetryCategory, boolean>
  /** Fraction of eligible events retained, in the inclusive range 0..1. */
  sampleRate: number
  retentionDays: number
  maxStoredEvents: number
}

export const DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS: BehaviorTelemetrySettings = {
  enabled: false,
  destinations: { local: true, remote: false },
  categories: {
    chat: true,
    workflow: true,
    connector: true,
    agentTeam: true,
    app: true,
    system: true,
  },
  sampleRate: 1,
  retentionDays: 30,
  maxStoredEvents: 10_000,
}

let runtimeSettings: BehaviorTelemetrySettings | null = null

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function sanitizeBehaviorTelemetrySettings(value: unknown): BehaviorTelemetrySettings {
  const source = record(value)
  const destinations = record(source.destinations)
  const categories = record(source.categories)

  return {
    enabled: boolean(source.enabled, DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.enabled),
    destinations: {
      local: boolean(destinations.local, DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.destinations.local),
      remote: boolean(destinations.remote, DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.destinations.remote),
    },
    categories: Object.fromEntries(
      BEHAVIOR_TELEMETRY_CATEGORIES.map((category) => [
        category,
        boolean(categories[category], DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.categories[category]),
      ])
    ) as Record<BehaviorTelemetryCategory, boolean>,
    sampleRate: boundedNumber(
      source.sampleRate,
      DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.sampleRate,
      0,
      1
    ),
    retentionDays: Math.round(
      boundedNumber(source.retentionDays, DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.retentionDays, 1, 365)
    ),
    maxStoredEvents: Math.round(
      boundedNumber(
        source.maxStoredEvents,
        DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.maxStoredEvents,
        100,
        100_000
      )
    ),
  }
}

export function getBehaviorTelemetrySettings(): BehaviorTelemetrySettings {
  if (runtimeSettings) return sanitizeBehaviorTelemetrySettings(runtimeSettings)
  if (typeof localStorage === "undefined") return sanitizeBehaviorTelemetrySettings(undefined)

  try {
    const raw = localStorage.getItem(BEHAVIOR_TELEMETRY_STORAGE_KEY)
    if (raw === "true") {
      // The legacy switch explicitly promised sharing, so preserve that consent
      // while moving it into the new independently configurable remote sink.
      return sanitizeBehaviorTelemetrySettings({
        ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
        enabled: true,
        destinations: { local: true, remote: true },
      })
    }
    if (raw === "false" || raw === null) {
      return sanitizeBehaviorTelemetrySettings(undefined)
    }
    return sanitizeBehaviorTelemetrySettings(JSON.parse(raw))
  } catch {
    return sanitizeBehaviorTelemetrySettings(undefined)
  }
}

export function saveBehaviorTelemetrySettings(settings: BehaviorTelemetrySettings): void {
  if (runtimeSettings) {
    runtimeSettings = sanitizeBehaviorTelemetrySettings(settings)
  }
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(
      BEHAVIOR_TELEMETRY_STORAGE_KEY,
      JSON.stringify(sanitizeBehaviorTelemetrySettings(settings))
    )
  } catch {
    // Consent reads fail closed; storage failures must never break the product.
  }
}

export function isBehaviorTelemetryEnabled(): boolean {
  return getBehaviorTelemetrySettings().enabled
}

export function setBehaviorTelemetryEnabled(enabled: boolean): BehaviorTelemetrySettings {
  const next = { ...getBehaviorTelemetrySettings(), enabled }
  saveBehaviorTelemetrySettings(next)
  return next
}

/** Install host-owned settings for runtimes without durable localStorage (for example the brain). */
export function configureBehaviorTelemetrySettings(
  settings: BehaviorTelemetrySettings | null
): void {
  runtimeSettings = settings ? sanitizeBehaviorTelemetrySettings(settings) : null
}
