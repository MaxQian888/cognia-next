/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  __clearRendererBackgroundRunsForTesting,
  cancelRendererBackgroundRun,
  collectRendererBackgroundResult,
  countRunningRendererBackgroundRuns,
  hasRendererBackgroundRun,
  interruptRendererBackgroundTasksOnBoot,
  journalRendererForegroundRun,
  listRendererBackgroundRuns,
  setRendererBackgroundSettleListener,
  startRendererBackgroundRun,
  subscribeRendererBackgroundLifecycle,
} from "./renderer-subagent-registry"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

const ok = (text: string, runId = "r1"): PluginSubagentDispatchResult => ({
  text,
  channel: "sidecar",
  toolsAvailable: true,
  runId,
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
})

function meta(overrides: Partial<Parameters<typeof startRendererBackgroundRun>[1]> = {}) {
  return {
    kind: "subagent" as const,
    subagentId: "reviewer",
    prompt: "check this",
    sessionId: "ses_1",
    host: "renderer" as const,
    startedAt: 1000,
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().backgroundTasks.clear()
  __clearRendererBackgroundRunsForTesting()
})

describe("renderer subagent background registry", () => {
  it("parks a structured run, journals it, and collects the live value", async () => {
    startRendererBackgroundRun("r1", meta(), Promise.resolve(ok("done")))

    expect(hasRendererBackgroundRun("r1")).toBe(true)
    expect(countRunningRendererBackgroundRuns()).toBe(1)
    expect(listRendererBackgroundRuns()).toEqual([
      expect.objectContaining({ runId: "r1", status: "running", subagentId: "reviewer" }),
    ])
    await expect(getDb().backgroundTasks.get("r1")).resolves.toMatchObject({
      runId: "r1",
      status: "running",
      prompt: "check this",
    })

    const collected = await collectRendererBackgroundResult("r1")
    expect(collected).toMatchObject({ text: "done", channel: "sidecar" })
    expect(listRendererBackgroundRuns()).toEqual([])
    await expect(getDb().backgroundTasks.get("r1")).resolves.toMatchObject({
      status: "done",
      resultText: "done",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    })
  })

  it("collapses a rejected live run into the existing error envelope", async () => {
    startRendererBackgroundRun("r1", meta(), Promise.reject(new Error("boom")))

    const collected = await collectRendererBackgroundResult("r1")
    expect(collected).toEqual({
      text: "boom",
      channel: "text",
      toolsAvailable: false,
      runId: "r1",
      finishReason: "error",
      errorEnvelope: { code: "unknown", retryable: false, message: "boom" },
    })
  })

  it("collapses a non-Error live rejection into the existing error envelope", async () => {
    startRendererBackgroundRun("r1", meta(), Promise.reject("plain boom"))

    await expect(collectRendererBackgroundResult("r1")).resolves.toEqual({
      text: "plain boom",
      channel: "text",
      toolsAvailable: false,
      runId: "r1",
      finishReason: "error",
      errorEnvelope: { code: "unknown", retryable: false, message: "plain boom" },
    })
  })

  it("falls back to a journaled done result after live memory is gone", async () => {
    await getDb().backgroundTasks.put({
      runId: "r1",
      kind: "subagent",
      subagentId: "reviewer",
      prompt: "check this",
      sessionId: "ses_1",
      host: "renderer",
      status: "done",
      startedAt: 1000,
      settledAt: 2000,
      resultText: "journal done",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    })

    await expect(collectRendererBackgroundResult("r1")).resolves.toMatchObject({
      text: "journal done",
      channel: "text",
      toolsAvailable: false,
      runId: "r1",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    })
  })

  it("omits incomplete journaled usage when rebuilding a done result", async () => {
    await getDb().backgroundTasks.put({
      runId: "r1",
      kind: "subagent",
      subagentId: "reviewer",
      prompt: "check this",
      sessionId: "ses_1",
      host: "renderer",
      status: "done",
      startedAt: 1000,
      settledAt: 2000,
      resultText: "journal done",
      usage: { inputTokens: 1 },
    })

    await expect(collectRendererBackgroundResult("r1")).resolves.toEqual({
      text: "journal done",
      channel: "text",
      toolsAvailable: false,
      runId: "r1",
    })
  })

  it("falls back to journaled error variants after live memory is gone", async () => {
    await getDb().backgroundTasks.bulkPut([
      {
        runId: "with-error",
        kind: "subagent",
        subagentId: "reviewer",
        prompt: "check this",
        sessionId: "ses_1",
        host: "renderer",
        status: "error",
        startedAt: 1000,
        settledAt: 2000,
        error: "journal boom",
      },
      {
        runId: "with-result-text",
        kind: "subagent",
        subagentId: "reviewer",
        prompt: "check this",
        sessionId: "ses_1",
        host: "renderer",
        status: "error",
        startedAt: 1000,
        settledAt: 2000,
        resultText: "fallback boom",
      },
      {
        runId: "without-message",
        kind: "subagent",
        subagentId: "reviewer",
        prompt: "check this",
        sessionId: "ses_1",
        host: "renderer",
        status: "error",
        startedAt: 1000,
        settledAt: 2000,
      },
    ])

    await expect(collectRendererBackgroundResult("with-error")).resolves.toMatchObject({
      text: "journal boom",
      finishReason: "error",
      errorEnvelope: { code: "unknown", retryable: false, message: "journal boom" },
    })
    await expect(collectRendererBackgroundResult("with-result-text")).resolves.toMatchObject({
      text: "fallback boom",
      finishReason: "error",
      // Salvaged partial output rides along on the rebuilt envelope.
      errorEnvelope: expect.objectContaining({ partialText: "fallback boom" }),
    })
    await expect(collectRendererBackgroundResult("without-message")).resolves.toMatchObject({
      text: "Background run failed.",
      finishReason: "error",
    })
  })

  it("rebuilds an interrupted-coded envelope for interrupted journal rows", async () => {
    await getDb().backgroundTasks.put({
      runId: "r1",
      kind: "subagent",
      subagentId: "reviewer",
      prompt: "check this",
      sessionId: "ses_1",
      host: "renderer",
      status: "interrupted",
      startedAt: 1000,
      settledAt: 2000,
      resultText: "partial before crash",
    })

    await expect(collectRendererBackgroundResult("r1")).resolves.toMatchObject({
      finishReason: "error",
      errorEnvelope: expect.objectContaining({
        code: "interrupted",
        partialText: "partial before crash",
      }),
    })
  })

  it("collect is idempotent — re-collects answer from the journal and stamp collectedAt", async () => {
    startRendererBackgroundRun("r1", meta(), Promise.resolve(ok("done twice")))

    const first = await collectRendererBackgroundResult("r1")
    expect(first).toMatchObject({ text: "done twice" })
    // Second collect falls back to the journal instead of "not found".
    const second = await collectRendererBackgroundResult("r1")
    expect(second).toMatchObject({ text: "done twice", channel: "text" })
    await expect(getDb().backgroundTasks.get("r1")).resolves.toMatchObject({
      collectedAt: expect.any(Number),
    })
  })

  it("notifies the registered settle listener with meta + settle payload", async () => {
    const listener = jest.fn()
    setRendererBackgroundSettleListener(listener)
    startRendererBackgroundRun("r1", meta(), Promise.resolve(ok("done")))
    await new Promise((r) => setTimeout(r, 0))

    expect(listener).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ subagentId: "reviewer", sessionId: "ses_1", mode: "background" }),
      expect.objectContaining({ status: "done", resultText: "done" })
    )
  })

  it("publishes minimal start/settle lifecycle events without prompt or result text", async () => {
    const listener = jest.fn()
    const unsubscribe = subscribeRendererBackgroundLifecycle(listener)

    startRendererBackgroundRun("r1", meta(), Promise.resolve(ok("sensitive result")))
    await new Promise((r) => setTimeout(r, 0))

    expect(listener.mock.calls).toEqual([
      [{ type: "started", runId: "r1", taskKind: "subagent" }],
      [{ type: "settled", runId: "r1", status: "done" }],
    ])
    expect(JSON.stringify(listener.mock.calls)).not.toContain("check this")
    expect(JSON.stringify(listener.mock.calls)).not.toContain("sensitive result")

    unsubscribe()
    startRendererBackgroundRun("r2", meta(), new Promise(() => {}))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("keeps lifecycle subscribers alive when the delivery settle listener throws", async () => {
    const lifecycle = jest.fn()
    subscribeRendererBackgroundLifecycle(lifecycle)
    setRendererBackgroundSettleListener(() => {
      throw new Error("delivery observer failed")
    })

    startRendererBackgroundRun("r1", meta(), Promise.resolve(ok("done")))
    await new Promise((r) => setTimeout(r, 0))

    expect(lifecycle).toHaveBeenLastCalledWith({
      type: "settled",
      runId: "r1",
      status: "done",
    })
  })

  it("journals a background failure with its envelope message + partial output", async () => {
    const failed: PluginSubagentDispatchResult = {
      text: "429 too many requests",
      channel: "text",
      toolsAvailable: false,
      runId: "r1",
      finishReason: "error",
      errorEnvelope: {
        code: "rate-limit",
        retryable: true,
        message: "429 too many requests",
        partialText: "got halfway",
      },
    }
    startRendererBackgroundRun("r1", meta(), Promise.resolve(failed))
    await new Promise((r) => setTimeout(r, 0))

    await expect(getDb().backgroundTasks.get("r1")).resolves.toMatchObject({
      status: "error",
      error: "429 too many requests",
      resultText: "got halfway",
      mode: "background",
    })
  })

  it("ignores non-renderer and still-running journal rows on collect", async () => {
    await getDb().backgroundTasks.bulkPut([
      {
        runId: "cli-row",
        kind: "subagent",
        subagentId: "reviewer",
        prompt: "check this",
        sessionId: "ses_1",
        host: "cli",
        status: "done",
        startedAt: 1000,
        settledAt: 2000,
        resultText: "cli result",
      },
      {
        runId: "running-row",
        kind: "subagent",
        subagentId: "reviewer",
        prompt: "check this",
        sessionId: "ses_1",
        host: "renderer",
        status: "running",
        startedAt: 1000,
      },
    ])

    await expect(collectRendererBackgroundResult("cli-row")).resolves.toBeUndefined()
    await expect(collectRendererBackgroundResult("running-row")).resolves.toBeUndefined()
  })

  it("replays the journal after the live result was collected (idempotent collect)", async () => {
    startRendererBackgroundRun("r1", meta(), Promise.resolve(ok("done")))

    await expect(collectRendererBackgroundResult("r1")).resolves.toMatchObject({ text: "done" })
    await expect(collectRendererBackgroundResult("r1")).resolves.toMatchObject({ text: "done" })
  })

  it("falls back to an interrupted notice for journaled interrupted runs", async () => {
    await getDb().backgroundTasks.put({
      runId: "r1",
      kind: "subagent",
      subagentId: "reviewer",
      prompt: "check this",
      sessionId: "ses_1",
      host: "renderer",
      status: "interrupted",
      startedAt: 1000,
      settledAt: 2000,
    })

    await expect(collectRendererBackgroundResult("r1")).resolves.toMatchObject({
      text: 'Background run "r1" was interrupted before it finished.',
      finishReason: "error",
    })
  })

  it("returns undefined when neither live memory nor journal knows the run", async () => {
    await expect(collectRendererBackgroundResult("missing")).resolves.toBeUndefined()
  })

  it("returns undefined when the journal read fails for a missing live run", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/db/background-tasks", () => ({
        createDexieBackgroundTaskJournal: () => ({
          recordStart: jest.fn(),
          recordSettle: jest.fn(),
        }),
        getBackgroundTaskRecord: jest.fn().mockRejectedValue(new Error("db down")),
        interruptBackgroundTasksOnBoot: jest.fn(),
      }))
      const fresh = await import("./renderer-subagent-registry")

      await expect(fresh.collectRendererBackgroundResult("missing")).resolves.toBeUndefined()
      jest.dontMock("@/lib/db/background-tasks")
    })
  })

  it("cancels a running task through its registered cancel hook", () => {
    const cancel = jest.fn()
    startRendererBackgroundRun("r1", meta(), new Promise<PluginSubagentDispatchResult>(() => {}), {
      cancel,
    })

    expect(cancelRendererBackgroundRun("r1")).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it("reconciles renderer running rows on boot", async () => {
    await getDb().backgroundTasks.put({
      runId: "stale",
      kind: "subagent",
      subagentId: "reviewer",
      prompt: "check this",
      sessionId: "ses_1",
      host: "renderer",
      status: "running",
      startedAt: 1000,
    })

    const flipped = await interruptRendererBackgroundTasksOnBoot({ now: () => 3000 })

    await expect(getDb().backgroundTasks.get("stale")).resolves.toMatchObject({
      status: "interrupted",
      settledAt: 3000,
    })
    expect(flipped).toEqual([expect.objectContaining({ runId: "stale", status: "interrupted" })])
  })
})

