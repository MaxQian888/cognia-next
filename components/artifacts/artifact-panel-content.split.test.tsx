/**
 * @jest-environment jsdom
 *
 * Covers the split-view render branch deterministically by mocking the panel
 * hook (Radix Tabs activation is unreliable in jsdom, so we can't reach the
 * `split` viewMode through a click).
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/dynamic", () => () => {
  const M = () => <textarea data-testid="monaco" />
  M.displayName = "MockMonaco"
  return M
})

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre>,
}))
jest.mock("./artifact-preview", () => ({
  ArtifactPreview: () => <div data-testid="preview" />,
}))
jest.mock("./artifact-list", () => ({ ArtifactList: () => <div data-testid="list" /> }))
jest.mock("./panel-version-history", () => ({ PanelVersionHistory: () => <div /> }))
jest.mock("./panel-designer-wrapper", () => ({ ArtifactDesignerWrapper: () => <div /> }))
jest.mock("@/components/editor/light-code-editor", () => ({ LightCodeEditor: () => <textarea /> }))

// react-resizable-panels needs a measured container; stub the primitives so the
// split layout renders its children synchronously in jsdom.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    "data-testid": testId,
  }: {
    children: React.ReactNode
    "data-testid"?: string
  }) => <div data-testid={testId}>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resize-handle" />,
}))

const mockState: Record<string, unknown> = {}
jest.mock("@/hooks/artifacts/use-artifact-panel", () => ({
  useArtifactPanelState: () => mockState,
}))

import { ArtifactPanelContent } from "./artifact-panel-content"

function setState(overrides: Record<string, unknown>) {
  const t = (key: string) => key
  Object.assign(mockState, {
    t,
    tCommon: t,
    activeArtifact: {
      id: "a1",
      type: "html",
      title: "Page",
      content: "<html></html>",
      version: 1,
      language: "html",
    },
    pendingReview: null,
    theme: "light",
    viewMode: "code",
    setViewMode: jest.fn(),
    copied: false,
    designerOpen: false,
    setDesignerOpen: jest.fn(),
    editContent: "",
    hasChanges: false,
    isFullscreen: false,
    showVersionHistory: false,
    setShowVersionHistory: jest.fn(),
    isPreviewable: true,
    isDesignable: false,
    primaryActions: ["modeTabs", "close"],
    overflowActions: [],
    closePanel: jest.fn(),
    handleOpenInCanvas: jest.fn(),
    handleEditMode: jest.fn(),
    handleSaveEdit: jest.fn(),
    handleCancelEdit: jest.fn(),
    handleEditorChange: jest.fn(),
    toggleFullscreen: jest.fn(),
    handleCopy: jest.fn(),
    handleDownload: jest.fn(),
    handleOpenInNewTab: jest.fn(),
    handleRevealInExplorer: jest.fn(),
    ...overrides,
  })
}

describe("ArtifactPanelContent split view", () => {
  it("renders code + preview side-by-side when viewMode is split", () => {
    setState({ viewMode: "split" })
    render(<ArtifactPanelContent panelMode="desktop" />)
    expect(screen.getByTestId("artifact-split-view")).toBeInTheDocument()
    expect(screen.getByTestId("code")).toBeInTheDocument()
    expect(screen.getByTestId("preview")).toBeInTheDocument()
  })

  it("falls back to preview-only when split is requested on mobile", () => {
    setState({ viewMode: "split" })
    render(<ArtifactPanelContent panelMode="mobile" />)
    // canSplit is false on mobile → not the split group; previewable → preview.
    expect(screen.queryByTestId("artifact-split-view")).not.toBeInTheDocument()
    expect(screen.getByTestId("preview")).toBeInTheDocument()
  })
})
