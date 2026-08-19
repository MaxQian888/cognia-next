/**
 * Tests for the read-only Logs & Agent-Trace Plugin API (`ctx.logs`).
 */

import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import { makeSpan } from "@/lib/observability/fixtures"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

const getLogs = jest.fn(async (..._a: unknown[]) => [{ id: "l1" }, { id: "l2" }])
const getStats = jest.fn(async () => ({ total: 2, byLevel: {}, byModule: {} }))
const exportLogs = jest.fn(async () => '[{"id":"l1"}]')
let logsUpdatedHandler: ((count: number) => void) | null = null
const onLogsUpdatedDispose = jest.fn()
const onLogsUpdated = jest.fn((handler: (count: number) => void) => {
  logsUpdatedHandler = handler
  return onLogsUpdatedDispose
})

jest.mock("@cognia/logging", () => ({
  IndexedDBTransport: class {
    static onLogsUpdated(handler: (count: number) => void) {
      return onLogsUpdated(handler)
    }
    getLogs(...a: unknown[]) {
      return getLogs(...a)
    }
    getStats() {
      return getStats()
    }
    export() {
      return exportLogs()
    }
  },
  getRegisteredModules: () => ["chat", "plugin"],
  getTransportHealthSnapshot: () => ({ indexeddb: { transport: "indexeddb", status: "healthy" } }),
}))

const queryByWindow = jest.fn(async (..._a: unknown[]) => [] as AgentTraceSpan[])
const queryByTrace = jest.fn(async (..._a: unknown[]) => [] as AgentTraceSpan[])
const queryBySession = jest.fn(async (..._a: unknown[]) => [] as AgentTraceSpan[])
const queryRecent = jest.fn(async (..._a: unknown[]) => [] as AgentTraceSpan[])
const aggregateStatsAll = jest.fn(async (..._a: unknown[]) => ({ totalSpans: 3 }))
jest.mock("@/lib/db/agent-traces", () => ({
  queryByWindow: (...a: unknown[]) => queryByWindow(...a),
  queryByTrace: (...a: unknown[]) => queryByTrace(...a),
  queryBySession: (...a: unknown[]) => queryBySession(...a),
  queryRecent: (...a: unknown[]) => queryRecent(...a),
  aggregateStatsAll: (...a: unknown[]) => aggregateStatsAll(...a),
}))

let liveNext: ((spans: AgentTraceSpan[]) => void) | null = null
let liveError: ((error: unknown) => void) | null = null
const unsubscribe = jest.fn()
jest.mock("dexie", () => ({
  liveQuery: (query: () => Promise<AgentTraceSpan[]>) => ({
    subscribe: (observer: {
      next: (spans: AgentTraceSpan[]) => void
      error: (error: unknown) => void
    }) => {
      void query()
      liveNext = observer.next
      liveError = observer.error
      return { unsubscribe }
    },
  }),
}))

import { createLogsAPI, resetPluginLogsTransport } from "./logs-api"

const PLUGIN = "obs-plugin"

function span(id: string, over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return makeSpan({ id, spanId: id, ...over })
}

