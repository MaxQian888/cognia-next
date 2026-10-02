import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { ObservationBatch } from "../../../../../lib/status/contract"
import { PROBE_HEADERS, verifyProbeRequest } from "../../../../../lib/status/signing"
import { AlertSink } from "./alerts"
import { backoffDelay, IngestionQueue } from "./ingest"
import { memoryLogger } from "./logger"
import { Spool } from "./spool"

const SECRET = new Uint8Array(32).map((_, index) => index + 1)
const API = "https://status.example.test/api/status/v1"

interface Captured {
  url: string
  headers: Headers
  body: Uint8Array
}

function batch(runId: string, scheduledAtMs: number): ObservationBatch {
  const iso = new Date(scheduledAtMs).toISOString()
  return {
    schemaVersion: 1,
    probeId: "ext-test",
    runId,
    registryRevision: 1,
    scheduledAt: iso,
    startedAt: iso,
    finishedAt: iso,
    profileId: "native",
    checks: [
      {
        checkId: "signalingHttp",
        result: "pass",
        durationMs: 12,
        reason: null,
        attempted: true,
        dependsOn: null,
      },
    ],
  }
}

async function harness(responder: (call: Captured, index: number) => Response | Promise<Response>) {
  let now = Date.UTC(2026, 9, 2, 10, 0, 5)
  const calls: Captured[] = []
  const logger = memoryLogger()
  const alertCalls: Array<Record<string, unknown>> = []
  const alerts = new AlertSink({
    webhook: "https://alerts.example.test/hook",
    probeId: "ext-test",
    logger,
    now: () => now,
    fetchImpl: async (_url, init) => {
      alertCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(null, { status: 204 })
    },
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), "probe-ingest-"))
  // The spool reports losses to the queue that is built from it.
  const queueRef: { current?: IngestionQueue } = {}
  const spool = new Spool(dir, {
    now: () => now,
    onLoss: (entry, reason) => queueRef.current?.recordLoss(entry, reason),
  })
  await spool.init()
  const queue = new IngestionQueue({
    apiBase: API,
    keyId: "ext-test-k1",
    secret: SECRET,
    spool,
    logger,
    alerts,
    now: () => now,
    random: () => 0.5,
    fetchImpl: async (url, init) => {
      const call: Captured = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: new Uint8Array(init?.body as Uint8Array),
      }
      calls.push(call)
      return responder(call, calls.length - 1)
    },
  })
  queueRef.current = queue
  return {
    queue,
    spool,
    calls,
    logger,
    alertCalls,
    advance: (ms: number) => {
      now += ms
    },
    minute: () => Math.floor(now / 60_000) * 60_000,
    now: () => now,
  }
}

describe("IngestionQueue signing", () => {
  it("signs the exact pathname, run id and body so the server verifier accepts it", async () => {
    const h = await harness(() =>
      Response.json({ status: "accepted", runId: "r1" }, { status: 202 })
    )
    await h.queue.enqueue(batch("r1", h.minute()))
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(1)
    const [call] = h.calls
    expect(call!.url).toBe(`${API}/observations`)
    expect(call!.headers.get("content-type")).toBe("application/json")
    expect(call!.headers.get(PROBE_HEADERS.runId)).toBe("r1")
    const verdict = await verifyProbeRequest({
      headers: call!.headers,
      method: "POST",
      path: "/api/status/v1/observations",
      body: call!.body,
      nowMs: h.now(),
      resolveSecret: (keyId) => (keyId === "ext-test-k1" ? SECRET : null),
    })
    expect(verdict).toEqual({ ok: true, keyId: "ext-test-k1", runId: "r1", timestampMs: h.now() })
    // A different path or a tampered body would not verify.
    expect(
      (
        await verifyProbeRequest({
          headers: call!.headers,
          method: "POST",
          path: "/observations",
          body: call!.body,
          nowMs: h.now(),
          resolveSecret: () => SECRET,
        })
      ).ok
    ).toBe(false)
    expect(h.spool.entries()).toEqual([])
    expect(h.queue.stats.accepted).toBe(1)
  })

  it("treats 200 duplicate as done", async () => {
    const h = await harness(() => Response.json({ status: "duplicate", runId: "r1" }))
    await h.queue.enqueue(batch("r1", h.minute()))
    await h.queue.drainDue()
    expect(h.queue.stats.duplicates).toBe(1)
    expect(h.queue.pendingCount).toBe(0)
  })
})

