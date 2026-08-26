import type { StepExecutionContext } from "@/types/workflow/visual"

let mockRootDir: string | null = "/panel-folder"
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: { getState: () => ({ rootDir: mockRootDir }) },
}))

let mockProjects: Record<string, unknown> = {}
let projectsThrows = false
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    projects: {
      get: async (id: string) => {
        if (projectsThrows) throw new Error("no database on this host")
        return mockProjects[id]
      },
    },
  }),
}))

import { boolParam, pathsParam, resolveRepo, strParam } from "./repo-target"

function ctx(params: Record<string, unknown>, projectId?: string): StepExecutionContext {
  return { params, ...(projectId ? { projectId } : {}) } as unknown as StepExecutionContext
}

beforeEach(() => {
  mockRootDir = "/panel-folder"
  mockProjects = {}
  projectsThrows = false
})

describe("param readers", () => {
  it("strParam ignores non-strings and empties", () => {
    expect(strParam({ a: "x" }, "a")).toBe("x")
    expect(strParam({ a: "" }, "a")).toBeUndefined()
    expect(strParam({ a: 3 }, "a")).toBeUndefined()
    expect(strParam({}, "a")).toBeUndefined()
  })

  it("boolParam distinguishes false from absent", () => {
    expect(boolParam({ a: false }, "a")).toBe(false)
    expect(boolParam({}, "a")).toBeUndefined()
    expect(boolParam({ a: "true" }, "a")).toBeUndefined()
  })

  it("pathsParam defaults to the whole tree and drops junk", () => {
    expect(pathsParam({})).toEqual(["."])
    expect(pathsParam({ paths: [] })).toEqual(["."])
    expect(pathsParam({ paths: ["a.ts", "", 3, "b.ts"] })).toEqual(["a.ts", "b.ts"])
  })
})

describe("resolveRepo", () => {
  it("takes an explicit repoPath first", async () => {
    mockProjects.w1 = { roots: [{ path: "/workspace", isPrimary: true }] }
    expect(await resolveRepo(ctx({ repoPath: "/explicit" }, "w1"))).toBe("/explicit")
  })

  it("prefers the run's workspace over the folder open in the panel", async () => {
    // The panel is somebody looking at something else. It is not a statement
    // about this run, and for a scheduled run there is no panel at all.
    mockProjects.w1 = { roots: [{ path: "/workspace", isPrimary: true }] }
    expect(await resolveRepo(ctx({}, "w1"))).toBe("/workspace")
  })

  it("lets a node override the run's workspace", async () => {
    mockProjects.w1 = { roots: [{ path: "/run-workspace", isPrimary: true }] }
    mockProjects.w2 = { roots: [{ path: "/node-workspace", isPrimary: true }] }
    expect(await resolveRepo(ctx({ projectId: "w2" }, "w1"))).toBe("/node-workspace")
  })

  it("still honours the panel for an editor run with no workspace", async () => {
    expect(await resolveRepo(ctx({}))).toBe("/panel-folder")
  })

  it("falls through an unknown workspace instead of failing early", async () => {
    expect(await resolveRepo(ctx({}, "deleted"))).toBe("/panel-folder")
  })

  it("falls through when there is no database at all", async () => {
    // A remote step broker or a test harness has no Dexie; that is a reason to
    // try the next rung, not to fail the node.
    projectsThrows = true
    expect(await resolveRepo(ctx({}, "w1"))).toBe("/panel-folder")
  })

  it("ignores a workspace root that is only whitespace", async () => {
    mockProjects.w1 = { roots: [{ path: "   ", isPrimary: true }] }
    expect(await resolveRepo(ctx({}, "w1"))).toBe("/panel-folder")
  })

  it("fails with a message a headless run can act on", async () => {
    // The previous message told the user to open a folder in Source Control,
    // which is not something a scheduled run on a server can do.
    mockRootDir = null
    await expect(resolveRepo(ctx({}))).rejects.toThrow(/bind the run to a workspace/)
  })

  it("names the workspace when that is what lacks a root", async () => {
    mockRootDir = null
    mockProjects.w1 = { roots: [] }
    await expect(resolveRepo(ctx({}, "w1"))).rejects.toThrow(/workspace w1 has no root directory/)
  })
})
