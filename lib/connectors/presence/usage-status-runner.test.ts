/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Dexie clear/reseed in beforeEach can exceed the default 5s hook timeout
// under parallel-worker CPU contention (repo idiom for Dexie suites).
jest.setTimeout(30_000)

import { getDb } from "@/lib/db/schema"
import { createAdapterInstance, getAdapterInstance } from "@/lib/db/adapter-instances"
import { upsertSessionUsage } from "@/lib/db/session-usage"
import { hasTaskExecutor } from "@/lib/scheduler/task-scheduler"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import {
  PRESENCE_REFRESH_TASK_TYPE,
  installUsagePresenceHandlers,
  resolvePresenceConfig,
  runUsagePresenceRefresh,
} from "./usage-status-runner"

const mockGetAdapter = jest.fn()
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({ getAdapter: (id: string) => mockGetAdapter(id) }),
}))

const NOW = new Date("2026-07-08T10:00:00Z").getTime()

async function seedAdapter(
  presence?: AdapterInstanceRow["presence"],
  presenceState?: AdapterInstanceRow["presenceState"]
): Promise<AdapterInstanceRow> {
  return createAdapterInstance({
    type: "lark",
    displayName: "Lark Bot",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: { mode: "auto" } as unknown as AdapterInstanceRow["trigger"],
    defaultMode: "auto" as AdapterInstanceRow["defaultMode"],
    presence,
    presenceState,
  } as unknown as Parameters<typeof createAdapterInstance>[0])
}

function fakeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id: "x",
    meta: {} as PlatformAdapter["meta"],
    start: jest.fn(),
    stop: jest.fn(),
    health: jest.fn(),
    send: jest.fn(),
    a2uiCapability: jest.fn(),
    ...overrides,
  } as unknown as PlatformAdapter
}

beforeEach(async () => {
  mockGetAdapter.mockReset()
  const db = getDb()
  await db.adapterInstances.clear()
  await db.sessionUsage.clear()
  await db.outboundQueue.clear()
  await upsertSessionUsage({
    messageId: "m1",
    sessionId: "s1",
    at: NOW - 60_000,
    model: "claude-sonnet-5",
    inputTokens: 1_000_000,
    outputTokens: 200_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 3.4,
    durationMs: 1000,
  })
})

describe("resolvePresenceConfig", () => {
  it("returns null when missing or disabled", () => {
    expect(resolvePresenceConfig(undefined)).toBeNull()
    expect(
      resolvePresenceConfig({ enabled: false, mode: "badge", intervalMinutes: 5, window: "today" })
    ).toBeNull()
  })

  it("applies defaults and clamps the interval", () => {
    const cfg = resolvePresenceConfig({
      enabled: true,
      mode: "badge",
      intervalMinutes: 0,
      window: "today",
    })
    expect(cfg!.intervalMinutes).toBe(1)
  })
})

