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

jest.mock("@/components/context-workbench/resource-workbench-chat-panel", () => ({
  ResourceWorkbenchChatPanel: ({ pendingPrompt }: { pendingPrompt?: string | null }) => (
    <div data-testid="resource-workbench-chat">{pendingPrompt}</div>
  ),
}))
jest.mock("@/hooks/chat/use-resource-workbench-session", () => ({
  useResourceWorkbenchSession: () => ({ id: "artifact-resource-session" }),
}))
jest.mock("@/hooks/context-workbench/use-context-workbench-instance-id", () => ({
  useContextWorkbenchInstanceId: () => "test-workbench",
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => workspaceAvailable,
}))

jest.mock("./workspace-mode/dock-workspace", () => ({
  DockWorkspace: ({ activeSessionId }: { activeSessionId: string | null }) => (
    <div data-testid="workspace" data-session={activeSessionId ?? ""} />
  ),
}))

jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="browser-preview" data-session={sessionId ?? ""} />
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
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

beforeEach(() => {
  localStorage.clear()
  workspaceAvailable = true
  artifactListProps.length = 0
  act(() => {
    useArtifactDockLayoutStore.getState().resetLayout()
    useArtifactStore.setState({ activeArtifactId: null, artifacts: {} })
    useContextWorkbenchStore.setState({ layouts: {}, sessionOverrides: {} })
  })
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

  it("opens the browser mode linked to the active chat session", () => {
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    expect(screen.getByTestId("artifact-dock-mode-browser")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByTestId("browser-preview")).toHaveAttribute("data-session", "sess-1")
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument()
  })

  it("preserves explicit workspace and artifact switches after leaving browser mode", () => {
    act(() => {
      useArtifactStore.setState({
        activeArtifactId: "artifact-1",
        artifacts: {
          "artifact-1": {
            id: "artifact-1",
            sessionId: "sess-1",
            messageId: "message-1",
            type: "document",
            title: "Document",
            content: "content",
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        },
      })
      useContextWorkbenchStore
        .getState()
        .navigatePanel("test-workbench::artifact:artifact-1", "preview", "narrow")
      useArtifactDockLayoutStore.getState().openBrowser()
    })
    const { rerender } = render(<ArtifactDock />)

    fireEvent.click(screen.getByTestId("artifact-dock-mode-workspace"))
    expect(
      useContextWorkbenchStore.getState().layouts["test-workbench::artifact:artifact-1"]
        .activePanelId
    ).toBe("workspace")

    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    rerender(<ArtifactDock />)
    fireEvent.click(screen.getByTestId("artifact-dock-mode-artifact"))
    expect(
      useContextWorkbenchStore.getState().layouts["test-workbench::artifact:artifact-1"]
        .activePanelId
    ).toBe("preview")
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

  it("moves Artifact, History, and Workspace into the Context Workbench registry host", () => {
    act(() => {
      useArtifactStore.setState({
        activeArtifactId: "artifact-1",
        artifacts: {
          "artifact-1": {
            id: "artifact-1",
            sessionId: "sess-1",
            messageId: "message-1",
            type: "document",
            title: "Document",
            content: "content",
            version: 3,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        },
      })
    })

    render(<ArtifactDock />)
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.metadata.artifactTitle" }))
    expect(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" })).toBeInTheDocument()
  })

  it("routes an Artifact selection comment into its resource AI panel", () => {
    act(() => {
      useArtifactStore.setState({
        activeArtifactId: "artifact-1",
        artifacts: {
          "artifact-1": {
            id: "artifact-1",
            sessionId: "sess-1",
            messageId: "message-1",
            type: "document",
            title: "Document",
            content: "selected text",
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        },
      })
    })
    render(<ArtifactDock />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent("artifact-context-selection", {
          detail: { artifactId: "artifact-1", start: 0, end: 8 },
        })
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.resourceChat" }))
    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.aiActions" }))
    fireEvent.change(screen.getByRole("textbox", { name: "label" }), {
      target: { value: "Rewrite this selection" },
    })
    fireEvent.click(screen.getByRole("button", { name: "sendToAi" }))

    expect(screen.getByTestId("resource-workbench-chat")).toHaveTextContent(
      "Rewrite this selection"
    )
  })
})
