import { detectPlatform } from "@/lib/platform/detect"
import { toReportableRoute } from "@/lib/telemetry/reportable-route"
import {
  BEHAVIOR_TELEMETRY_STORAGE_KEY,
  subscribeBehaviorTelemetrySettings,
} from "@/lib/telemetry/events/settings"

export const WEB_VITAL_NAMES = ["LCP", "INP", "CLS", "FCP", "TTFB", "FID"] as const
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number]
export const WEB_VITALS_STORAGE_KEY = "cognia-web-vitals-v1"

export interface WebVitalsSettings {
  enabled: boolean
  reporting: boolean
  metrics: Record<WebVitalName, boolean>
}

export interface WebVitalRecord {
  name: WebVitalName
  id: string
  value: number
  delta: number
  rating: "good" | "needs-improvement" | "poor"
  navigationType: string
  route: string
  runtime: string
  appVersion: string
  observedAt: number
}

export interface WebVitalsSnapshot {
  settings: WebVitalsSettings
  metrics: Partial<Record<WebVitalName, WebVitalRecord>>
  supported: WebVitalName[] | null
  started: boolean
  error: boolean
  persistenceError: boolean
}

interface Dependencies {
  storage?: Pick<Storage, "getItem" | "setItem">
  supportedEntryTypes?: () => readonly string[]
  supportsInteractionId?: () => boolean
  context?: () => Pick<WebVitalRecord, "route" | "runtime" | "appVersion">
  report?: (metric: WebVitalRecord, options: { signal: AbortSignal }) => Promise<boolean>
  now?: () => number
}

const DEFAULT_SETTINGS: WebVitalsSettings = {
  enabled: false,
  reporting: false,
  metrics: { LCP: true, INP: true, CLS: true, FCP: true, TTFB: true, FID: false },
}
const SERVER_SNAPSHOT: WebVitalsSnapshot = {
  settings: DEFAULT_SETTINGS,
  metrics: {},
  supported: null,
  started: false,
  error: false,
  persistenceError: false,
}
const ENTRY_TYPES: Record<WebVitalName, string> = {
  LCP: "largest-contentful-paint",
  INP: "event",
  CLS: "layout-shift",
  FCP: "paint",
  TTFB: "navigation",
  FID: "first-input",
}
const NAVIGATION_TYPES = new Set([
  "navigate",
  "reload",
  "back-forward",
  "back-forward-cache",
  "prerender",
  "restore",
])

function settingsFrom(value: unknown): WebVitalsSettings {
  const source = value && typeof value === "object" ? (value as Partial<WebVitalsSettings>) : {}
  return {
    enabled: source.enabled === true,
    reporting: source.reporting === true,
    metrics: Object.fromEntries(
      WEB_VITAL_NAMES.map((name) => [
        name,
        typeof source.metrics?.[name] === "boolean"
          ? source.metrics[name]
          : DEFAULT_SETTINGS.metrics[name],
      ])
    ) as Record<WebVitalName, boolean>,
  }
}

function documentContext(): Pick<WebVitalRecord, "route" | "runtime" | "appVersion"> {
  const platform = detectPlatform()
  return {
    route: typeof window === "undefined" ? "other" : window.location.pathname,
    runtime:
      platform === "mobile"
        ? /android/i.test(navigator.userAgent)
          ? "capacitor-android"
          : "capacitor-ios"
        : platform === "web"
          ? "browser"
          : platform,
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
  }
}

/** A document summary, not interval samples. At most six records are retained. */
export class WebVitalsStore {
  private snapshot: WebVitalsSnapshot = SERVER_SNAPSHOT
  private listeners = new Set<() => void>()
  private connections = 0
  private context: Pick<WebVitalRecord, "route" | "runtime" | "appVersion"> | null = null
  private fingerprints = new Map<WebVitalName, string>()
  private metricIds = new Map<WebVitalName, string>()
  private sends = new Map<WebVitalName, AbortController>()
  private unsubscribeConsent: (() => void) | null = null

  constructor(private readonly dependencies: Dependencies = {}) {}

  getSnapshot = (): WebVitalsSnapshot => this.snapshot
  getServerSnapshot = (): WebVitalsSnapshot => SERVER_SNAPSHOT
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  connect = (): (() => void) => {
    this.connections++
    if (this.connections === 1) {
      this.context ??= (this.dependencies.context ?? documentContext)()
      this.loadSettings()
      const types =
        this.dependencies.supportedEntryTypes?.() ??
        (typeof PerformanceObserver === "undefined"
          ? []
          : (PerformanceObserver.supportedEntryTypes ?? []))
      const interactionId =
        this.dependencies.supportsInteractionId?.() ??
        (typeof PerformanceEventTiming !== "undefined" &&
          "interactionId" in PerformanceEventTiming.prototype)
      this.publish({
        supported: WEB_VITAL_NAMES.filter(
          (name) => types.includes(ENTRY_TYPES[name]) && (name !== "INP" || interactionId)
        ),
      })
      this.unsubscribeConsent = subscribeBehaviorTelemetrySettings(() => this.cancelReports())
      if (typeof window !== "undefined") {
        window.addEventListener("storage", this.onStorage)
        // The bundled library also uses capture and emits restored TTFB
        // synchronously. Reset the visit before that callback runs.
        window.addEventListener("pageshow", this.onPageShow, true)
      }
    }
    return () => {
      this.connections--
      if (this.connections === 0) {
        if (typeof window !== "undefined") {
          window.removeEventListener("storage", this.onStorage)
          window.removeEventListener("pageshow", this.onPageShow, true)
        }
        this.unsubscribeConsent?.()
        this.unsubscribeConsent = null
        this.cancelReports()
      }
    }
  }

