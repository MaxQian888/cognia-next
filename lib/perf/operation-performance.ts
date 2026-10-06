import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { type7Percentile } from "./comparison"

export const OPERATION_GROUPS = ["startup", "storage", "transport", "network"] as const
export type OperationGroup = (typeof OPERATION_GROUPS)[number]
export const OPERATION_NAMES = [
  "startup.capability-probe",
  "storage.messages.load",
  "storage.messages.write",
  "storage.sessions.list",
  "transport.local.call",
  "transport.remote.call",
  "network.browser.fetch",
  "network.tauri.fetch",
  "network.capacitor.fetch",
] as const
export type OperationName = (typeof OPERATION_NAMES)[number]
export type OperationOutcome = "success" | "error" | "cancelled"
export interface OperationPerformanceSettings {
  enabled: boolean
  groups: Record<OperationGroup, boolean>
}
export interface OperationTimingRow {
  name: OperationName
  group: OperationGroup
  count: number
  errors: number
  cancelled: number
  inFlight: number
  samples: number
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number | null
  lastMs: number | null
}
export interface OperationPerformanceSnapshot {
  settings: OperationPerformanceSettings
  persistenceError: boolean
  rows: OperationTimingRow[]
  dropped: number
}
export interface OperationPerformanceDependencies {
  clock?: () => number
  storage?: Pick<Storage, "getItem" | "setItem">
  isBrowser?: () => boolean
  readScope?: () => string | null
}
export const OPERATION_PERFORMANCE_STORAGE_KEY = "cognia-operation-performance-v1"
const defaults = (): OperationPerformanceSettings => ({
  enabled: false,
  groups: { startup: true, storage: true, transport: true, network: true },
})
const groupOf = (name: OperationName): OperationGroup => name.split(".")[0] as OperationGroup
const emptyRow = (name: OperationName): OperationTimingRow => ({
  name,
  group: groupOf(name),
  count: 0,
  errors: 0,
  cancelled: 0,
  inFlight: 0,
  samples: 0,
  p50Ms: null,
  p95Ms: null,
  maxMs: null,
  lastMs: null,
})
const emptySnapshot = (): OperationPerformanceSnapshot => ({
  settings: defaults(),
  persistenceError: false,
  rows: OPERATION_NAMES.map(emptyRow),
  dropped: 0,
})
const SERVER_SNAPSHOT = emptySnapshot()
const noop = () => {}
function parseSettings(raw: unknown): OperationPerformanceSettings {
  const settings = defaults()
  if (!raw || typeof raw !== "object") return settings
  const value = raw as Partial<OperationPerformanceSettings>
  if (typeof value.enabled === "boolean") settings.enabled = value.enabled
  for (const group of OPERATION_GROUPS) {
    if (typeof value.groups?.[group] === "boolean") settings.groups[group] = value.groups[group]
  }
  return settings
}

/** Fixed-name local summaries only. No arguments, URLs, user IDs, or exporters. */
export class OperationPerformanceRecorder {
  private snapshot = emptySnapshot()
  private readonly listeners = new Set<() => void>()
  private readonly active = new Map<object, OperationName>()
  private readonly samples = new Map<OperationName, number[]>()
  private interval = OPERATION_GROUPS.map(() => ({ count: 0, errors: 0, cancelled: 0, valid: 0 }))
  private intervalSamples: { group: OperationGroup; duration: number }[] = []
  private unsavedSettings: OperationPerformanceSettings | null = null
  private initialized = false
  private listening = false
  private connections = 0
  private scope: string | null = null
  private scopeInitialized = false

