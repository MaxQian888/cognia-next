import {
  listAllRoots,
  normalizeRelPath,
  resolveGrantedRoots,
  resolveTarget,
  type GrantDeps,
} from "./grants"

jest.mock("@/lib/db/projects", () => ({ getAllProjects: jest.fn(async () => []) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => ({})) }))

const projects = [
  {
    id: "p1",
    name: "Cognia",
    roots: [
      { id: "root-a", path: "/work/cognia", isPrimary: true },
      { id: "root-b", path: "/work/docs", label: "Docs" },
    ],
  },
  { id: "p2", name: "Other", roots: [{ id: "root-c", path: "/work/other" }] },
]

function deps(grants: Record<string, string[]> | undefined): GrantDeps {
  return {
    loadSettings: async () => ({ enabled: true, enabledScopes: [], workspaceGrants: grants }),
    loadProjects: async () => projects as never,
  }
}

describe("listAllRoots", () => {
  it("labels roots by their label, else the folder name", () => {
    expect(listAllRoots(projects as never).map((r) => [r.id, r.label, r.workspace])).toEqual([
      ["root-a", "cognia", "Cognia"],
      ["root-b", "Docs", "Cognia"],
      ["root-c", "other", "Other"],
    ])
  })
})

describe("resolveGrantedRoots", () => {
  it("returns only the caller's granted roots and drops unknown ids", async () => {
    const roots = await resolveGrantedRoots(
      "mcp:c1",
      deps({ "mcp:c1": ["root-b", "root-gone"], "mcp:c2": ["root-a"] })
    )
    expect(roots.map((r) => r.id)).toEqual(["root-b"])
  })

  it("grants nothing without an entry", async () => {
    expect(await resolveGrantedRoots("mcp:c1", deps(undefined))).toEqual([])
  })
})

describe("normalizeRelPath", () => {
  it("normalizes separators and dot segments", () => {
    expect(normalizeRelPath(undefined)).toBe("")
    expect(normalizeRelPath("./src//lib\\a.ts")).toBe("src/lib/a.ts")
  })

  it.each(["/etc/passwd", "C:\\x", "a/../b", "..", "a\0b", 5])("refuses %p", (raw) => {
    expect(normalizeRelPath(raw)).toBeNull()
  })
})

describe("resolveTarget", () => {
  it("resolves a granted root and relative path", async () => {
    const out = await resolveTarget("mcp:c1", "root-a", "src/a.ts", deps({ "mcp:c1": ["root-a"] }))
    expect(out).toMatchObject({ ok: true, relPath: "src/a.ts", root: { path: "/work/cognia" } })
  })

  it("refuses an ungranted root, explaining when nothing is granted at all", async () => {
    const none = await resolveTarget("mcp:c1", "root-a", "", deps({}))
    expect(none).toMatchObject({ ok: false, code: "root_not_granted" })
    expect(!none.ok && none.error).toMatch(/Workspace access/)
    const other = await resolveTarget("mcp:c1", "root-c", "", deps({ "mcp:c1": ["root-a"] }))
    expect(other).toMatchObject({ ok: false, code: "root_not_granted" })
    expect(!other.ok && other.error).toMatch(/workspace_roots/)
  })

  it("refuses an escaping path", async () => {
    const out = await resolveTarget("mcp:c1", "root-a", "../x", deps({ "mcp:c1": ["root-a"] }))
    expect(out).toMatchObject({ ok: false, code: "invalid_path" })
  })
})
