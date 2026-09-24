import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { ResourceChange } from "@/lib/task-workspace/types"
import { createEvidenceBundle, workspaceEvidenceRevision } from "./evidence-bundle"

const resource = (overrides: Partial<ResourceChange> = {}): ResourceChange => ({
  runId: "workspace-run",
  path: "src/main.ts",
  oldPath: null,
  kind: "modified",
  origin: "agent",
  agentId: "mate",
  mediaType: "text/typescript",
  size: 12,
  hash: "current-content",
  beforeHash: "previous-content",
  insertions: 1,
  deletions: 1,
  binary: false,
  resourceKind: "file",
  beforeMode: 420,
  afterMode: 420,
  sensitive: false,
  revision: 3,
  captureClass: "source",
  contentCaptured: true,
  ...overrides,
})

describe("workspace evidence revision", () => {
  it("is stable across resource ordering and does not mutate the snapshot", async () => {
    const a = resource()
    const b = resource({ path: "src/other.ts" })
    const before = structuredClone([a, b])
    const revision = await workspaceEvidenceRevision([a, b])
    expect(revision).toMatch(/^workspace:sha256:[0-9a-f]{64}$/)
    expect(await workspaceEvidenceRevision([b, a])).toBe(revision)
    expect([a, b]).toEqual(before)
  })

  it.each([
    { hash: "changed" },
    { beforeHash: "changed" },
    { revision: 4 },
    { path: "src/new.ts" },
    { oldPath: "src/old.ts" },
    { runId: "other-run" },
    { afterMode: 493 },
    { beforeMode: 493 },
    { resourceKind: "symlink" as const },
    { kind: "renamed" as const },
  ])("changes when material snapshot identity changes: %o", async (change) => {
    expect(await workspaceEvidenceRevision([resource(change)])).not.toBe(
      await workspaceEvidenceRevision([resource()])
    )
  })

  it("rejects incomplete snapshots but binds deletions without current bytes", async () => {
    expect(await workspaceEvidenceRevision([])).toBeUndefined()
    for (const kind of ["created", "modified", "renamed"] as const) {
      expect(
        await workspaceEvidenceRevision([resource(), resource({ kind, hash: null })])
      ).toBeUndefined()
    }
    expect(await workspaceEvidenceRevision([resource({ hash: " " })])).toBeUndefined()
    expect(await workspaceEvidenceRevision([resource({ kind: "deleted", hash: null })])).toMatch(
      /^workspace:sha256:/
    )
  })

  it("binds source changes when Registry also returns metadata-only generated output", async () => {
    const source = resource()
    const generated = resource({
      path: "dist/main.js",
      captureClass: "generated",
      contentCaptured: false,
      hash: null,
      beforeHash: null,
    })
    expect(await workspaceEvidenceRevision([source, generated])).toBe(
      await workspaceEvidenceRevision([source])
    )
    expect(await workspaceEvidenceRevision([generated])).toBeUndefined()
    const legacy = resource({ captureClass: undefined })
    expect(await workspaceEvidenceRevision([legacy])).toBe(
      await workspaceEvidenceRevision([source])
    )
    expect(
      await workspaceEvidenceRevision([
        resource({ captureClass: undefined, hash: null }),
        generated,
      ])
    ).toBeUndefined()
  })
})

describe("AgentTeam evidence bundle", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("stores large payloads by digest and validates code completion evidence", async () => {
    const bundle = createEvidenceBundle({ runId: "run-1", taskId: "task-1", now: () => 10 })
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
    expect(await getDb().agentTeamContentObjects.count()).toBe(2)
    expect(await bundle.validate({ taskKind: "code", visualSupported: false })).toEqual({
      complete: true,
      missing: [],
    })
  })

  it("requires visual proof only for UI work when the environment supports it", async () => {
    const bundle = createEvidenceBundle({ runId: "run-2", taskId: "task-2", now: () => 20 })
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
      runId: "run",
      taskId: "task",
      childRunId: "old",
      attempt: 1,
    })
    for (const kind of ["activity", "outcome", "diff", "test"] as const) {
      await old.record({ kind, title: kind, status: "passed" })
    }
    const current = createEvidenceBundle({
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
    const bundle = createEvidenceBundle({ runId: "run", taskId: "task" })
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
      runId: "run",
      taskId: "task",
      policy: { requireCodeDiff: false, requireVerification: false },
    })
    expect(
      (await disabled.validate({ taskKind: "code", visualSupported: false, requireRevision: true }))
        .complete
    ).toBe(true)
    const revision = await workspaceEvidenceRevision([resource()])
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

  it("refuses evidence whose referenced content has disappeared", async () => {
    const bundle = createEvidenceBundle({ runId: "run", taskId: "task" })
    await bundle.record({ kind: "activity", title: "ran" })
    const outcome = await bundle.record({ kind: "outcome", title: "done", content: "result" })
    await getDb().agentTeamContentObjects.delete(outcome.contentHash!)
    expect(
      (await bundle.validate({ taskKind: "general", visualSupported: false })).missing
    ).toEqual(["outcome"])
  })

  it("does not accept corrupted content under a previously valid digest", async () => {
    const bundle = createEvidenceBundle({ runId: "run", taskId: "task" })
    await bundle.record({ kind: "activity", title: "ran", content: "result" })
    const outcome = await bundle.record({ kind: "outcome", title: "done", content: "result" })
    expect((await bundle.validate({ taskKind: "general", visualSupported: false })).complete).toBe(
      true
    )
    await getDb().agentTeamContentObjects.update(outcome.contentHash!, {
      data: new TextEncoder().encode("forged"),
    })
    expect(
      (await bundle.validate({ taskKind: "general", visualSupported: false })).missing
    ).toEqual(["activity", "outcome"])
  })
})
