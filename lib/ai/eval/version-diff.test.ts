import type { EvalCase } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"
import { diffVersions, planRestore, versionCaseIds } from "./version-diff"

function evalCase(id: string, over: Partial<EvalCase> = {}): EvalCase {
  return {
    id,
    datasetId: "d",
    input: `prompt ${id}`,
    capability: "chat.qa",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function version(id: string, caseIds: string[], over: Partial<EvalDatasetVersion> = {}) {
  return {
    id,
    datasetId: "d",
    version: 1,
    caseIds,
    casesHash: `hash-${id}`,
    createdAt: 0,
    ...over,
  } as EvalDatasetVersion
}

/** A pre-slimming snapshot, which kept full copies. */
function legacyVersion(id: string, cases: EvalCase[]) {
  return {
    id,
    datasetId: "d",
    version: 1,
    cases,
    casesHash: `hash-${id}`,
    createdAt: 0,
  } as unknown as EvalDatasetVersion
}

describe("versionCaseIds", () => {
  it("reads ids from a slimmed snapshot", () => {
    expect(versionCaseIds(version("v1", ["a", "b"]))).toEqual(["a", "b"])
  })

  it("derives them from a legacy full-copy snapshot", () => {
    expect(versionCaseIds(legacyVersion("v0", [evalCase("a"), evalCase("b")]))).toEqual(["a", "b"])
  })

  it("returns nothing for a snapshot with neither", () => {
    expect(versionCaseIds({ id: "x" } as EvalDatasetVersion)).toEqual([])
  })
})

describe("diffVersions", () => {
  it("reports added and removed cases", () => {
    const diff = diffVersions(version("v1", ["a", "b"]), version("v2", ["b", "c"]))
    expect(diff.added).toEqual(["c"])
    expect(diff.removed).toEqual(["a"])
    expect(diff.unchanged).toEqual(["b"])
    expect(diff.changed).toEqual([])
  })

  it("reports nothing for identical snapshots", () => {
    const diff = diffVersions(version("v1", ["a", "b"]), version("v2", ["a", "b"]))
    expect(diff).toMatchObject({ added: [], removed: [], changed: [] })
    expect(diff.unchanged).toEqual(["a", "b"])
  })

  it("detects edited content when the older snapshot kept copies", () => {
    // Two runs pinned to different snapshots can score differently because a
    // case was EDITED, not just added or removed — that has to be visible.
    const before = legacyVersion("v1", [evalCase("a"), evalCase("b")])
    const after = version("v2", ["a", "b"])
    const current = new Map([["a", evalCase("a", { input: "edited prompt" })]])
    const diff = diffVersions(before, after, current)
    expect(diff.changed).toEqual(["a"])
    expect(diff.unchanged).toEqual(["b"])
  })

  it("ignores timestamp-only differences", () => {
    // Re-saving a case bumps `updatedAt` without changing what is graded.
    const before = legacyVersion("v1", [evalCase("a", { updatedAt: 1 })])
    const diff = diffVersions(
      before,
      version("v2", ["a"]),
      new Map([["a", evalCase("a", { updatedAt: 999 })]])
    )
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toEqual(["a"])
  })

  it("ignores key ORDER inside a case, not just top-level fields", () => {
    const before = legacyVersion("v1", [
      evalCase("a", { reference: { expectedOutput: "42", expectedTools: ["Read"] } }),
    ])
    const current = new Map([
      ["a", evalCase("a", { reference: { expectedTools: ["Read"], expectedOutput: "42" } })],
    ])
    expect(diffVersions(before, version("v2", ["a"]), current).changed).toEqual([])
  })

  it("does not invent changes when neither snapshot kept copies", () => {
    // Id-only snapshots have nothing to compare, so the shared ids are
    // reported as unchanged rather than guessed at.
    const diff = diffVersions(version("v1", ["a"]), version("v2", ["a"]))
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toEqual(["a"])
  })

  it("does not report a change for a case that no longer exists", () => {
    const before = legacyVersion("v1", [evalCase("a")])
    expect(diffVersions(before, version("v2", ["a"]), new Map()).changed).toEqual([])
  })
})

describe("planRestore", () => {
  it("lists the cases a restore would delete", () => {
    const plan = planRestore(version("v1", ["a", "b"]), ["a", "b", "c"])
    expect(plan.toDelete).toEqual(["c"])
    expect(plan.toKeep).toEqual(["a", "b"])
    expect(plan.missing).toEqual([])
  })

  it("flags snapshot cases that were deleted and cannot be recovered", () => {
    // An id-only snapshot keeps no copy, so restoring cannot bring `b` back —
    // saying so beats silently restoring a smaller set than asked for.
    const plan = planRestore(version("v1", ["a", "b"]), ["a"])
    expect(plan.missing).toEqual(["b"])
    expect(plan.toKeep).toEqual(["a"])
  })

  it("can re-add a deleted case from a legacy full-copy snapshot", () => {
    const plan = planRestore(legacyVersion("v0", [evalCase("a"), evalCase("b")]), ["a"])
    expect(plan.missing).toEqual([])
    expect(plan.toKeep).toEqual(["a", "b"])
  })

  it("is a no-op plan when the dataset already matches the snapshot", () => {
    const plan = planRestore(version("v1", ["a"]), ["a"])
    expect(plan).toEqual({ toDelete: [], toKeep: ["a"], missing: [] })
  })

  it("deletes everything when restoring an empty snapshot", () => {
    expect(planRestore(version("v1", []), ["a", "b"]).toDelete).toEqual(["a", "b"])
  })
})
