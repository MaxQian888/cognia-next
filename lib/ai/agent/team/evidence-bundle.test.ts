import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createEvidenceBundle } from "./evidence-bundle"

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
    await bundle.record({ kind: "test", title: "Jest", content: "7 tests passed" })

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
    await bundle.record({ kind: "test", title: "RTL" })

    expect(await bundle.validate({ taskKind: "ui", visualSupported: true })).toEqual({
      complete: false,
      missing: ["visual"],
    })
    expect(await bundle.validate({ taskKind: "ui", visualSupported: false })).toEqual({
      complete: true,
      missing: [],
    })
  })
})
