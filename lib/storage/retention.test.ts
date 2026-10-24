const mockRetryDesktopDeletion = jest.fn(async () => 0)
jest.mock("@/lib/automation/managed-desktop-result-deletion", () => ({
  retryManagedDesktopResultDeletions: () => mockRetryDesktopDeletion(),
}))
import {
  getStorageRetentionSnapshot,
  pruneRetainedTables,
  startStorageRetentionSweeper,
  RETENTION_TARGETS,
  RETENTION_SWEEP_INTERVAL_MS,
  type RetentionTarget,
} from "./retention"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { saveSettings, getSettings, DEFAULTS } from "@/lib/db/settings"
import { DEFAULT_OCR_SETTINGS } from "@/types/ocr"
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/types/notifications"
import { localDayString } from "@/lib/db/provider-cost-daily"

// Wrap getSettings so one test can force the read to reject; every other call
// falls through to the real implementation (which reads the saved row).
jest.mock("@/lib/db/settings", () => {
  const actual = jest.requireActual("@/lib/db/settings")
  return { __esModule: true, ...actual, getSettings: jest.fn(actual.getSettings) }
})

jest.mock("@/lib/ai/media/video-jobs/app-data-sweep", () => ({
  sweepVideoAppData: jest.fn(async () => ({
    databaseDirectories: 0,
    orphanVideos: 0,
    staleStagingCopies: 0,
  })),
}))

// The sweep's own behavior is covered by `lib/db/session-aside-orphans.test.ts`;
// here it only matters that the daily sweep runs it and survives its failure.
const mockPurgeOrphanedSessionSideChats = jest.fn(async () => 0)
jest.mock("@/lib/db/session-aside-orphans", () => ({
  purgeOrphanedSessionSideChats: () => mockPurgeOrphanedSessionSideChats(),
}))

const MS_PER_DAY = 86_400_000

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().agentTraces.clear()
  await getDb().ocrResults.clear()
})

function span(id: string, startTime: number) {
  return {
    id,
    spanId: id,
    sessionId: "s1",
    traceId: "t1",
    providerName: "test",
    startTime,
    operationName: "noop",
    surface: "chat",
  } as unknown as import("@/types/agent-trace/span").AgentTraceSpan
}

afterAll(dbFixture.dispose)