describe("IngestionQueue retries", () => {
  it("retries 5xx and network errors with the same run id and identical body bytes", async () => {
    const h = await harness((_call, index) => {
      if (index === 0) return new Response("oops", { status: 503 })
      if (index === 1) throw new TypeError("fetch failed")
      return Response.json({ status: "accepted", runId: "r1" }, { status: 202 })
    })
    await h.queue.enqueue(batch("r1", h.minute()))
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(1)
    // Backoff: nothing is due until the delay passes.
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(1)
    h.advance(backoffDelay(1, { baseMs: 2_000, maxMs: 60_000 }, () => 0.5))
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(2)
    h.advance(backoffDelay(2, { baseMs: 2_000, maxMs: 60_000 }, () => 0.5))
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(3)
    const bodies = h.calls.map((call) => Buffer.from(call.body).toString("utf8"))
    expect(new Set(bodies).size).toBe(1)
    expect(h.calls.every((call) => call.headers.get(PROBE_HEADERS.runId) === "r1")).toBe(true)
    // Each attempt carries a fresh signature over a current timestamp.
    expect(new Set(h.calls.map((call) => call.headers.get(PROBE_HEADERS.timestamp))).size).toBe(3)
    expect(h.queue.stats).toMatchObject({ accepted: 1, retries: 2 })
    expect(h.spool.entries()).toEqual([])
  })

  it("backs off exponentially with jitter, capped", () => {
    const policy = { baseMs: 2_000, maxMs: 60_000 }
    expect(backoffDelay(1, policy, () => 0)).toBe(1_000)
    expect(backoffDelay(1, policy, () => 1)).toBe(2_000)
    expect(backoffDelay(3, policy, () => 0.5)).toBe(6_000)
    expect(backoffDelay(20, policy, () => 1)).toBe(60_000)
  })

  it("honours Retry-After on 429", async () => {
    const h = await harness((_call, index) =>
      index === 0
        ? new Response(null, { status: 429, headers: { "retry-after": "30" } })
        : Response.json({ status: "accepted", runId: "r1" })
    )
    await h.queue.enqueue(batch("r1", h.minute()))
    await h.queue.drainDue()
    h.advance(10_000)
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(1)
    h.advance(20_000)
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(2)
  })

  it("gives up once the batch leaves the 10-minute window and counts the loss", async () => {
    const h = await harness(() => new Response(null, { status: 502 }))
    await h.queue.enqueue(batch("r1", h.minute()))
    for (let step = 0; step < 15; step += 1) {
      await h.queue.drainDue()
      h.advance(60_000)
    }
    await h.queue.drainDue()
    expect(h.queue.pendingCount).toBe(0)
    expect(h.queue.stats.lost).toBe(1)
    expect(h.spool.entries()).toEqual([])
    expect(
      h.logger.lines.some((line) => line.event === "observer_loss" && line.reason === "expired")
    ).toBe(true)
    // Failing for more than 3 minutes pages the operator once (30 min cooldown).
    expect(h.alertCalls.filter((alert) => alert.key === "ingestion_failing")).toHaveLength(1)
  })
})

describe("IngestionQueue definitive answers", () => {
  it("drops a 409 conflicting replay without retrying", async () => {
    const h = await harness(() =>
      Response.json({ code: "conflict", requestId: "q" }, { status: 409 })
    )
    await h.queue.enqueue(batch("r1", h.minute()))
    await h.queue.drainDue()
    h.advance(120_000)
    await h.queue.drainDue()
    expect(h.calls).toHaveLength(1)
    expect(h.queue.stats.conflicts).toBe(1)
    expect(h.spool.entries()).toEqual([])
    expect(h.logger.lines.some((line) => line.event === "ingest_conflict")).toBe(true)
  })

  it("drops other 4xx with an operator alert", async () => {
    const h = await harness(() =>
      Response.json({ code: "unauthorized", requestId: "q" }, { status: 401 })
    )
    await h.queue.enqueue(batch("r1", h.minute()))
    await h.queue.drainDue()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.queue.stats.rejected).toBe(1)
    expect(h.queue.pendingCount).toBe(0)
    expect(h.alertCalls.map((alert) => alert.key)).toEqual(["ingestion_rejected"])
  })

  it("never logs bodies, signatures or secrets", async () => {
    const h = await harness(() => new Response(null, { status: 500 }))
    await h.queue.enqueue(batch("r1", h.minute()))
    await h.queue.drainDue()
    const serialized = JSON.stringify(h.logger.lines)
    expect(serialized).not.toContain("signalingHttp")
    expect(serialized).not.toContain(h.calls[0]!.headers.get(PROBE_HEADERS.signature)!)
  })
})

describe("IngestionQueue durability", () => {
  it("resumes spooled batches after a restart, with the original bytes", async () => {
    const first = await harness(() => new Response(null, { status: 503 }))
    await first.queue.enqueue(batch("r1", first.minute()))
    await first.queue.drainDue()
    await first.queue.stop()
    expect(first.spool.entries()).toHaveLength(1)

    const calls: Uint8Array[] = []
    const logger = memoryLogger()
    const spool = new Spool(first.spool.dir, { now: first.now })
    await spool.init()
    const resumed = new IngestionQueue({
      apiBase: API,
      keyId: "ext-test-k1",
      secret: SECRET,
      spool,
      logger,
      alerts: new AlertSink({ webhook: null, probeId: null, logger }),
      now: first.now,
      fetchImpl: async (_url, init) => {
        calls.push(new Uint8Array(init?.body as Uint8Array))
        return Response.json({ status: "duplicate", runId: "r1" })
      },
    })
    resumed.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await resumed.stop()
    expect(calls).toHaveLength(1)
    expect(Buffer.from(calls[0]!).toString()).toBe(Buffer.from(first.calls[0]!.body).toString())
    expect(spool.entries()).toEqual([])
  })

  it("alerts on spool overflow", async () => {
    const h = await harness(() => new Response(null, { status: 503 }))
    h.queue.recordLoss({ runId: "rX", scheduledAtMs: h.minute() }, "overflow")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.alertCalls.map((alert) => alert.key)).toEqual(["spool_overflow"])
    expect(h.queue.stats.lost).toBe(1)
  })
})
