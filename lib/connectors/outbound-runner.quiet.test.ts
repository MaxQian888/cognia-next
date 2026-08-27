/** @jest-environment jsdom */
/**
 * Quiet hours + global mute tests for outbound-runner — Task 109.
 *
 * Tests the isInQuietHours and msUntilQuietEnd pure functions,
 * plus integration tests for the muted/quiet-hours deferral paths.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { enqueueOutboundMany } from "@/lib/db/outbound-jobs"
import { startOutboundRunner, isInQuietHours, msUntilQuietEnd } from "./outbound-runner"
import type { PlatformAdapter, OutboundResult } from "@/types/connectors"

// ── Module mocks (hoisted) ───────────────────────────────────────────────────

// We control what getAdapterInstance returns per test
let adapterInstanceOverride: Record<string, unknown> | undefined | null = null

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(async () => adapterInstanceOverride),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(id: string, send: () => Promise<OutboundResult>): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Adapter ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn(send),
  } as unknown as PlatformAdapter
}

/**
 * Enqueue against the SAME clock the runner is given.
 *
 * `enqueueOutboundMany` stamps `nextAttemptAt` from its `now`, and the runner
 * only drains rows whose `nextAttemptAt <= its own now`. Enqueuing on the wall
 * clock while running the drain at a pinned 2024 timestamp left every row
 * `pending` forever — the runner was correct and the test was asking it to
 * dispatch work that, on its clock, had not been scheduled yet.
 */
async function enqueue(adapterId: string, conversationKey: string, now: number) {
  const [row] = await enqueueOutboundMany(
    [
      {
        adapterId,
        conversationKey,
        request: {
          conversationRef: { platform: "telegram", adapterId },
          segments: [{ type: "text", text: "msg" }],
          metadata: { idempotencyKey: crypto.randomUUID() },
        },
        source: "ai-run",
      },
    ],
    { now }
  )
  return row
}

async function runForTicks(
  adapters: Map<string, PlatformAdapter>,
  clock: () => number,
  ticks = 15
): Promise<void> {
  const controller = new AbortController()
  let count = 0
  const promise = startOutboundRunner({
    adapters,
    signal: controller.signal,
    pollIntervalMs: 1,
    now: clock,
  })
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      count++
      if (count >= ticks) {
        clearInterval(id)
        controller.abort()
        resolve()
      }
    }, 5)
  })
  await promise
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await __resetDbForTesting()
  adapterInstanceOverride = null
  jest.clearAllMocks()
})

// ── isInQuietHours unit tests ──────────────────────────────────────────────────

describe("isInQuietHours", () => {
  it("returns true when current time is within same-day window", () => {
    const ts = new Date("2024-05-01T14:00:00Z").getTime()
    expect(isInQuietHours(ts, "09:00", "17:00", "UTC")).toBe(true)
  })

  it("returns false when current time is outside same-day window", () => {
    const ts = new Date("2024-05-01T18:00:00Z").getTime()
    expect(isInQuietHours(ts, "09:00", "17:00", "UTC")).toBe(false)
  })

  it("returns true when current time is within cross-midnight window (before midnight)", () => {
    const ts = new Date("2024-05-01T23:00:00Z").getTime()
    expect(isInQuietHours(ts, "22:00", "06:00", "UTC")).toBe(true)
  })

  it("returns true when current time is within cross-midnight window (after midnight)", () => {
    const ts = new Date("2024-05-02T03:00:00Z").getTime()
    expect(isInQuietHours(ts, "22:00", "06:00", "UTC")).toBe(true)
  })

  it("returns false when current time is outside cross-midnight window", () => {
    const ts = new Date("2024-05-01T12:00:00Z").getTime()
    expect(isInQuietHours(ts, "22:00", "06:00", "UTC")).toBe(false)
  })

  it("uses timezone correctly", () => {
    // 14:00 UTC = ~09:00 America/New_York (UTC-5 in winter)
    const ts = new Date("2024-01-15T14:00:00Z").getTime()
    // 09:00 NY is inside 08:00–10:00 NY window
    expect(isInQuietHours(ts, "08:00", "10:00", "America/New_York")).toBe(true)
    // 14:00 UTC is outside 08:00–10:00 UTC window
    expect(isInQuietHours(ts, "08:00", "10:00", "UTC")).toBe(false)
  })
})

// ── msUntilQuietEnd unit tests ────────────────────────────────────────────────

