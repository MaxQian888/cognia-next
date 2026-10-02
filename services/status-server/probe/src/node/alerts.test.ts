import { describe, expect, it } from "vitest"

import { ALERT_COOLDOWN_MS, AlertSink } from "./alerts"
import { memoryLogger } from "./logger"

function harness(status = 204, webhook: string | null = "https://alerts.example.test/hook") {
  let now = Date.UTC(2026, 9, 2, 10, 0, 0)
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  const logger = memoryLogger()
  const sink = new AlertSink({
    webhook,
    probeId: "ext-1",
    logger,
    now: () => now,
    fetchImpl: async (url, init) => {
      posts.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(null, { status })
    },
  })
  return { sink, posts, logger, advance: (ms: number) => (now += ms) }
}

describe("AlertSink", () => {
  it("posts a fixed JSON shape to the configured webhook", async () => {
    const h = harness()
    expect(await h.sink.raise("spool_overflow", "spool full", { pending: 3 })).toBe(true)
    expect(h.posts).toEqual([
      {
        url: "https://alerts.example.test/hook",
        body: {
          source: "cognia-status-probe",
          probeId: "ext-1",
          key: "spool_overflow",
          summary: "spool full",
          detail: { pending: 3 },
          at: "2026-10-02T10:00:00.000Z",
        },
      },
    ])
  })

  it("de-duplicates per key for 30 minutes", async () => {
    const h = harness()
    expect(ALERT_COOLDOWN_MS).toBe(1_800_000)
    await h.sink.raise("ingestion_failing", "a")
    expect(await h.sink.raise("ingestion_failing", "b")).toBe(false)
    expect(await h.sink.raise("status_api_failing", "c")).toBe(true)
    h.advance(ALERT_COOLDOWN_MS - 1)
    expect(await h.sink.raise("ingestion_failing", "d")).toBe(false)
    h.advance(1)
    expect(await h.sink.raise("ingestion_failing", "e")).toBe(true)
    expect(h.posts.map((post) => post.body.summary)).toEqual(["a", "c", "e"])
  })

  it("retries on the next occurrence when delivery fails", async () => {
    const h = harness(500)
    expect(await h.sink.raise("spool_overflow", "x")).toBe(false)
    expect(await h.sink.raise("spool_overflow", "y")).toBe(false)
    expect(h.posts).toHaveLength(2)
    expect(h.logger.lines.filter((line) => line.event === "alert_delivery_failed")).toHaveLength(2)
  })

  it("logs only when no webhook is configured", async () => {
    const h = harness(204, null)
    expect(await h.sink.raise("observer_loss", "lost")).toBe(true)
    expect(h.posts).toEqual([])
    expect(h.logger.lines).toEqual([
      { level: "error", event: "alert", key: "observer_loss", summary: "lost" },
    ])
  })
})
