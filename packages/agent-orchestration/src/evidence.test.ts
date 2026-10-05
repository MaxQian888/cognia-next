import { createEvidenceBundle, DEFAULT_EVIDENCE_POLICY } from "./evidence"
import { createMemoryTeamRunStore } from "./memory-store"
import type { TeamRunStore } from "./store"

describe("AgentTeam evidence bundle", () => {
  let store: TeamRunStore

  beforeEach(() => {
    store = createMemoryTeamRunStore()
  })

  it("requires every evidence class by default", () => {
    expect(DEFAULT_EVIDENCE_POLICY).toEqual({
      requireActivity: true,
      requireOutcome: true,
      requireCodeDiff: true,
      requireVerification: true,
      requireVisualForUi: true,
    })
    expect(Object.isFrozen(DEFAULT_EVIDENCE_POLICY)).toBe(true)
  })

  it("stores large payloads by digest and validates code completion evidence", async () => {
    const bundle = createEvidenceBundle({ store, runId: "run-1", taskId: "task-1", now: () => 10 })
    await bundle.record({ kind: "activity", title: "Implemented runtime" })
    await bundle.record({ kind: "outcome", title: "Runtime complete" })
    const diff = await bundle.record({ kind: "diff", title: "Code diff", content: "diff --git" })
    await bundle.record({
      kind: "test",
      title: "Jest",
      content: "7 tests passed",
      status: "passed",
    })

    expect(diff.contentHash).toMatch(/^sha256:/)
    expect(await store.getContent(diff.contentHash!)).toMatchObject({ mimeType: "text/plain" })
    expect(await bundle.validate({ taskKind: "code", visualSupported: false })).toEqual({
      complete: true,
      missing: [],
    })
  })

  it("requires visual proof only for UI work when the environment supports it", async () => {
    const bundle = createEvidenceBundle({ store, runId: "run-2", taskId: "task-2", now: () => 20 })
    await bundle.record({ kind: "activity", title: "Built UI" })
    await bundle.record({ kind: "outcome", title: "UI complete" })
    await bundle.record({ kind: "diff", title: "UI diff" })
    await bundle.record({ kind: "test", title: "RTL", status: "passed" })

    expect(await bundle.validate({ taskKind: "ui", visualSupported: true })).toEqual({
      complete: false,
      missing: ["visual"],
    })
    expect(await bundle.validate({ taskKind: "ui", visualSupported: false })).toEqual({
      complete: true,
      missing: [],
    })
  })

  it("does not accept another child or previous attempt's evidence", async () => {
    const old = createEvidenceBundle({
      store,
      runId: "run",
      taskId: "task",
      childRunId: "old",
      attempt: 1,
    })
    for (const kind of ["activity", "outcome", "diff", "test"] as const) {
      await old.record({ kind, title: kind, status: "passed" })
    }
    const current = createEvidenceBundle({
      store,
      runId: "run",
      taskId: "task",
      childRunId: "new",
      attempt: 2,
    })
    expect((await current.validate({ taskKind: "code", visualSupported: false })).missing).toEqual([
      "activity",
      "outcome",
      "code_diff",
      "verification",
    ])
    const retry = createEvidenceBundle({
      store,
      runId: "run",
      taskId: "task",
      childRunId: "old",
      attempt: 2,
    })
    expect((await retry.validate({ taskKind: "code", visualSupported: false })).complete).toBe(
      false
    )
  })

  it("requires successful verification for the current revision", async () => {
    const bundle = createEvidenceBundle({
      store,
      runId: "run",
      taskId: "task",
      childRunId: "child",
      attempt: 1,
    })
    await bundle.record({ kind: "activity", title: "ran" })
    await bundle.record({ kind: "outcome", title: "done" })
    await bundle.record({ kind: "diff", title: "changes", revision: "r2" })
    await bundle.record({ kind: "test", title: "failed", status: "failed", revision: "r2" })
    await bundle.record({ kind: "ci", title: "old success", status: "passed", revision: "r1" })
    expect(
      (await bundle.validate({ taskKind: "code", visualSupported: false, revision: "r2" })).missing
    ).toEqual(["verification"])
    await bundle.record({ kind: "test", title: "passed", status: "passed", revision: "r2" })
    expect(
      (await bundle.validate({ taskKind: "code", visualSupported: false, revision: "r2" })).complete
    ).toBe(true)
  })

  it("requires an explicit snapshot revision only for an enabled code artifact gate", async () => {
    const bundle = createEvidenceBundle({ store, runId: "run", taskId: "task" })
    for (const kind of ["activity", "outcome", "diff", "test"] as const) {
      await bundle.record({ kind, title: kind, status: "passed" })
    }
    expect(
      (await bundle.validate({ taskKind: "code", visualSupported: false, requireRevision: true }))
        .missing
    ).toEqual(["revision"])
    expect(
      (
        await bundle.validate({
          taskKind: "general",
          visualSupported: false,
          requireRevision: true,
        })
      ).complete
    ).toBe(true)
    const disabled = createEvidenceBundle({
      store,
      runId: "run",
      taskId: "task",
      policy: { requireCodeDiff: false, requireVerification: false },
    })
    expect(
      (await disabled.validate({ taskKind: "code", visualSupported: false, requireRevision: true }))
        .complete
    ).toBe(true)
    const revision = "workspace:sha256:current"
    await bundle.record({ kind: "diff", title: "current", revision })
    await bundle.record({ kind: "test", title: "verified", revision, status: "passed" })
    expect(
      (
        await bundle.validate({
          taskKind: "code",
          visualSupported: false,
          requireRevision: true,
          revision,
        })
      ).complete
    ).toBe(true)
  })

  it("does not count evidence whose content the store can no longer return", async () => {
    const bundle = createEvidenceBundle({ store, runId: "run", taskId: "task" })
    await bundle.record({ kind: "activity", title: "ran" })
    const outcome = await bundle.record({ kind: "outcome", title: "done", content: "result" })
    expect((await bundle.validate({ taskKind: "general", visualSupported: false })).complete).toBe(
      true
    )
    const unreadable: TeamRunStore = {
      ...store,
      getContent: async (hash) =>
        hash === outcome.contentHash ? undefined : store.getContent(hash),
    }
    const reread = createEvidenceBundle({ store: unreadable, runId: "run", taskId: "task" })
    expect(
      (await reread.validate({ taskKind: "general", visualSupported: false })).missing
    ).toEqual(["outcome"])
  })

  it("records evidence under its attempt, revision and status", async () => {
    const bundle = createEvidenceBundle({
      store,
      runId: "run",
      taskId: "task",
      childRunId: "child",
      attempt: 3,
      revision: "r1",
      now: () => 42,
    })
    const recorded = await bundle.record({
      kind: "screenshot",
      title: "after",
      url: "file:///shot.png",
      metadata: { width: 800 },
      status: "passed",
      content: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    })
    expect(recorded).toMatchObject({
      runId: "run",
      taskId: "task",
      childRunId: "child",
      attempt: 3,
      revision: "r1",
      status: "passed",
      url: "file:///shot.png",
      metadata: { width: 800 },
      createdAt: 42,
    })
    expect(await store.getContent(recorded.contentHash!)).toMatchObject({
      mimeType: "image/png",
      byteLength: 3,
    })
    expect(await store.getEvidence([recorded.id])).toEqual([recorded])
  })
})