  constructor(private readonly dependencies: OperationPerformanceDependencies = {}) {}
  getSnapshot = (): OperationPerformanceSnapshot => this.snapshot
  getServerSnapshot = (): OperationPerformanceSnapshot => SERVER_SNAPSHOT
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private browser(): boolean {
    try {
      return this.dependencies.isBrowser?.() ?? typeof window !== "undefined"
    } catch {
      return false
    }
  }
  private storage(): Pick<Storage, "getItem" | "setItem"> {
    return this.dependencies.storage ?? window.localStorage
  }
  private initialize(): void {
    if (!this.browser()) return
    this.syncScope()
    if (!this.initialized) {
      this.initialized = true
      this.load()
    }
    if (!this.listening && typeof window !== "undefined") {
      window.addEventListener("storage", this.onStorage)
      this.listening = true
    }
  }
  connect = (): (() => void) => {
    this.initialize()
    this.connections++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.connections === 0 && this.listening && typeof window !== "undefined") {
        window.removeEventListener("storage", this.onStorage)
        this.listening = false
        // A later begin/connect reloads preferences changed while disconnected.
        this.initialized = false
      }
    }
  }
  private onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== OPERATION_PERFORMANCE_STORAGE_KEY) return
    try {
      if (event.storageArea && event.storageArea !== this.storage()) return
    } catch {
      return
    }
    this.load(true)
  }
  private load(external = false): void {
    // A failed write must never let stale persisted opt-in undo the user's session opt-out.
    if (this.unsavedSettings && !external) {
      this.applySettings(this.unsavedSettings, true)
      return
    }
    let settings = defaults()
    let persistenceError = false
    try {
      const raw = this.storage().getItem(OPERATION_PERFORMANCE_STORAGE_KEY)
      settings = parseSettings(raw ? JSON.parse(raw) : null)
    } catch {
      persistenceError = true
    }
    if (this.unsavedSettings) {
      // Other tabs may revoke consent, but cannot undo this tab's unsaved opt-out.
      settings.enabled &&= this.unsavedSettings.enabled
      for (const group of OPERATION_GROUPS)
        settings.groups[group] &&= this.unsavedSettings.groups[group]
      this.unsavedSettings = settings
      persistenceError = true
    }
    this.applySettings(settings, persistenceError)
  }
  updateSettings = (
    patch: Partial<Omit<OperationPerformanceSettings, "groups">> & {
      groups?: Partial<Record<OperationGroup, boolean>>
    }
  ): void => {
    this.initialize()
    const settings = parseSettings({
      ...this.snapshot.settings,
      ...patch,
      groups: { ...this.snapshot.settings.groups, ...patch.groups },
    })
    let persistenceError = false
    try {
      if (this.browser())
        this.storage().setItem(OPERATION_PERFORMANCE_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      persistenceError = true
    }
    this.unsavedSettings = persistenceError ? settings : null
    this.applySettings(settings, persistenceError)
  }
  setEnabled = (enabled: boolean): void => this.updateSettings({ enabled })
  setGroupEnabled = (group: OperationGroup, enabled: boolean): void => {
    if (OPERATION_GROUPS.includes(group)) this.updateSettings({ groups: { [group]: enabled } })
  }
  private applySettings(settings: OperationPerformanceSettings, persistenceError: boolean): void {
    const previous = this.snapshot.settings
    this.snapshot = { ...this.snapshot, settings, persistenceError }
    if (previous.enabled !== settings.enabled) this.clear()
    else {
      for (const group of OPERATION_GROUPS)
        if (previous.groups[group] !== settings.groups[group]) this.resetGroup(group)
      this.publish()
    }
  }
  private resetGroup(group: OperationGroup): void {
    for (const [token, name] of this.active) if (groupOf(name) === group) this.active.delete(token)
    for (const name of OPERATION_NAMES) if (groupOf(name) === group) this.samples.delete(name)
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.map((row) => (row.group === group ? emptyRow(row.name) : row)),
    }
    this.interval[OPERATION_GROUPS.indexOf(group)] = { count: 0, errors: 0, cancelled: 0, valid: 0 }
    this.intervalSamples = this.intervalSamples.filter((sample) => sample.group !== group)
  }
  clear = (): void => {
    this.active.clear()
    this.samples.clear()
    this.resetInterval()
    this.snapshot = { ...this.snapshot, rows: OPERATION_NAMES.map(emptyRow), dropped: 0 }
    this.publish()
  }
  setScope = (scope: string | null): void => {
    if (!this.scopeInitialized) {
      this.scopeInitialized = true
      this.scope = scope
      return
    }
    if (this.scope === scope) return
    this.scope = scope
    this.clear()
  }
  private syncScope(): void {
    try {
      const context = this.dependencies.readScope ? null : getActiveRuntimeTargetContext()
      this.setScope(
        this.dependencies.readScope
          ? this.dependencies.readScope()
          : context
            ? JSON.stringify([context.accountId, context.targetId, context.routingGeneration])
            : null
      )
    } catch {
      this.clear()
    }
  }
  private now(): number | null {
    try {
      const value = this.dependencies.clock?.() ?? performance.now()
      return Number.isFinite(value) && value >= 0 ? value : null
    } catch {
      return null
    }
  }
  begin = (name: OperationName): ((outcome?: OperationOutcome) => void) => {
    this.initialize()
    if (
      !this.browser() ||
      !OPERATION_NAMES.includes(name) ||
      !this.snapshot.settings.enabled ||
      !this.snapshot.settings.groups[groupOf(name)]
    )
      return noop
    if (this.active.size >= 256) {
      this.snapshot = { ...this.snapshot, dropped: this.snapshot.dropped + 1 }
      this.publish()
      return noop
    }
    const start = this.now()
    const token = {}
    this.active.set(token, name)
    this.updateRow(name, (row) => ({ ...row, inFlight: row.inFlight + 1 }))
    return (outcome = "success") => {
      this.initialize()
      if (!this.active.delete(token)) return
      const end = this.now()
      const duration = start !== null && end !== null && end >= start ? end - start : null
      const group = groupOf(name)
      const interval = this.interval[OPERATION_GROUPS.indexOf(group)]
      interval.count++
      if (outcome === "error") interval.errors++
      if (outcome === "cancelled") interval.cancelled++
      if (duration !== null) {
        const samples = this.samples.get(name) ?? []
        samples.push(duration)
        if (samples.length > 120) samples.shift()
        this.samples.set(name, samples)
        interval.valid++
        if (this.intervalSamples.length < 500) this.intervalSamples.push({ group, duration })
      }
      const samples = this.samples.get(name) ?? []
      this.updateRow(name, (row) => ({
        ...row,
        count: row.count + 1,
        errors: row.errors + Number(outcome === "error"),
        cancelled: row.cancelled + Number(outcome === "cancelled"),
        inFlight: row.inFlight - 1,
        samples: samples.length,
        p50Ms: type7Percentile(samples, 0.5),
        p95Ms: type7Percentile(samples, 0.95),
        maxMs: samples.length ? Math.max(...samples) : null,
        lastMs: duration,
      }))
    }
  }
  private updateRow(
    name: OperationName,
    update: (row: OperationTimingRow) => OperationTimingRow
  ): void {
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.map((row) => (row.name === name ? update(row) : row)),
    }
    this.publish()
  }
  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* Diagnostics must not affect the observed operation. */
      }
    }
  }
  resetInterval = (): void => {
    this.interval = OPERATION_GROUPS.map(() => ({ count: 0, errors: 0, cancelled: 0, valid: 0 }))
    this.intervalSamples = []
  }
  collectInterval = (): Record<string, number | null> => {
    this.initialize()
    const enabled =
      this.browser() &&
      this.snapshot.settings.enabled &&
      OPERATION_GROUPS.some((group) => this.snapshot.settings.groups[group])
    const sum = (key: keyof (typeof this.interval)[number]) =>
      this.interval.reduce((total, item) => total + item[key], 0)
    const result = {
      "renderer.operation.count": enabled ? sum("count") : null,
      "renderer.operation.duration.p95.ms":
        enabled && sum("valid") === this.intervalSamples.length
          ? type7Percentile(
              this.intervalSamples.map((sample) => sample.duration),
              0.95
            )
          : null,
      "renderer.operation.error.count": enabled ? sum("errors") : null,
      "renderer.operation.cancelled.count": enabled ? sum("cancelled") : null,
      "renderer.operation.inflight.count": enabled ? this.active.size : null,
    }
    this.resetInterval()
    return result
  }
}
export function createOperationPerformanceRecorder(
  dependencies: OperationPerformanceDependencies = {}
): OperationPerformanceRecorder {
  return new OperationPerformanceRecorder(dependencies)
}
let singleton: OperationPerformanceRecorder | undefined
export function getOperationPerformanceRecorder(): OperationPerformanceRecorder {
  return (singleton ??= createOperationPerformanceRecorder())
}