describe("msUntilQuietEnd", () => {
  it("returns positive ms to next window-close time (~7h ahead at 23:00)", () => {
    const ts = new Date("2024-05-01T23:00:00Z").getTime()
    const ms = msUntilQuietEnd(ts, "06:00", "UTC")
    // 06:00 next day = ~7h ahead
    expect(ms).toBeGreaterThan(6 * 60 * 60 * 1000)
    expect(ms).toBeLessThan(8 * 60 * 60 * 1000)
  })

  it("returns approximately correct ms for same-day window end", () => {
    const ts = new Date("2024-05-01T10:00:00Z").getTime()
    const ms = msUntilQuietEnd(ts, "17:00", "UTC")
    // 17:00 today = 7h ahead
    expect(ms).toBeGreaterThan(6 * 60 * 60 * 1000)
    expect(ms).toBeLessThan(8 * 60 * 60 * 1000)
  })
})

// ── muted adapter integration test ────────────────────────────────────────────

describe("muted adapter", () => {
  it("defers job with status=failed and reason=muted rather than delivering", async () => {
    const adapterId = "adp_muted"
    const now = new Date("2024-05-01T12:00:00Z").getTime()
    const clock = () => now

    // Simulate adapter instance returning muted=true
    adapterInstanceOverride = { muted: true }

    await enqueue(adapterId, "tg:muted:1", now)

    const adapters = new Map<string, PlatformAdapter>([
      [adapterId, makeAdapter(adapterId, async () => ({ ok: true }))],
    ])

    await runForTicks(adapters, clock)

    const jobs = await getDb()
      .outboundQueue.filter((j) => j.adapterId === adapterId)
      .toArray()
    expect(jobs).toHaveLength(1)
    const job = jobs[0]
    expect(job.status).toBe("failed")
    expect(job.lastErrorCode).toBe("muted")
    // nextAttemptAt deferred by at least 50s
    expect(job.nextAttemptAt).toBeGreaterThan(now + 50_000)
    // The adapter's send should NOT have been called
    const adapter = adapters.get(adapterId)!
    expect(adapter.send).not.toHaveBeenCalled()
  })
})

// ── quiet hours integration test ──────────────────────────────────────────────

describe("quiet hours adapter", () => {
  it("defers job when current time is within quiet window", async () => {
    const adapterId = "adp_quiet_on"
    const fixedNow = new Date("2024-05-01T12:00:00Z").getTime()
    const clock = () => fixedNow

    adapterInstanceOverride = {
      muted: false,
      quietHours: { from: "00:00", to: "23:59", tz: "UTC" }, // always in window
    }

    await enqueue(adapterId, "tg:quiet:1", fixedNow)

    const adapters = new Map<string, PlatformAdapter>([
      [adapterId, makeAdapter(adapterId, async () => ({ ok: true }))],
    ])

    await runForTicks(adapters, clock, 30)

    const jobs = await getDb()
      .outboundQueue.filter((j) => j.adapterId === adapterId)
      .toArray()
    expect(jobs).toHaveLength(1)
    const job = jobs[0]
    expect(job.status).toBe("failed")
    expect(job.lastErrorCode).toBe("quiet_hours")
    // nextAttemptAt deferred past current time
    expect(job.nextAttemptAt).toBeGreaterThan(fixedNow)
    const adapter = adapters.get(adapterId)!
    expect(adapter.send).not.toHaveBeenCalled()
  })

  it("delivers normally when outside quiet window", async () => {
    const adapterId = "adp_quiet_off"
    const fixedNow = new Date("2024-05-01T12:00:00Z").getTime()
    const clock = () => fixedNow

    adapterInstanceOverride = {
      muted: false,
      quietHours: { from: "22:00", to: "06:00", tz: "UTC" },
    }

    await enqueue(adapterId, "tg:quiet:2", fixedNow)

    const adapters = new Map<string, PlatformAdapter>([
      [adapterId, makeAdapter(adapterId, async () => ({ ok: true, platformMessageId: "pm_ok" }))],
    ])

    await runForTicks(adapters, clock, 30)

    const jobs = await getDb()
      .outboundQueue.filter((j) => j.adapterId === adapterId)
      .toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe("sent")
  })

  it("delivers normally when no quietHours configured", async () => {
    const adapterId = "adp_no_quiet"
    const fixedNow = new Date("2024-05-01T23:00:00Z").getTime()
    const clock = () => fixedNow

    // No quiet hours
    adapterInstanceOverride = { muted: false }

    await enqueue(adapterId, "tg:quiet:3", fixedNow)

    const adapters = new Map<string, PlatformAdapter>([
      [adapterId, makeAdapter(adapterId, async () => ({ ok: true, platformMessageId: "pm_ok2" }))],
    ])

    await runForTicks(adapters, clock, 30)

    const jobs = await getDb()
      .outboundQueue.filter((j) => j.adapterId === adapterId)
      .toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe("sent")
  })
})
