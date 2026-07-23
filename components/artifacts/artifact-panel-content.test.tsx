/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: jest.fn(),
  openPath: jest.fn(),
}))

jest.mock("next/dynamic", () => () => {
  const MockMonaco = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="monaco" value={value} onChange={(e) => onChange(e.target.value)} />
  )
  MockMonaco.displayName = "MockMonacoEditor"
  return MockMonaco
})

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre>,
}))

jest.mock("./artifact-preview", () => ({
  ArtifactPreview: () => <div data-testid="preview" />,
}))

jest.mock("./artifact-list", () => ({
  ArtifactList: () => <div data-testid="list" />,
}))

jest.mock("./panel-version-history", () => ({
  PanelVersionHistory: () => <div data-testid="history" />,
}))

jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="light-code-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

import { ArtifactPanelContent } from "./artifact-panel-content"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactId: null,
    artifactVersions: {},
    artifactWorkspace: {
      scope: "session",
      sessionId: null,
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
      recentArtifactIds: [],
      returnContext: null,
    },
    canvasDocuments: {},
    activeCanvasId: null,
    canvasOpen: false,
    analysisResults: {},
    panelOpen: true,
    panelView: "artifact",
  })
})

function makeArtifact(type: "code" | "html" = "code") {
  return useArtifactStore.getState().createArtifact({
    sessionId: "s",
    messageId: "m",
    type,
    title: type === "html" ? "MyPage" : "MyCode",
    content: type === "html" ? "<html></html>" : "console.log(1)",
    language: type === "html" ? "html" : "javascript",
  })
}

describe("ArtifactPanelContent", () => {
  it("renders the empty list state when no artifact is active", () => {
    render(<ArtifactPanelContent panelMode="desktop" />)
    expect(screen.getByText("recentArtifacts")).toBeInTheDocument()
    expect(screen.getByTestId("list")).toBeInTheDocument()
  })

  it("renders the active artifact identity and code", () => {
    makeArtifact()
    render(<ArtifactPanelContent panelMode="desktop" />)
    expect(screen.getByText("MyCode")).toBeInTheDocument()
    expect(screen.getByTestId("code")).toBeInTheDocument()
  })

  it("offers a split tab for previewable types on desktop", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="desktop" />)
    expect(screen.getByTestId("artifact-tab-split")).toBeInTheDocument()
  })

  it("does NOT offer a split tab on mobile", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="mobile" />)
    expect(screen.queryByTestId("artifact-tab-split")).not.toBeInTheDocument()
  })

  it("renders the overflow trigger on desktop", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="desktop" />)
    // (Radix dropdown/tab activation is unreliable in jsdom — the split-view
    // render branch and overflow actions are covered in the mocked-hook test
    // and the use-artifact-panel hook tests.)
    expect(screen.getByTestId("artifact-overflow-trigger")).toBeInTheDocument()
  })

  it("mobile edit mode uses the light editor", () => {
    makeArtifact()
    render(<ArtifactPanelContent panelMode="mobile" />)
    // Mobile has no header actions row; the footer carries the edit action.
    fireEvent.click(screen.getByTestId("action-edit"))
    expect(screen.getByTestId("light-code-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
  })
})
