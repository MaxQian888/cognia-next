/** @jest-environment jsdom */

// How the editor workbench sizes itself inside the chat's right dock: the
// one sidebar — the file context workbench, whose rail also carries the
// explorer and search — as a panel of the editor's resizable group (bounded by
// the dock, folding to its rail, answering narrow/wide hints), and a width that
// stays put while files open, switch and close.
//
// jsdom has no layout, so the resizable group is replaced by a fake that keeps
// each panel's size in pixels against a fixed group width, applies the
// imperative handle the way the library does, and reports sizes through
// `onResize` — the channel the workbench reads them from. The main suite keeps
// the real library, which is what catches registration-order mistakes.

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode, Ref } from "react"

const mockTranslate = (key: string) => key
jest.mock("next-intl", () => ({ useTranslations: () => mockTranslate }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@/lib/files/project-editor-bridge", () => ({
  registerProjectEditorOpener: () => () => {},
  notifyActiveEditorChanged: () => {},
}))
jest.mock("@/stores/canvas/keybinding-store", () => ({
  useKeybindingStore: (selector: (state: { bindings: Record<string, string> }) => unknown) =>
    selector({ bindings: {} }),
}))
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"

const mockEditor = {
  scopeKey: "session:dock",
  deps: { readFile: jest.fn().mockResolvedValue(""), listDir: jest.fn().mockResolvedValue([]) },
  roots: [{ key: "/repo", label: "main", path: "/repo", isMain: true }],
  rootKey: "/repo",
  rootPath: "/repo",
  rootsReady: true,
  sessionRestored: true,
  openFiles: [{ relPath: "src/a.ts" }] as Array<Record<string, unknown>>,
  activePath: "src/a.ts" as string | null,
  activeFile: {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    savedContent: "old",
    draftContent: "old",
    draftVersion: 1,
  } as Record<string, unknown> | null,
  previewPath: null as string | null,
  dirtyCount: 0,
  treeRefreshToken: 0,
  selectRoot: jest.fn(),
  openFile: jest.fn().mockResolvedValue(undefined),
  isPathOpen: jest.fn(() => true),
  pinFile: jest.fn(),
  closeFile: jest.fn(),
  closeFiles: jest.fn(),
  moveOpenFile: jest.fn(),
  closeAllFiles: jest.fn(),
  reopenClosedFile: jest.fn(),
  setActivePath: jest.fn(),
  setDraft: jest.fn(),
  saveFile: jest.fn().mockResolvedValue(undefined),
  saveAll: jest.fn().mockResolvedValue(undefined),
  reloadFile: jest.fn().mockResolvedValue(undefined),
  renameOpenFile: jest.fn().mockResolvedValue(undefined),
  reconcileDeleted: jest.fn(),
  confirmDiscardDraft: jest.fn(() => "confirm"),
}
jest.mock("./use-project-editor", () => ({ useProjectEditor: () => mockEditor }))
jest.mock("./project-editor-tabs", () => ({
  EDITOR_TAB_DRAG_MIME: "application/x-cognia-editor-tab",
  ProjectEditorTabs: () => <div data-testid="tabs" />,
}))
jest.mock("./project-file-tree", () => ({ ProjectFileTree: () => <div data-testid="tree" /> }))
jest.mock("./project-search-panel", () => ({ ProjectSearchPanel: () => null }))
jest.mock("./use-project-git-status", () => ({
  useProjectGitStatus: () => ({ branch: null, byPath: new Map() }),
}))
jest.mock("./project-quick-open", () => ({ ProjectQuickOpen: () => null }))
jest.mock("./project-editor-breadcrumbs", () => ({ ProjectEditorBreadcrumbs: () => null }))
jest.mock("./project-editor-status-bar", () => ({ ProjectEditorStatusBar: () => null }))
jest.mock("./project-monaco", () => ({ ProjectMonaco: () => <div data-testid="monaco" /> }))
jest.mock("./project-file-preview-panel", () => ({ ProjectFilePreviewPanel: () => null }))
jest.mock("@/lib/canvas/monaco-loader", () => ({
  loadConfiguredMonaco: jest.fn(() => Promise.resolve(null)),
}))
jest.mock("@/components/editor/light-code-editor", () => ({ LightCodeEditor: () => null }))
jest.mock("@/components/source-control/diff-viewer", () => ({ DiffViewer: () => null }))

