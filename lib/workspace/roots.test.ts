import {
  primaryRootOf,
  additionalDirsOf,
  allRootPaths,
  normalizeRoots,
  syncDerivedDirFields,
  rootsFromLegacy,
} from "./roots"
import type { Project } from "@/types"
import type { WorkspaceRoot } from "@/types/workspace"

const root = (path: string, isPrimary = false, label?: string): WorkspaceRoot => ({
  id: `root-${path}`,
  path,
  isPrimary,
  label,
})

const project = (roots: WorkspaceRoot[]): Project =>
  ({
    id: "p1",
    name: "P",
    roots,
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
  }) as Project

describe("roots helpers", () => {
  it("primaryRootOf returns the primary root", () => {
    const p = project([root("/a"), root("/b", true)])
    expect(primaryRootOf(p)?.path).toBe("/b")
  })

  it("primaryRootOf falls back to first root when none is flagged", () => {
    const p = project([root("/a"), root("/b")])
    expect(primaryRootOf(p)?.path).toBe("/a")
  })

  it("primaryRootOf returns undefined when no roots", () => {
    expect(primaryRootOf(project([]))).toBeUndefined()
  })

  it("additionalDirsOf returns non-primary paths in order", () => {
    const p = project([root("/a", true), root("/b"), root("/c")])
    expect(additionalDirsOf(p)).toEqual(["/b", "/c"])
  })

  it("allRootPaths lists primary first then the rest", () => {
    const p = project([root("/b"), root("/a", true), root("/c")])
    expect(allRootPaths(p)).toEqual(["/a", "/b", "/c"])
  })

  it("allRootPaths is empty for a rootless workspace", () => {
    expect(allRootPaths(project([]))).toEqual([])
  })

  it("normalizeRoots dedupes by path and keeps a single primary", () => {
    const out = normalizeRoots([root("/a", true), root("/a"), root("/b", true)])
    expect(out.map((r) => r.path)).toEqual(["/a", "/b"])
    expect(out.filter((r) => r.isPrimary)).toHaveLength(1)
    expect(out[0].isPrimary).toBe(true)
  })

  it("normalizeRoots promotes the first root when none is primary", () => {
    const out = normalizeRoots([root("/a"), root("/b")])
    expect(out[0].isPrimary).toBe(true)
    expect(out[1].isPrimary).toBeFalsy()
  })

  it("normalizeRoots drops empty/whitespace paths", () => {
    const out = normalizeRoots([root("  "), root("/a")])
    expect(out.map((r) => r.path)).toEqual(["/a"])
  })

  it("normalizeRoots returns [] for empty input", () => {
    expect(normalizeRoots([])).toEqual([])
  })

  it("syncDerivedDirFields writes rootDir + additionalDirs from roots", () => {
    const p = syncDerivedDirFields(project([root("/a", true), root("/b")]))
    expect(p.rootDir).toBe("/a")
    expect(p.additionalDirs).toEqual(["/b"])
  })

  it("syncDerivedDirFields clears mirrors when no roots", () => {
    const p = syncDerivedDirFields(project([]))
    expect(p.rootDir).toBeUndefined()
    expect(p.additionalDirs).toBeUndefined()
  })

  it("rootsFromLegacy builds roots from rootDir + additionalDirs", () => {
    const out = rootsFromLegacy("/a", ["/b", "/c"])
    expect(out[0]).toMatchObject({ path: "/a", isPrimary: true })
    expect(out.map((r) => r.path)).toEqual(["/a", "/b", "/c"])
  })

  it("rootsFromLegacy returns [] for empty input", () => {
    expect(rootsFromLegacy(undefined, undefined)).toEqual([])
  })

  it("rootsFromLegacy promotes the first additional dir when no rootDir", () => {
    const out = rootsFromLegacy(undefined, ["/b", "/c"])
    expect(out[0]).toMatchObject({ path: "/b", isPrimary: true })
  })
})
