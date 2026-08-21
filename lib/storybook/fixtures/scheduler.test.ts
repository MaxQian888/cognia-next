import { makeUnifiedRun, makeUnifiedRunSet } from "./scheduler"

describe("unified scheduler run fixtures", () => {
  it("builds completed and running records with coherent timing", () => {
    const completed = makeUnifiedRun({ kind: "workflow", status: "failed", startedAt: 1_000 })
    const running = makeUnifiedRun({ kind: "connector", status: "running", startedAt: 2_000 })

    expect(completed).toMatchObject({
      kind: "workflow",
      status: "failed",
      startedAt: 1_000,
      finishedAt: 2_850,
      durationMs: 1_850,
    })
    expect(running).toMatchObject({
      kind: "connector",
      status: "running",
      startedAt: 2_000,
      finishedAt: undefined,
      durationMs: undefined,
    })
  })

  it("returns a mixed set including an in-progress run", () => {
    const runs = makeUnifiedRunSet()

    expect(runs.map((run) => run.kind)).toEqual(["app", "workflow", "backup", "connector"])
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "failed", "succeeded", "running"])
  })
})