interface ContextWorkbenchProps {
  file: { relPath: string } | null
  projectViews: { files: () => ReactNode; search: () => ReactNode }
  railOnly: boolean
  onCollapse: () => void
  onEnsureVisible: () => void
  onModeWidthHint: (mode: "narrow" | "wide" | "focus", panelId?: string) => void
  resolvedMode?: "narrow" | "wide"
}
const mockContextWorkbenchProps = jest.fn()
jest.mock("./project-context-workbench", () => ({
  ProjectContextWorkbench: (props: ContextWorkbenchProps) => {
    mockContextWorkbenchProps(props)
    // The explorer is the sidebar's default panel.
    return (
      <div data-testid="project-context-workbench">
        {props.railOnly ? null : props.projectViews.files()}
      </div>
    )
  },
  ProjectContextWorkbenchMobile: () => null,
  PROJECT_FILES_PANEL_ID: "files",
  PROJECT_SEARCH_PANEL_ID: "search",
}))

// --- Fake resizable group -------------------------------------------------

interface MockPanel {
  props: Record<string, unknown>
  px: number
  calls: string[]
}
const mockPanels = new Map<string, MockPanel>()
let mockGroupWidth = 600

function mockToPx(size: unknown): number {
  if (typeof size === "number") return size
  const text = String(size)
  if (text.endsWith("%")) return (parseFloat(text) / 100) * mockGroupWidth
  return parseFloat(text)
}

jest.mock("@/components/ui/resizable", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const report = (panel: MockPanel) => {
    const onResize = panel.props.onResize as
      ((size: { inPixels: number; asPercentage: number }) => void) | undefined
    onResize?.({ inPixels: panel.px, asPercentage: (panel.px / mockGroupWidth) * 100 })
  }
  const setPx = (panel: MockPanel, px: number) => {
    const min = panel.props.minSize === undefined ? 0 : mockToPx(panel.props.minSize)
    const max = panel.props.maxSize === undefined ? mockGroupWidth : mockToPx(panel.props.maxSize)
    const collapsed = mockToPx(panel.props.collapsedSize ?? 0)
    panel.px = panel.props.collapsible && px < min ? collapsed : Math.min(Math.max(px, min), max)
    report(panel)
  }
  function ResizablePanel(props: Record<string, unknown> & { children?: ReactNode }) {
    const id = props.id as string
    let panel = mockPanels.get(id)
    if (!panel) {
      panel = { props, px: mockToPx(props.defaultSize ?? 0), calls: [] }
      mockPanels.set(id, panel)
    }
    panel.props = props
    const current = panel
    React.useLayoutEffect(() => {
      const ref = props.panelRef as { current: unknown } | undefined
      if (!ref) return
      ref.current = {
        collapse: () => {
          current.calls.push("collapse")
          if (!current.props.collapsible) return
          current.px = mockToPx(current.props.collapsedSize ?? 0)
          report(current)
        },
        expand: () => {
          current.calls.push("expand")
          setPx(current, mockToPx(current.props.minSize ?? 0))
        },
        resize: (size: string | number) => {
          current.calls.push(`resize:${size}`)
          setPx(current, mockToPx(size))
        },
        isCollapsed: () =>
          Boolean(current.props.collapsible) &&
          current.px <= mockToPx(current.props.collapsedSize ?? 0),
        getSize: () => ({
          inPixels: current.px,
          asPercentage: (current.px / mockGroupWidth) * 100,
        }),
      }
    })
    React.useEffect(() => () => void mockPanels.delete(id), [id])
    return (
      <div data-testid={`panel-${id}`} data-px={current.px}>
        {props.children}
      </div>
    )
  }
  return {
    ResizablePanelGroup: ({
      children,
      elementRef,
    }: {
      children?: ReactNode
      elementRef?: Ref<HTMLDivElement>
    }) => <div ref={elementRef}>{children}</div>,
    ResizablePanel,
    ResizableHandle: () => <div data-testid="resize-handle" />,
  }
})

import { ProjectEditorFileWorkbench, useProjectEditorWorkbench } from "./project-editor-workbench"

function Harness() {
  const workbench = useProjectEditorWorkbench({
    scopeKey: "session:dock",
    workingDir: "/repo",
    registerProjectOpener: false,
  })
  return (
    <div onKeyDown={workbench.onKeyDown}>
      <ProjectEditorFileWorkbench workbench={workbench} panelIdPrefix="dock" />
    </div>
  )
}

const contextPanel = () => mockPanels.get("dock-context")
const lastContextProps = () =>
  mockContextWorkbenchProps.mock.calls.at(-1)?.[0] as ContextWorkbenchProps
const contextOpenInStore = () =>
  useProjectEditorSessionStore.getState().sessions["session:dock"]?.contextWorkbenchOpen === true

/** Simulate the user dragging a panel's divider to `px`. */
function drag(panel: MockPanel | undefined, px: number) {
  act(() => {
    panel!.px = px
    const onResize = panel!.props.onResize as (size: {
      inPixels: number
      asPercentage: number
    }) => void
    onResize({ inPixels: px, asPercentage: (px / mockGroupWidth) * 100 })
  })
}

