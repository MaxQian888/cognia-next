/** @jest-environment jsdom */

import { createWebVitalsStore, WEB_VITALS_STORAGE_KEY, type WebVitalRecord } from "./web-vitals"
import {
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
  saveBehaviorTelemetrySettings,
} from "@/lib/telemetry/events/settings"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  localStorage.clear()
})

const metric = {
  name: "LCP",
  id: "v4-123-456",
  value: 1250,
  delta: 1250,
  rating: "good",
  navigationType: "navigate",
  entries: [{ element: "private content" }],
}

function setup(saved?: string) {
  const storage = new Map<string, string>(saved ? [[WEB_VITALS_STORAGE_KEY, saved]] : [])
  const report = jest.fn(async (_metric: WebVitalRecord, _options: { signal: AbortSignal }) => true)
  const store = createWebVitalsStore({
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value)
      },
    },
    supportedEntryTypes: () => ["paint", "largest-contentful-paint", "event", "navigation"],
    supportsInteractionId: () => true,
    context: () => ({ route: "/chat?secret=hidden", runtime: "browser", appVersion: "1.0.0" }),
    report,
    now: () => 123,
  })
  cleanups.push(store.connect())
  return { store, storage, report }
}

describe("Web Vitals collection controls", () => {
  it("starts disabled, does not retain or report callbacks, and persists explicit opt-in", () => {
    const { store, storage, report } = setup()
    store.ingest(metric)
    expect(store.getSnapshot().metrics).toEqual({})
    expect(report).not.toHaveBeenCalled()
    store.updateSettings({ enabled: true })
    store.ingest(metric)
    expect(store.getSnapshot().metrics.LCP).toEqual({
      name: "LCP",
      id: "v4-123-456",
      value: 1250,
      delta: 1250,
      rating: "good",
      navigationType: "navigate",
      route: "/chat",
      runtime: "browser",
      appVersion: "1.0.0",
      observedAt: 123,
    })
    expect(report).not.toHaveBeenCalled()
    expect(JSON.parse(storage.get(WEB_VITALS_STORAGE_KEY)!)).toMatchObject({
      enabled: true,
      reporting: false,
    })
    const reloaded = setup(storage.get(WEB_VITALS_STORAGE_KEY))
    expect(reloaded.store.getSnapshot().settings.enabled).toBe(true)
  })

  it("cancels pending sends immediately and clears disabled metric data without changing other toggles", () => {
    const { store, report } = setup()
    store.updateSettings({ enabled: true, reporting: true })
    store.ingest(metric)
    const signal = report.mock.calls[0][1].signal
    store.updateSettings({ metrics: { ...store.getSnapshot().settings.metrics, LCP: false } })
    expect(signal.aborted).toBe(true)
    expect(store.getSnapshot().metrics.LCP).toBeUndefined()
    store.ingest({ ...metric, value: 1500 })
    expect(report).toHaveBeenCalledTimes(1)
    store.ingest({ ...metric, name: "FCP", id: "v4-2", value: 250 })
    expect(report).toHaveBeenCalledTimes(2)
    const fcpSignal = report.mock.calls[1][1].signal
    store.updateSettings({ reporting: false })
    expect(fcpSignal.aborted).toBe(true)
    expect(store.getSnapshot().metrics.FCP?.value).toBe(250)
    store.ingest({ ...metric, name: "FCP", id: "v4-3", value: 300 })
    expect(store.getSnapshot().metrics.FCP?.value).toBe(300)
    expect(report).toHaveBeenCalledTimes(2)
    store.updateSettings({ enabled: false })
    expect(store.getSnapshot().metrics).toEqual({})
  })

  it("deduplicates repeated callbacks but retains updates and BFCache identities, bounded to six metrics", () => {
    const { store, report } = setup()
    store.updateSettings({ enabled: true, reporting: true })
    store.ingest(metric)
    store.ingest(metric)
    expect(report).toHaveBeenCalledTimes(1)
    store.ingest({ ...metric, value: 1350, delta: 100 })
    expect(report).toHaveBeenCalledTimes(2)
    // Strict Mode registers a duplicate observer with a different random id.
    store.ingest({ ...metric, id: "v4-duplicate", value: 1350, delta: 100 })
    expect(report).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().metrics.LCP?.id).toBe("v4-123-456")
    for (let i = 0; i < 100; i++) {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))
      store.ingest({ ...metric, id: `v4-${i}`, navigationType: "back-forward-cache" })
    }
    expect(Object.keys(store.getSnapshot().metrics)).toEqual(["LCP"])
    expect(store.getSnapshot().metrics.LCP?.navigationType).toBe("back-forward-cache")
    expect(store.getSnapshot().metrics.LCP?.id).toBe("v4-99")
    store.clear()
    store.ingest({ ...metric, id: "v4-99", navigationType: "back-forward-cache" })
    expect(store.getSnapshot().metrics).toEqual({})
  })

  it("revokes queued reporting epochs across behavior telemetry OFF/ON", () => {
    const { store, report } = setup()
    store.updateSettings({ enabled: true, reporting: true })
    store.ingest(metric)
    const signal = report.mock.calls[0][1].signal
    saveBehaviorTelemetrySettings({ ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS, enabled: false })
    saveBehaviorTelemetrySettings({ ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS, enabled: true })
    expect(signal.aborted).toBe(true)
    store.ingest({ ...metric, value: 2000, delta: 750 })
    expect(report.mock.calls[1][1].signal.aborted).toBe(false)
  })

  it("does not advertise INP just because an old engine supports event entries", () => {
    const store = createWebVitalsStore({
      supportedEntryTypes: () => ["event"],
      supportsInteractionId: () => false,
    })
    cleanups.push(store.connect())
    expect(store.getSnapshot().supported).not.toContain("INP")
  })

  it.each([
    { value: Number.NaN },
    { value: -1 },
    { delta: Infinity },
    { name: "secret" },
    { id: "https://private.example/secret" },
    { rating: "unknown" },
    { navigationType: "invalid" },
  ])("rejects invalid input %p", (invalid) => {
    const { store, report } = setup()
    store.updateSettings({ enabled: true, reporting: true })
    store.ingest({ ...metric, ...invalid })
    expect(store.getSnapshot().metrics).toEqual({})
    expect(report).not.toHaveBeenCalled()
  })

  it("keeps the document's initial route when SPA navigation changes", () => {
    const context = { route: "/chat?q=secret", runtime: "tauri", appVersion: "1" }
    const store = createWebVitalsStore({ context: () => ({ ...context }) })
    const stop = store.connect()
    store.updateSettings({ enabled: true })
    context.route = "/performance"
    store.ingest(metric)
    expect(store.getSnapshot().metrics.LCP?.route).toBe("/chat")
    stop()
    store.ingest({ ...metric, value: 2000 })
    expect(store.getSnapshot().metrics.LCP?.value).toBe(1250)
  })

  it("synchronizes opt-out and storage clearing from another window", () => {
    const { store, storage, report } = setup()
    store.updateSettings({ enabled: true, reporting: true })
    store.ingest(metric)
    const signal = report.mock.calls[0][1].signal
    storage.delete(WEB_VITALS_STORAGE_KEY)
    window.dispatchEvent(new StorageEvent("storage", { key: null }))
    expect(store.getSnapshot().settings.enabled).toBe(false)
    expect(store.getSnapshot().metrics).toEqual({})
    expect(signal.aborted).toBe(true)
  })

  it("fails closed on corrupt storage, but supports session-only controls when storage throws", () => {
    expect(setup("not-json").store.getSnapshot().settings.enabled).toBe(false)
    const store = createWebVitalsStore({
      storage: {
        getItem: () => {
          throw new Error("denied")
        },
        setItem: () => {
          throw new Error("denied")
        },
      },
    })
    const stop = store.connect()
    expect(store.getSnapshot().settings.enabled).toBe(false)
    expect(() => store.updateSettings({ enabled: true })).not.toThrow()
    expect(store.getSnapshot().settings.enabled).toBe(true)
    expect(store.getSnapshot().persistenceError).toBe(true)
    store.updateSettings({ enabled: false })
    stop()
  })

  it("distinguishes unsupported metrics from pending and real zero measurements", () => {
    const { store } = setup()
    store.updateSettings({ enabled: true })
    expect(store.getSnapshot().supported).not.toContain("CLS")
    expect(store.getSnapshot().supported).toContain("LCP")
    expect(store.getSnapshot().metrics.LCP).toBeUndefined()
    store.ingest({ ...metric, name: "CLS", value: 0, delta: 0 })
    expect(store.getSnapshot().supported).toContain("CLS")
    expect(store.getSnapshot().metrics.CLS?.value).toBe(0)
  })
})
