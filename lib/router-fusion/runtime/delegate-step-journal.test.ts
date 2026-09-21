import { MemoryStepJournal, type DelegateStepJournal } from "@cognia/router-fusion"

import {
  createDelegateStepJournal,
  createMemoryDelegateStepJournalStore,
} from "./delegate-step-journal"

const RUN = "run-delegate-1"

function hostJournal() {
  const store = createMemoryDelegateStepJournalStore()
  return { store, journal: createDelegateStepJournal({ runId: RUN, store, now: () => 7 }) }
}

const step = (overrides: Record<string, unknown> = {}) => ({
  stepId: "delegate:stage:1",
  kind: "stage_patch" as const,
  requestHash: "a".repeat(64),
  ...overrides,
})

describe("createDelegateStepJournal", () => {
  it("prepares a fresh step, replays a committed one and never replays the wrong receipt", async () => {
    const { journal, store } = hostJournal()
    await expect(journal.begin(step())).resolves.toEqual({ kind: "fresh" })
    await journal.markDispatched("delegate:stage:1")
    await journal.commit("delegate:stage:1", { ok: true, revision: "staged:1" })

    await expect(journal.begin(step())).resolves.toEqual({
      kind: "replay",
      receipt: { ok: true, revision: "staged:1" },
    })
    const row = await store.get(RUN, "delegate:stage:1")
    expect(row).toMatchObject({ state: "committed", kind: "stage_patch", updatedAt: 7 })
    expect(row?.receipt).toBe('{"ok":true,"revision":"staged:1"}')
  })

  it("[ACC:REC-06] a dispatched step that never answered is UNKNOWN, not fresh", async () => {
    const { journal, store } = hostJournal()
    store.strand(RUN, "delegate:deliver:apply", "workspace_apply", "b".repeat(64))
    await expect(
      journal.begin({
        stepId: "delegate:deliver:apply",
        kind: "workspace_apply",
        requestHash: "b".repeat(64),
      })
    ).resolves.toEqual({ kind: "unknown" })
  })

  it("[ACC:REC-06] a step id begun with another request is a mismatch, never a replay", async () => {
    const { journal } = hostJournal()
    await journal.begin(step())
    await expect(journal.begin(step({ requestHash: "c".repeat(64) }))).resolves.toEqual({
      kind: "mismatch",
    })
    await expect(journal.begin(step({ kind: "acceptance_run" }))).resolves.toEqual({
      kind: "mismatch",
    })
  })

  it("treats a committed step whose receipt cannot be read as unknown, never as done", async () => {
    const { journal, store } = hostJournal()
    await journal.begin(step())
    await journal.markDispatched("delegate:stage:1")
    await journal.commit("delegate:stage:1", { ok: true })
    const row = (await store.get(RUN, "delegate:stage:1"))!

    await store.put({ ...row, receipt: "{not json" })
    await expect(journal.begin(step())).resolves.toEqual({ kind: "unknown" })
    await store.put({ ...row, receipt: null })
    await expect(journal.begin(step())).resolves.toEqual({ kind: "unknown" })
  })

  it("refuses to dispatch or commit a step that is not in the right state", async () => {
    const { journal } = hostJournal()
    await expect(journal.markDispatched("nope")).rejects.toThrow("no journal step")
    await expect(journal.commit("nope", {})).rejects.toThrow("not dispatched")
    await journal.begin(step())
    await expect(journal.commit("delegate:stage:1", {})).rejects.toThrow("not dispatched")
    await journal.markDispatched("delegate:stage:1")
    await journal.commit("delegate:stage:1", {})
    await expect(journal.markDispatched("delegate:stage:1")).rejects.toThrow("already committed")
  })

  it("refuses a receipt the database could not hold, instead of losing it silently", async () => {
    const { journal } = hostJournal()
    await journal.begin(step())
    await journal.markDispatched("delegate:stage:1")
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(journal.commit("delegate:stage:1", cyclic)).rejects.toThrow(
      "not JSON-serialisable"
    )
  })

  it("keeps one run's steps apart from another's and lists them in order", async () => {
    const store = createMemoryDelegateStepJournalStore()
    const mine = createDelegateStepJournal({ runId: RUN, store, now: () => 1 })
    const theirs = createDelegateStepJournal({ runId: "run-2", store, now: () => 2 })
    await mine.begin(step())
    await mine.markDispatched("delegate:stage:1")
    await mine.commit("delegate:stage:1", { revision: "mine" })
    // The same step id in another run is a different step.
    await expect(theirs.begin(step())).resolves.toEqual({ kind: "fresh" })
    await mine.begin(step({ stepId: "delegate:verify:1", kind: "acceptance_run" }))

    expect((await store.list(RUN)).map((row) => [row.stepId, row.state])).toEqual([
      ["delegate:stage:1", "committed"],
      ["delegate:verify:1", "prepared"],
    ])
    expect((await store.list("run-2")).map((row) => row.stepId)).toEqual(["delegate:stage:1"])
  })

  it("behaves exactly like the package's reference journal", async () => {
    const { journal } = hostJournal()
    const reference = new MemoryStepJournal()
    const script = async (target: DelegateStepJournal) => {
      const seen: unknown[] = []
      seen.push(await target.begin(step()))
      seen.push(await target.begin(step()))
      await target.markDispatched("delegate:stage:1")
      seen.push(await target.begin(step()))
      await target.commit("delegate:stage:1", { revision: "staged:1" })
      seen.push(await target.begin(step()))
      seen.push(await target.begin(step({ requestHash: "z".repeat(64) })))
      return seen
    }
    expect(await script(journal)).toEqual(await script(reference))
  })
})
