const revealWorkspaceReview = jest.fn()
const revealWorkspaceFile = jest.fn()

let backend = true
let session: { projectId?: string; executionContext?: Record<string, unknown> } | undefined
let projects: Array<{ id: string; roots: Array<{ id: string; path: string; isPrimary?: boolean }> }>

jest.mock("@/lib/files/workspace-backend", () => ({ hasWorkspaceFsBackend: () => backend }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(async () => session) }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ projects }) },
}))
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ revealWorkspaceReview, revealWorkspaceFile }) },
}))

import {
  canOfferWorkbenchReview,
  openEditInWorkbenchReview,
  openFileInWorkbenchWorkspace,
} from "./edit-review-bridge"

beforeEach(() => {
  revealWorkspaceReview.mockClear()
  revealWorkspaceFile.mockClear()
  backend = true
  session = { projectId: "p1" }
  projects = [{ id: "p1", roots: [{ id: "r1", path: "/repo", isPrimary: true }] }]
})

describe("canOfferWorkbenchReview", () => {
  it("reflects the filesystem backend availability", () => {
    backend = true
    expect(canOfferWorkbenchReview()).toBe(true)
    backend = false
    expect(canOfferWorkbenchReview()).toBe(false)
  })
})

describe("openEditInWorkbenchReview", () => {
  it("reveals the dock review surface with the edited file selected", async () => {
    const routed = await openEditInWorkbenchReview({
      sessionId: "s1",
      absolutePath: "/repo/src/a.ts",
    })
    expect(routed).toBe(true)
    expect(revealWorkspaceReview).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/repo",
      relPath: "src/a.ts",
    })
  })

  it("no-ops without a filesystem backend", async () => {
    backend = false
    expect(await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "/repo/a.ts" })).toBe(
      false
    )
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })

  it("no-ops when the session has no project root", async () => {
    session = { projectId: undefined }
    expect(await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "/repo/a.ts" })).toBe(
      false
    )
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })

  it("no-ops when the file is outside the session root", async () => {
    expect(
      await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "/elsewhere/a.ts" })
    ).toBe(false)
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })

  it("no-ops when the session cannot be loaded", async () => {
    session = undefined
    expect(await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "/repo/a.ts" })).toBe(
      false
    )
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })
})

describe("windows roots", () => {
  // The agent reports `C:\\repo\\a.ts`; the root may be recorded with either
  // separator. Matching `${base}/` by hand put every Windows path outside its
  // own root, and the caller's only signal is a silent `false`.
  it("locates a backslash path inside a backslash root", async () => {
    projects = [{ id: "p1", roots: [{ id: "r1", path: "C:\\repo", isPrimary: true }] }]
    expect(
      await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "C:\\repo\\src\\a.ts" })
    ).toBe(true)
    expect(revealWorkspaceReview).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "C:\\repo",
      relPath: "src/a.ts",
    })
  })

  it("matches across mixed separators, case and a trailing slash", async () => {
    projects = [{ id: "p1", roots: [{ id: "r1", path: "C:/Repo/", isPrimary: true }] }]
    expect(
      await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "c:\\repo\\src\\a.ts" })
    ).toBe(true)
    expect(revealWorkspaceReview).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "C:/Repo/",
      relPath: "src/a.ts",
    })
  })

  it("still refuses a sibling directory that merely shares a prefix", async () => {
    projects = [{ id: "p1", roots: [{ id: "r1", path: "C:\\repo", isPrimary: true }] }]
    expect(
      await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "C:\\repo-other\\a.ts" })
    ).toBe(false)
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })
})

describe("a conversation running in a managed worktree", () => {
  const worktreeContext = {
    location: "managedWorktree",
    projectRoot: "/repo",
    workspaceBinding: { kind: "managed", workspaceId: "ws-1" },
    managedWorkspace: { availability: "available", localRoot: "/repo/.wt/feature" },
  }

  it("reveals the edit in the tree the agent actually wrote to", async () => {
    // The regression this pins: the containment check below compares the
    // agent's absolute path against the resolved root. Resolving the WORKSPACE
    // root for a worktree-bound conversation made every agent edit fall out of
    // it — and the failure mode is a bare `false`, so the button did nothing
    // at all: no error, no panel, no clue.
    session = { projectId: "p1", executionContext: worktreeContext }
    const routed = await openEditInWorkbenchReview({
      sessionId: "s1",
      absolutePath: "/repo/.wt/feature/src/a.ts",
    })
    expect(routed).toBe(true)
    expect(revealWorkspaceReview).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/repo/.wt/feature",
      relPath: "src/a.ts",
    })
  })

  it("still refuses a path outside the tree it is bound to", async () => {
    // Following the execution root must not widen containment: the source
    // repository is now OUTSIDE this conversation's root, and revealing it
    // would put the user in a checkout the agent never touched.
    session = { projectId: "p1", executionContext: worktreeContext }
    expect(
      await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "/repo/src/a.ts" })
    ).toBe(false)
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })

  it("falls back to the workspace root before the worktree materializes", async () => {
    session = {
      projectId: "p1",
      executionContext: {
        ...worktreeContext,
        managedWorkspace: { availability: "missing-on-device" },
      },
    }
    expect(
      await openEditInWorkbenchReview({ sessionId: "s1", absolutePath: "/repo/src/a.ts" })
    ).toBe(true)
    expect(revealWorkspaceReview).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/repo",
      relPath: "src/a.ts",
    })
  })
})