describe("createLogsAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    resetPluginLogsTransport()
    liveNext = null
    liveError = null
    logsUpdatedHandler = null
    guard = getPermissionGuard()
  })

  it("gates the log surface behind logs:read", () => {
    guard.registerPlugin(PLUGIN, [])
    const api = createLogsAPI(PLUGIN)
    expect(() => api.query()).toThrow(PermissionError)
    expect(() => api.stats()).toThrow(PermissionError)
    expect(() => api.modules()).toThrow(PermissionError)
    expect(() => api.export()).toThrow(PermissionError)
    expect(() => api.transports()).toThrow(PermissionError)
    expect(() => api.subscribe(() => {})).toThrow(PermissionError)
  })

  it("gates traces behind trace:read, separately from logs:read", () => {
    guard.registerPlugin(PLUGIN, ["logs:read"])
    const api = createLogsAPI(PLUGIN)
    // Log side is open…
    expect(() => api.modules()).not.toThrow()
    // …the span side, which can carry prompt previews, is not.
    expect(() => api.traces.list()).toThrow(PermissionError)
    expect(() => api.traces.spans("t")).toThrow(PermissionError)
    expect(() => api.traces.subscribe(() => {})).toThrow(PermissionError)
    expect(() => api.traces.serialize("t")).toThrow(PermissionError)
  })

  it("grants traces without granting the log firehose", () => {
    guard.registerPlugin(PLUGIN, ["trace:read"])
    const api = createLogsAPI(PLUGIN)
    expect(() => api.traces.list()).not.toThrow()
    expect(() => api.query()).toThrow(PermissionError)
  })

  it("exposes no destructive method", () => {
    guard.registerPlugin(PLUGIN, ["logs:read", "trace:read"])
    const api = createLogsAPI(PLUGIN) as unknown as Record<string, unknown>
    for (const forbidden of ["clear", "deleteEntries", "purge", "write", "log"]) {
      expect(api[forbidden]).toBeUndefined()
    }
  })

  describe("granted", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["logs:read", "trace:read"]))

    it("reads logs, stats, modules, transports, and export", async () => {
      const api = createLogsAPI(PLUGIN)
      expect(await api.query({ level: "error" })).toHaveLength(2)
      expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }))
      expect(await api.stats()).toMatchObject({ total: 2 })
      expect(api.modules()).toEqual(["chat", "plugin"])
      expect(api.transports()).toMatchObject({ indexeddb: { status: "healthy" } })
      expect(await api.export()).toContain("l1")
    })

    it("caps an unbounded query so a plugin cannot pull the whole store", async () => {
      const api = createLogsAPI(PLUGIN)
      await api.query({ limit: 1_000_000 })
      expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ limit: 5_000 }))
      await api.query()
      expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 500 }))
    })

    it("delivers only log entries written after subscribing", async () => {
      const api = createLogsAPI(PLUGIN)
      const handler = jest.fn()
      const dispose = api.subscribe(handler)
      expect(onLogsUpdated).toHaveBeenCalled()

      // First flush primes the seen-set: history is not news.
      logsUpdatedHandler?.(2)
      await Promise.resolve()
      await Promise.resolve()
      expect(handler).not.toHaveBeenCalled()

      getLogs.mockResolvedValueOnce([{ id: "l3" }, { id: "l1" }])
      logsUpdatedHandler?.(2)
      await Promise.resolve()
      await Promise.resolve()
      expect(handler).toHaveBeenCalledWith([{ id: "l3" }])

      dispose()
      expect(onLogsUpdatedDispose).toHaveBeenCalled()
    })

    it("rolls the window's spans into traces, newest-first", async () => {
      queryByWindow.mockResolvedValueOnce([
        span("a", { traceId: "t1", startTime: 100 }),
        span("b", { traceId: "t2", startTime: 200 }),
      ])
      const api = createLogsAPI(PLUGIN)
      const traces = await api.traces.list({ window: "week" })
      expect(traces.map((t) => t.traceId)).toEqual(["t2", "t1"])
      expect(queryByWindow).toHaveBeenCalledWith({ since: expect.any(Number) })
    })

    it("filters the trace list to failures on request", async () => {
      queryByWindow.mockResolvedValue([
        span("a", { traceId: "ok", startTime: 100 }),
        span("b", { traceId: "bad", startTime: 200, errorType: "ToolError" }),
      ])
      const api = createLogsAPI(PLUGIN)
      expect((await api.traces.list({ errorsOnly: true })).map((t) => t.traceId)).toEqual(["bad"])
      expect((await api.traces.list()).map((t) => t.traceId)).toEqual(["bad", "ok"])
    })

    it("caps the trace list", async () => {
      queryByWindow.mockResolvedValueOnce(
        Array.from({ length: 20 }, (_, i) => span(`s${i}`, { traceId: `t${i}`, startTime: i }))
      )
      const api = createLogsAPI(PLUGIN)
      expect(await api.traces.list({ limit: 5 })).toHaveLength(5)
    })

    it("reads one trace's spans, waterfall, and timeline from the same query", async () => {
      const spans = [
        span("root", {
          traceId: "t",
          startTime: 1_000,
          durationMs: 500,
          operationName: "invoke_agent",
        }),
        span("child", {
          traceId: "t",
          parentSpanId: "root",
          startTime: 1_100,
          durationMs: 50,
          operationName: "execute_tool",
          toolName: "Bash",
        }),
      ]
      queryByTrace.mockResolvedValue(spans)
      const api = createLogsAPI(PLUGIN)

      expect(await api.traces.spans("t")).toHaveLength(2)

      const waterfall = await api.traces.waterfall("t")
      expect(waterfall.roots).toHaveLength(1)
      expect(waterfall.roots[0].children).toHaveLength(1)

      const timeline = await api.traces.timeline("t", { grouping: "operation" })
      expect(timeline.lanes.map((lane) => lane.id)).toEqual(["invoke_agent", "execute_tool"])
    })

    it("serializes a trace as span JSON and as OTLP", async () => {
      queryByTrace.mockResolvedValue([
        span("root", { traceId: "t", startTime: 1_000, inputPreview: "prompt" }),
      ])
      const api = createLogsAPI(PLUGIN)

      const json = JSON.parse(await api.traces.serialize("t")) as Array<{ spanId: string }>
      expect(json[0].spanId).toBe("root")

      const otlp = JSON.parse(await api.traces.serialize("t", "otlp")) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>
      }
      expect(otlp.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1)
    })

    it("strips content previews from a serialized trace on request", async () => {
      queryByTrace.mockResolvedValue([
        span("root", { traceId: "t", startTime: 1_000, inputPreview: "prompt" }),
      ])
      const api = createLogsAPI(PLUGIN)
      expect(await api.traces.serialize("t")).toContain("prompt")
      expect(await api.traces.serialize("t", "json", { redactPreviews: true })).not.toContain(
        "prompt"
      )
    })

    it("passes the session limit through, clamped", async () => {
      const api = createLogsAPI(PLUGIN)
      await api.traces.bySession("s1")
      expect(queryBySession).toHaveBeenCalledWith("s1", 500)
      await api.traces.bySession("s1", 10_000)
      expect(queryBySession).toHaveBeenLastCalledWith("s1", 5_000)
    })

    it("scopes trace stats to the window, and drops the bound for all-time", async () => {
      const api = createLogsAPI(PLUGIN)
      await api.traces.stats({ window: "month" })
      expect(aggregateStatsAll).toHaveBeenCalledWith({ since: expect.any(Number) })
      await api.traces.stats({ window: "all" })
      expect(aggregateStatsAll).toHaveBeenLastCalledWith(undefined)
    })

    it("delivers only spans that land after subscribing", () => {
      const api = createLogsAPI(PLUGIN)
      const handler = jest.fn()
      const dispose = api.traces.subscribe(handler)

      liveNext?.([span("a"), span("b")])
      expect(handler).not.toHaveBeenCalled()

      liveNext?.([span("c"), span("a")])
      expect(handler).toHaveBeenCalledWith([expect.objectContaining({ id: "c" })])

      dispose()
      expect(unsubscribe).toHaveBeenCalled()
    })

    it("survives a failing live query without throwing at the plugin", () => {
      const api = createLogsAPI(PLUGIN)
      api.traces.subscribe(jest.fn())
      expect(() => liveError?.(new Error("dexie down"))).not.toThrow()
    })
  })
})
