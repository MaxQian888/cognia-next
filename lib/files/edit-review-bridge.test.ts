const revealWorkspaceReview = jest.fn()

let backend = true
let session: { projectId?: string; executionContext?: Record<string, unknown> } | undefined
let projects: Array<{ id: string; roots: Array<{ id: string; path: string; isPrimary?: boolean }> }>

jest.mock("@/lib/files/workspace-backend", () => ({ hasWorkspaceFsBackend: () => backend }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(async () => session) }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ projects }) },
}))
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ revealWorkspaceReview }) },
}))

import { canOfferWorkbenchReview, openEditInWorkbenchReview } from "./edit-review-bridge"

beforeEach(() => {
  revealWorkspaceReview.mockClear()
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
