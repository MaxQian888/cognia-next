/**
 * @jest-environment node
 */
import {
  BackgroundTaskRegistry,
  interruptRunningTasks,
  type BackgroundTaskJournal,
  type BackgroundTaskJournalRecord,
} from "./registry-core"

interface ParkedValue {
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function meta(overrides: Partial<BackgroundTaskJournalRecord> = {}) {
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

function createJournal(initial: BackgroundTaskJournalRecord[] = []) {
  const records = new Map(initial.map((record) => [record.runId, { ...record }]))
  const starts: BackgroundTaskJournalRecord[] = []
  const settles: Array<{ runId: string; patch: Partial<BackgroundTaskJournalRecord> }> = []
  const journal: BackgroundTaskJournal = {
    async recordStart(record) {
      starts.push({ ...record })
      records.set(record.runId, { ...record })
    },
    async recordSettle(runId, patch) {
      settles.push({ runId, patch: { ...patch } })
      const current = records.get(runId)
      if (current) records.set(runId, { ...current, ...patch })
    },
    async list() {
      return [...records.values()]
    },
    async get(runId) {
      return records.get(runId)
    },
    async update(runId, patch) {
      const current = records.get(runId)
      if (current) records.set(runId, { ...current, ...patch })
    },
    async clearSettled() {
      for (const [runId, record] of records) {
        if (record.status !== "running") records.delete(runId)
      }
    },
  }
  return { journal, records, starts, settles }
}

describe("BackgroundTaskRegistry", () => {
  it("parks a run, exposes metadata, and counts only running entries", async () => {
    const { journal, starts } = createJournal()
    const d = deferred<ParkedValue>()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => ({ text: value.text, usage: value.usage }),
    })

    registry.start("r1", meta(), d.promise)

    expect(registry.has("r1")).toBe(true)
    expect(registry.countRunning()).toBe(1)
    expect(registry.list()).toEqual([
      expect.objectContaining({
        runId: "r1",
        status: "running",
        subagentId: "reviewer",
        startedAt: 1000,
      }),
    ])
    expect(starts).toEqual([
      expect.objectContaining({
        runId: "r1",
        status: "running",
        host: "renderer",
      }),
    ])

    d.resolve({ text: "done" })
    await d.promise
  })

  it("journals done transitions with projected text and usage", async () => {
    const { journal, settles, records } = createJournal()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => ({ text: value.text, usage: value.usage }),
    })

    registry.start(
      "r1",
      meta({ startedAt: 1000 }),
      Promise.resolve({ text: "done", usage: { inputTokens: 3 } })
    )

    const value = await registry.collect("r1")
    expect(value).toEqual({ text: "done", usage: { inputTokens: 3 } })
    expect(registry.has("r1")).toBe(false)
    expect(settles).toEqual([
      {
        runId: "r1",
        patch: {
          status: "done",
          settledAt: expect.any(Number),
          resultText: "done",
          usage: { inputTokens: 3 },
        },
      },
    ])
    expect(records.get("r1")).toMatchObject({ status: "done", resultText: "done" })
  })

  it("journals rejected promises as errors and collect rethrows before dropping", async () => {
    const { journal, records } = createJournal()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => ({ text: value.text }),
    })

    registry.start("r1", meta(), Promise.reject(new Error("boom")))

    await expect(registry.collect("r1")).rejects.toThrow("boom")
    expect(registry.has("r1")).toBe(false)
    expect(records.get("r1")).toMatchObject({ status: "error", error: "boom" })
  })

  it("keeps the live lifecycle working when a journal write throws", async () => {
    const journal: BackgroundTaskJournal = {
      recordStart() {
        throw new Error("journal unavailable")
      },
      recordSettle: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      get: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      clearSettled: jest.fn().mockResolvedValue(undefined),
    }
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => ({ text: value.text }),
    })

    registry.start("r1", meta(), Promise.resolve({ text: "done" }))

    await expect(registry.collect("r1")).resolves.toEqual({ text: "done" })
    expect(journal.recordSettle).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ status: "done", resultText: "done" })
    )
  })

  it("captures non-Error rejections as journal text", async () => {
    const { journal, records } = createJournal()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => ({ text: value.text }),
    })

    registry.start("r1", meta(), Promise.reject("plain boom"))

    await expect(registry.collect("r1")).rejects.toBe("plain boom")
    expect(records.get("r1")).toMatchObject({ status: "error", error: "plain boom" })
  })

  it("lists settled metadata before collection drops the live entry", async () => {
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      projectForJournal: (value) => ({ text: value.text, usage: value.usage }),
      now: () => 2000,
    })

    registry.start("r1", meta({ startedAt: 1000 }), Promise.resolve({ text: "done" }))
    await Promise.resolve()

    expect(registry.cancel("r1")).toBe(false)
    expect(registry.countRunning()).toBe(0)
    expect(registry.list()).toEqual([
      expect.objectContaining({
        runId: "r1",
        status: "done",
        settledAt: 2000,
        resultText: "done",
      }),
    ])
  })

  it("invokes the cancel hook for running tasks only", async () => {
    const cancel = jest.fn()
    const d = deferred<ParkedValue>()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      projectForJournal: (value) => ({ text: value.text }),
    })
    registry.start("r1", meta(), d.promise, { cancel })

    expect(registry.cancel("r1")).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)

    d.resolve({ text: "done" })
    await registry.collect("r1")
    expect(registry.cancel("r1")).toBe(false)
  })

  it("returns undefined when collecting an unknown run", async () => {
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      projectForJournal: (value) => ({ text: value.text }),
    })

    await expect(registry.collect("missing")).resolves.toBeUndefined()
  })

  it("settles an error-shaped projection (resolved promise) as status error", async () => {
    const { journal, records } = createJournal()
    const registry = new BackgroundTaskRegistry<ParkedValue & { failed?: boolean }>({
      journal,
      projectForJournal: (value) => ({
        text: value.text,
        ...(value.failed ? { error: value.text } : {}),
      }),
    })

    registry.start("r1", meta(), Promise.resolve({ text: "it broke", failed: true }))
    await Promise.resolve()

    expect(records.get("r1")).toMatchObject({
      status: "error",
      error: "it broke",
      resultText: "it broke",
    })
    expect(registry.list()[0]).toMatchObject({ status: "error", error: "it broke" })
  })

  it("round-trips the optional meta extensions into journal starts and list()", async () => {
    const { journal, starts } = createJournal()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => ({ text: value.text }),
    })
    const d = deferred<ParkedValue>()

    registry.start(
      "r1",
      meta({
        kind: "plugin-agent",
        mode: "background",
        toolsEnabled: true,
        pluginId: "my-plugin",
        label: "sweeper",
        resumeOfRunId: "r0",
        resumeAttempt: 1,
      }),
      d.promise
    )

    const expected = {
      kind: "plugin-agent",
      mode: "background",
      toolsEnabled: true,
      pluginId: "my-plugin",
      label: "sweeper",
      resumeOfRunId: "r0",
      resumeAttempt: 1,
    }
    expect(starts[0]).toMatchObject(expected)
    expect(registry.list()[0]).toMatchObject(expected)

    d.resolve({ text: "ok" })
    await d.promise
  })

  describe("onSettle", () => {
    it("fires with the done payload after a resolve", async () => {
      const onSettle = jest.fn()
      const registry = new BackgroundTaskRegistry<ParkedValue>({
        projectForJournal: (value) => ({ text: value.text, usage: value.usage }),
        now: () => 2000,
        onSettle,
      })

      registry.start("r1", meta(), Promise.resolve({ text: "done", usage: { inputTokens: 3 } }))
      await Promise.resolve()

      expect(onSettle).toHaveBeenCalledWith(
        "r1",
        expect.objectContaining({ subagentId: "reviewer", sessionId: "ses_1" }),
        { status: "done", settledAt: 2000, resultText: "done", usage: { inputTokens: 3 } }
      )
    })

    it("fires with the error payload after a reject", async () => {
      const onSettle = jest.fn()
      const registry = new BackgroundTaskRegistry<ParkedValue>({
        projectForJournal: (value) => ({ text: value.text }),
        now: () => 2000,
        onSettle,
      })

      registry.start("r1", meta(), Promise.reject(new Error("boom")))
      await Promise.resolve().then(() => Promise.resolve())

      expect(onSettle).toHaveBeenCalledWith("r1", expect.objectContaining({ sessionId: "ses_1" }), {
        status: "error",
        settledAt: 2000,
        error: "boom",
      })
      // Swallow the parked rejection so jest doesn't flag an unhandled promise.
      await registry.collect("r1").catch(() => undefined)
    })

    it("a throwing listener never breaks the lifecycle or journal", async () => {
      const { journal, records } = createJournal()
      const registry = new BackgroundTaskRegistry<ParkedValue>({
        journal,
        projectForJournal: (value) => ({ text: value.text }),
        onSettle: () => {
          throw new Error("listener exploded")
        },
      })

      registry.start("r1", meta(), Promise.resolve({ text: "done" }))

      await expect(registry.collect("r1")).resolves.toEqual({ text: "done" })
      expect(records.get("r1")).toMatchObject({ status: "done" })
    })
  })

  describe("cancelWhere", () => {
    it("cancels only running entries matching the predicate", async () => {
      const cancelA = jest.fn()
      const cancelB = jest.fn()
      const cancelC = jest.fn()
      const registry = new BackgroundTaskRegistry<ParkedValue>({
        projectForJournal: (value) => ({ text: value.text }),
      })
      const dA = deferred<ParkedValue>()
      const dB = deferred<ParkedValue>()

      registry.start("a", meta({ pluginId: "p1" }), dA.promise, { cancel: cancelA })
      registry.start("b", meta({ pluginId: "p2" }), dB.promise, { cancel: cancelB })
      registry.start("c", meta({ pluginId: "p1" }), Promise.resolve({ text: "done" }), {
        cancel: cancelC,
      })
      await Promise.resolve() // let "c" settle

      const cancelled = registry.cancelWhere((entry) => entry.pluginId === "p1")

      expect(cancelled).toBe(1)
      expect(cancelA).toHaveBeenCalledTimes(1)
      expect(cancelB).not.toHaveBeenCalled()
      expect(cancelC).not.toHaveBeenCalled()

      dA.resolve({ text: "x" })
      dB.resolve({ text: "y" })
      await Promise.all([dA.promise, dB.promise])
    })
  })
})

