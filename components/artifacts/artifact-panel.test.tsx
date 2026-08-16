/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent } from "@testing-library/react"

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
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"

beforeEach(() => {
  localStorage.clear()
  mobileViewportRef.current = false
  // Tabs and the active artifact are bucketed per conversation, so the panel
  // only resolves one once a conversation is on screen.
  useChatStore.setState({ activeSessionId: "s" })
  useArtifactDockLayoutStore.getState().resetLayout()
  useArtifactDockLayoutStore.setState({ mobileSheetOpen: true })
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactIdBySession: {},
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
    render(<ArtifactPanel />)

    // The empty state used to be a plain Sheet that could only show the
    // artifact list, leaving the browser/comments/metadata panels unreachable
    // on a phone. It is the same workbench shell as everything else now.
    expect(screen.getByTestId("context-workbench-mobile-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    expect(screen.getByTestId("list")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "browser.title" })).toBeInTheDocument()
  })

  it("takes its visibility from mobileSheetOpen, not from panelOpen", () => {
    makeArtifact()
    const { rerender } = render(<ArtifactPanel />)
    expect(screen.getByTestId("context-workbench-mobile-sheet")).toHaveAttribute(
      "data-state",
      "open"
    )

    // `panelOpen` is an engagement flag for the panel's keyboard shortcuts, not
    // a visibility flag. It used to gate this Sheet, and because `createArtifact`
    // and `setActiveArtifact` raise it unconditionally, every new artifact threw
    // a 92dvh modal over the conversation — `userDismissed` never got a say.
    useArtifactStore.setState({ panelOpen: false })
    rerender(<ArtifactPanel />)
    expect(screen.getByTestId("context-workbench-mobile-sheet")).toHaveAttribute(
      "data-state",
      "open"
    )

    useArtifactDockLayoutStore.setState({ mobileSheetOpen: false })
    rerender(<ArtifactPanel />)
    // vaul owns its own exit animation and then drops the surface, so "closed"
    // is an absence rather than a `data-state` on a still-mounted node.
    expect(screen.queryByTestId("context-workbench-mobile-sheet")).not.toBeInTheDocument()
  })

  it("records a dismissal when the Sheet is swiped away", () => {
    makeArtifact()
    render(<ArtifactPanel />)

    act(() => {
      useArtifactDockLayoutStore.getState().setDockCollapsed(true)
    })

    // The dismissal has to reach `userDismissed`, or the next artifact re-throws
    // the Sheet over the conversation the user just cleared.
    expect(useArtifactDockLayoutStore.getState().userDismissed).toBe(true)
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false)
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

  it("dismissing the drawer closes the artifact panel", async () => {
    makeArtifact()
    render(<ArtifactPanel />)
    expect(useArtifactStore.getState().panelOpen).toBe(true)

    // The rail's trailing button is the drawer's dismiss affordance here — a
    // drawer has no collapsed strip to shrink into, which is why it reads
    // "Close" rather than "Collapse" on this placement.
    fireEvent.click(await screen.findByRole("button", { name: "contextWorkbench.actions.close" }))

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

  it("overrides the drawer slide to a snappier pace that honors motion-speed (not vaul's 500ms default)", async () => {
    makeArtifact()
    render(<ArtifactPanel />)
    const content = await screen.findByTestId("context-workbench-mobile-sheet")
    // vaul drives the slide with a *transition* on `[data-vaul-drawer]`, not the
    // Radix keyframes the Sheet used, and hardcodes it at .5s. Same contract as
    // before — the pace is scaled by --motion-duration-scale so the appearance
    // setting applies — expressed on the property vaul actually animates.
    expect(content.className).toContain(
      "[transition-duration:calc(300ms*var(--motion-duration-scale,1))]!"
    )
  })
})
