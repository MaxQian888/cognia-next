import { MemoryStepJournal } from "./memory-step-journal"

describe("MemoryStepJournal", () => {
  it("replays a committed step's receipt as JSON", async () => {
    const journal = new MemoryStepJournal()
    const step = { stepId: "delegate:verify:1", kind: "acceptance_run" as const, requestHash: "h" }
    expect(await journal.begin(step)).toEqual({ kind: "fresh" })
    // Prepared and not dispatched: still fresh.
    expect(await journal.begin(step)).toEqual({ kind: "fresh" })
    await journal.markDispatched(step.stepId)
    await journal.commit(step.stepId, { kind: "report", at: new Date(0), skip: undefined })
    expect(await journal.begin(step)).toEqual({
      kind: "replay",
      receipt: { kind: "report", at: "1970-01-01T00:00:00.000Z" },
    })
  })

  it("answers unknown for a dispatched step with no receipt, and mismatch for another request", async () => {
    const journal = new MemoryStepJournal()
    journal.strand("delegate:deliver:apply", "workspace_apply", "h")
    expect(
      await journal.begin({
        stepId: "delegate:deliver:apply",
        kind: "workspace_apply",
        requestHash: "h",
      })
    ).toEqual({ kind: "unknown" })
    expect(
      await journal.begin({
        stepId: "delegate:deliver:apply",
        kind: "workspace_apply",
        requestHash: "other",
      })
    ).toEqual({ kind: "mismatch" })
    expect(
      await journal.begin({
        stepId: "delegate:deliver:apply",
        kind: "stage_patch",
        requestHash: "h",
      })
    ).toEqual({ kind: "mismatch" })
  })

  it("keeps the order: dispatched before committed, committed once", async () => {
    const journal = new MemoryStepJournal()
    await expect(journal.markDispatched("x")).rejects.toThrow("no journal step x")
    await journal.begin({ stepId: "x", kind: "stage_patch", requestHash: "h" })
    await expect(journal.commit("x", {})).rejects.toThrow("not dispatched")
    await journal.markDispatched("x")
    await journal.commit("x", { ok: true })
    await expect(journal.markDispatched("x")).rejects.toThrow("already committed")
    await expect(journal.commit("x", {})).rejects.toThrow("not dispatched")
  })
})
