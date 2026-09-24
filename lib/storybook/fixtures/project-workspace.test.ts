/**
 * @jest-environment jsdom
 */
import { createMockWorkspace, MOCK_WORKSPACE_ROOT } from "./project-workspace"
import type { WorkspaceFsChange } from "@/lib/files/workspace-watch"

jest.useFakeTimers()

function collect(workspace: ReturnType<typeof createMockWorkspace>) {
  const changes: WorkspaceFsChange[] = []
  const dispose = workspace.deps.watch!(workspace.root, (c) => changes.push(c))
  return { changes, dispose }
}

function flushWatch() {
  jest.runOnlyPendingTimers()
}

describe("createMockWorkspace", () => {
  it("lists the seeded tree depth-1 with dirs and files", async () => {
    const ws = createMockWorkspace()
    const top = await ws.deps.listDir!(ws.root)
    const names = top.map((e) => e.relPath).sort()
    expect(names).toEqual(
      expect.arrayContaining(["package.json", "README.md", "src", "docs", "tests"])
    )
    expect(top.find((e) => e.relPath === "src")?.isDir).toBe(true)

    const src = await ws.deps.listDir!(ws.root, "src")
    expect(src.map((e) => e.relPath).sort()).toEqual(
      expect.arrayContaining(["src/App.tsx", "src/main.tsx", "src/components", "src/lib"])
    )
  })

  it("reads and stats seeded files", async () => {
    const ws = createMockWorkspace()
    const content = await ws.deps.readFile!(ws.root, "src/lib/utils.ts")
    expect(content).toContain("export function clamp")

    const stat = await ws.deps.statFile!(ws.root, "src/lib/utils.ts")
    expect(stat).toMatchObject({ exists: true, isDir: false })
    const missing = await ws.deps.statFile!(ws.root, "src/nope.ts")
    expect(missing.exists).toBe(false)
    const dir = await ws.deps.statFile!(ws.root, "src/lib")
    expect(dir.isDir).toBe(true)
  })

  it("truncates reads at maxBytes", async () => {
    const ws = createMockWorkspace()
    const head = await ws.deps.readFile!(ws.root, "README.md", 10)
    expect(head.length).toBeLessThanOrEqual(10)
  })

  it("writeFile creates parents and emits a watcher event", async () => {
    const ws = createMockWorkspace()
    const { changes } = collect(ws)
    await ws.deps.writeFile!(ws.root, "src/new/deep/file.ts", "hello\n")
    flushWatch()
    expect(await ws.deps.readFile!(ws.root, "src/new/deep/file.ts")).toBe("hello\n")
    const stat = await ws.deps.statFile!(ws.root, "src/new/deep")
    expect(stat.isDir).toBe(true)
    expect(changes).toEqual([
      { kind: "create", path: `${MOCK_WORKSPACE_ROOT}/src/new/deep/file.ts` },
    ])
  })

  it("deleteEntry removes files and guarded directories", async () => {
    const ws = createMockWorkspace()
    const { changes } = collect(ws)

    await ws.deps.deleteEntry!(ws.root, "src/types.ts", false)
    expect((await ws.deps.statFile!(ws.root, "src/types.ts")).exists).toBe(false)

    await expect(ws.deps.deleteEntry!(ws.root, "src/lib", false)).rejects.toThrow(/not empty/)
    await ws.deps.deleteEntry!(ws.root, "src/lib", true)
    expect((await ws.deps.statFile!(ws.root, "src/lib/utils.ts")).exists).toBe(false)

    flushWatch()
    expect(changes.map((c) => c.kind)).toEqual(["delete", "delete"])
  })

  it("renameEntry moves files and refuses to clobber", async () => {
    const ws = createMockWorkspace()
    await expect(ws.deps.renameEntry!(ws.root, "src/types.ts", "src/main.tsx")).rejects.toThrow(
      /exists/
    )

    await ws.deps.renameEntry!(ws.root, "src/types.ts", "src/models.ts")
    expect((await ws.deps.statFile!(ws.root, "src/types.ts")).exists).toBe(false)
    expect(await ws.deps.readFile!(ws.root, "src/models.ts")).toContain("interface User")
  })

  it("walk returns files under the cap and honours includeDirs", async () => {
    const ws = createMockWorkspace()
    const filesOnly = await ws.quickOpenDeps.walk!(ws.root, {})
    expect(filesOnly.entries.every((e) => !e.isDir)).toBe(true)
    expect(filesOnly.entries.length).toBeGreaterThan(10)
    expect(filesOnly.truncated).toBe(false)

    const withDirs = await ws.quickOpenDeps.walk!(ws.root, { includeDirs: true })
    expect(withDirs.entries.some((e) => e.isDir)).toBe(true)

    const capped = await ws.quickOpenDeps.walk!(ws.root, { maxEntries: 3 })
    expect(capped.entries).toHaveLength(3)
    expect(capped.truncated).toBe(true)
  })

  it("search finds substring and regex matches with line/column", async () => {
    const ws = createMockWorkspace()
    const hits = await ws.searchDeps.search!(ws.root, "clamp", {})
    expect(hits.length).toBeGreaterThanOrEqual(2) // utils.ts + tests
    expect(hits[0]).toMatchObject({ line: expect.any(Number) })
    expect(hits[0].column).toBeGreaterThan(0)

    const regex = await ws.searchDeps.search!(ws.root, "export (function|interface)", {
      isRegex: true,
    })
    expect(regex.length).toBeGreaterThanOrEqual(3)

    const none = await ws.searchDeps.search!(ws.root, "definitely-absent-token", {})
    expect(none).toEqual([])
  })

  it("watcher dispose stops events", async () => {
    const ws = createMockWorkspace()
    const { changes, dispose } = collect(ws)
    dispose()
    await ws.deps.writeFile!(ws.root, "late.txt", "x")
    flushWatch()
    expect(changes).toEqual([])
  })

  it("git deps report a repo with branch and decorations", async () => {
    const ws = createMockWorkspace()
    const state = await ws.gitDeps.gitRepoState!(ws.root)
    expect(state).toMatchObject({ isRepo: true, rootDir: ws.root })
    const status = await ws.gitDeps.gitStatus!(ws.root)
    expect(status.branch).toBe("main")
    expect(status.changes.length).toBeGreaterThan(0)
  })

  it("git status tracks writes, deletes and renames live", async () => {
    const ws = createMockWorkspace()
    const paths = async () =>
      new Map((await ws.gitDeps.gitStatus!(ws.root)).changes.map((c) => [c.path, c.status]))

    expect((await paths()).get("src/App.tsx")).toBeUndefined()
    await ws.deps.writeFile!(ws.root, "src/App.tsx", "// touched\n")
    expect((await paths()).get("src/App.tsx")).toBe("modified")

    await ws.deps.writeFile!(ws.root, "src/brand-new.ts", "x\n")
    expect((await paths()).get("src/brand-new.ts")).toBe("untracked")

    await ws.deps.deleteEntry!(ws.root, "src/App.tsx", false)
    expect((await paths()).get("src/App.tsx")).toBe("deleted")

    await ws.deps.deleteEntry!(ws.root, "src/brand-new.ts", false)
    expect((await paths()).has("src/brand-new.ts")).toBe(false)

    await ws.deps.renameEntry!(ws.root, "src/types.ts", "src/models.ts")
    const afterRename = await paths()
    expect(afterRename.get("src/models.ts")).toBe("renamed")
    expect(afterRename.has("src/types.ts")).toBe(false)
  })

  it("notifies git subscribers on fs changes (coalesced)", async () => {
    const ws = createMockWorkspace()
    const handler = jest.fn()
    const dispose = ws.gitDeps.subscribeGitStatusChanged!(handler)
    await ws.deps.writeFile!(ws.root, "a.txt", "1")
    await ws.deps.writeFile!(ws.root, "b.txt", "2")
    flushWatch()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ rootDir: MOCK_WORKSPACE_ROOT })
    dispose()
  })
})
