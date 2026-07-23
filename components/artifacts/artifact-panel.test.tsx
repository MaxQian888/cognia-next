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
  it("hosts the session workbench when no artifact is active", () => {
    useArtifactStore.setState({ panelOpen: true })
    render(<ArtifactPanel />)

    // The empty state used to be a plain Sheet that could only show the
    // artifact list, leaving the browser/comments/metadata panels unreachable
    // on a phone. It is the same workbench shell as everything else now.
    expect(screen.getByTestId("context-workbench-mobile-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    expect(screen.getByTestId("list")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "browser.title" })).toBeInTheDocument()
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

  it("dismissing the Sheet closes the artifact panel", async () => {
    makeArtifact()
    render(<ArtifactPanel />)
    expect(useArtifactStore.getState().panelOpen).toBe(true)

    // The rail's collapse button is the Sheet's dismiss affordance here — a
    // Sheet has no collapsed strip to shrink into.
    fireEvent.click(
      await screen.findByRole("button", { name: "contextWorkbench.actions.collapse" })
    )

    expect(useArtifactStore.getState().panelOpen).toBe(false)
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

  it("overrides the Sheet slide to a snappier pace that honors motion-speed (not the 500/300ms default)", async () => {
    makeArtifact()
    render(<ArtifactPanel />)
    const content = await screen.findByTestId("context-workbench-mobile-sheet")
    // Overrides via animation-duration (the property that drives the slide),
    // scaled by --motion-duration-scale so motion-speed applies.
    expect(content.className).toContain(
      "data-[state=open]:[animation-duration:calc(300ms*var(--motion-duration-scale,1))]"
    )
    expect(content.className).toContain(
      "data-[state=closed]:[animation-duration:calc(200ms*var(--motion-duration-scale,1))]"
    )
    // tailwind-merge must drop the base 500ms enter so the override actually wins.
    expect(content.className).not.toContain(
      "data-[state=open]:[animation-duration:calc(500ms*var(--motion-duration-scale,1))]"
    )
  })
})
