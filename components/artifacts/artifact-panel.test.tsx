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

jest.mock("./panel-designer-wrapper", () => ({
  ArtifactDesignerWrapper: () => <div data-testid="designer" />,
}))

// Viewport control: drive panelMode (desktop/mobile) through useMediaQuery.
const mobileViewportRef = { current: false }
jest.mock("@/hooks/ui", () => {
  const actual = jest.requireActual("@/hooks/ui")
  return {
    ...actual,
    useMediaQuery: (query: string) =>
      query.includes("max-width: 639px") ? mobileViewportRef.current : false,
  }
})

// CM6 needs DOM-measure shims in jsdom — stub the light editor with the same
// value/onChange contract.
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="light-code-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

import { ArtifactPanel } from "./artifact-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

beforeEach(() => {
  localStorage.clear()
  mobileViewportRef.current = false
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

describe("ArtifactPanel", () => {
  it("renders the recent-artifacts list when no artifact is active", () => {
    useArtifactStore.setState({ panelOpen: true })
    render(<ArtifactPanel />)
    expect(screen.getByText("recentArtifacts")).toBeInTheDocument()
  })

  it("renders the active artifact's identity row", () => {
    makeArtifact()
    render(<ArtifactPanel />)
    expect(screen.getByText("MyCode")).toBeInTheDocument()
  })

  it("clicking the edit action mounts the Monaco editor", () => {
    makeArtifact()
    render(<ArtifactPanel />)
    fireEvent.click(screen.getByTestId("action-edit"))
    expect(screen.getByTestId("monaco")).toBeInTheDocument()
  })

  it("mobile edit mode uses the light editor (no Monaco, no LSP workbench)", () => {
    mobileViewportRef.current = true
    makeArtifact()
    render(<ArtifactPanel />)
    fireEvent.click(screen.getByTestId("action-edit"))
    expect(screen.getByTestId("light-code-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
    // Edits flow through the same editContent path the Save action persists.
    fireEvent.change(screen.getByTestId("light-code-editor"), {
      target: { value: "console.log(2)" },
    })
    expect((screen.getByTestId("light-code-editor") as HTMLTextAreaElement).value).toBe(
      "console.log(2)"
    )
  })

  it("renders the preview tab for previewable types", () => {
    makeArtifact("html")
    render(<ArtifactPanel />)
    // For HTML artifacts both tabs are present; pointer-driven tab activation
    // is unreliable in jsdom, so we just verify the tab triggers exist.
    expect(screen.getByTestId("artifact-tab-code")).toBeInTheDocument()
    expect(screen.getByTestId("artifact-tab-preview")).toBeInTheDocument()
  })

  it("clicking the close action closes the panel", async () => {
    makeArtifact()
    render(<ArtifactPanel />)
    // Sheet portal renders close-buttons asynchronously into document.body;
    // pick the first matching button.
    const buttons = await screen.findAllByTestId("artifact-close")
    fireEvent.click(buttons[0])
    expect(useArtifactStore.getState().panelOpen).toBe(false)
  })
})