  private storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
    return (
      this.dependencies.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined)
    )
  }

  private loadSettings(): void {
    try {
      this.applySettings(
        settingsFrom(JSON.parse(this.storage()?.getItem(WEB_VITALS_STORAGE_KEY) ?? "null"))
      )
    } catch {
      this.applySettings(settingsFrom(null))
    }
  }

  private onStorage = (event: StorageEvent): void => {
    if (event.key === BEHAVIOR_TELEMETRY_STORAGE_KEY || event.key === null) this.cancelReports()
    if (event.key === WEB_VITALS_STORAGE_KEY || event.key === null) this.loadSettings()
  }

  private onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return
    this.cancelReports()
    this.fingerprints.clear()
    this.metricIds.clear()
    this.context = (this.dependencies.context ?? documentContext)()
    this.publish({ metrics: {} })
  }

  updateSettings = (patch: Partial<WebVitalsSettings>): void => {
    const settings = settingsFrom({ ...this.snapshot.settings, ...patch })
    // Always apply an opt-out even when persistent storage is unavailable.
    // The session still works; a new document fails closed when it cannot read.
    let persistenceError = false
    try {
      const storage = this.storage()
      if (!storage) persistenceError = true
      else storage.setItem(WEB_VITALS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      persistenceError = true
    }
    this.publish({ persistenceError })
    this.applySettings(settings)
  }

  private applySettings(settings: WebVitalsSettings): void {
    const metrics = { ...this.snapshot.metrics }
    for (const name of WEB_VITAL_NAMES) {
      if (!settings.enabled || !settings.metrics[name]) delete metrics[name]
      if (!settings.enabled || !settings.reporting || !settings.metrics[name]) {
        this.sends.get(name)?.abort()
        this.sends.delete(name)
      }
    }
    this.publish({ settings, metrics })
  }

  markStarted = (): void => {
    this.publish({ started: true, error: false })
  }
  markError = (): void => {
    this.cancelReports()
    this.publish({ error: true })
  }

  ingest = (input: unknown): void => {
    const { settings } = this.snapshot
    if (
      !this.connections ||
      !settings.enabled ||
      this.snapshot.error ||
      !input ||
      typeof input !== "object"
    )
      return
    const raw = input as Record<string, unknown>
    const name = raw.name as WebVitalName
    if (!WEB_VITAL_NAMES.includes(name) || !settings.metrics[name]) return
    if (
      typeof raw.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id) ||
      typeof raw.value !== "number" ||
      !Number.isFinite(raw.value) ||
      raw.value < 0 ||
      typeof raw.delta !== "number" ||
      !Number.isFinite(raw.delta) ||
      !["good", "needs-improvement", "poor"].includes(String(raw.rating)) ||
      typeof raw.navigationType !== "string" ||
      !NAVIGATION_TYPES.has(raw.navigationType)
    )
      return
    // The hook has no effect cleanup: Strict Mode can create two observers
    // with different random IDs for the same visit. Canonicalize the visit's
    // metric identity and coalesce identical readings. BFCache starts a new
    // visit in onPageShow before the library emits its restored measurements.
    const fingerprint = `${raw.navigationType}:${raw.value}:${raw.delta}`
    if (this.fingerprints.get(name) === fingerprint) return
    this.fingerprints.set(name, fingerprint)
    const context = this.context ?? (this.dependencies.context ?? documentContext)()
    const id = this.metricIds.get(name) ?? raw.id
    this.metricIds.set(name, id)
    const metric: WebVitalRecord = {
      name,
      id,
      value: raw.value,
      delta: raw.delta,
      rating: raw.rating as WebVitalRecord["rating"],
      navigationType: raw.navigationType,
      route: toReportableRoute(context.route),
      runtime: context.runtime,
      appVersion: context.appVersion,
      observedAt: (this.dependencies.now ?? Date.now)(),
    }
    // Receipt proves support even if an engine omits a supportedEntryTypes entry.
    const supported = [...new Set([...(this.snapshot.supported ?? []), name])]
    this.publish({ metrics: { ...this.snapshot.metrics, [name]: metric }, supported })
    if (!settings.reporting) return
    let controller = this.sends.get(name)
    if (!controller) {
      controller = new AbortController()
      this.sends.set(name, controller)
    }
    const signal = controller.signal
    const send = this.dependencies.report ?? reportMetric
    void send(metric, { signal }).catch(() => {
      /* Diagnostics must not interrupt rendering. */
    })
  }

  clear = (): void => {
    this.cancelReports()
    // Keep the bounded dedupe fingerprints: a replay cannot undo Clear.
    this.publish({ metrics: {} })
  }

  private cancelReports(): void {
    for (const controller of this.sends.values()) controller.abort()
    this.sends.clear()
  }

  private publish(patch: Partial<WebVitalsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

async function reportMetric(
  metric: WebVitalRecord,
  options: { signal: AbortSignal }
): Promise<boolean> {
  const { reportWebVital } = await import("@/lib/telemetry/web-vitals")
  if (options.signal.aborted) return false
  return reportWebVital(metric, options)
}

export function createWebVitalsStore(dependencies: Dependencies = {}): WebVitalsStore {
  return new WebVitalsStore(dependencies)
}

export const webVitalsStore = createWebVitalsStore()
