/** @jest-environment jsdom */
/**
 * Two behaviours matter here and both are failure modes the plugin copies of
 * this logic shared: an absent/throwing store must read as "no workspace open"
 * rather than crashing a tool call, and the root must be the ACTIVE project's
 * primary root — not the first project, and not a secondary root.
 */

const state: {
  activeProjectId: string | null
  projects: Array<{ id: string; roots?: unknown }>
} = { activeProjectId: null, projects: [] }

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => state },
}))

import { getActiveWorkspaceRoot } from "./workspace-root"

beforeEach(() => {
  state.activeProjectId = null
  state.projects = []
})

describe("getActiveWorkspaceRoot", () => {
  it("is undefined when no project is active", () => {
    state.projects = [{ id: "p1", roots: [{ path: "/tmp/a", primary: true }] }]
    expect(getActiveWorkspaceRoot()).toBeUndefined()
  })

  it("resolves the ACTIVE project's primary root, not the first project's", () => {
    state.projects = [
      { id: "p1", roots: [{ path: "/tmp/a", primary: true }] },
      { id: "p2", roots: [{ path: "/tmp/b", primary: true }] },
    ]
    state.activeProjectId = "p2"
    expect(getActiveWorkspaceRoot()).toBe("/tmp/b")
  })

  it("is undefined when the active project declares no roots", () => {
    state.projects = [{ id: "p1" }]
    state.activeProjectId = "p1"
    expect(getActiveWorkspaceRoot()).toBeUndefined()
  })

  it("reads a throwing store as 'no workspace open' rather than propagating", () => {
    state.projects = [{ id: "p1", roots: [{ path: "/tmp/a", primary: true }] }]
    state.activeProjectId = "p1"
    const spy = jest.spyOn(state.projects, "find").mockImplementation(() => {
      throw new Error("store not initialised")
    })
    expect(getActiveWorkspaceRoot()).toBeUndefined()
    spy.mockRestore()
  })
})