function openContextSidebar() {
  act(() => lastContextProps().onEnsureVisible())
}

/** The session remembers the sidebar folded to its rail. */
function restoreFolded() {
  useProjectEditorSessionStore.setState({
    sessions: {
      "session:dock": {
        rootKey: "/repo",
        openPaths: [],
        activePath: null,
        contextWorkbenchOpen: false,
      },
    },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPanels.clear()
  mockGroupWidth = 600
  mockEditor.openFiles = [{ relPath: "src/a.ts" }]
  mockEditor.activePath = "src/a.ts"
  mockEditor.activeFile = {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    savedContent: "old",
    draftContent: "old",
    draftVersion: 1,
  }
  useProjectEditorSessionStore.setState({ sessions: {} })
  // The narrow-dock fold runs a frame later; run it inline.
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0)
    return 0
  })
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("the file context workbench as a resizable sidebar", () => {
  it("is a panel of the editor's group, bounded by the dock rather than the window", () => {
    render(<Harness />)

    const panel = contextPanel()!
    expect(panel.props).toEqual(
      expect.objectContaining({
        collapsible: true,
        collapsedSize: "48px",
        minSize: "240px",
        maxSize: "65%",
        // Open by default: the explorer is its first panel.
        defaultSize: "360px",
        groupResizeBehavior: "preserve-pixel-size",
      })
    )
    // The sidebar keeps its pixel width while the dock is dragged; the editor
    // absorbs the change.
    expect(mockPanels.get("dock-editor")!.props.groupResizeBehavior).toBeUndefined()
    expect(lastContextProps().railOnly).toBe(false)
    // Mounting needs no imperative call — the handle is not registered yet.
    expect(contextPanel()!.calls).toEqual([])
    // The editor has one sidebar: no separate explorer panel beside it.
    expect(mockPanels.has("dock-sidebar")).toBe(false)
    expect(screen.getByTestId("project-context-workbench")).toContainElement(
      screen.getByTestId("tree")
    )
  })

  it("first appears folded to its rail when the session restores it folded", () => {
    restoreFolded()
    render(<Harness />)

    expect(contextPanel()!.props.defaultSize).toBe("48px")
    expect(lastContextProps().railOnly).toBe(true)
    expect(contextPanel()!.calls).toEqual([])
  })

  it("unfolds to its last width and folds back to the rail on the rail's requests", () => {
    restoreFolded()
    render(<Harness />)

    openContextSidebar()
    expect(contextPanel()!.calls).toEqual(["resize:360px"])
    expect(contextPanel()!.px).toBe(360)
    expect(lastContextProps().railOnly).toBe(false)

    drag(contextPanel(), 300)
    act(() => lastContextProps().onCollapse())
    expect(contextPanel()!.calls.at(-1)).toBe("collapse")
    expect(contextPanel()!.px).toBe(48)
    expect(contextOpenInStore()).toBe(false)

    openContextSidebar()
    expect(contextPanel()!.calls.at(-1)).toBe("resize:300px")
  })

  it("treats a drag across the collapse threshold as an open or a close", () => {
    restoreFolded()
    render(<Harness />)

    drag(contextPanel(), 280)
    expect(contextOpenInStore()).toBe(true)
    expect(lastContextProps().railOnly).toBe(false)

    drag(contextPanel(), 48)
    expect(contextOpenInStore()).toBe(false)
    expect(lastContextProps().railOnly).toBe(true)
  })

  it("reports the preset it really sits at for the header's narrow/wide highlight", () => {
    restoreFolded()
    render(<Harness />)
    expect(lastContextProps().resolvedMode).toBeUndefined()

    openContextSidebar()
    expect(lastContextProps().resolvedMode).toBe("narrow")
    drag(contextPanel(), 420)
    expect(lastContextProps().resolvedMode).toBe("wide")
  })

  it("applies the header's narrow/wide buttons as asked, within the dock", () => {
    restoreFolded()
    render(<Harness />)
    openContextSidebar()

    act(() => lastContextProps().onModeWidthHint("wide"))
    expect(contextPanel()!.calls.at(-1)).toBe("resize:60%")
    expect(contextPanel()!.px).toBe(360)

    act(() => lastContextProps().onModeWidthHint("narrow"))
    expect(contextPanel()!.calls.at(-1)).toBe("resize:360px")

    // Focus is a full-screen takeover; it owns no sidebar width.
    const before = contextPanel()!.calls.length
    act(() => lastContextProps().onModeWidthHint("focus"))
    expect(contextPanel()!.calls).toHaveLength(before)
  })

  it("lets a panel activation widen the sidebar but never narrow it", () => {
    mockGroupWidth = 1000
    restoreFolded()
    render(<Harness />)
    openContextSidebar()
    drag(contextPanel(), 450)
    const before = contextPanel()!.calls.length

    act(() => lastContextProps().onModeWidthHint("narrow", "comments"))
    expect(contextPanel()!.calls).toHaveLength(before)

    act(() => lastContextProps().onModeWidthHint("wide", "proposal-review"))
    expect(contextPanel()!.calls.at(-1)).toBe("resize:60%")
    expect(contextPanel()!.px).toBe(600)

    drag(contextPanel(), 640)
    const wideBefore = contextPanel()!.calls.length
    act(() => lastContextProps().onModeWidthHint("wide", "proposal-review"))
    expect(contextPanel()!.calls).toHaveLength(wideBefore)
  })

  it("unfolds straight to the wide preset when a proposal lands on the folded rail", () => {
    restoreFolded()
    render(<Harness />)

    // What the context workbench does when the AI answers with a proposal.
    act(() => {
      lastContextProps().onEnsureVisible()
      lastContextProps().onModeWidthHint("wide", "proposal-review")
    })
    expect(contextPanel()!.calls).toEqual(["resize:60%"])
    expect(contextPanel()!.px).toBe(360)
    expect(lastContextProps().railOnly).toBe(false)
  })

  it("stays mounted, at the same width, with no file to act on", () => {
    mockEditor.activeFile = null
    mockEditor.activePath = null
    mockEditor.openFiles = []
    render(<Harness />)
    expect(contextPanel()!.px).toBe(360)
    expect(lastContextProps().file).toBeNull()
    expect(screen.getByTestId("tree")).toBeInTheDocument()
  })

  it("steps aside for zen and comes back open without driving the fresh panel", () => {
    restoreFolded()
    render(<Harness />)
    openContextSidebar()
    const zenChord = () => {
      const monaco = screen.getByTestId("monaco")
      fireEvent.keyDown(monaco, { key: "k", metaKey: true })
      fireEvent.keyDown(monaco, { key: "z" })
    }

    zenChord()
    expect(contextPanel()).toBeUndefined()

    zenChord()
    // A remounted panel is not registered with its group until a render
    // later; its size comes from the open flag (and, in the real group, the
    // layout it remembers), never from an imperative call that would throw.
    expect(contextPanel()!.calls).toEqual([])
    expect(contextPanel()!.props.defaultSize).toBe("360px")
    expect(lastContextProps().railOnly).toBe(false)
  })
})