describe("openFileInWorkbenchWorkspace", () => {
  it("reveals the named file in the dock's editor, carrying the caret", async () => {
    const routed = await openFileInWorkbenchWorkspace({
      sessionId: "s1",
      path: "/repo/src/a.ts",
      line: 42,
      column: 7,
    })
    expect(routed).toBe(true)
    expect(revealWorkspaceFile).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/repo",
      relPath: "src/a.ts",
      line: 42,
      column: 7,
    })
    // A read is not a change, so it must never open the diff surface.
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })

  it("refuses under exactly the conditions the review twin refuses under", async () => {
    backend = false
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "/repo/a.ts" })).toBe(false)

    backend = true
    session = undefined
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "/repo/a.ts" })).toBe(false)

    session = { projectId: "p1" }
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "/elsewhere/a.ts" })).toBe(
      false
    )

    expect(revealWorkspaceFile).not.toHaveBeenCalled()
  })

  it("follows the worktree a conversation is bound to", async () => {
    session = {
      projectId: "p1",
      executionContext: {
        location: "managedWorktree",
        projectRoot: "/repo",
        workspaceBinding: { kind: "managed", workspaceId: "ws-1" },
        managedWorkspace: { availability: "available", localRoot: "/repo/.wt/feature" },
      },
    }
    expect(
      await openFileInWorkbenchWorkspace({
        sessionId: "s1",
        path: "/repo/.wt/feature/src/a.ts",
      })
    ).toBe(true)
    expect(revealWorkspaceFile).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/repo/.wt/feature",
      relPath: "src/a.ts",
      line: undefined,
      column: undefined,
    })
  })
})

describe("relative paths reported by Read / Glob / Grep", () => {
  // Built-in `Read` accepts a relative `file_path`, and `Glob`/`Grep` report
  // paths relative to the session's working directory. Refusing them made the
  // majority of tool-card paths inert while the execution root — the very thing
  // they are relative to — was already resolved right here.
  it("resolves a relative path against the conversation's execution root", async () => {
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "src/a.ts", line: 9 })).toBe(
      true
    )
    expect(revealWorkspaceFile).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/repo",
      relPath: "src/a.ts",
      line: 9,
      column: undefined,
    })
  })

  it("resolves a `./`-prefixed path to the same file", async () => {
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "./src/a.ts" })).toBe(true)
    expect(revealWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo", relPath: "src/a.ts" })
    )
  })

  it("resolves against the worktree a conversation is bound to, not the workspace", async () => {
    session = {
      projectId: "p1",
      executionContext: {
        location: "managedWorktree",
        projectRoot: "/repo",
        workspaceBinding: { kind: "managed", workspaceId: "ws-1" },
        managedWorkspace: { availability: "available", localRoot: "/repo/.wt/feature" },
      },
    }
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "src/a.ts" })).toBe(true)
    expect(revealWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo/.wt/feature", relPath: "src/a.ts" })
    )
  })

  it("still refuses a relative path that climbs out of the root", async () => {
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "../elsewhere/a.ts" })).toBe(
      false
    )
    expect(revealWorkspaceFile).not.toHaveBeenCalled()
  })

  it("refuses the root itself, which names no file", async () => {
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "." })).toBe(false)
    expect(revealWorkspaceFile).not.toHaveBeenCalled()
  })

  it("joins a relative path onto a Windows root with the root's own separator", async () => {
    projects = [{ id: "p1", roots: [{ id: "r1", path: "C:\\repo", isPrimary: true }] }]
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "src\\a.ts" })).toBe(true)
    expect(revealWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "C:\\repo", relPath: "src/a.ts" })
    )
  })

  it("keeps refusing an absolute path outside the root", async () => {
    expect(await openFileInWorkbenchWorkspace({ sessionId: "s1", path: "/elsewhere/a.ts" })).toBe(
      false
    )
    expect(revealWorkspaceFile).not.toHaveBeenCalled()
  })
})
