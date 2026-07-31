/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"
import { useResourceWorkbenchSession } from "./use-resource-workbench-session"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

const get = jest.fn()
const put = jest.fn().mockResolvedValue(undefined)
const update = jest.fn().mockResolvedValue(1)
const toArray = jest.fn().mockResolvedValue([])
/** Resolves the indexed `surfaceBindingKey` lookup the hook uses since v131. */
const first = jest.fn().mockResolvedValue(undefined)
const equals = jest.fn(() => ({ first }))
const where = jest.fn(() => ({ equals }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessions: { get, put, update, toArray, where } }),
}))
jest.mock("@/lib/db/project-scope", () => ({
  resolveScopeProjectId: jest.fn(async () => "proj-active"),
}))

beforeEach(() => {
  get.mockReset().mockResolvedValue(undefined)
  put.mockClear()
  update.mockClear()
  toArray.mockClear().mockResolvedValue([])
  first.mockClear().mockResolvedValue(undefined)
  equals.mockClear()
  where.mockClear()
  useContextWorkbenchStore.setState({ sessionOverrides: {} })
})

it("finds an existing aside through the surfaceBindingKey index, not a table scan", async () => {
  // The pre-v131 lookup was `db.sessions.toArray()` + a JSON compare per row —
  // a full scan of every session in the profile on every workbench open.
  first.mockResolvedValue({
    id: "resource-workbench:session:main-1",
    title: "aside",
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: { kind: "session", sessionId: "main-1" },
    surfaceBindingKey: "session:main-1",
    projectId: "proj-A",
    createdAt: 1,
    updatedAt: 1,
  })
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", capabilities: ["ai"], sessionId: "main-1" },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.id).toBe("resource-workbench:session:main-1"))
  expect(where).toHaveBeenCalledWith("surfaceBindingKey")
  expect(equals).toHaveBeenCalledWith("session:main-1")
  expect(toArray).not.toHaveBeenCalled()
})

it("stamps a new aside with the MAIN conversation's workspace, not the active one", async () => {
  // A row written without a projectId is absent from `[projectId+updatedAt]`
  // entirely — invisible to the sidebar and outside `deleteProjectCascade`.
  get.mockImplementation(async (id: string) =>
    id === "main-1" ? { id, title: "main", projectId: "proj-parent" } : undefined
  )
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", capabilities: ["ai"], sessionId: "main-1" },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.projectId).toBe("proj-parent"))
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "proj-parent", surfaceBindingKey: "session:main-1" })
  )
})

it("switches to a manually reassociated embedded session and migrates its binding", async () => {
  get.mockImplementation(async (id: string) =>
    id === "old-session"
      ? {
          id,
          title: "Old resource",
          kind: "resource-workbench",
          visibility: "embedded",
          createdAt: 1,
          updatedAt: 1,
          surfaceBinding: {
            kind: "project-file",
            projectId: "p",
            rootId: "r",
            relPath: "old.ts",
          },
        }
      : undefined
  )
  useContextWorkbenchStore.getState().setSessionOverride("project:p:r:new.ts", "old-session")
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "project-file",
        capabilities: ["ai"],
        projectId: "p",
        rootId: "r",
        relPath: "new.ts",
        contentHash: "hash",
        draftVersion: 1,
      },
      true,
      "window-a"
    )
  )
  await waitFor(() => expect(result.current?.id).toBe("old-session"))
  expect(update).toHaveBeenCalledWith(
    "old-session",
    expect.objectContaining({
      surfaceBinding: { kind: "project-file", projectId: "p", rootId: "r", relPath: "new.ts" },
    })
  )
})

it("ensures an embedded session for a project resource without changing global focus", async () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "project-file",
        capabilities: ["ai"],
        projectId: "p",
        rootId: "r",
        relPath: "a.ts",
        contentHash: "hash",
        draftVersion: 1,
      },
      true,
      "window-a"
    )
  )

  await waitFor(() => expect(result.current?.visibility).toBe("embedded"))
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "resource-workbench",
      surfaceBinding: { kind: "project-file", projectId: "p", rootId: "r", relPath: "a.ts" },
    })
  )
})

it("keeps the same resource session when only the draft revision changes", async () => {
  const { result, rerender } = renderHook(
    ({ draftVersion }) =>
      useResourceWorkbenchSession(
        {
          kind: "project-file",
          capabilities: ["ai"],
          projectId: "p",
          rootId: "r",
          relPath: "a.ts",
          contentHash: `hash-${draftVersion}`,
          draftVersion,
        },
        true,
        "window-a"
      ),
    { initialProps: { draftVersion: 1 } }
  )

  await waitFor(() => expect(result.current?.visibility).toBe("embedded"))
  expect(get).toHaveBeenCalledTimes(1)

  rerender({ draftVersion: 2 })

  expect(result.current?.visibility).toBe("embedded")
  expect(get).toHaveBeenCalledTimes(1)
})

it("leaves workflow session ownership to the workflow editor", () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "workflow",
        capabilities: ["ai"],
        workflowId: "w",
        editorRevision: "1",
      },
      true,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  expect(get).not.toHaveBeenCalled()
})

it("gives a conversation its own sidechat session", () => {
  renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "session",
        sessionId: "s",
        capabilities: ["inspect"],
      },
      true,
      "window-a"
    )
  )

  // A conversation CAN own an aside — that is the workbench sidechat.
  expect(get).toHaveBeenCalledWith("resource-workbench:session:s")
})

it("never nests an aside under an aside", () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "session",
        // A workbench session's own id. Binding to it would nest without limit,
        // and no surface renders the second level.
        sessionId: "resource-workbench:session:s",
        capabilities: ["inspect"],
      },
      true,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  expect(get).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
})

it("creates no aside while the dock has no conversation open", () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      { kind: "session", sessionId: "none", capabilities: ["inspect"] },
      true,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  expect(get).not.toHaveBeenCalled()
})

it("does not create a session before an AI panel is activated", () => {
  const { result } = renderHook(() =>
    useResourceWorkbenchSession(
      {
        kind: "artifact",
        artifactId: "a",
        version: "1",
        capabilities: ["ai"],
      },
      false,
      "window-a"
    )
  )

  expect(result.current).toBeNull()
  expect(get).not.toHaveBeenCalled()
})
