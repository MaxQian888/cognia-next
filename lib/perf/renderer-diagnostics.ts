import { type7Percentile } from "./comparison"

export type RendererDiagnosticsGroup = "resources" | "interactions" | "navigation" | "frames"

export interface RendererDiagnosticsSettings {
  enabled: boolean
  resources: boolean
  interactions: boolean
  navigation: boolean
  frames: boolean
}

export interface RendererNavigationSummary {
  dnsMs: number | null
  connectMs: number | null
  tlsMs: number | null
  requestMs: number | null
  responseMs: number | null
  domInteractiveMs: number | null
  domContentLoadedMs: number | null
  loadMs: number | null
}

export interface RendererDiagnosticsSnapshot {
  settings: RendererDiagnosticsSettings
  supported: Record<RendererDiagnosticsGroup, boolean>
  errors: Record<RendererDiagnosticsGroup, boolean>
  persistenceError: boolean
  navigation: RendererNavigationSummary | null
}

/** Only scalar fields are read; resource URLs and event targets are never retained. */
export interface RendererDiagnosticEntry {
  startTime: number
  duration: number
  transferSize?: number
  encodedBodySize?: number
  responseStart?: number
  processingStart?: number
  processingEnd?: number
}

interface DiagnosticObserver {
  // Event Timing's extension is not present in every TypeScript DOM lib yet.
  observe(options: PerformanceObserverInit & { durationThreshold?: number }): void
  disconnect(): void
}

export interface RendererDiagnosticsDependencies {
  storage?: Pick<Storage, "getItem" | "setItem">
  supportedEntryTypes?: readonly string[]
  supportsEventTiming?: boolean
  supportsFrames?: boolean
  createObserver?: (
    callback: (entries: readonly RendererDiagnosticEntry[]) => void
  ) => DiagnosticObserver
  readNavigation?: () => Partial<PerformanceNavigationTiming> | null
  now?: () => number
}

export const RENDERER_DIAGNOSTICS_STORAGE_KEY = "cognia-renderer-diagnostics-v1"
const GROUPS: RendererDiagnosticsGroup[] = ["resources", "interactions", "navigation", "frames"]
const DEFAULT_SETTINGS: RendererDiagnosticsSettings = {
  enabled: false,
  resources: true,
  interactions: true,
  navigation: true,
  frames: true,
}
const NO_FLAGS = { resources: false, interactions: false, navigation: false, frames: false }
const SERVER_SNAPSHOT: RendererDiagnosticsSnapshot = {
  settings: DEFAULT_SETTINGS,
  supported: NO_FLAGS,
  errors: NO_FLAGS,
  persistenceError: false,
  navigation: null,
}
const MAX_SAMPLES = 500

function settingsFrom(input: unknown): RendererDiagnosticsSettings {
  const value =
    input && typeof input === "object" ? (input as Partial<RendererDiagnosticsSettings>) : {}
  return Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => [
      key,
      typeof value[key as keyof RendererDiagnosticsSettings] === "boolean"
        ? value[key as keyof RendererDiagnosticsSettings]
        : fallback,
    ])
  ) as unknown as RendererDiagnosticsSettings
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function phase(start: unknown, end: unknown): number | null {
  return finite(start) && finite(end) && end > 0 && end >= start ? end - start : null
}

/** Demand-scoped, opt-in browser summaries. No exporter or raw-entry history. */
export class RendererDiagnostics {
  private snapshot: RendererDiagnosticsSnapshot
  private readonly listeners = new Set<() => void>()
  private connections = 0
  private demand = 0
  private readonly observers = new Map<RendererDiagnosticsGroup, DiagnosticObserver>()
  private readonly generations = { resources: 0, interactions: 0 }
  private navigationCleared = false
  private resourceCount = 0
  private resourceDurations: number[] = []
  private transferBytes = 0
  private observableBytes = false
  private eventCount = 0
  private inputDelays: number[] = []
  private processingDurations: number[] = []
  readonly capabilities: readonly string[]

  constructor(private readonly dependencies: RendererDiagnosticsDependencies = {}) {
    const types =
      dependencies.supportedEntryTypes ??
      (typeof PerformanceObserver === "undefined"
        ? []
        : (PerformanceObserver.supportedEntryTypes ?? []))
    const eventTiming =
      dependencies.supportsEventTiming ??
      (typeof PerformanceEventTiming !== "undefined" &&
        "processingStart" in PerformanceEventTiming.prototype)
    const supported = {
      resources: types.includes("resource"),
      interactions: types.includes("event") && eventTiming,
      navigation: types.includes("navigation"),
      frames: dependencies.supportsFrames ?? typeof requestAnimationFrame === "function",
    }
    this.snapshot = { ...SERVER_SNAPSHOT, supported }
    this.capabilities = Object.freeze([
      ...(supported.resources ? ["renderer.resource"] : []),
      ...(supported.interactions ? ["renderer.event-timing"] : []),
      ...(supported.frames ? ["renderer.frame-timing"] : []),
    ])
  }

