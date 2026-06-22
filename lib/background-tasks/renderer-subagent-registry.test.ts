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
  listRendererBackgroundRuns,
  startRendererBackgroundRun,
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
    })
    await expect(collectRendererBackgroundResult("with-result-text")).resolves.toMatchObject({
      text: "fallback boom",
      finishReason: "error",
    })
    await expect(collectRendererBackgroundResult("without-message")).resolves.toMatchObject({
      text: "Background run failed.",
      finishReason: "error",
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

  it("does not replay the journal after a live result was collected", async () => {
    startRendererBackgroundRun("r1", meta(), Promise.resolve(ok("done")))

    await expect(collectRendererBackgroundResult("r1")).resolves.toMatchObject({ text: "done" })
    await expect(collectRendererBackgroundResult("r1")).resolves.toBeUndefined()
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

    await interruptRendererBackgroundTasksOnBoot({ now: () => 3000 })

    await expect(getDb().backgroundTasks.get("stale")).resolves.toMatchObject({
      status: "interrupted",
      settledAt: 3000,
    })
  })
})
