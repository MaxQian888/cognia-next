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

describe("owned journal lifecycle", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("does not settle an existing owner when a second registry fails admission", async () => {
    const { journal, settles, records } = createJournal()
    journal.renewLease = jest.fn().mockResolvedValue(true)
    const writeStart = journal.recordStart
    journal.recordStart = async (record) => {
      if (records.has(record.runId)) throw new Error("duplicate")
      await writeStart(record)
    }
    const first = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => value,
    })
    const second = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => value,
    })
    const pending = deferred<ParkedValue>()
    first.start("same", meta(), pending.promise)
    second.start("same", meta(), Promise.resolve({ text: "new" }))
    await expect(second.collect("same")).rejects.toThrow("admission did not commit")
    expect(settles).toEqual([])
    expect(records.get("same")?.status).toBe("running")
    pending.resolve({ text: "original" })
    await expect(first.collect("same")).resolves.toEqual({ text: "original" })
    expect(records.get("same")?.resultText).toBe("original")
  })

  it("refuses duplicate live IDs without replacing the tracked producer", async () => {
    const { journal } = createJournal()
    journal.renewLease = jest.fn().mockResolvedValue(true)
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => value,
    })
    const pending = deferred<ParkedValue>()
    registry.start("same", meta(), pending.promise)
    expect(() => registry.start("same", meta(), Promise.resolve({ text: "duplicate" }))).toThrow(
      "already tracked"
    )
    pending.resolve({ text: "original" })
    await expect(registry.collect("same")).resolves.toEqual({ text: "original" })
  })

  it("renews plugin and team runs and aborts without delivering a stale result", async () => {
    const { journal, settles } = createJournal()
    journal.renewLease = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    journal.leaseIntervalMs = 10
    const onSettle = jest.fn()
    const onLeaseLost = jest.fn()
    const pending = deferred<ParkedValue>()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      onSettle,
      projectForJournal: (value) => value,
    })
    registry.start("owned", meta({ kind: "team-delegation" }), pending.promise, { onLeaseLost })
    const collected = registry.collect("owned")
    const rejection = expect(collected).rejects.toThrow("ownership lost")
    await jest.advanceTimersByTimeAsync(20)
    await rejection
    expect(onLeaseLost).toHaveBeenCalledTimes(1)
    expect(settles).toEqual([])
    pending.resolve({ text: "late output" })
    await jest.advanceTimersByTimeAsync(100)
    expect(onSettle).not.toHaveBeenCalled()
    expect(settles).toEqual([])
    expect(journal.renewLease).toHaveBeenCalledTimes(2)
  })

  it("waits for admission before persisting an already completed result", async () => {
    const admitted = deferred<void>()
    const { journal, settles } = createJournal()
    journal.recordStart = jest.fn(() => admitted.promise)
    journal.renewLease = jest.fn().mockResolvedValue(true)
    journal.leaseIntervalMs = 10
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      projectForJournal: (value) => value,
    })
    registry.start("owned", meta(), Promise.resolve({ text: "done" }))
    await Promise.resolve()
    expect(settles).toEqual([])
    admitted.resolve()
    await registry.collect("owned")
    expect(settles).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(100)
    expect(journal.renewLease).not.toHaveBeenCalled()
  })

  it("does not deliver when the durable ownership fence rejects settlement", async () => {
    const { journal } = createJournal()
    journal.recordSettle = jest.fn().mockRejectedValue(new Error("lease expired"))
    journal.renewLease = jest.fn().mockResolvedValue(true)
    const onSettle = jest.fn()
    const onDiscard = jest.fn()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      journal,
      onSettle,
      onDiscard,
      projectForJournal: (value) => value,
    })
    registry.startAccepted("owned", meta(), Promise.resolve({ text: "stale" }), journal)
    await expect(registry.collect("owned")).rejects.toThrow("lease expired")
    expect(onSettle).not.toHaveBeenCalled()
    expect(onDiscard).toHaveBeenCalledWith("owned")
    await jest.advanceTimersByTimeAsync(100_000)
    expect(journal.renewLease).not.toHaveBeenCalled()
  })
})

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

describe("accepted background settlement", () => {
  it("does not deliver or collect a result before its terminal commit", async () => {
    const persisted = deferred<void>()
    const onSettle = jest.fn()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      projectForJournal: (value) => value,
      onSettle,
    })
    const journal = { recordStart: jest.fn(), recordSettle: jest.fn(() => persisted.promise) }
    registry.startAccepted("r1", meta(), Promise.resolve({ text: "saved" }), journal)
    const collected = registry.collect("r1")
    await Promise.resolve()
    expect(onSettle).not.toHaveBeenCalled()
    expect(journal.recordStart).not.toHaveBeenCalled()
    persisted.resolve()
    await expect(collected).resolves.toEqual({ text: "saved" })
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it("parks a failed terminal commit instead of delivering unpersisted output", async () => {
    const onSettle = jest.fn()
    const registry = new BackgroundTaskRegistry<ParkedValue>({
      projectForJournal: (value) => value,
      onSettle,
    })
    registry.startAccepted("r1", meta(), Promise.resolve({ text: "unsaved" }), {
      recordStart: jest.fn(),
      recordSettle: jest.fn(async () => {
        throw new Error("disk unavailable")
      }),
    })
    await expect(registry.collect("r1")).rejects.toThrow("disk unavailable")
    expect(onSettle).not.toHaveBeenCalled()
  })
})

it("does not advertise durable cancellation until the async control commits", async () => {
  const persisted = deferred<void>()
  const registry = new BackgroundTaskRegistry<ParkedValue>({ projectForJournal: (value) => value })
  registry.start("r1", meta(), new Promise(() => {}), { cancel: () => persisted.promise })
  expect(registry.cancel("r1")).toBe(true)
  expect(registry.list()[0].cancelled).toBeUndefined()
  persisted.resolve()
  await Promise.resolve()
  expect(registry.list()[0].cancelled).toBe(true)
})

it("retains a visible cancellation error when persistence rejects", async () => {
  const registry = new BackgroundTaskRegistry<ParkedValue>({ projectForJournal: (value) => value })
  registry.start("r1", meta(), new Promise(() => {}), {
    cancel: async () => {
      throw new Error("cancel journal failed")
    },
  })
  expect(registry.cancel("r1")).toBe(true)
  await Promise.resolve()
  expect(registry.list()[0]).toMatchObject({ status: "running", error: "cancel journal failed" })
  expect(registry.list()[0].cancelled).toBeUndefined()
})

it("awaited cancellation reports a rejected durable write as unsuccessful", async () => {
  const registry = new BackgroundTaskRegistry<ParkedValue>({ projectForJournal: (value) => value })
  registry.start("r1", meta(), new Promise(() => {}), {
    cancel: async () => {
      throw new Error("disk full")
    },
  })
  await expect(registry.cancelAndWait("r1")).resolves.toBe(false)
  expect(registry.list()[0].cancelled).toBeUndefined()
})
