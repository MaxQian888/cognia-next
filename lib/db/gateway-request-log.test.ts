import "fake-indexeddb/auto"
import {
  appendGatewayRequestLog,
  clearGatewayRequestLog,
  filterGatewayRequestLog,
  GATEWAY_REQUEST_LOG_CAP,
  listGatewayRequestLog,
  summarizeGatewayUsage,
} from "./gateway-request-log"
import { getDb } from "./schema"
import type { GatewayRequestLogRow } from "@/types/gateway"

function row(
  id: string,
  at: string,
  over: Partial<GatewayRequestLogRow> = {}
): GatewayRequestLogRow {
  return {
    id,
    at,
    route: "/v1/chat/completions",
    remoteIp: "127.0.0.1",
    keyId: "k1",
    model: "fast",
    providerId: "groq",
    status: 200,
    latencyMs: 10,
    inputTokens: 5,
    outputTokens: 7,
    error: null,
    stream: false,
    ...over,
  }
}

// Cold-opening the versioned CogniaDB under fake-indexeddb can exceed the
// default 5s hook timeout on the first test; give it headroom.
beforeEach(async () => {
  await getDb().gatewayRequestLog.clear()
}, 30_000)

describe("gateway-request-log CRUD", () => {
  it("appends and lists newest-first", async () => {
    await appendGatewayRequestLog(row("a", "2026-07-03T00:00:01Z"))
    await appendGatewayRequestLog(row("b", "2026-07-03T00:00:02Z"))
    await appendGatewayRequestLog(row("c", "2026-07-03T00:00:03Z"))
    const rows = await listGatewayRequestLog()
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"])
  })

  it("filters by outcome, keyId and model substring", async () => {
    await appendGatewayRequestLog(
      row("ok", "2026-07-03T00:00:01Z", { status: 200, model: "gpt-4o" })
    )
    await appendGatewayRequestLog(
      row("err", "2026-07-03T00:00:02Z", { status: 429, model: "fast", keyId: "k2" })
    )
    expect((await listGatewayRequestLog({ outcome: "errors" })).map((r) => r.id)).toEqual(["err"])
    expect((await listGatewayRequestLog({ outcome: "ok" })).map((r) => r.id)).toEqual(["ok"])
    expect((await listGatewayRequestLog({ keyId: "k2" })).map((r) => r.id)).toEqual(["err"])
    expect((await listGatewayRequestLog({ model: "GPT" })).map((r) => r.id)).toEqual(["ok"])
  })

  it("respects the row limit", async () => {
    await appendGatewayRequestLog(row("a", "2026-07-03T00:00:01Z"))
    await appendGatewayRequestLog(row("b", "2026-07-03T00:00:02Z"))
    expect((await listGatewayRequestLog({ limit: 1 })).map((r) => r.id)).toEqual(["b"])
  })

  it("clears the table", async () => {
    await appendGatewayRequestLog(row("a", "2026-07-03T00:00:01Z"))
    await clearGatewayRequestLog()
    expect(await listGatewayRequestLog()).toEqual([])
  })

  it("trims the oldest rows past the cap on insert", async () => {
    const seed: GatewayRequestLogRow[] = []
    for (let i = 0; i < GATEWAY_REQUEST_LOG_CAP; i++) {
      seed.push(row(`seed-${i}`, String(i).padStart(6, "0")))
    }
    await getDb().gatewayRequestLog.bulkPut(seed)
    // One more past the cap → the single oldest row is trimmed.
    await appendGatewayRequestLog(row("newest", "999999"))
    expect(await getDb().gatewayRequestLog.count()).toBe(GATEWAY_REQUEST_LOG_CAP)
    expect(await getDb().gatewayRequestLog.get("seed-0")).toBeUndefined()
    expect(await getDb().gatewayRequestLog.get("newest")).toBeTruthy()
  }, 30_000)
})

describe("gateway-request-log pure helpers", () => {
  it("filterGatewayRequestLog applies every predicate", () => {
    const rows = [
      row("a", "1", { status: 200, model: "gpt-4o", keyId: "k1" }),
      row("b", "2", { status: 500, model: "fast", keyId: "k2" }),
    ]
    expect(filterGatewayRequestLog(rows, {}).length).toBe(2)
    expect(filterGatewayRequestLog(rows, { outcome: "errors" }).map((r) => r.id)).toEqual(["b"])
    expect(filterGatewayRequestLog(rows, { outcome: "ok" }).map((r) => r.id)).toEqual(["a"])
    expect(filterGatewayRequestLog(rows, { keyId: "k1" }).map((r) => r.id)).toEqual(["a"])
    expect(filterGatewayRequestLog(rows, { model: "fa" }).map((r) => r.id)).toEqual(["b"])
  })

  it("summarizeGatewayUsage aggregates tokens/latency/errors", () => {
    expect(summarizeGatewayUsage([])).toEqual({
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      avgLatencyMs: 0,
    })
    const rows = [
      row("a", "1", { status: 200, inputTokens: 10, outputTokens: 20, latencyMs: 100 }),
      row("b", "2", { status: 500, inputTokens: 0, outputTokens: null, latencyMs: 300 }),
    ]
    expect(summarizeGatewayUsage(rows)).toEqual({
      requests: 2,
      errors: 1,
      inputTokens: 10,
      outputTokens: 20,
      avgLatencyMs: 200,
    })
  })
})