describe("a stable width while files come and go", () => {
  const fileState = (relPath: string, extra: Record<string, unknown> = {}) => ({
    relPath,
    absolutePath: `/repo/${relPath}`,
    savedContent: "x",
    draftContent: "x",
    draftVersion: 1,
    ...extra,
  })

  it("opening, switching and closing files never resizes or remounts the sidebar", () => {
    mockEditor.activeFile = null
    mockEditor.activePath = null
    mockEditor.openFiles = []
    const { rerender } = render(<Harness />)
    drag(contextPanel(), 420)
    const panelBefore = contextPanel()
    const callsBefore = contextPanel()!.calls.length

    // First file opens into an empty editor.
    mockEditor.openFiles = [{ relPath: "src/a.ts" }]
    mockEditor.activePath = "src/a.ts"
    mockEditor.activeFile = fileState("src/a.ts")
    rerender(<Harness />)
    // A second tab.
    mockEditor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    mockEditor.activePath = "src/b.ts"
    mockEditor.activeFile = fileState("src/b.ts")
    rerender(<Harness />)
    // A file the editor refuses (binary/too large) — nothing to act on.
    mockEditor.activePath = "img.bin"
    mockEditor.activeFile = fileState("img.bin", { blocked: "binary" })
    rerender(<Harness />)
    // Everything closed again.
    mockEditor.openFiles = []
    mockEditor.activePath = null
    mockEditor.activeFile = null
    rerender(<Harness />)

    expect(contextPanel()).toBe(panelBefore)
    expect(contextPanel()!.calls).toHaveLength(callsBefore)
    expect(contextPanel()!.px).toBe(420)
    expect(lastContextProps().railOnly).toBe(false)
  })

  it("keeps one layout for the whole project rather than one per file", () => {
    const { rerender } = render(<Harness />)
    const first = lastContextProps()
    mockEditor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    mockEditor.activePath = "src/b.ts"
    mockEditor.activeFile = fileState("src/b.ts")
    rerender(<Harness />)
    expect(lastContextProps().file?.relPath).toBe("src/b.ts")
    expect(lastContextProps().railOnly).toBe(first.railOnly)
  })
})
