import { beforeEach, describe, expect, it } from "vitest"

import { createStatusFixture } from "../../../../../lib/status/fixtures"
import { executionContext, resetCore, testEnv } from "../../test/helpers"
import worker from "../index"
import { stampServerTime } from "./routes"

const db = () => testEnv.DB

async function call(path: string, init: RequestInit = {}) {
  const ctx = executionContext()
  const response = await worker.fetch(new Request(`https://status.test${path}`, init), testEnv, ctx)
  await ctx.settle()
  return response
}

async function storeSnapshot(range: string, revision: number) {
  const body = JSON.stringify({ ...createStatusFixture("operational", range as "24h"), revision })
  await db()
    .prepare(
      `INSERT INTO snapshots (range, revision, generated_at, etag, body) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (range) DO UPDATE SET revision = excluded.revision, etag = excluded.etag, body = excluded.body`
    )
    .bind(range, revision, Date.now(), `"r${revision}-${range}"`, body)
    .run()
}

beforeEach(async () => {
  await resetCore()
  // Each test uses a distinct range or revision so the edge cache cannot
  // hand one test another test's body.
})

describe("GET /api/status/v1/snapshot", () => {
  it("answers unavailable, never a preview, before the first snapshot", async () => {
    const response = await call("/api/status/v1/snapshot?range=30d")
    expect(response.status).toBe(503)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    await expect(response.json()).resolves.toMatchObject({ code: "unavailable" })
  })

  it("returns the stored snapshot with a fresh serverTime, ETag and public CORS", async () => {
    await storeSnapshot("7d", 11)
    const before = Date.now()
    const response = await call("/api/status/v1/snapshot?range=7d")
    expect(response.status).toBe(200)
    expect(response.headers.get("etag")).toBe('"r11-7d"')
    expect(response.headers.get("x-status-revision")).toBe("11")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    const body = (await response.json()) as { revision: number; range: string; serverTime: string }
    expect(body).toMatchObject({ revision: 11, range: "7d" })
    expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(before - 1_000)
  })

  it("stamps serverTime on every response, including edge-cache hits", async () => {
    await storeSnapshot("30d", 13)
    const first = (await (await call("/api/status/v1/snapshot?range=30d")).json()) as {
      serverTime: string
    }
    await new Promise((resolve) => setTimeout(resolve, 15))
    const second = (await (await call("/api/status/v1/snapshot?range=30d")).json()) as {
      serverTime: string
    }
    expect(Date.parse(second.serverTime)).toBeGreaterThan(Date.parse(first.serverTime))
  })

  it("never answers 304, because every body carries a fresh clock reference", async () => {
    await storeSnapshot("90d", 12)
    const response = await call("/api/status/v1/snapshot?range=90d", {
      headers: { "if-none-match": '"r12-90d"' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("etag")).toBe('"r12-90d"')
  })

  it("rejects unknown ranges and parameters", async () => {
    expect((await call("/api/status/v1/snapshot?range=1y")).status).toBe(400)
    expect((await call("/api/status/v1/snapshot?range=24h&probe=x")).status).toBe(400)
  })

  it("only allows reads", async () => {
    expect((await call("/api/status/v1/snapshot", { method: "POST" })).status).toBe(405)
    const preflight = await call("/api/status/v1/snapshot", { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS")
    const adminPreflight = await call("/api/status/v1/admin/incidents", { method: "OPTIONS" })
    expect(adminPreflight.status).toBe(405)
    expect(adminPreflight.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("GET /api/status/v1/healthz", () => {
  it("reports backend liveness and build identity, not relay health", async () => {
    const response = await call("/api/status/v1/healthz")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "cognia-status",
      version: "0.1.0-test",
      build: "testsha",
      schemaVersion: 1,
      database: "ok",
      snapshotAgeMs: null,
    })
  })
})

describe("API routing", () => {
  it("answers unknown API paths with JSON 404, never HTML", async () => {
    for (const path of ["/api/status/v1/nope", "/api/status/v2/snapshot", "/api/anything"]) {
      const response = await call(path)
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
    }
  })
})

describe("stampServerTime", () => {
  it("replaces only the top-level serverTime", () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      serverTime: "2026-01-01T00:00:00.000Z",
      nested: { at: "x" },
    })
    const stamped = JSON.parse(stampServerTime(body, Date.parse("2026-10-02T00:00:00.000Z")))
    expect(stamped.serverTime).toBe("2026-10-02T00:00:00.000Z")
    expect(stamped.nested).toEqual({ at: "x" })
  })
})
