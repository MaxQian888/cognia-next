/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"

let activeSessionId: string | null = "session-1"
let session: { id: string; projectId?: string } | undefined = {
  id: "session-1",
  projectId: "project-1",
}
let projects: Array<{
  id: string
  roots: Array<{ id: string; path: string; isPrimary?: boolean }>
}> = [
  {
    id: "project-1",
    roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
  },
]
let backendAvailable = true

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (state: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId }),
}))
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => session,
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: { projects: typeof projects }) => unknown) =>
    selector({ projects }),
}))
jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => backendAvailable,
}))

import { WorkspaceRevealOpener } from "./workspace-reveal-opener"
import {
  __resetProjectEditorBridgeForTesting,
  openInProjectEditor,
} from "@/lib/files/project-editor-bridge"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

beforeEach(() => {
  __resetProjectEditorBridgeForTesting()
  activeSessionId = "session-1"
  session = { id: "session-1", projectId: "project-1" }
  projects = [
    {
      id: "project-1",
      roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
    },
  ]
  backendAvailable = true
  act(() => useArtifactDockLayoutStore.getState().resetLayout())
})

afterEach(() => __resetProjectEditorBridgeForTesting())

it("queues a workspace file reveal while the workspace dock is not mounted", () => {
  render(<WorkspaceRevealOpener />)

  expect(openInProjectEditor("/repo/src/a.ts", 3, 4)).toBe(true)
  expect(useArtifactDockLayoutStore.getState().workspaceRevealRequest).toMatchObject({
    sessionId: "session-1",
    rootPath: "/repo",
    kind: "file",
    relPath: "src/a.ts",
    line: 3,
    column: 4,
  })
  expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("workspace")
  expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
})

it("unregisters a stale root when the active workspace changes", () => {
  const { rerender, unmount } = render(<WorkspaceRevealOpener />)
  projects = [
    {
      id: "project-1",
      roots: [{ id: "root-2", path: "/other", isPrimary: true }],
    },
  ]
  rerender(<WorkspaceRevealOpener />)

  expect(openInProjectEditor("/repo/src/a.ts")).toBe(false)
  expect(openInProjectEditor("/other/src/a.ts")).toBe(true)

  unmount()
  expect(openInProjectEditor("/other/src/a.ts")).toBe(false)
})

it("does not register without a backend, session, project, or root", () => {
  backendAvailable = false
  const { rerender } = render(<WorkspaceRevealOpener />)
  expect(openInProjectEditor("/repo/src/a.ts")).toBe(false)

  backendAvailable = true
  session = undefined
  rerender(<WorkspaceRevealOpener />)
  expect(openInProjectEditor("/repo/src/a.ts")).toBe(false)

  session = { id: "session-1", projectId: "missing" }
  rerender(<WorkspaceRevealOpener />)
  expect(openInProjectEditor("/repo/src/a.ts")).toBe(false)

  session = { id: "session-1", projectId: "project-1" }
  projects = [{ id: "project-1", roots: [] }]
  rerender(<WorkspaceRevealOpener />)
  expect(openInProjectEditor("/repo/src/a.ts")).toBe(false)
})