describe("pruneRetainedTables", () => {
  it("short-circuits without touching targets for days <= 0", async () => {
    const prune = jest.fn(async () => 5)
    expect(await pruneRetainedTables(0, [{ id: "x", prune }])).toEqual([
      { id: "x", removed: 0, status: "off", reason: "configured-off" },
    ])
    expect(await pruneRetainedTables(-3, [{ id: "x", prune }])).toEqual([
      { id: "x", removed: 0, status: "off", reason: "configured-off" },
    ])
    expect(prune).not.toHaveBeenCalled()
  })

  it("short-circuits for non-finite days", async () => {
    const prune = jest.fn(async () => 1)
    expect(await pruneRetainedTables(Number.NaN, [{ id: "x", prune }])).toEqual([
      { id: "x", removed: 0, status: "off", reason: "configured-off" },
    ])
    expect(prune).not.toHaveBeenCalled()
  })

  it("still deletes independently expired rows when trace retention is keep-forever", async () => {
    const windowPrune = jest.fn(async () => 1)
    const expiryPrune = jest.fn(async () => 2)

    await expect(
      pruneRetainedTables(0, [
        { id: "window", policy: "configured-window", prune: windowPrune },
        { id: "expiry", policy: "row-expiry", prune: expiryPrune },
      ])
    ).resolves.toEqual([
      { id: "window", removed: 0, status: "off", reason: "configured-off" },
      { id: "expiry", removed: 2, status: "completed" },
    ])
    expect(windowPrune).not.toHaveBeenCalled()
    expect(expiryPrune).toHaveBeenCalledTimes(1)
  })

  it("passes a cutoff of now - days and aggregates removed counts", async () => {
    let seenCutoff = 0
    const targets: RetentionTarget[] = [
      {
        id: "a",
        prune: async (cutoff) => {
          seenCutoff = cutoff
          return 2
        },
      },
      { id: "b", prune: async () => 3 },
    ]
    const before = Date.now()
    const out = await pruneRetainedTables(7, targets)
    const after = Date.now()
    expect(out).toEqual([
      { id: "a", removed: 2, status: "completed" },
      { id: "b", removed: 3, status: "completed" },
    ])
    expect(seenCutoff).toBeGreaterThanOrEqual(before - 7 * MS_PER_DAY)
    expect(seenCutoff).toBeLessThanOrEqual(after - 7 * MS_PER_DAY)
  })

  it("isolates a failing target — logs and reports removed 0, others continue", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const targets: RetentionTarget[] = [
      { id: "bad", prune: async () => Promise.reject(new Error("boom")) },
      { id: "good", prune: async () => 4 },
    ]
    const out = await pruneRetainedTables(1, targets)
    expect(out).toEqual([
      { id: "bad", removed: 0, status: "failed", reason: "prune-failed" },
      { id: "good", removed: 4, status: "completed" },
    ])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("prunes real agentTraces spans older than the window via the default targets", async () => {
    const now = Date.now()
    await getDb().agentTraces.bulkPut([
      span("old", now - 40 * MS_PER_DAY),
      span("fresh", now - 1 * MS_PER_DAY),
    ])
    const out = await pruneRetainedTables(30)
    expect(out).toEqual([
      { id: "actionReviewReceipts", removed: 0, status: "completed-no-work" },
      { id: "agentTraces", removed: 1, status: "completed" },
      { id: "evalArtifacts", removed: 0, status: "completed-no-work" },
      { id: "evalOnline", removed: 0, status: "completed-no-work" },
      { id: "workSubmissions", removed: 0, status: "completed-no-work" },
      { id: "managedDesktopDeletion", removed: 0, status: "completed-no-work" },
      expect.objectContaining({
        id: "mediaGenerationJobs",
        removed: 0,
        status: "completed-no-work",
      }),
      { id: "memoryGovernance", removed: 0, status: "completed-no-work" },
      { id: "notificationDelivery", removed: 0, status: "completed-no-work" },
      { id: "ocrResults", removed: 0, status: "completed-no-work" },
      { id: "usageHistory", removed: 0, status: "completed-no-work" },
      { id: "retrievalControl", removed: 0, status: "completed-no-work" },
      { id: "workflowAppData", removed: 0, status: "completed-no-work" },
      { id: "siteArtifacts", removed: 0, status: "completed-no-work" },
      { id: "syncTombstones", removed: 0, status: "completed-no-work" },
    ])
    expect((await getDb().agentTraces.toArray()).map((r) => r.id)).toEqual(["fresh"])
  })

  it("sweeps the video files no job row accounts for after pruning the rows", async () => {
    const { sweepVideoAppData } = jest.requireMock("@/lib/ai/media/video-jobs/app-data-sweep")
    const target = RETENTION_TARGETS.find((t) => t.id === "mediaGenerationJobs")!
    ;(sweepVideoAppData as jest.Mock).mockClear()
    await expect(target.prune(Date.now())).resolves.toMatchObject({ removed: 0 })
    expect(sweepVideoAppData).toHaveBeenCalledTimes(1)

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    ;(sweepVideoAppData as jest.Mock).mockRejectedValueOnce(new Error("fs refused"))
    await expect(target.prune(Date.now())).resolves.toMatchObject({
      removed: 0,
      status: "partial",
      stages: expect.arrayContaining([expect.objectContaining({ id: "files", status: "failed" })]),
    })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("exposes agentTraces as a default target", () => {
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("agentTraces")
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("evalArtifacts")
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("ocrResults")
    // Declaring `executorId: "evalOnline"` in the governance catalog is a
    // promise; `governedRetentionTargets()` throws if nothing implements it, so
    // this pins that the online tables are actually swept rather than merely
    // documented as swept.
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("evalOnline")
    // ADR-0115's two prune functions were written, tested, and then called from
    // nowhere, so the memory and retrieval control-plane tables grew without
    // bound. These two entries are what actually sweeps them.
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("memoryGovernance")
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("retrievalControl")
    // `pruneActionReviewReceipts` had no caller either (ADR-0239 WP1).
    expect(RETENTION_TARGETS.map((t) => t.id)).toContain("actionReviewReceipts")
  })

  it("preserves deletions already completed when a later file sweep stage fails", async () => {
    const { sweepVideoAppData } = jest.requireMock("@/lib/ai/media/video-jobs/app-data-sweep")
    sweepVideoAppData.mockImplementationOnce(
      async (_deps: unknown, report: { removed: number }) => {
        report.removed = 3
        throw new Error("private filesystem path must not escape")
      }
    )
    const target = RETENTION_TARGETS.find((row) => row.id === "mediaGenerationJobs")!
    const [result] = await pruneRetainedTables(30, [target])
    expect(result).toMatchObject({
      removed: 3,
      status: "partial",
      stages: expect.arrayContaining([
        expect.objectContaining({ id: "files", removed: 3, status: "partial" }),
      ]),
    })
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it("sweeps the memory and retrieval control planes on a real database", async () => {
    const stale = Date.now() - 200 * MS_PER_DAY
    await getDb().memoryAuditEvents.add({
      id: "a-old",
      action: "created",
      reason: "user",
      createdAt: stale,
    })
    await getDb().memoryEvidence.add({
      id: "e-orphan",
      kind: "message",
      sourceId: "s1:turn:2:user",
      contaminationState: "clean",
      reviewed: false,
      createdAt: stale,
    })

    const out = await pruneRetainedTables(30)
    expect(out).toContainEqual({ id: "memoryGovernance", removed: 2, status: "completed" })
    expect(await getDb().memoryAuditEvents.count()).toBe(0)
    // The turn path used to leak two of these per turn, and nothing could reach
    // them because `deleteMemoryEvidence` keys on `memoryId`.
    expect(await getDb().memoryEvidence.count()).toBe(0)
  })

  it("prunes stale OCR cache rows through the shared configured window", async () => {
    const now = Date.now()
    await getDb().ocrResults.bulkPut([
      {
        id: "old",
        fileSha: "old",
        providerId: "mistral-ocr",
        langs: "en",
        result: "{}",
        createdAt: now - 40 * MS_PER_DAY,
        bytesIn: 100,
      },
      {
        id: "fresh",
        fileSha: "fresh",
        providerId: "mistral-ocr",
        langs: "en",
        result: "{}",
        createdAt: now - MS_PER_DAY,
        bytesIn: 100,
      },
    ])

    const out = await pruneRetainedTables(30)

    expect(out).toContainEqual({ id: "ocrResults", removed: 1, status: "completed" })
    expect((await getDb().ocrResults.toArray()).map((row) => row.id)).toEqual(["fresh"])
  })
})

describe("startStorageRetentionSweeper", () => {
  it("prunes rolling usage on the existing daily callback, preserves the boundary day, and retries atomically", async () => {
    const now = Date.now()
    const cutoff = now - 90 * MS_PER_DAY
    const raw = (messageId: string, at: number) => ({
      messageId,
      at,
      sessionId: "s",
      inputTokens: 1,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 1,
      durationMs: 0,
    })
    const cost = (id: string, day: string) => ({
      id,
      day,
      providerId: "p",
      modelId: "m",
      totalCostUsd: 1,
      requestCount: 1,
      updatedAt: now,
    })
    const setSpy = jest.spyOn(global, "setInterval")
    const stop = await startStorageRetentionSweeper()
    try {
      await getDb().sessionUsage.bulkPut([
        raw("expired", cutoff - 1000),
        raw("boundary", cutoff + 1000),
        raw("today", now),
      ])
      await getDb().providerCostDaily.bulkPut([
        cost("old", localDayString(cutoff - 2 * MS_PER_DAY)),
        cost("boundary", localDayString(cutoff)),
        cost("today", localDayString(now)),
      ])
      const callback = setSpy.mock.calls.find(
        (args) => args[1] === RETENTION_SWEEP_INTERVAL_MS
      )![0] as () => Promise<void>
      const failure = jest
        .spyOn(getDb().providerCostDaily, "bulkDelete")
        .mockRejectedValueOnce(new Error("write refused"))
      await callback()
      expect(await getDb().sessionUsage.get("expired")).toBeDefined()
      expect(getStorageRetentionSnapshot()?.results).toContainEqual({
        id: "usageHistory",
        removed: 0,
        status: "failed",
        reason: "prune-failed",
      })
      failure.mockRestore()
      await callback()
      expect(await getDb().sessionUsage.toCollection().primaryKeys()).toEqual(["boundary", "today"])
      expect(await getDb().providerCostDaily.toCollection().primaryKeys()).toEqual([
        "boundary",
        "today",
      ])
      expect(getStorageRetentionSnapshot()?.results).toContainEqual({
        id: "usageHistory",
        removed: 2,
        status: "completed",
      })
    } finally {
      stop()
      setSpy.mockRestore()
    }
  })
  it("purges orphaned side chats on each sweep and survives that purge failing", async () => {
    mockPurgeOrphanedSessionSideChats.mockClear()
    const stop = await startStorageRetentionSweeper()
    expect(mockPurgeOrphanedSessionSideChats).toHaveBeenCalledTimes(1)
    stop()

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockPurgeOrphanedSessionSideChats.mockRejectedValueOnce(new Error("locked"))
    const stopAgain = await startStorageRetentionSweeper()
    expect(getStorageRetentionSnapshot()?.results).toContainEqual({
      id: "sessionSideChats",
      removed: 0,
      status: "failed",
      reason: "prune-failed",
    })
    expect(warn).not.toHaveBeenCalledWith("storage retention sweep failed", expect.anything())
    stopAgain()
    warn.mockRestore()
  })

  it("runs an initial sweep honoring the live retention days", async () => {
    // Real timers: driving Dexie through fake timers deadlocks (IndexedDB
    // schedules its own macrotasks). We assert the initial sweep instead.
    await saveSettings({ storageRetention: { traceRetentionDays: 30 } })
    const now = Date.now()
    await getDb().agentTraces.bulkPut([
      span("old", now - 90 * MS_PER_DAY),
      span("keep", now - 2 * MS_PER_DAY),
    ])
    const stop = await startStorageRetentionSweeper()
    expect((await getDb().agentTraces.toArray()).map((r) => r.id)).toEqual(["keep"])
    stop()
  })

  it("keeps everything when retention is set to 0 (keep forever)", async () => {
    await saveSettings({ storageRetention: { traceRetentionDays: 0 } })
    const now = Date.now()
    await getDb().agentTraces.bulkPut([span("ancient", now - 999 * MS_PER_DAY)])
    const stop = await startStorageRetentionSweeper()
    expect(await getDb().agentTraces.get("ancient")).toBeDefined()
    stop()
  })

  it("uses the OCR cache TTL independently from trace retention", async () => {
    await saveSettings({
      storageRetention: { traceRetentionDays: 0 },
      ocrSettings: { ...DEFAULT_OCR_SETTINGS, cacheTtlDays: 7 },
    })
    const now = Date.now()
    await getDb().ocrResults.bulkPut([
      {
        id: "old-ocr",
        fileSha: "old-ocr",
        providerId: "mistral-ocr",
        langs: "en",
        result: "{}",
        createdAt: now - 10 * MS_PER_DAY,
        bytesIn: 100,
      },
      {
        id: "fresh-ocr",
        fileSha: "fresh-ocr",
        providerId: "mistral-ocr",
        langs: "en",
        result: "{}",
        createdAt: now - MS_PER_DAY,
        bytesIn: 100,
      },
    ])

    const stop = await startStorageRetentionSweeper()

    expect((await getDb().ocrResults.toArray()).map((row) => row.id)).toEqual(["fresh-ocr"])
    stop()
  })

  it("falls back to the default window when settings can't be read", async () => {
    ;(getSettings as jest.Mock).mockRejectedValueOnce(new Error("settings unavailable"))
    const now = Date.now()
    await getDb().agentTraces.bulkPut([
      span("old", now - 90 * MS_PER_DAY),
      span("keep", now - 1 * MS_PER_DAY),
    ])
    // No settings → readRetentionDays catches and uses the 30-day default.
    const stop = await startStorageRetentionSweeper()
    expect((await getDb().agentTraces.toArray()).map((r) => r.id)).toEqual(["keep"])
    stop()
  })

  it("schedules a daily interval and the unsubscribe clears it", async () => {
    const setSpy = jest.spyOn(global, "setInterval")
    const clearSpy = jest.spyOn(global, "clearInterval")
    try {
      const stop = await startStorageRetentionSweeper()
      expect(setSpy).toHaveBeenCalledWith(expect.any(Function), RETENTION_SWEEP_INTERVAL_MS)
      stop()
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})

it("reconciles explicitly deleted draft rows through the governed sweep even with trace keep-forever", async () => {
  const db = getDb()
  await db.chatDrafts.put({
    sessionId: "deleted-draft",
    text: "orphan",
    revision: 1,
    updatedAt: 1,
  } as never)
  await db.syncTombstones.put({ table: "sessions", id: "deleted-draft", deletedAt: 1 })
  const result = await pruneRetainedTables(0)
  expect(result).toContainEqual({ id: "syncTombstones", removed: 2, status: "completed" })
  expect(await db.chatDrafts.get("deleted-draft")).toBeUndefined()
})

it("uses safe fallback windows when legacy settings and optional defaults omit retention fields", async () => {
  const traceDefaults = DEFAULTS.storageRetention
  const ocrDefaults = DEFAULTS.ocrSettings
  const now = Date.now()
  await getDb().agentTraces.bulkPut([
    span("old-fallback", now - 90 * MS_PER_DAY),
    span("keep-fallback", now),
  ])
  await getDb().ocrResults.put({
    id: "old-fallback",
    fileSha: "old-fallback",
    providerId: "ocr",
    langs: "en",
    result: "{}",
    createdAt: now - 90 * MS_PER_DAY,
    bytesIn: 1,
  })
  ;(getSettings as jest.Mock).mockResolvedValueOnce({})
  try {
    DEFAULTS.storageRetention = undefined
    DEFAULTS.ocrSettings = undefined
    const stop = await startStorageRetentionSweeper()
    stop()
    expect(await getDb().agentTraces.get("old-fallback")).toBeUndefined()
    expect(await getDb().agentTraces.get("keep-fallback")).toBeDefined()
    expect(await getDb().ocrResults.get("old-fallback")).toBeUndefined()
  } finally {
    DEFAULTS.storageRetention = traceDefaults
    DEFAULTS.ocrSettings = ocrDefaults
  }
})

describe("notification delivery retention", () => {
  const target = () => RETENTION_TARGETS.find((t) => t.id === "notificationDelivery")!

  async function seedSettledIntent(updatedAt: number) {
    await getDb().notificationDeliveryIntents.put({
      id: "i1",
      scopeKey: "scope",
      scope: { namespaceId: "n", accountId: "a", authorityHostId: "h" },
      operationKey: "op-1",
      targetId: "t",
      targetAddress: { kind: "feishu-webhook", endpointSecretRef: "ref", region: "feishu" },
      targetVersion: 1,
      purpose: "result-summary",
      category: "run.result",
      status: "accepted",
      payload: {
        title: "Deploy finished",
        body: "body",
        level: "info",
        disclosureLevel: "internal",
        clippedFactCount: 0,
        contentHash: "h",
      },
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: updatedAt,
      updatedAt,
    })
  }

  afterEach(async () => {
    await getDb().notificationDeliveryIntents.clear()
    await saveSettings({ notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES })
  })

  it("is a row-expiry target that follows the inbox's retention window", async () => {
    expect(target().policy).toBe("row-expiry")
    await saveSettings({
      notificationPreferences: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        retentionMaxAgeMs: 7 * MS_PER_DAY,
      },
    })
    await seedSettledIntent(Date.now() - 8 * MS_PER_DAY)
    // The sweeper hands row-expiry targets "now"; the window is the inbox's.
    expect(await target().prune(Date.now())).toBe(1)
    expect((await getDb().notificationDeliveryIntents.get("i1"))?.compactedAt).toBeDefined()
  })

  it("keeps everything when the inbox keeps everything", async () => {
    await saveSettings({
      notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, retentionMaxAgeMs: 0 },
    })
    await seedSettledIntent(Date.now() - 400 * MS_PER_DAY)
    expect(await target().prune(Date.now())).toEqual({
      removed: 0,
      status: "off",
      reason: "configured-off",
    })
    expect((await getDb().notificationDeliveryIntents.get("i1"))?.compactedAt).toBeUndefined()
  })

  it("leaves a delivery still inside the default 30-day window alone", async () => {
    await seedSettledIntent(Date.now() - 10 * MS_PER_DAY)
    expect(await target().prune(Date.now())).toBe(0)
  })
})

it("replays desktop deletion even when configured retention keeps everything", async () => {
  mockRetryDesktopDeletion.mockResolvedValueOnce(2)
  const target = RETENTION_TARGETS.find((row) => row.id === "managedDesktopDeletion")!
  expect(await pruneRetainedTables(0, [target])).toEqual([
    { id: "managedDesktopDeletion", removed: 2, status: "completed" },
  ])
})

it("sweeps expired action-review receipts and keeps live ones (ADR-0239 WP1)", async () => {
  const now = Date.now()
  const base = { decidedAt: 1, authKeys: [], surfaceIds: [] }
  await getDb().actionReviewReceipts.bulkPut([
    { ...base, id: "expired", expiresAt: now - 1 },
    { ...base, id: "live", expiresAt: now + MS_PER_DAY },
  ] as never)
  const target = RETENTION_TARGETS.find((row) => row.id === "actionReviewReceipts")!
  expect(await pruneRetainedTables(0, [target])).toEqual([
    { id: "actionReviewReceipts", removed: 1, status: "completed" },
  ])
  expect(await getDb().actionReviewReceipts.toCollection().primaryKeys()).toEqual(["live"])
})
