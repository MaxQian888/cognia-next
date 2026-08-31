/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

jest.mock("@/lib/db/projects", () => ({
  getAllProjects: jest.fn(async () => []),
  loadActiveProjectId: jest.fn(async () => null),
  putProject: jest.fn(async () => undefined),
  deleteProjectRow: jest.fn(async () => undefined),
  persistActiveProjectId: jest.fn(async () => undefined),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchProjectSwitch: jest.fn() }),
}))

import { useNewChatExecution } from "./use-new-chat-execution"
import { useProjectStore } from "@/stores/project/project-store"

function seed(projects: unknown[], activeProjectId: string | null) {
  act(() => {
    useProjectStore.setState({ projects: projects as never, activeProjectId, loaded: true })
  })
}

beforeEach(() => seed([], null))

describe("useNewChatExecution", () => {
  it("falls back to an isolated worktree when the workspace states no preference", () => {
    seed([{ id: "p1", name: "A", roots: [{ id: "r", path: "/repo", isPrimary: true }] }], "p1")
    const { result } = renderHook(() => useNewChatExecution())

    expect(result.current.value).toEqual({
      location: "managedWorktree",
      base: { kind: "workingState" },
    })
    expect(result.current.rootDir).toBe("/repo")
  })

  it("honours the workspace's own default", () => {
    seed(
      [
        {
          id: "p1",
          name: "A",
          roots: [{ id: "r", path: "/repo", isPrimary: true }],
          defaultExecutionLocation: "local",
        },
      ],
      "p1"
    )
    const { result } = renderHook(() => useNewChatExecution())

    expect(result.current.value.location).toBe("local")
  })

  it("keeps an override scoped to the workspace it was made in", () => {
    // Carrying a choice about one repository into another is how a conversation
    // ends up running somewhere the user never picked.
    seed(
      [
        { id: "p1", name: "A", roots: [{ id: "r1", path: "/a", isPrimary: true }] },
        { id: "p2", name: "B", roots: [{ id: "r2", path: "/b", isPrimary: true }] },
      ],
      "p1"
    )
    const { result, rerender } = renderHook(() => useNewChatExecution())

    act(() => result.current.setValue({ location: "local", base: { kind: "localHead" } }))
    rerender()
    expect(result.current.value.location).toBe("local")

    seed(
      [
        { id: "p1", name: "A", roots: [{ id: "r1", path: "/a", isPrimary: true }] },
        { id: "p2", name: "B", roots: [{ id: "r2", path: "/b", isPrimary: true }] },
      ],
      "p2"
    )
    rerender()
    expect(result.current.value.location).toBe("managedWorktree")
    expect(result.current.rootDir).toBe("/b")
  })

  it("reports no root for a rootless workspace, so callers can skip the choice", () => {
    // "Local" means nothing without a directory: the session falls back to a
    // managed workspace regardless, so offering the choice would be a lie.
    seed([{ id: "p1", name: "Default", roots: [] }], "p1")
    const { result } = renderHook(() => useNewChatExecution())

    expect(result.current.rootDir).toBeUndefined()
  })

  it("ignores a write with no active workspace rather than stranding it", () => {
    const { result, rerender } = renderHook(() => useNewChatExecution())

    act(() => result.current.setValue({ location: "local", base: { kind: "localHead" } }))
    rerender()

    expect(result.current.value.location).toBe("managedWorktree")
  })
})
