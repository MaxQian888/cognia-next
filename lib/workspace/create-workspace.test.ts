import type { Project } from "@/types"
import { createWorkspaceFromScratch } from "./create-workspace"

function makeDeps(over: Partial<Parameters<typeof createWorkspaceFromScratch>[1]> = {}) {
  const project = { id: "project-new", name: "My App" } as unknown as Project
  return {
    createDir: jest.fn(async () => undefined),
    initGit: jest.fn(async () => undefined),
    openAsWorkspace: jest.fn(() => project),
    ...over,
  }
}

describe("createWorkspaceFromScratch", () => {
  it("creates the directory under the parent and registers the workspace", async () => {
    const deps = makeDeps()
    const result = await createWorkspaceFromScratch(
      { parentDir: "/Users/x/Projects", name: "My App", initGit: false },
      deps
    )

    expect(deps.createDir).toHaveBeenCalledWith("/Users/x/Projects", "My App")
    expect(deps.initGit).not.toHaveBeenCalled()
    expect(deps.openAsWorkspace).toHaveBeenCalledWith("/Users/x/Projects/My App", "My App")
    expect(result).toMatchObject({ ok: true, path: "/Users/x/Projects/My App" })
  })

  it("initialises a repository when asked", async () => {
    const deps = makeDeps()
    await createWorkspaceFromScratch(
      { parentDir: "/Users/x/Projects", name: "My App", initGit: true },
      deps
    )
    expect(deps.initGit).toHaveBeenCalledWith("/Users/x/Projects/My App")
  })

  it("keeps the workspace when git init fails, and says so", async () => {
    // The directory exists and is usable; refusing here would orphan it on disk
    // with nothing in the app pointing at it.
    const cause = new Error("git missing")
    const deps = makeDeps({
      initGit: jest.fn(async () => {
        throw cause
      }),
    })
    const result = await createWorkspaceFromScratch(
      { parentDir: "/Users/x/Projects", name: "My App", initGit: true },
      deps
    )
    expect(result).toMatchObject({ ok: true, gitInitError: cause })
    expect(deps.openAsWorkspace).toHaveBeenCalled()
  })

  it("never registers a workspace when the directory could not be created", async () => {
    const deps = makeDeps({
      createDir: jest.fn(async () => {
        throw new Error("EACCES")
      }),
    })
    const result = await createWorkspaceFromScratch(
      { parentDir: "/Users/x/Projects", name: "My App", initGit: true },
      deps
    )
    expect(result).toMatchObject({ ok: false, reason: "mkdir-failed" })
    expect(deps.initGit).not.toHaveBeenCalled()
    expect(deps.openAsWorkspace).not.toHaveBeenCalled()
  })

  it("passes the typed name through, not the sanitized folder name", async () => {
    const deps = makeDeps()
    await createWorkspaceFromScratch(
      { parentDir: "/Users/x/Projects", name: "My App: v2", initGit: false },
      deps
    )
    expect(deps.createDir).toHaveBeenCalledWith("/Users/x/Projects", "My App- v2")
    expect(deps.openAsWorkspace).toHaveBeenCalledWith("/Users/x/Projects/My App- v2", "My App: v2")
  })

  it("refuses before touching the filesystem when the input cannot yield a path", async () => {
    const deps = makeDeps()
    expect(
      await createWorkspaceFromScratch({ parentDir: null, name: "App", initGit: false }, deps)
    ).toEqual({ ok: false, reason: "no-parent" })
    expect(
      await createWorkspaceFromScratch(
        { parentDir: "/Users/x/Projects", name: "  ", initGit: false },
        deps
      )
    ).toEqual({ ok: false, reason: "empty-name" })
    expect(deps.createDir).not.toHaveBeenCalled()
  })

  it("contains a traversal attempt inside the parent instead of creating it elsewhere", async () => {
    const deps = makeDeps()
    await createWorkspaceFromScratch(
      { parentDir: "/Users/x/Projects", name: "../../etc", initGit: false },
      deps
    )
    expect(deps.createDir).toHaveBeenCalledWith("/Users/x/Projects", "etc")
  })
})