describe("journalRendererForegroundRun", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it("journals a foreground run as mode foreground and settles done, never collectable", async () => {
    journalRendererForegroundRun("fg1", meta(), Promise.resolve(ok("fg done", "fg1")))
    await settle()

    await expect(getDb().backgroundTasks.get("fg1")).resolves.toMatchObject({
      mode: "foreground",
      status: "done",
      resultText: "fg done",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    })
    // Foreground rows never enter the collectable registry…
    expect(hasRendererBackgroundRun("fg1")).toBe(false)
    expect(listRendererBackgroundRuns()).toEqual([])
    // …but the journal fallback would still answer a collect for the DONE row;
    // that is acceptable (result reuse), the live path is what must stay clean.
  })

  it("settles a foreground failure with error + salvaged partial output", async () => {
    const failed: PluginSubagentDispatchResult = {
      text: "boom",
      channel: "text",
      toolsAvailable: false,
      runId: "fg1",
      finishReason: "error",
      errorEnvelope: { code: "network", retryable: true, message: "boom", partialText: "half" },
    }
    journalRendererForegroundRun("fg1", meta(), Promise.resolve(failed))
    await settle()

    await expect(getDb().backgroundTasks.get("fg1")).resolves.toMatchObject({
      status: "error",
      error: "boom",
      resultText: "half",
      mode: "foreground",
    })
  })

  it("marks cancelled foreground runs as error rows so boot reconciliation skips them", async () => {
    const cancelled: PluginSubagentDispatchResult = {
      text: "cancelled",
      channel: "text",
      toolsAvailable: false,
      runId: "fg1",
      finishReason: "cancelled",
    }
    journalRendererForegroundRun("fg1", meta(), Promise.resolve(cancelled))
    await settle()

    await expect(getDb().backgroundTasks.get("fg1")).resolves.toMatchObject({
      status: "error",
      error: "cancelled",
    })
  })

  it("settles an unexpected rejection as an error row (belt-and-braces)", async () => {
    journalRendererForegroundRun("fg1", meta(), Promise.reject(new Error("unexpected")))
    await settle()

    await expect(getDb().backgroundTasks.get("fg1")).resolves.toMatchObject({
      status: "error",
      error: "unexpected",
    })
  })

  it("a foreground run interrupted by reload reconciles to interrupted on boot", async () => {
    journalRendererForegroundRun("fg1", meta(), new Promise(() => {}))
    await settle()

    const flipped = await interruptRendererBackgroundTasksOnBoot({ now: () => 9000 })

    expect(flipped).toEqual([
      expect.objectContaining({ runId: "fg1", status: "interrupted", mode: "foreground" }),
    ])
  })
})