  getSnapshot = (): RendererDiagnosticsSnapshot => this.snapshot
  getServerSnapshot = (): RendererDiagnosticsSnapshot => SERVER_SNAPSHOT
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  connect = (): (() => void) => {
    if (++this.connections === 1) {
      this.loadSettings()
      if (typeof window !== "undefined") window.addEventListener("storage", this.onStorage)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.connections === 0 && typeof window !== "undefined") {
        window.removeEventListener("storage", this.onStorage)
      }
    }
  }

  acquire = (): (() => void) => {
    const disconnect = this.connect()
    if (++this.demand === 1) {
      this.navigationCleared = false
      this.reconcile()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.demand === 0) this.reconcile()
      disconnect()
    }
  }

  isEnabled = (group: RendererDiagnosticsGroup): boolean =>
    this.snapshot.settings.enabled &&
    this.snapshot.settings[group] &&
    this.snapshot.supported[group] &&
    !this.snapshot.errors[group]

  updateSettings = (patch: Partial<RendererDiagnosticsSettings>): void => {
    const settings = settingsFrom({ ...this.snapshot.settings, ...patch })
    let persistenceError = false
    try {
      const storage = this.storage()
      if (!storage) persistenceError = true
      else storage.setItem(RENDERER_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      persistenceError = true
    }
    this.applySettings(settings, persistenceError)
  }

  clear = (): void => {
    this.navigationCleared = true
    this.publish({ navigation: null })
  }

  /** A target/routing change must not inherit the previous scope's observations. */
  resetInterval = (): void => {
    for (const group of ["resources", "interactions"] as const) {
      this.stop(group)
      if (this.demand > 0 && this.isEnabled(group)) this.start(group)
    }
  }

  collectInterval = (): Record<string, number | null> => {
    this.refreshNavigation()
    const resources = this.demand > 0 && this.isEnabled("resources")
    const interactions = this.demand > 0 && this.isEnabled("interactions")
    const result = {
      "renderer.resource.count": resources ? this.resourceCount : null,
      // An overflow is unavailable, never a percentile of an unlabeled subset.
      "renderer.resource.duration.p95.ms":
        resources && this.resourceCount <= MAX_SAMPLES
          ? type7Percentile(this.resourceDurations, 0.95)
          : null,
      "renderer.resource.transfer.bytes":
        resources && this.observableBytes ? this.transferBytes : null,
      "renderer.event.count": interactions ? this.eventCount : null,
      "renderer.event.input-delay.p95.ms":
        interactions && this.eventCount <= MAX_SAMPLES
          ? type7Percentile(this.inputDelays, 0.95)
          : null,
      "renderer.event.processing.p95.ms":
        interactions && this.eventCount <= MAX_SAMPLES
          ? type7Percentile(this.processingDurations, 0.95)
          : null,
    }
    this.reset("resources")
    this.reset("interactions")
    return result
  }

  private storage(): Pick<Storage, "getItem" | "setItem"> | undefined {
    return (
      this.dependencies.storage ?? (typeof window === "undefined" ? undefined : window.localStorage)
    )
  }

  private loadSettings(): void {
    try {
      this.applySettings(
        settingsFrom(
          JSON.parse(this.storage()?.getItem(RENDERER_DIAGNOSTICS_STORAGE_KEY) ?? "null")
        ),
        false
      )
    } catch {
      this.applySettings(settingsFrom(null), true)
    }
  }

  private onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === RENDERER_DIAGNOSTICS_STORAGE_KEY) this.loadSettings()
  }

  private applySettings(settings: RendererDiagnosticsSettings, persistenceError: boolean): void {
    const previous = this.snapshot.settings
    if ((!previous.enabled && settings.enabled) || (!previous.navigation && settings.navigation)) {
      this.navigationCleared = false
    }
    const errors = { ...this.snapshot.errors }
    for (const group of GROUPS) {
      if (previous.enabled !== settings.enabled || previous[group] !== settings[group])
        errors[group] = false
    }
    this.publish({ settings, errors, persistenceError })
    this.reconcile()
  }

  private reconcile(): void {
    for (const group of ["resources", "interactions"] as const) {
      if (!this.demand || !this.isEnabled(group)) this.stop(group)
      else if (!this.observers.has(group)) this.start(group)
    }
    if (!this.demand || !this.isEnabled("navigation")) {
      if (this.snapshot.navigation !== null) this.publish({ navigation: null })
    } else this.refreshNavigation()
  }

  private now(): number {
    return this.dependencies.now?.() ?? (typeof performance === "undefined" ? 0 : performance.now())
  }

  private start(group: "resources" | "interactions"): void {
    const generation = ++this.generations[group]
    const since = this.now()
    let observer: DiagnosticObserver | undefined
    try {
      const factory =
        this.dependencies.createObserver ??
        ((callback) => new PerformanceObserver((list) => callback(list.getEntries())))
      observer = factory((entries) => {
        if (this.generations[group] !== generation || !this.demand || !this.isEnabled(group)) return
        for (const entry of entries) {
          if (!finite(entry.startTime) || entry.startTime < since || !finite(entry.duration))
            continue
          if (group === "resources") {
            this.resourceCount = Math.min(Number.MAX_SAFE_INTEGER, this.resourceCount + 1)
            if (this.resourceDurations.length < MAX_SAMPLES)
              this.resourceDurations.push(entry.duration)
            if (
              finite(entry.transferSize) &&
              (entry.transferSize > 0 ||
                (finite(entry.encodedBodySize) && entry.encodedBodySize > 0) ||
                (finite(entry.responseStart) && entry.responseStart > 0))
            ) {
              this.transferBytes = Math.min(
                Number.MAX_SAFE_INTEGER,
                this.transferBytes + entry.transferSize
              )
              this.observableBytes = true
            }
          } else {
            if (
              !finite(entry.processingStart) ||
              !finite(entry.processingEnd) ||
              entry.processingStart < entry.startTime ||
              entry.processingEnd < entry.processingStart
            )
              continue
            this.eventCount = Math.min(Number.MAX_SAFE_INTEGER, this.eventCount + 1)
            if (this.inputDelays.length < MAX_SAMPLES) {
              this.inputDelays.push(entry.processingStart - entry.startTime)
              this.processingDurations.push(entry.processingEnd - entry.processingStart)
            }
          }
        }
      })
      observer.observe(
        group === "resources"
          ? { type: "resource", buffered: false }
          : { type: "event", buffered: false, durationThreshold: 16 }
      )
      this.observers.set(group, observer)
    } catch {
      observer?.disconnect()
      this.generations[group]++
      this.reset(group)
      this.publish({ errors: { ...this.snapshot.errors, [group]: true } })
    }
  }

  private stop(group: "resources" | "interactions"): void {
    this.generations[group]++
    this.observers.get(group)?.disconnect()
    this.observers.delete(group)
    this.reset(group)
  }

  private reset(group: "resources" | "interactions"): void {
    if (group === "resources") {
      this.resourceCount = 0
      this.resourceDurations = []
      this.transferBytes = 0
      this.observableBytes = false
    } else {
      this.eventCount = 0
      this.inputDelays = []
      this.processingDurations = []
    }
  }

  private refreshNavigation(): void {
    if (!this.demand || !this.isEnabled("navigation") || this.navigationCleared) return
    try {
      const raw =
        this.dependencies.readNavigation?.() ??
        (this.dependencies.readNavigation
          ? null
          : typeof performance === "undefined"
            ? null
            : (performance.getEntriesByType("navigation")[0] as
                PerformanceNavigationTiming | undefined))
      if (!raw) return
      const summary: RendererNavigationSummary = {
        dnsMs: phase(raw.domainLookupStart, raw.domainLookupEnd),
        connectMs: phase(raw.connectStart, raw.connectEnd),
        tlsMs:
          finite(raw.secureConnectionStart) && raw.secureConnectionStart > 0
            ? phase(raw.secureConnectionStart, raw.connectEnd)
            : null,
        requestMs: phase(raw.requestStart, raw.responseStart),
        responseMs: phase(raw.responseStart, raw.responseEnd),
        domInteractiveMs: phase(raw.startTime, raw.domInteractive),
        domContentLoadedMs: phase(raw.startTime, raw.domContentLoadedEventEnd),
        loadMs: phase(raw.startTime, raw.loadEventEnd),
      }
      if (JSON.stringify(summary) !== JSON.stringify(this.snapshot.navigation))
        this.publish({ navigation: summary })
    } catch {
      this.publish({ navigation: null, errors: { ...this.snapshot.errors, navigation: true } })
    }
  }

  private publish(patch: Partial<RendererDiagnosticsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

export function createRendererDiagnostics(
  dependencies: RendererDiagnosticsDependencies = {}
): RendererDiagnostics {
  return new RendererDiagnostics(dependencies)
}

let singleton: RendererDiagnostics | undefined
export function getRendererDiagnostics(): RendererDiagnostics {
  return (singleton ??= createRendererDiagnostics())
}
