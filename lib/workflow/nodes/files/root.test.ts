/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const listWorkspaceRoots = jest.fn()
jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceRoots: (...a: unknown[]) => listWorkspaceRoots(...a),
}))

import { fsRootMode, optionalRelPath, requireRelPath, resolveFsRoot } from "./root"
import type { StepExecutionContext } from "@/types/workflow/visual"

function ctxWith(params: Record<string, unknown>, projectId?: string): StepExecutionContext {
  return { params, projectId } as unknown as StepExecutionContext
}

describe("resolveFsRoot", () => {
  beforeEach(() => {
    listWorkspaceRoots.mockReset()
    listWorkspaceRoots.mockResolvedValue([])
  })

  it("passes an explicit root through without a second opinion", async () => {
    // Deliberately a path no local root would contain. The authoritative
    // answer is the Host's `authorize_workspace_root`, which is per-Host, so a
    // check here would refuse paths a remote Host would have accepted.
    const resolved = await resolveFsRoot(
      ctxWith({ rootMode: "explicit", rootPath: "/srv/elsewhere" })
    )
    expect(resolved).toEqual({ root: "/srv/elsewhere", mode: "explicit" })
    expect(listWorkspaceRoots).not.toHaveBeenCalled()
  })

  it("refuses an explicit mode with no path, by name", async () => {
    await expect(resolveFsRoot(ctxWith({ rootMode: "explicit", rootPath: "  " }))).rejects.toThrow(
      /rootPath is empty/
    )
  })

  it("falls back to the Host's declared root when the run has no workspace", async () => {
    listWorkspaceRoots.mockResolvedValue([
      { path: "/srv/workspaces", source: "headless-workspaces-dir" },
    ])
    // This is the rung that makes a saved workflow portable: a brain declares
    // exactly the root it will accept, so this is an answer rather than a guess.
    expect(await resolveFsRoot(ctxWith({}))).toEqual({
      root: "/srv/workspaces",
      mode: "host-default",
    })
  })

  it("prefers the run's workspace over the Host default", async () => {
    listWorkspaceRoots.mockResolvedValue([{ path: "/srv/fallback", source: "desktop-project" }])
    const { getDb } = await import("@/lib/db/schema")
    await getDb().projects.put({
      id: "proj_1",
      name: "Proj",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      roots: [{ id: "r1", path: "/Users/me/proj", isPrimary: true }],
    } as never)

    expect(await resolveFsRoot(ctxWith({}, "proj_1"))).toEqual({
      root: "/Users/me/proj",
      mode: "project",
    })
    expect(listWorkspaceRoots).not.toHaveBeenCalled()
  })

  it("names all three ways out when nothing resolves", async () => {
    await expect(resolveFsRoot(ctxWith({}))).rejects.toThrow(
      /Bind the run to a workspace.*explicit.*rootPath.*browse/s
    )
  })

  it("marks the failure non-retryable, because no root now is no root on a retry", async () => {
    await expect(resolveFsRoot(ctxWith({}))).rejects.toMatchObject({ retryable: false })
  })
})

describe("fsRootMode", () => {
  it("defaults to the run's workspace for an unset or unknown mode", () => {
    expect(fsRootMode({})).toBe("project")
    expect(fsRootMode({ rootMode: "nonsense" })).toBe("project")
    expect(fsRootMode({ rootMode: "host-default" })).toBe("host-default")
    expect(fsRootMode({ rootMode: "explicit" })).toBe("explicit")
  })
})

describe("relPath validation", () => {
  it.each([
    ["/etc/passwd"],
    ["C:\\Windows\\system32"],
    [".."],
    ["../../etc/passwd"],
    ["..\\..\\etc\\passwd"],
  ])("rejects %s before any Host call", (relPath) => {
    expect(() => requireRelPath({ relPath }, "relPath", "action.fs.read")).toThrow(
      expect.objectContaining({ retryable: false })
    )
  })

  it("accepts an ordinary relative path, and one that merely contains ..", () => {
    expect(requireRelPath({ relPath: "docs/README.md" }, "relPath", "k")).toBe("docs/README.md")
    // Not a prefix, so not an escape. The Host canonicalises and is the real
    // boundary, so this check exists for error quality rather than for safety.
    expect(requireRelPath({ relPath: "a/../b.txt" }, "relPath", "k")).toBe("a/../b.txt")
  })

  it("requires a value, and treats whitespace as absent", () => {
    expect(() => requireRelPath({}, "relPath", "action.fs.read")).toThrow(/requires 'relPath'/)
    expect(() => requireRelPath({ relPath: "   " }, "relPath", "action.fs.read")).toThrow(
      /requires 'relPath'/
    )
  })

  it("lets an optional path be absent but still validates one that is present", () => {
    expect(optionalRelPath({}, "relPath", "k")).toBeUndefined()
    expect(optionalRelPath({ relPath: "src" }, "relPath", "k")).toBe("src")
    expect(() => optionalRelPath({ relPath: "/abs" }, "relPath", "k")).toThrow()
  })
})
