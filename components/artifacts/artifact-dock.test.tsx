/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

let workspaceAvailable = true

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./artifact-panel-content", () => ({
  ArtifactPanelContent: ({ panelMode }: { panelMode: string }) => (
    <div data-testid="panel-content" data-mode={panelMode} />
  ),
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => workspaceAvailable,
}))

jest.mock("./workspace-mode/dock-workspace", () => ({
  DockWorkspace: ({ activeSessionId }: { activeSessionId: string | null }) => (
    <div data-testid="workspace" data-session={activeSessionId ?? ""} />
  ),
}))

const artifactListProps: Array<{ sessionId?: string }> = []
jest.mock("./artifact-list", () => ({
  ArtifactList: (props: { sessionId?: string }) => {
    artifactListProps.push(props)
    return <div data-testid="list" data-session={props.sessionId ?? ""} />
  },
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId: "sess-1" }),
}))

import { ArtifactDock } from "./artifact-dock"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

beforeEach(() => {
  localStorage.clear()
  workspaceAvailable = true
  artifactListProps.length = 0
  act(() => useArtifactDockLayoutStore.getState().resetLayout())
})

describe("ArtifactDock", () => {
  it("renders the shared content in desktop mode", () => {
    render(<ArtifactDock />)
    expect(screen.getByTestId("panel-content")).toHaveAttribute("data-mode", "desktop")
  })

  it("switches between artifact and workspace modes", () => {
    render(<ArtifactDock />)
    expect(screen.getByTestId("artifact-dock-mode-artifact")).toHaveAttribute(
      "aria-selected",
      "true"
    )

    fireEvent.click(screen.getByTestId("artifact-dock-mode-workspace"))

    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("workspace")
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-dock-history-toggle")).not.toBeInTheDocument()
  })

  it("disables workspace without a backend but preserves a persisted workspace selection", () => {
    workspaceAvailable = false
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))

    render(<ArtifactDock />)

    expect(screen.getByTestId("artifact-dock-mode-workspace")).toBeDisabled()
    expect(screen.getByTestId("artifact-dock-mode-workspace")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByTestId("workspace")).toBeInTheDocument()
  })

  it("hides the history rail by default and shows it when toggled", () => {
    render(<ArtifactDock />)
    expect(screen.queryByTestId("artifact-dock-history-rail")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("artifact-dock-history-toggle"))
    expect(screen.getByTestId("artifact-dock-history-rail")).toBeInTheDocument()
    expect(useArtifactDockLayoutStore.getState().listRailOpen).toBe(true)
  })

  it("scopes the history rail to the active chat session", () => {
    act(() => useArtifactDockLayoutStore.getState().setListRailOpen(true))
    render(<ArtifactDock />)
    expect(screen.getByTestId("list")).toHaveAttribute("data-session", "sess-1")
  })

  it("collapses the dock via the collapse button", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)
    fireEvent.click(screen.getByTestId("artifact-dock-collapse"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })
})