describe("runUsagePresenceRefresh", () => {
  it("skips cleanly when presence is disabled", async () => {
    const row = await seedAdapter(undefined)
    const res = await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })
    expect(res).toEqual({ success: true, output: { skipped: "disabled" } })
  })

  it("fails when the adapter row does not exist", async () => {
    const res = await runUsagePresenceRefresh({ adapterId: "nope", now: NOW })
    expect(res.success).toBe(false)
  })

  it("fails when the adapter is not running", async () => {
    const row = await seedAdapter({
      enabled: true,
      mode: "badge",
      intervalMinutes: 5,
      window: "today",
    })
    mockGetAdapter.mockReturnValue(undefined)
    const res = await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })
    expect(res.success).toBe(false)
    expect(res.error).toContain("not running")
  })

  it("badge mode calls setPresenceStatus with formatted text, expiry, and targets", async () => {
    const row = await seedAdapter({
      enabled: true,
      mode: "badge",
      intervalMinutes: 5,
      window: "today",
      targetUserIds: ["ou_1"],
    })
    const setPresenceStatus = jest.fn().mockResolvedValue(undefined)
    mockGetAdapter.mockReturnValue(fakeAdapter({ setPresenceStatus }))

    const res = await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })
    expect(res.success).toBe(true)
    expect(setPresenceStatus).toHaveBeenCalledWith({
      text: "AI 1.2M $3.4",
      expiresAt: NOW + 10 * 60_000,
      targetUserIds: ["ou_1"],
    })
    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.lastRefreshAt).toBe(NOW)
    expect(updated!.presenceState!.lastError).toBeUndefined()
  })

  it("records badge errors on presenceState without failing the tick", async () => {
    const row = await seedAdapter({
      enabled: true,
      mode: "badge",
      intervalMinutes: 5,
      window: "today",
    })
    mockGetAdapter.mockReturnValue(
      fakeAdapter({ setPresenceStatus: jest.fn().mockRejectedValue(new Error("boom")) })
    )
    const res = await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })
    expect(res.success).toBe(true)
    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.lastError).toContain("boom")
  })

  it("records a config error when the adapter lacks setPresenceStatus", async () => {
    const row = await seedAdapter({
      enabled: true,
      mode: "badge",
      intervalMinutes: 5,
      window: "today",
    })
    mockGetAdapter.mockReturnValue(fakeAdapter())
    await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })
    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.lastError).toContain("setPresenceStatus")
  })

  it("card mode enqueues a markdown card and records the creating job id", async () => {
    const row = await seedAdapter({
      enabled: true,
      mode: "card",
      intervalMinutes: 5,
      window: "today",
      cardConversationKey: "lark:ad-1:oc_chat",
    })
    mockGetAdapter.mockReturnValue(fakeAdapter())

    const res = await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })
    expect(res.success).toBe(true)

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    const seg = jobs[0].request.segments[0] as { type: string; md: string }
    expect(seg.type).toBe("markdown")
    expect(seg.md).toContain("Token Usage / 用量统计")
    expect(jobs[0].request.editTargetMessageId).toBeUndefined()

    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.cardJobId).toBe(jobs[0].id)
  })

  it("card mode edits in place and pins once the message id is known", async () => {
    const row = await seedAdapter(
      {
        enabled: true,
        mode: "card",
        intervalMinutes: 5,
        window: "today",
        cardConversationKey: "lark:ad-1:oc_chat",
      },
      { cardMessageId: "om_1" }
    )
    const pinMessage = jest.fn().mockResolvedValue(undefined)
    mockGetAdapter.mockReturnValue(fakeAdapter({ pinMessage }))

    await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs[0].request.editTargetMessageId).toBe("om_1")
    expect(pinMessage).toHaveBeenCalledWith("lark:ad-1:oc_chat", "om_1")
    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.cardPinned).toBe(true)
  })

  it("clears a dead-lettered creating job and tracks the replacement card job", async () => {
    const row = await seedAdapter(
      {
        enabled: true,
        mode: "card",
        intervalMinutes: 5,
        window: "today",
        cardConversationKey: "lark:ad-1:oc_chat",
      },
      { cardJobId: "job-dead" }
    )
    mockGetAdapter.mockReturnValue(fakeAdapter())
    await getDb().outboundQueue.add({
      id: "job-dead",
      adapterId: row.id,
      conversationKey: "lark:ad-1:oc_chat",
      request: {
        conversationRef: { platform: "lark", adapterId: row.id },
        segments: [],
        metadata: { idempotencyKey: "k-dead" },
      },
      status: "deadlettered",
      attempts: 5,
      createdAt: NOW - 60_000,
      nextAttemptAt: NOW - 60_000,
      idempotencyKey: "k-dead",
      source: "manual",
      lastErrorCode: "max_attempts",
    } as never)

    await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })

    const jobs = await getDb().outboundQueue.toArray()
    const fresh = jobs.find((j) => j.id !== "job-dead")!
    // A new card is created cleanly (no edit target pointing at nothing)…
    expect(fresh.request.editTargetMessageId).toBeUndefined()
    // …and the dangling pointer is REPLACED by the new creating job, so the
    // next tick edits in place instead of minting a card per tick forever.
    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.cardJobId).toBe(fresh.id)
    expect(updated!.presenceState!.cardMessageId).toBeUndefined()
  })

  it("follows a rerouted dead-letter to the sibling's delivery evidence", async () => {
    const row = await seedAdapter(
      {
        enabled: true,
        mode: "card",
        intervalMinutes: 5,
        window: "today",
        cardConversationKey: "lark:ad-1:oc_chat",
      },
      { cardJobId: "job-original" }
    )
    mockGetAdapter.mockReturnValue(fakeAdapter())
    const base = {
      adapterId: row.id,
      conversationKey: "lark:ad-1:oc_chat",
      request: {
        conversationRef: { platform: "lark", adapterId: row.id },
        segments: [],
        metadata: { idempotencyKey: "k-reroute" },
      },
      attempts: 1,
      createdAt: NOW - 60_000,
      nextAttemptAt: NOW - 60_000,
      idempotencyKey: "k-reroute",
      source: "manual",
    }
    await getDb().outboundQueue.bulkAdd([
      {
        ...base,
        id: "job-original",
        status: "deadlettered",
        lastErrorCode: "failover",
        reroutedToJobId: "job-sibling",
        reroutedMechanism: "failover",
      },
      { ...base, id: "job-sibling", status: "sent", platformMessageId: "om_sibling" },
    ] as never)

    await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })

    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.cardMessageId).toBe("om_sibling")
    const jobs = await getDb().outboundQueue.toArray()
    const refresh = jobs.find((j) => j.id !== "job-original" && j.id !== "job-sibling")!
    expect(refresh.request.editTargetMessageId).toBe("om_sibling")
  })

  it("keeps waiting on a still-active creating job (no pointer churn)", async () => {
    const row = await seedAdapter(
      {
        enabled: true,
        mode: "card",
        intervalMinutes: 5,
        window: "today",
        cardConversationKey: "lark:ad-1:oc_chat",
      },
      { cardJobId: "job-pending" }
    )
    mockGetAdapter.mockReturnValue(fakeAdapter())
    await getDb().outboundQueue.add({
      id: "job-pending",
      adapterId: row.id,
      conversationKey: "lark:ad-1:oc_chat",
      request: {
        conversationRef: { platform: "lark", adapterId: row.id },
        segments: [],
        metadata: { idempotencyKey: "k-pending" },
      },
      status: "pending",
      attempts: 0,
      createdAt: NOW - 1_000,
      nextAttemptAt: NOW - 1_000,
      idempotencyKey: "k-pending",
      source: "manual",
    } as never)

    await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })

    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.cardJobId).toBe("job-pending")
    expect(updated!.presenceState!.cardMessageId).toBeUndefined()
  })

  it("resolves the card message id from a delivered creating job", async () => {
    const row = await seedAdapter(
      {
        enabled: true,
        mode: "card",
        intervalMinutes: 5,
        window: "today",
        cardConversationKey: "lark:ad-1:oc_chat",
      },
      { cardJobId: "job-1" }
    )
    mockGetAdapter.mockReturnValue(fakeAdapter())
    await getDb().outboundQueue.add({
      id: "job-1",
      adapterId: row.id,
      conversationKey: "lark:ad-1:oc_chat",
      request: {
        conversationRef: { platform: "lark", adapterId: row.id },
        segments: [],
        metadata: { idempotencyKey: "k" },
      },
      status: "sent",
      platformMessageId: "om_99",
      attempts: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as never)

    await runUsagePresenceRefresh({ adapterId: row.id, now: NOW })
    const updated = await getAdapterInstance(row.id)
    expect(updated!.presenceState!.cardMessageId).toBe("om_99")
    const jobs = await getDb().outboundQueue.toArray()
    const refresh = jobs.find((j) => j.id !== "job-1")!
    expect(refresh.request.editTargetMessageId).toBe("om_99")
  })
})

describe("installUsagePresenceHandlers", () => {
  it("registers the connection:presence:refresh executor", () => {
    installUsagePresenceHandlers()
    expect(hasTaskExecutor(PRESENCE_REFRESH_TASK_TYPE)).toBe(true)
  })
})