/** Synchronous invocation and original promise identity preserve Dexie's transaction context. */
export function measureOperation<T>(
  name: OperationName,
  operation: () => Promise<T>,
  classify?: (result: T) => OperationOutcome
): Promise<T> {
  let finish: (outcome?: OperationOutcome) => void = noop
  try {
    finish = getOperationPerformanceRecorder().begin(name)
  } catch {
    /* Observe without changing business results. */
  }
  if (finish === noop) return operation()
  const complete = (outcome: OperationOutcome) => {
    try {
      finish(outcome)
    } catch {
      /* Instrumentation is best effort. */
    }
  }
  let promise: Promise<T>
  try {
    promise = operation()
  } catch (error) {
    let outcome: OperationOutcome = "error"
    try {
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError")
        outcome = "cancelled"
    } catch {
      /* Preserve opaque synchronous errors. */
    }
    complete(outcome)
    throw error
  }
  try {
    promise.then(
      (result) => {
        let outcome: OperationOutcome = "success"
        try {
          outcome = classify?.(result) ?? "success"
        } catch {
          /* A diagnostic classifier cannot affect callers. */
        }
        complete(outcome)
      },
      (error) => {
        let outcome: OperationOutcome = "error"
        try {
          if (error?.name === "AbortError") outcome = "cancelled"
        } catch {
          /* Opaque errors remain errors. */
        }
        complete(outcome)
      }
    )
  } catch {
    complete("error")
  }
  return promise
}