describe("interruptRunningTasks", () => {
  it("marks journaled running records interrupted on boot", async () => {
    const { journal, records } = createJournal([
      {
        runId: "running",
        kind: "subagent",
        subagentId: "reviewer",
        prompt: "check this",
        sessionId: "ses_1",
        host: "renderer",
        status: "running",
        startedAt: 1000,
      },
      {
        runId: "done",
        kind: "subagent",
        subagentId: "writer",
        prompt: "write",
        sessionId: "ses_1",
        host: "renderer",
        status: "done",
        startedAt: 1000,
        settledAt: 2000,
        resultText: "ok",
      },
    ])

    const flipped = await interruptRunningTasks(journal, { now: () => 3000 })

    expect(records.get("running")).toMatchObject({
      status: "interrupted",
      settledAt: 3000,
      error: "Background task interrupted because its host process stopped.",
    })
    expect(records.get("done")).toMatchObject({ status: "done", resultText: "ok" })
    // Returns ONLY the freshly transitioned rows, with the patch applied.
    expect(flipped).toEqual([
      expect.objectContaining({ runId: "running", status: "interrupted", settledAt: 3000 }),
    ])
  })

  it("returns an empty array when nothing was running", async () => {
    const { journal } = createJournal([
      {
        runId: "old",
        kind: "subagent",
        subagentId: "reviewer",
        prompt: "p",
        sessionId: "ses_1",
        host: "renderer",
        status: "interrupted",
        startedAt: 1000,
        settledAt: 1500,
      },
    ])

    await expect(interruptRunningTasks(journal, { now: () => 3000 })).resolves.toEqual([])
  })
})
