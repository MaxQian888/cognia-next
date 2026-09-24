/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

const mockTranslate = (key: string) => key
jest.mock("next-intl", () => ({ useTranslations: () => mockTranslate }))
const mockToastError = jest.fn()
const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}))
const disposeOpener = jest.fn()
const registerOpener = jest.fn((_args: unknown) => disposeOpener)
const notifyActiveEditorChanged = jest.fn()
jest.mock("@/lib/files/project-editor-bridge", () => ({
  registerProjectEditorOpener: (args: unknown) => registerOpener(args),
  notifyActiveEditorChanged: () => notifyActiveEditorChanged(),
}))
jest.mock("@/stores/canvas/keybinding-store", () => ({
  useKeybindingStore: (selector: (state: { bindings: Record<string, string> }) => unknown) =>
    selector({ bindings: {} }),
}))
// The session store is real (zustand): split-layout persistence tests seed
// and read it directly; beforeEach resets it to a clean slate.
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"

const editor = {
  scopeKey: "session:s1",
  deps: {
    readFile: jest.fn().mockResolvedValue("disk side\n"),
    listDir: jest.fn().mockResolvedValue([]),
  } as Record<string, unknown>,
  roots: [{ key: "/repo", label: "main", path: "/repo", isMain: true }],
  rootKey: "/repo",
  rootPath: "/repo",
  rootsReady: true,
  sessionRestored: true,
  openFiles: [] as Array<Record<string, unknown>>,
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
  isPathOpen: jest.fn(
    (relPath: string): boolean =>
      editor.openFiles.some((f) => f.relPath === relPath) || relPath === "src/a.ts"
  ),
  pinFile: jest.fn(),
  closeFile: jest.fn(),
  closeFiles: jest.fn(),
  moveOpenFile: jest.fn(),
  closeAllFiles: jest.fn(),
  reopenClosedFile: jest.fn(),
  // Deliberately inert: cycleTab tests rely on a frozen `activePath`, and the
  // group-reconcile effect may legitimately call this with null while the
  // mock holds a stale path. Split-group tests mutate `editor.activePath`
  // themselves to simulate the real state write.
  setActivePath: jest.fn(),
  setDraft: jest.fn(),
  saveFile: jest.fn().mockResolvedValue(undefined),
  saveAll: jest.fn().mockResolvedValue(undefined),
  reloadFile: jest.fn().mockResolvedValue(undefined),
  renameOpenFile: jest.fn().mockResolvedValue(undefined),
  reconcileDeleted: jest.fn(),
  // Boolean answers are legal too — the hook normalizes a window.confirm-style
  // true/false, so tests may refuse a gate with `mockReturnValueOnce(false)`.
  confirmDiscardDraft: jest.fn((): "confirm" | "save" | "cancel" | boolean => "confirm"),
}

jest.mock("./use-project-editor", () => ({
  useProjectEditor: jest.fn(() => editor),
}))
const editorTabsProps = jest.fn()
jest.mock("./project-editor-tabs", () => ({
  EDITOR_TAB_DRAG_MIME: "application/x-cognia-editor-tab",
  ProjectEditorTabs: (props: Record<string, unknown>) => {
    editorTabsProps(props)
    return <div data-testid="tabs" />
  },
}))
const mockTreeRender = jest.fn()
const fileTreeProps = jest.fn()
jest.mock("./project-file-tree", () => ({
  ProjectFileTree: ({
    onOpenFile,
    active,
    activePath,
    ...rest
  }: {
    onOpenFile: (path: string, options?: { mode?: string }) => void
    active?: boolean
    activePath?: string | null
    [key: string]: unknown
  }) => {
    mockTreeRender()
    fileTreeProps({ onOpenFile, active, activePath, ...rest })
    return (
      <button
        data-testid="tree"
        data-active={String(active)}
        data-path={activePath}
        onClick={() => onOpenFile("src/tree.ts", { mode: "preview" })}
      />
    )
  },
}))
const searchPanelProps = jest.fn()
jest.mock("./project-search-panel", () => ({
  ProjectSearchPanel: (props: { onOpenMatch: (path: string) => void }) => {
    searchPanelProps(props)
    return <button data-testid="search" onClick={() => props.onOpenMatch("src/search.ts")} />
  },
}))
// The decoration hook otherwise hits the real transport and resolves outside
// act(); a never-settling status keeps the suite quiet and badge-free.
const mockGitDecorations = new Map()
jest.mock("./use-project-git-status", () => ({
  useProjectGitStatus: () => ({ branch: null, byPath: mockGitDecorations }),
}))
const quickOpenProps = jest.fn()
jest.mock("./project-quick-open", () => ({
  ProjectQuickOpen: (props: { open: boolean }) => {
    quickOpenProps(props)
    return props.open ? <div data-testid="quick-open" /> : null
  },
}))
jest.mock("./project-editor-breadcrumbs", () => ({
  ProjectEditorBreadcrumbs: () => null,
}))
const statusBarProps = jest.fn()
jest.mock("./project-editor-status-bar", () => ({
  ProjectEditorStatusBar: (props: unknown) => {
    statusBarProps(props)
    return <div data-testid="status-bar" />
  },
}))
jest.mock("./project-file-fallback", () => ({
  ProjectFileFallback: ({ onOpenAnyway }: { onOpenAnyway?: () => void }) => (
    <div data-testid="file-fallback">
      <button data-testid="open-anyway" onClick={() => onOpenAnyway?.()} />
    </div>
  ),
}))
// `mount-monaco` stands in for ProjectMonaco's real `onMount`, which is the
// only place the live monaco/editor instances surface. The model/namespace
// are module-level so status-bar tests can spy on the mutations the
// indentation/EOL/language actions issue through them.
const monacoModel = {
  uri: "file:///repo/src/a.ts",
  getValueInRange: () => "const",
  getOptions: jest.fn(() => ({ tabSize: 4, insertSpaces: true })),
  updateOptions: jest.fn(),
  getEOL: jest.fn(() => "\n"),
  setEOL: jest.fn(),
}
const monacoSetModelLanguage = jest.fn()
const monacoEditorAction = jest.fn()
const monacoNs = {
  editor: {
    getModelMarkers: () => [
      {
        severity: 8,
        message: "boom",
        resource: { toString: () => monacoModel.uri },
        startLineNumber: 3,
        startColumn: 5,
        endLineNumber: 3,
        endColumn: 9,
      },
    ],
    onDidChangeMarkers: () => ({ dispose: () => {} }),
    setModelLanguage: monacoSetModelLanguage,
  },
  languages: {
    getLanguages: () => [
      { id: "typescript", aliases: ["TypeScript"] },
      { id: "markdown", aliases: ["Markdown"] },
    ],
  },
}
const monacoProps = jest.fn()
jest.mock("./project-monaco", () => ({
  ProjectMonaco: ({
    actions,
    onDiagnosticsReady,
    onSelectionChange,
    ...rest
  }: {
    actions: Array<{ id: string; run?: () => void }>
    onDiagnosticsReady?: (relPath: string, next: unknown) => void
    onSelectionChange?: (selection: unknown) => void
    wordWrap?: boolean
    fontSize?: number
    file?: { relPath: string }
    [key: string]: unknown
  }) => {
    monacoProps(rest)
    return (
      <div data-testid="monaco">
        <button
          data-testid="monaco-select"
          onClick={() => onSelectionChange?.({ kind: "text", start: 1, end: 4 })}
        />
        {actions.map((action) => (
          <button key={action.id} data-testid={action.id} onClick={action.run} />
        ))}
        <button
          data-testid="mount-monaco"
          onClick={() =>
            onDiagnosticsReady?.("src/a.ts", {
              monaco: monacoNs,
              editor: {
                getSelection: () => ({
                  startLineNumber: 2,
                  startColumn: 1,
                  endLineNumber: 2,
                  endColumn: 6,
                }),
                getModel: () => monacoModel,
                getAction: (id: string) => ({ run: () => monacoEditorAction(id) }),
              },
            })
          }
        />
      </div>
    )
  },
}))
// The preview surface pulls in the whole viewer registry; the workbench only
// needs to know the overlay mounted and which live content it was fed.
const previewPanelProps = jest.fn()
jest.mock("./project-file-preview-panel", () => ({
  ProjectFilePreviewPanel: (props: { relPath: string; content: string }) => {
    previewPanelProps(props)
    return <div data-testid="file-preview-panel" />
  },
}))
const projectContextWorkbenchProps = jest.fn()
jest.mock("./project-context-workbench", () => ({
  ProjectContextWorkbench: (props: Record<string, unknown>) => {
    projectContextWorkbenchProps(props)
    return (
      <div data-testid="project-context-workbench">
        <button
          data-testid="workbench-draft"
          onClick={() => (props.onDraftChange as (c: string) => void)?.("from workbench")}
        />
      </div>
    )
  },
  ProjectContextWorkbenchMobile: ({
    open,
    onDraftChange,
  }: {
    open: boolean
    onDraftChange?: (content: string) => void
  }) => (
    <div data-testid="project-context-workbench-mobile" data-open={String(open)}>
      <button
        data-testid="workbench-draft-mobile"
        onClick={() => onDraftChange?.("from mobile workbench")}
      />
    </div>
  ),
}))
// Both the project-wide TS mirror and the Problems view load the Monaco
// namespace directly; tests hand them the fake one (or nothing) explicitly.
jest.mock("@/lib/canvas/monaco-loader", () => ({
  loadConfiguredMonaco: jest.fn(() => Promise.resolve(null)),
}))
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      data-testid="light-editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))
jest.mock("@/components/source-control/diff-viewer", () => ({
  DiffViewer: ({ diff }: { diff: { oldContent: string; newContent: string } }) => (
    <div data-testid="diff-viewer">
      {diff.oldContent}|{diff.newContent}
    </div>
  ),
}))

import { ProjectEditorFileWorkbench, useProjectEditorWorkbench } from "./project-editor-workbench"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"

function Harness({
  beforeOpen,
  registerProjectOpener,
  active = true,
  workbenchProps,
}: {
  beforeOpen?: () => void
  registerProjectOpener?: boolean
  active?: boolean
  workbenchProps?: Partial<Parameters<typeof ProjectEditorFileWorkbench>[0]>
}) {
  const workbench = useProjectEditorWorkbench({
    scopeKey: "session:s1",
    workingDir: "/repo",
    beforeOpen,
    registerProjectOpener,
  })
  return (
    <div onKeyDown={workbench.onKeyDown}>
      <button data-testid="goto" onClick={() => workbench.gotoLine("src/jump.ts", 7)} />
      <ProjectEditorFileWorkbench
        workbench={workbench}
        active={active}
        panelIdPrefix="test"
        {...workbenchProps}
      />
    </div>
  )
}

function MobileHarness() {
  const workbench = useProjectEditorWorkbench({
    scopeKey: "session:s1",
    workingDir: "/repo",
    layout: "mobile",
  })
  return (
    <div onKeyDown={workbench.onKeyDown}>
      <ProjectEditorFileWorkbench workbench={workbench} panelIdPrefix="mobile-test" />
    </div>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  registerOpener.mockReturnValue(disposeOpener)
  projectContextWorkbenchProps.mockClear()
  useProjectEditorSessionStore.setState({ sessions: {} })
  monacoModel.getOptions.mockReturnValue({ tabSize: 4, insertSpaces: true })
  monacoModel.getEOL.mockReturnValue("\n")
  editor.openFiles = []
  editor.activePath = "src/a.ts"
  editor.sessionRestored = true
  editor.activeFile = {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    savedContent: "old",
    draftContent: "old",
    draftVersion: 1,
  }
})

it("shares file navigation, search actions, and keyboard saves", () => {
  const beforeOpen = jest.fn()
  render(<Harness beforeOpen={beforeOpen} />)

  fireEvent.click(screen.getByTestId("tree"))
  expect(beforeOpen).toHaveBeenCalled()
  expect(editor.openFile).toHaveBeenCalledWith("src/tree.ts", { mode: "preview" })

  fireEvent.click(screen.getByTestId("file.searchProject"))
  fireEvent.click(screen.getByTestId("search"))
  expect(editor.openFile).toHaveBeenCalledWith("src/search.ts")

  fireEvent.keyDown(screen.getByTestId("tabs").parentElement!, { key: "s", metaKey: true })
  expect(editor.saveFile).toHaveBeenCalledWith("src/a.ts")
})

it("registers the root opener and removes it on unmount", () => {
  const { unmount } = render(<Harness />)
  expect(registerOpener).toHaveBeenCalledWith(expect.objectContaining({ root: "/repo" }))
  unmount()
  expect(disposeOpener).toHaveBeenCalled()
})

it("can suspend Monaco routing while another editor owns the root", () => {
  render(<Harness registerProjectOpener={false} />)
  expect(registerOpener).not.toHaveBeenCalled()
})

describe("readActive", () => {
  /** The `readActive` the hook handed to the bridge on the latest registration. */
  const registeredReadActive = () => {
    const args = registerOpener.mock.calls.at(-1)?.[0] as {
      readActive?: () => Promise<unknown>
    }
    return args.readActive
  }

  it("registers a readActive so the read side is not Pro-IDE-only", () => {
    // Monaco is the default engine, so without this the `read_active_editor`
    // tool is permanently unavailable for almost every user.
    render(<Harness />)
    expect(registeredReadActive()).toEqual(expect.any(Function))
  })

  it("answers with the open files even before Monaco has mounted", async () => {
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    render(<Harness />)

    await expect(registeredReadActive()!()).resolves.toEqual({
      path: "/repo/src/a.ts",
      selection: null,
      selectedText: null,
      diagnostics: [],
      openEditors: ["/repo/src/a.ts", "/repo/src/b.ts"],
    })
    editor.openFiles = []
  })

  it("folds in the live selection and diagnostics once Monaco mounts", async () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)

    fireEvent.click(screen.getByTestId("mount-monaco"))

    await expect(registeredReadActive()!()).resolves.toEqual({
      path: "/repo/src/a.ts",
      selection: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 6 },
      selectedText: "const",
      diagnostics: [{ message: "boom", severity: "error", line: 3, column: 5 }],
      openEditors: ["/repo/src/a.ts"],
    })
    editor.openFiles = []
  })

  it("announces the move so ctx.editor subscribers re-read", () => {
    // Without this the change event would only fire on mount/unmount, which is
    // not what `onDidChangeActiveEditor` promises.
    notifyActiveEditorChanged.mockClear()
    render(<Harness />)

    expect(notifyActiveEditorChanged).toHaveBeenCalled()
  })

  it("reports a null path when no file is active", async () => {
    const previousActive = editor.activePath
    editor.activePath = null
    editor.openFiles = []
    try {
      render(<Harness />)
      await expect(registeredReadActive()!()).resolves.toEqual(
        expect.objectContaining({ path: null, openEditors: [] })
      )
    } finally {
      editor.activePath = previousActive
    }
  })

  it("does not re-register the opener when the mounted handles change", () => {
    // `readActive` reads its inputs through refs precisely so the bridge is not
    // churned on every caret move; re-registering would also thrash the
    // deepest-root/latest-registration resolution.
    render(<Harness />)
    const before = registerOpener.mock.calls.length

    fireEvent.click(screen.getByTestId("mount-monaco"))

    expect(registerOpener.mock.calls.length).toBe(before)
  })
})

it("lays the primary sidebar out on the left, rail first, editor after", () => {
  render(<Harness />)

  const rail = screen.getByTestId("project-editor-activity-rail")
  const editorGroup = screen.getByTestId("editor-group-0")
  // DOCUMENT_POSITION_FOLLOWING: the editor comes after the rail.
  expect(rail.compareDocumentPosition(editorGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(rail).toHaveClass("border-r")
  expect(screen.getByTestId("tree")).toBeInTheDocument()
})

it("renders one tab strip per editor group, with the tab actions wired", () => {
  render(<Harness />)

  const props = editorTabsProps.mock.calls.at(-1)?.[0] as Record<string, unknown>
  for (const handler of [
    "onSelect",
    "onClose",
    "onPin",
    "onSaveAll",
    "onMove",
    "onCloseOthers",
    "onCloseToRight",
    "onCloseAll",
    "onReopenClosed",
    "onCopyPath",
    "onRevert",
    "onRevealInExplorer",
    "onAddToChat",
  ]) {
    expect(props[handler]).toEqual(expect.any(Function))
  }
  // Not split: "Move to Other Group" has nowhere to go.
  expect(props.onMoveToOtherGroup).toBeUndefined()
})

describe("file context workbench (secondary sidebar)", () => {
  it("mounts for the shown file, folded to its rail until opened", () => {
    render(<Harness />)

    expect(screen.getByTestId("project-context-workbench")).toBeInTheDocument()
    expect(projectContextWorkbenchProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopeKey: "session:s1",
        rootPath: "/repo",
        file: expect.objectContaining({ relPath: "src/a.ts" }),
        railOnly: true,
      })
    )
  })

  it("persists open / closed per editor scope through the rail's requests", () => {
    render(<Harness />)

    const last = () =>
      projectContextWorkbenchProps.mock.calls.at(-1)?.[0] as {
        railOnly: boolean
        onEnsureVisible: () => void
        onCollapse: () => void
      }
    act(() => last().onEnsureVisible())
    expect(last().railOnly).toBe(false)
    expect(useProjectEditorSessionStore.getState().sessions["session:s1"]).toEqual(
      expect.objectContaining({ contextWorkbenchOpen: true })
    )

    act(() => last().onCollapse())
    expect(last().railOnly).toBe(true)
    expect(
      useProjectEditorSessionStore.getState().sessions["session:s1"]?.contextWorkbenchOpen
    ).toBe(false)
  })

  it("restores an opened workbench from the session record", () => {
    useProjectEditorSessionStore.setState({
      sessions: {
        "session:s1": {
          rootKey: "/repo",
          openPaths: [],
          activePath: null,
          contextWorkbenchOpen: true,
        },
      },
    })
    render(<Harness />)

    expect(projectContextWorkbenchProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ railOnly: false })
    )
  })

  it("stays away from a blocked file, which has no text to act on", () => {
    editor.activeFile = { ...editor.activeFile, blocked: "binary" }
    render(<Harness />)

    expect(screen.getByTestId("file-fallback")).toBeInTheDocument()
    expect(screen.queryByTestId("project-context-workbench")).not.toBeInTheDocument()
  })

  it("feeds draft edits made from a panel back into the editor", () => {
    render(<Harness />)

    fireEvent.click(screen.getByTestId("workbench-draft"))
    expect(editor.setDraft).toHaveBeenCalledWith("src/a.ts", "from workbench")
  })
})

it("copies absolute and relative paths through shared Monaco actions", () => {
  const writeText = jest.fn()
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  render(<Harness />)

  fireEvent.click(screen.getByTestId("file.copyPath"))
  fireEvent.click(screen.getByTestId("file.copyRelativePath"))
  expect(writeText).toHaveBeenNthCalledWith(1, "/repo/src/a.ts")
  expect(writeText).toHaveBeenNthCalledWith(2, "src/a.ts")
})

it("renders the shared empty editor state", () => {
  editor.activeFile = null
  editor.activePath = null
  render(<Harness />)
  expect(screen.getByTestId("editor-empty")).toHaveTextContent("emptyEditor")
  fireEvent.keyDown(screen.getByTestId("tabs"), { key: "s", metaKey: true })
  expect(editor.saveFile).not.toHaveBeenCalled()
})

it("empty-state shortcut rows drive quick open, search, and reopen", () => {
  editor.activeFile = null
  editor.activePath = null
  render(<Harness />)

  fireEvent.click(screen.getByTestId("editor-empty-quick-open"))
  expect(screen.getByTestId("quick-open")).toBeInTheDocument()

  fireEvent.click(screen.getByTestId("editor-empty-search"))
  expect(screen.getByTestId("left-tab-search")).toHaveAttribute("aria-pressed", "true")
  expect(
    screen.getByTestId("project-editor-sidebar-content").querySelector('[data-testid="search"]')
  ).not.toBeNull()

  fireEvent.click(screen.getByTestId("editor-empty-reopen"))
  expect(editor.reopenClosedFile).toHaveBeenCalled()
})

it("keeps the editor mounted under a veil while a cold open reads the file", () => {
  // A cold open moves `activePath` synchronously but `activeFile` only exists
  // after the async read lands. Falling back to the empty state in between
  // unmounted Monaco for a frame — the file-switch flicker.
  const rendered = render(<Harness />)
  expect(screen.getByTestId("monaco")).toBeInTheDocument()

  editor.activePath = "src/b.ts"
  editor.activeFile = null
  editor.openFiles = [{ relPath: "src/a.ts", absolutePath: "/repo/src/a.ts", draftContent: "old" }]
  rendered.rerender(<Harness />)

  expect(screen.getByTestId("monaco")).toBeInTheDocument()
  expect(screen.getByTestId("editor-loading")).toBeInTheDocument()
  expect(screen.queryByTestId("editor-empty")).not.toBeInTheDocument()

  editor.activeFile = {
    relPath: "src/b.ts",
    absolutePath: "/repo/src/b.ts",
    savedContent: "b",
    draftContent: "b",
    draftVersion: 1,
  }
  editor.openFiles = [
    { relPath: "src/a.ts", absolutePath: "/repo/src/a.ts", draftContent: "old" },
    editor.activeFile,
  ]
  rendered.rerender(<Harness />)

  expect(screen.getByTestId("monaco")).toBeInTheDocument()
  expect(screen.queryByTestId("editor-loading")).not.toBeInTheDocument()
  editor.openFiles = []
})

it("shows a loading pane instead of the empty state on the very first open", () => {
  editor.activePath = "src/a.ts"
  editor.activeFile = null
  editor.openFiles = []
  render(<Harness />)

  expect(screen.getByTestId("editor-loading")).toBeInTheDocument()
  expect(screen.queryByTestId("editor-empty")).not.toBeInTheDocument()
  expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
})

it("keeps the light editor mounted while the next file loads on mobile", () => {
  const rendered = render(<MobileHarness />)
  fireEvent.click(screen.getByTestId("project-editor-mobile-editor"))
  expect(screen.getByTestId("light-editor")).toBeInTheDocument()

  editor.activePath = "src/b.ts"
  editor.activeFile = null
  editor.openFiles = [{ relPath: "src/a.ts", absolutePath: "/repo/src/a.ts", draftContent: "old" }]
  rendered.rerender(<MobileHarness />)

  expect(screen.getByTestId("light-editor")).toBeInTheDocument()
  expect(screen.getByTestId("editor-loading")).toBeInTheDocument()
  expect(screen.queryByTestId("editor-empty")).not.toBeInTheDocument()
  editor.openFiles = []
})

it("reports active and save-all failures through the shared toast path", async () => {
  editor.saveFile.mockRejectedValueOnce(new Error("save active"))
  editor.saveAll.mockRejectedValueOnce(new Error("save all"))
  render(<Harness />)

  fireEvent.click(screen.getByTestId("file.save"))
  fireEvent.keyDown(screen.getByTestId("tabs"), { key: "s", ctrlKey: true, shiftKey: true })

  await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(2))
})

it("reuses the workbench as a touch-friendly mobile Files/Search/Editor flow", () => {
  render(<MobileHarness />)

  expect(screen.getByTestId("project-editor-mobile-files")).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByTestId("project-context-workbench-mobile")).toHaveAttribute(
    "data-open",
    "false"
  )
  fireEvent.click(screen.getByTestId("project-editor-mobile-workbench"))
  expect(screen.getByTestId("project-context-workbench-mobile")).toHaveAttribute(
    "data-open",
    "true"
  )
  fireEvent.click(screen.getByTestId("tree"))
  expect(editor.openFile).toHaveBeenCalledWith("src/tree.ts", { mode: "preview" })
  expect(screen.getByTestId("light-editor")).toBeInTheDocument()

  fireEvent.change(screen.getByTestId("light-editor"), { target: { value: "mobile edit" } })
  expect(editor.setDraft).toHaveBeenCalledWith("src/a.ts", "mobile edit")
  fireEvent.click(screen.getByTestId("project-editor-mobile-save"))
  expect(editor.saveFile).toHaveBeenCalledWith("src/a.ts")

  fireEvent.click(screen.getByTestId("project-editor-mobile-search"))
  expect(screen.getByTestId("search")).toBeInTheDocument()
  fireEvent.click(screen.getByTestId("project-editor-mobile-files"))
  expect(screen.getByTestId("tree")).toBeInTheDocument()
  fireEvent.click(screen.getByTestId("project-editor-mobile-editor"))
  expect(screen.getByTestId("light-editor")).toBeInTheDocument()
})

it("shows the shared empty editor state in the mobile Editor pane", () => {
  editor.activePath = null
  editor.activeFile = null
  render(<MobileHarness />)

  fireEvent.click(screen.getByTestId("project-editor-mobile-editor"))

  expect(screen.getByTestId("editor-empty")).toHaveTextContent("emptyEditor")
  expect(screen.queryByTestId("project-editor-mobile-save")).not.toBeInTheDocument()
})

describe("saveDirty", () => {
  const registeredSaveDirty = () => {
    const args = registerOpener.mock.calls.at(-1)?.[0] as {
      saveDirty?: () => Promise<string[]>
    }
    return args.saveDirty
  }

  it("registers a flush so Monaco's drafts are not invisible to the agent", async () => {
    // Monaco keeps `draftContent` in memory until saved, exactly like a VS Code
    // buffer — without this, the agent reading disk sees stale content and its
    // write clobbers the user's unsaved work, on the default engine.
    render(<Harness />)

    await expect(registeredSaveDirty()?.()).resolves.toEqual([])
    expect(editor.saveAll).toHaveBeenCalled()
  })

  it("reports the root when the flush fails, rather than throwing into the turn", async () => {
    // `saveAll` doesn't say which file it choked on; naming the root is more
    // useful than swallowing it, and throwing would abort a turn that could
    // still proceed with a warning.
    editor.saveAll.mockRejectedValueOnce(new Error("disk full"))
    render(<Harness />)

    await expect(registeredSaveDirty()?.()).resolves.toEqual(["/repo"])
  })
})

it("lifts the editor selection so the context workbench sees it", () => {
  notifyActiveEditorChanged.mockClear()
  render(<Harness />)
  fireEvent.click(screen.getByTestId("monaco-select"))
  expect(notifyActiveEditorChanged).toHaveBeenCalled()
})

it("dispatches a goto event after the file opens, defaulting the column", async () => {
  const events: CustomEvent[] = []
  const listener = (e: Event) => events.push(e as CustomEvent)
  window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, listener)
  jest.useFakeTimers()
  try {
    render(<Harness />)
    fireEvent.click(screen.getByTestId("goto"))
    // The dispatch is scheduled inside `openFile().then(...)`, so the microtask
    // queue has to drain before the timer it schedules exists.
    await act(async () => {})
    await act(async () => {
      jest.runAllTimers()
    })
    expect(events.at(-1)?.detail).toEqual({ relPath: "src/jump.ts", line: 7, column: 1 })
  } finally {
    jest.useRealTimers()
    window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, listener)
  }
})

it("routes a context-workbench draft edit back into the active file", () => {
  render(<Harness />)
  fireEvent.click(screen.getByTestId("workbench-draft"))
  expect(editor.setDraft).toHaveBeenCalledWith("src/a.ts", "from workbench")
})

it("routes a mobile context-workbench draft edit back into the active file", () => {
  render(<MobileHarness />)
  fireEvent.click(screen.getByTestId("workbench-draft-mobile"))
  expect(editor.setDraft).toHaveBeenCalledWith("src/a.ts", "from mobile workbench")
})

it("ignores a plain `s` keypress and a non-save modifier chord", () => {
  render(<Harness />)
  const surface = screen.getByTestId("tabs").parentElement!
  fireEvent.keyDown(surface, { key: "s" })
  fireEvent.keyDown(surface, { key: "p", metaKey: true })
  expect(editor.saveFile).not.toHaveBeenCalled()
  expect(editor.saveAll).not.toHaveBeenCalled()
})

describe("tab keyboard chords", () => {
  const surface = () => screen.getByTestId("tabs").parentElement!

  it("closes the active tab on mod+W and leaves the chord alone with no tab", () => {
    const view = render(<Harness />)
    // fireEvent returns false when the dispatched event was preventDefaulted.
    expect(fireEvent.keyDown(surface(), { key: "w", metaKey: true })).toBe(false)
    expect(editor.closeFile).toHaveBeenCalledWith("src/a.ts")

    editor.closeFile.mockClear()
    editor.activePath = null
    view.rerender(<Harness />)
    expect(fireEvent.keyDown(surface(), { key: "w", metaKey: true })).toBe(true)
    expect(editor.closeFile).not.toHaveBeenCalled()
  })

  it("reopens the last closed tab on mod+shift+T", () => {
    render(<Harness />)
    fireEvent.keyDown(surface(), { key: "T", metaKey: true, shiftKey: true })
    expect(editor.reopenClosedFile).toHaveBeenCalled()
  })

  it("cycles tabs on ctrl+tab / ctrl+shift+tab with wraparound", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }, { relPath: "src/c.ts" }]
    editor.activePath = "src/a.ts"
    render(<Harness />)

    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true })
    expect(editor.setActivePath).toHaveBeenLastCalledWith("src/b.ts")

    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true, shiftKey: true })
    expect(editor.setActivePath).toHaveBeenLastCalledWith("src/c.ts")
  })

  it("cycles tabs on mod+shift+bracket using event.code, not the shifted glyph", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    editor.activePath = "src/b.ts"
    render(<Harness />)

    fireEvent.keyDown(surface(), { key: "}", code: "BracketRight", metaKey: true, shiftKey: true })
    expect(editor.setActivePath).toHaveBeenLastCalledWith("src/a.ts")

    fireEvent.keyDown(surface(), { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true })
    expect(editor.setActivePath).toHaveBeenLastCalledWith("src/a.ts")
  })

  it("does not cycle on a single tab or swallow the OS ⌘Tab switcher", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)

    fireEvent.keyDown(surface(), { key: "Tab", ctrlKey: true })
    fireEvent.keyDown(surface(), { key: "Tab", metaKey: true })
    expect(editor.setActivePath).not.toHaveBeenCalled()
  })

  it("opens project search on mod+shift+F", () => {
    render(<Harness />)
    fireEvent.keyDown(surface(), { key: "F", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("left-tab-search")).toHaveAttribute("aria-pressed", "true")
    expect(
      screen.getByTestId("project-editor-sidebar-content").querySelector('[data-testid="search"]')
    ).not.toBeNull()
  })
})

describe("activity rail", () => {
  it("switches the sidebar between the file tree and search panel", () => {
    render(<Harness />)
    const sidebar = screen.getByTestId("project-editor-sidebar-content")
    expect(sidebar.querySelector('[data-testid="tree"]')).not.toBeNull()

    fireEvent.click(screen.getByTestId("left-tab-search"))
    expect(sidebar.querySelector('[data-testid="search"]')).not.toBeNull()
    expect(screen.getByTestId("tree")).not.toBeVisible()
    expect(screen.getByTestId("left-tab-search")).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(screen.getByTestId("left-tab-files"))
    expect(sidebar.querySelector('[data-testid="tree"]')).not.toBeNull()
  })

  it("opens quick-open from the rail button", () => {
    render(<Harness />)
    expect(screen.queryByTestId("quick-open")).toBeNull()
    fireEvent.click(screen.getByTestId("rail-quick-open"))
    expect(screen.getByTestId("quick-open")).toBeInTheDocument()
    expect(quickOpenProps).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }))
  })

  it("opens quick-open on the mod+P chord", () => {
    render(<Harness />)
    const surface = screen.getByTestId("tabs").parentElement!
    fireEvent.keyDown(surface, { key: "p", metaKey: true })
    expect(screen.getByTestId("quick-open")).toBeInTheDocument()
  })
})

describe("blocked files", () => {
  it("renders the fallback pane and forwards open-anyway to the editor", () => {
    editor.activeFile = {
      relPath: "big.log",
      absolutePath: "/repo/big.log",
      savedContent: "",
      draftContent: "",
      draftVersion: 1,
      blocked: "too-large",
    }
    editor.activePath = "big.log"
    render(<Harness />)
    expect(screen.getByTestId("file-fallback")).toBeInTheDocument()
    expect(screen.queryByTestId("monaco")).toBeNull()

    fireEvent.click(screen.getByTestId("open-anyway"))
    expect(editor.openFile).toHaveBeenCalledWith("big.log", { allowLarge: true })
  })
})

it("does not rerender the file tree for 20 editor selection changes", () => {
  render(<Harness />)
  mockTreeRender.mockClear()
  for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTestId("monaco-select"))
  expect(mockTreeRender).toHaveBeenCalledTimes(0)
  expect(projectContextWorkbenchProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ selection: { kind: "text", start: 1, end: 4 } })
  )
})

it("retains the same file-tree and search nodes across sidebar switches", () => {
  render(<Harness />)
  const tree = screen.getByTestId("tree")
  fireEvent.click(screen.getByTestId("left-tab-search"))
  const search = screen.getByTestId("search")
  expect(tree).toBeInTheDocument()
  expect(tree).not.toBeVisible()
  fireEvent.click(screen.getByTestId("left-tab-files"))
  expect(screen.getByTestId("tree")).toBe(tree)
  expect(search).toBeInTheDocument()
  expect(search).not.toBeVisible()
})

it("retains the light editor while switching mobile navigation", () => {
  render(<MobileHarness />)
  fireEvent.click(screen.getByTestId("project-editor-mobile-editor"))
  const input = screen.getByTestId("light-editor")
  fireEvent.click(screen.getByTestId("project-editor-mobile-files"))
  expect(input).toBeInTheDocument()
  expect(input).not.toBeVisible()
  fireEvent.click(screen.getByTestId("project-editor-mobile-editor"))
  expect(screen.getByTestId("light-editor")).toBe(input)
  expect(input).toBeVisible()
})

it("pauses retained views when the dock selects another surface", () => {
  const view = render(<Harness />)
  const tree = screen.getByTestId("tree")
  expect(tree).toHaveAttribute("data-active", "true")
  view.rerender(<Harness active={false} />)
  expect(screen.getByTestId("tree")).toBe(tree)
  expect(tree).toHaveAttribute("data-active", "false")
  view.rerender(<Harness active />)
  expect(tree).toHaveAttribute("data-active", "true")
})

describe("disk-truth sync banner", () => {
  const conflictFile = (dirty: boolean) => ({
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    savedContent: "old",
    draftContent: dirty ? "draft" : "old",
    draftVersion: dirty ? 2 : 1,
    externallyChanged: true,
  })

  it("shows the conflict actions for a dirty file changed on disk", async () => {
    editor.openFiles = [conflictFile(true)]
    editor.activeFile = conflictFile(true)
    render(<Harness />)

    expect(screen.getByTestId("editor-conflict-banner")).toHaveTextContent("sync.conflictBanner")
    // Compare reads the disk side lazily and opens the diff dialog.
    fireEvent.click(screen.getByTestId("editor-conflict-compare"))
    expect(await screen.findByTestId("editor-compare-dialog")).toBeInTheDocument()
    expect(editor.deps.readFile).toHaveBeenCalledWith("/repo", "src/a.ts")
    fireEvent.click(screen.getByTestId("editor-compare-save"))
    expect(editor.saveFile).toHaveBeenCalledWith("src/a.ts", { force: true })
  })

  it("reloads from the banner and force-saves the draft", () => {
    editor.openFiles = [conflictFile(true)]
    editor.activeFile = conflictFile(true)
    render(<Harness />)

    fireEvent.click(screen.getByTestId("editor-conflict-reload"))
    expect(editor.confirmDiscardDraft).toHaveBeenCalledWith("src/a.ts")
    expect(editor.reloadFile).toHaveBeenCalledWith("src/a.ts")

    fireEvent.click(screen.getByTestId("editor-conflict-save"))
    expect(editor.saveFile).toHaveBeenCalledWith("src/a.ts", { force: true })
  })

  it("a cancelled revert confirmation leaves the draft alone", () => {
    editor.openFiles = [conflictFile(true)]
    editor.activeFile = conflictFile(true)
    editor.confirmDiscardDraft.mockReturnValueOnce(false)
    render(<Harness />)

    fireEvent.click(screen.getByTestId("editor-conflict-reload"))
    expect(editor.reloadFile).not.toHaveBeenCalled()
  })

  it("shows the deleted banner and restores the buffer by force-saving", () => {
    const deleted = { ...conflictFile(true), deletedOnDisk: true, externallyChanged: false }
    editor.openFiles = [deleted]
    editor.activeFile = deleted
    render(<Harness />)

    expect(screen.getByTestId("editor-deleted-banner")).toHaveTextContent("sync.deletedBanner")
    expect(screen.queryByTestId("editor-conflict-banner")).toBeNull()
    fireEvent.click(screen.getByTestId("editor-deleted-restore"))
    expect(editor.saveFile).toHaveBeenCalledWith("src/a.ts", { force: true })
    fireEvent.click(screen.getByTestId("editor-deleted-close"))
    expect(editor.closeFile).toHaveBeenCalledWith("src/a.ts")
  })

  it("a clean externally-changed file offers Compare and Reload, never Save Mine", async () => {
    editor.openFiles = [conflictFile(false)]
    editor.activeFile = conflictFile(false)
    render(<Harness />)

    expect(screen.getByTestId("editor-conflict-banner")).toHaveTextContent("sync.externalBanner")
    // Overwriting disk with a clean, stale buffer would silently revert the
    // external change — there is no "my version" to keep.
    expect(screen.queryByTestId("editor-conflict-save")).toBeNull()
    // Compare is the same question the status-bar chip answers: what changed.
    fireEvent.click(screen.getByTestId("editor-conflict-compare"))
    expect(await screen.findByTestId("editor-compare-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("editor-compare-reload")).toBeInTheDocument()
    expect(screen.queryByTestId("editor-compare-save")).toBeNull()
  })
})

it("updates the memoized tree when the active path changes", () => {
  const view = render(<Harness />)
  editor.activePath = "src/b.ts"
  view.rerender(<Harness />)
  expect(screen.getByTestId("tree")).toHaveAttribute("data-path", "src/b.ts")
})

describe("confirm dialog host", () => {
  // The workbench injects `confirm` into useProjectEditor — the mock captures
  // the arg so a test can drive the AlertDialog end to end.
  const confirmArg = () => {
    const { useProjectEditor } = jest.requireMock("./use-project-editor") as {
      useProjectEditor: jest.Mock
    }
    const last = useProjectEditor.mock.calls.at(-1)
    return last?.[0].confirm as (req: {
      message: string
      confirmLabel: string
      saveLabel?: string
    }) => Promise<string>
  }

  it("renders the request and resolves 'confirm' on the action button", async () => {
    render(<Harness />)
    let verdict!: Promise<string>
    act(() => {
      verdict = confirmArg()({ message: "Discard a.ts?", confirmLabel: "confirmDontSave" })
    })

    expect(screen.getByTestId("editor-confirm-dialog")).toHaveTextContent("Discard a.ts?")
    fireEvent.click(screen.getByTestId("editor-confirm-action"))

    await expect(verdict).resolves.toBe("confirm")
    expect(screen.queryByTestId("editor-confirm-dialog")).toBeNull()
  })

  it("resolves 'cancel' on cancel", async () => {
    render(<Harness />)
    let verdict!: Promise<string>
    act(() => {
      verdict = confirmArg()({ message: "Overwrite?", confirmLabel: "confirmOverwrite" })
    })

    fireEvent.click(screen.getByText("cancel"))
    await expect(verdict).resolves.toBe("cancel")
    expect(screen.queryByTestId("editor-confirm-dialog")).toBeNull()
  })

  it("a saveLabel request offers a third 'save' answer", async () => {
    render(<Harness />)
    let verdict!: Promise<string>
    act(() => {
      verdict = confirmArg()({
        message: "a.ts has unsaved changes.",
        confirmLabel: "confirmDontSave",
        saveLabel: "confirmSave",
      })
    })

    expect(screen.getByTestId("editor-confirm-save")).toHaveTextContent("confirmSave")
    fireEvent.click(screen.getByTestId("editor-confirm-save"))
    await expect(verdict).resolves.toBe("save")
  })

  it("a second prompt supersedes and refuses the first", async () => {
    render(<Harness />)
    let first!: Promise<string>
    let second!: Promise<string>
    act(() => {
      first = confirmArg()({ message: "first?", confirmLabel: "confirmDiscard" })
    })
    act(() => {
      second = confirmArg()({ message: "second?", confirmLabel: "confirmOverwrite" })
    })

    // Only the latest request stays on screen; the superseded one is a "no".
    expect(screen.getByTestId("editor-confirm-dialog")).toHaveTextContent("second?")
    await expect(first).resolves.toBe("cancel")

    fireEvent.click(screen.getByTestId("editor-confirm-action"))
    await expect(second).resolves.toBe("confirm")
  })
})

describe("editor groups and command palette", () => {
  const fileA = {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    savedContent: "a",
    draftContent: "a",
    draftVersion: 1,
  }
  const fileB = {
    relPath: "src/b.ts",
    absolutePath: "/repo/src/b.ts",
    savedContent: "b",
    draftContent: "b",
    draftVersion: 1,
  }

  it("⌘\\ moves the active editor into a second group with its own Monaco", async () => {
    editor.openFiles = [fileA, fileB]
    const view = render(<Harness />)
    expect(screen.queryByTestId("editor-group-1")).not.toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId("monaco"), { key: "\\", metaKey: true })
    await waitFor(() => expect(screen.getByTestId("editor-group-1")).toBeInTheDocument())
    expect(screen.getAllByTestId("monaco")).toHaveLength(2)
    // Focus follows the moved editor — the split pane is now the focused one.
    expect(screen.getByTestId("editor-group-1")).toHaveAttribute("data-focused", "true")
    expect(screen.getByTestId("editor-group-0")).not.toHaveAttribute("data-focused")

    // ⌘1 asks to activate group 0's remembered tab; the real hook then moves
    // `activePath`, which the mock's inert setter cannot — simulate the state
    // write the real editor would have made.
    fireEvent.keyDown(screen.getByTestId("editor-group-1"), { key: "1", metaKey: true })
    expect(editor.setActivePath).toHaveBeenCalledWith("src/b.ts")
    act(() => {
      editor.activePath = "src/b.ts"
    })
    view.rerender(<Harness />)
    await waitFor(() =>
      expect(screen.getByTestId("editor-group-0")).toHaveAttribute("data-focused", "true")
    )
    expect(screen.getByTestId("editor-group-1")).not.toHaveAttribute("data-focused")

    // The last member leaving group 1 collapses the split back to one pane.
    act(() => {
      editor.openFiles = [fileB]
    })
    view.rerender(<Harness />)
    await waitFor(() => expect(screen.queryByTestId("editor-group-1")).not.toBeInTheDocument())
  })

  it("an already-split file activates its own group instead of relocating", async () => {
    editor.openFiles = [fileA, fileB]
    const view = render(<Harness />)
    fireEvent.keyDown(screen.getByTestId("monaco"), { key: "\\", metaKey: true })
    await waitFor(() => expect(screen.getByTestId("editor-group-1")).toBeInTheDocument())

    // Focus group 0 — same inert-setter simulation as above — then open a
    // file that does not live in the split: group 0 must keep focus.
    fireEvent.keyDown(screen.getByTestId("editor-group-1"), { key: "1", metaKey: true })
    act(() => {
      editor.activePath = "src/b.ts"
    })
    view.rerender(<Harness />)
    await waitFor(() =>
      expect(screen.getByTestId("editor-group-0")).toHaveAttribute("data-focused", "true")
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId("tree"))
    })
    expect(screen.getByTestId("editor-group-0")).toHaveAttribute("data-focused", "true")
  })

  it("⌘⇧P opens the palette seeded with '>' and ⌘P opens it bare", () => {
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId("monaco"), { key: "p", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("quick-open")).toBeInTheDocument()
    expect(quickOpenProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, seedQuery: { text: ">" } })
    )

    fireEvent.keyDown(screen.getByTestId("monaco"), { key: "p", metaKey: true })
    expect(quickOpenProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, seedQuery: { text: "" } })
    )
  })

  it("commands the workbench registers ride the palette's command list", () => {
    render(<Harness />)
    const commands = quickOpenProps.mock.calls.at(-1)?.[0]?.commands as
      Array<{ id: string; label: string; hint?: string }> | undefined
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "file.save", hint: "⌘S" }),
        expect.objectContaining({ id: "workbench.commandPalette", hint: "⇧⌘P" }),
        expect.objectContaining({ id: "editor.splitRight" }),
        expect.objectContaining({ id: "workbench.toggleMinimap" }),
        expect.objectContaining({ id: "workbench.toggleSidebar", hint: "⌘B" }),
      ])
    )
  })
})

describe("split layout session persistence", () => {
  it("restores group membership and focus from the session record", async () => {
    useProjectEditorSessionStore.setState({
      sessions: {
        "session:s1": {
          rootKey: "/repo",
          openPaths: ["src/a.ts", "src/b.ts"],
          activePath: "src/b.ts",
          splitPaths: ["src/b.ts"],
          groupActivePaths: ["src/a.ts", "src/b.ts"],
          focusedGroup: 1,
        },
      },
    })
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    editor.activePath = "src/b.ts"
    render(<Harness />)

    await waitFor(() => expect(screen.getByTestId("editor-group-1")).toBeInTheDocument())
    expect(screen.getByTestId("editor-group-1")).toHaveAttribute("data-focused", "true")
  })

  it("waits for the editor's session restore before seeding the split", async () => {
    // The editor reopens persisted files in a sequential `await openFile`
    // loop; `isPathOpen` only answers for the whole set once
    // `sessionRestored` flips. Restoring earlier filtered every path out.
    useProjectEditorSessionStore.setState({
      sessions: {
        "session:s1": {
          rootKey: "/repo",
          openPaths: ["src/a.ts", "src/b.ts"],
          activePath: "src/b.ts",
          splitPaths: ["src/b.ts"],
          groupActivePaths: ["src/a.ts", "src/b.ts"],
          focusedGroup: 1,
        },
      },
    })
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    editor.activePath = "src/b.ts"
    editor.sessionRestored = false
    const { rerender } = render(<Harness />)
    expect(screen.queryByTestId("editor-group-1")).not.toBeInTheDocument()

    editor.sessionRestored = true
    rerender(<Harness />)
    await waitFor(() => expect(screen.getByTestId("editor-group-1")).toBeInTheDocument())
    expect(screen.getByTestId("editor-group-1")).toHaveAttribute("data-focused", "true")
  })

  it("writes group membership into the session record on split", async () => {
    useProjectEditorSessionStore.setState({
      sessions: {
        "session:s1": {
          rootKey: "/repo",
          openPaths: ["src/a.ts", "src/b.ts"],
          activePath: "src/a.ts",
        },
      },
    })
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    editor.activePath = "src/a.ts"
    render(<Harness />)

    fireEvent.keyDown(screen.getByTestId("tabs").parentElement!, {
      key: "\\",
      metaKey: true,
    })
    await waitFor(() => {
      const session = useProjectEditorSessionStore.getState().sessions["session:s1"]
      expect(session?.splitPaths).toEqual(["src/a.ts"])
      expect(session?.focusedGroup).toBe(1)
    })
  })

  it("does not seed a stray session before the editor persists one", () => {
    render(<Harness />)
    expect(useProjectEditorSessionStore.getState().sessions["session:s1"]).toBeUndefined()
  })
})

describe("cross-group tab drag", () => {
  it("moves a dragged tab into the group it was dropped on", async () => {
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }]
    editor.activePath = "src/a.ts"
    render(<Harness />)

    // ⌘\ splits the active file into group 1.
    fireEvent.keyDown(screen.getByTestId("tabs").parentElement!, {
      key: "\\",
      metaKey: true,
    })
    expect(screen.getByTestId("editor-group-1")).toBeInTheDocument()

    // Dragging it back onto group 0 collapses the split again.
    fireEvent.drop(screen.getByTestId("editor-group-0"), {
      dataTransfer: {
        getData: () => "src/a.ts",
        types: ["application/x-cognia-editor-tab"],
      },
    })
    await waitFor(() => expect(screen.queryByTestId("editor-group-1")).toBeNull())
  })
})

describe("most-recently-used order", () => {
  it("cycles ctrl+tab by recency, not tab order", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }, { relPath: "src/c.ts" }]
    editor.activePath = "src/a.ts"
    const { rerender } = render(<Harness />)
    // Activation history a → b → c makes the MRU walk [c, b, a]; a positional
    // walk from c would wrap to a, so b proves the MRU semantics.
    editor.activePath = "src/b.ts"
    rerender(<Harness />)
    editor.activePath = "src/c.ts"
    rerender(<Harness />)

    fireEvent.keyDown(screen.getByTestId("tabs").parentElement!, {
      key: "Tab",
      ctrlKey: true,
    })
    expect(editor.setActivePath).toHaveBeenLastCalledWith("src/b.ts")
  })

  it("feeds quick open's editor group in recency order", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }, { relPath: "src/c.ts" }]
    editor.activePath = "src/a.ts"
    const { rerender } = render(<Harness />)
    editor.activePath = "src/b.ts"
    rerender(<Harness />)
    editor.activePath = "src/c.ts"
    rerender(<Harness />)

    expect(quickOpenProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ openPaths: ["src/c.ts", "src/b.ts", "src/a.ts"] })
    )
  })
})

describe("status-bar model actions", () => {
  it("routes indentation, EOL and language changes to the focused model", async () => {
    editor.openFiles = [{ relPath: "src/a.ts", monacoLanguage: "typescript" }]
    editor.activeFile = {
      relPath: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
      savedContent: "old",
      draftContent: "old",
      draftVersion: 1,
      monacoLanguage: "typescript",
    }
    render(<Harness />)
    fireEvent.click(screen.getByTestId("mount-monaco"))

    await waitFor(() =>
      expect(statusBarProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          indent: expect.objectContaining({ tabSize: 4, insertSpaces: true }),
          onToggleEol: expect.any(Function),
          language: expect.objectContaining({ value: expect.any(String) }),
        })
      )
    )
    const props = statusBarProps.mock.calls.at(-1)![0] as {
      indent: { onChange: (o: { insertSpaces: boolean; tabSize: number }) => void }
      onToggleEol: () => void
      language: { onChange: (id: string) => void }
    }

    act(() => props.indent.onChange({ insertSpaces: false, tabSize: 2 }))
    expect(monacoModel.updateOptions).toHaveBeenCalledWith({ insertSpaces: false, tabSize: 2 })
    await waitFor(() =>
      expect(statusBarProps).toHaveBeenLastCalledWith(
        expect.objectContaining({
          indent: expect.objectContaining({ tabSize: 2, insertSpaces: false }),
        })
      )
    )

    act(() => props.onToggleEol())
    expect(monacoModel.setEOL).toHaveBeenCalledWith(1)

    act(() => props.language.onChange("markdown"))
    expect(monacoSetModelLanguage).toHaveBeenCalledWith(monacoModel, "markdown")
  })

  it("carries the status bar's model controls in the palette, where a narrow dock folds them", async () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    const commands = () =>
      (
        quickOpenProps.mock.calls.at(-1)![0] as {
          commands: Array<{ id: string; label: string; run: () => void }>
        }
      ).commands
    const run = (id: string) =>
      act(() =>
        commands()
          .find((c) => c.id === id)!
          .run()
      )
    const modelCommands = [
      "editor.indentUsingSpaces",
      "editor.indentUsingTabs",
      "editor.convertIndentationToSpaces",
      "editor.convertIndentationToTabs",
      "editor.changeEol",
    ]
    // Nothing to act on before Monaco hands over its model.
    expect(commands().map((c) => c.id)).toEqual(expect.not.arrayContaining(modelCommands))

    fireEvent.click(screen.getByTestId("mount-monaco"))
    await waitFor(() =>
      expect(commands().map((c) => c.id)).toEqual(expect.arrayContaining(modelCommands))
    )
    expect(commands().find((c) => c.id === "editor.indentUsingTabs")!.label).toBe(
      "statusBar.indentUsingTabs"
    )
    expect(commands().find((c) => c.id === "editor.changeEol")!.label).toBe("command.changeEol")

    // Switching the mode keeps the model's tab size.
    run("editor.indentUsingTabs")
    expect(monacoModel.updateOptions).toHaveBeenLastCalledWith({ insertSpaces: false, tabSize: 4 })
    run("editor.indentUsingSpaces")
    expect(monacoModel.updateOptions).toHaveBeenLastCalledWith({ insertSpaces: true, tabSize: 4 })
    run("editor.convertIndentationToTabs")
    expect(monacoEditorAction).toHaveBeenLastCalledWith("editor.action.indentationToTabs")
    run("editor.convertIndentationToSpaces")
    expect(monacoEditorAction).toHaveBeenLastCalledWith("editor.action.indentationToSpaces")
    run("editor.changeEol")
    expect(monacoModel.setEOL).toHaveBeenCalledWith(1)
  })

  it("keeps the model controls out of the phone palette, which edits in CodeMirror", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<MobileHarness />)
    const ids = (
      quickOpenProps.mock.calls.at(-1)![0] as { commands: Array<{ id: string }> }
    ).commands.map((c) => c.id)
    expect(ids).not.toContain("editor.indentUsingSpaces")
    expect(ids).not.toContain("editor.changeEol")
  })

  it("leaves status-bar model actions inert until a Monaco handle mounts", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    const props = statusBarProps.mock.calls.at(-1)![0] as {
      indent: unknown
      onToggleEol: unknown
      language: unknown
    }
    expect(props.indent).toBeNull()
    expect(props.onToggleEol).toBeNull()
    expect(props.language).toBeNull()
  })
})

describe("injected backend deps", () => {
  it("forwards searchDeps and quickOpenDeps to the panels", () => {
    const search = jest.fn()
    const walk = jest.fn()
    render(<Harness workbenchProps={{ searchDeps: { search }, quickOpenDeps: { walk } }} />)
    expect(searchPanelProps).toHaveBeenLastCalledWith(expect.objectContaining({ deps: { search } }))
    expect(quickOpenProps).toHaveBeenLastCalledWith(expect.objectContaining({ deps: { walk } }))
  })
})

describe("in-editor rich preview", () => {
  const openMarkdown = () => {
    editor.activePath = "src/doc.md"
    editor.activeFile = {
      relPath: "src/doc.md",
      absolutePath: "/repo/src/doc.md",
      savedContent: "# Hi",
      draftContent: "# Hi\n\n**draft**",
      draftVersion: 2,
    }
    editor.openFiles = [
      {
        relPath: "src/doc.md",
        absolutePath: "/repo/src/doc.md",
        savedContent: "# Hi",
        draftContent: "# Hi\n\n**draft**",
        draftVersion: 2,
      },
    ]
  }

  it("shows the preview eye only for files the viewer registry can render", () => {
    render(<Harness />)
    // src/a.ts — nothing in the registry renders TypeScript.
    expect(screen.queryByTestId("editor-preview-toggle")).toBeNull()
  })

  it("toggles the overlay via the title eye and feeds it the live draft", () => {
    openMarkdown()
    render(<Harness />)
    const eye = screen.getByTestId("editor-preview-toggle")
    fireEvent.click(eye)
    const overlay = screen.getByTestId("editor-preview-overlay")
    expect(overlay.querySelector("[data-testid=file-preview-panel]")).not.toBeNull()
    // The panel renders the draft buffer, not disk content.
    expect(previewPanelProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ relPath: "src/doc.md", content: "# Hi\n\n**draft**" })
    )
    // The editor stays mounted underneath — undo stack survives the toggle.
    expect(screen.getByTestId("monaco")).not.toBeNull()
    fireEvent.click(eye)
    expect(screen.queryByTestId("editor-preview-overlay")).toBeNull()
  })

  it("toggles the overlay on mod+shift+V and ignores unrenderable files", () => {
    openMarkdown()
    const view = render(<Harness />)
    const surface = () => screen.getByTestId("tabs").parentElement!
    fireEvent.keyDown(surface(), { key: "V", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("editor-preview-overlay")).not.toBeNull()
    fireEvent.keyDown(surface(), { key: "V", metaKey: true, shiftKey: true })
    expect(screen.queryByTestId("editor-preview-overlay")).toBeNull()

    // A .ts tab never gets the chord's preview.
    editor.activePath = "src/a.ts"
    editor.activeFile = {
      relPath: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
      savedContent: "old",
      draftContent: "old",
      draftVersion: 1,
    }
    editor.openFiles = [{ relPath: "src/a.ts" }]
    view.rerender(<Harness />)
    // The chord is still ours — it prevents default but the command no-ops
    // on a file nothing can render.
    expect(fireEvent.keyDown(surface(), { key: "V", metaKey: true, shiftKey: true })).toBe(false)
    expect(screen.queryByTestId("editor-preview-overlay")).toBeNull()
  })

  it("opens the preview to the side on the mod+K V chord", () => {
    openMarkdown()
    render(<Harness />)
    const surface = () => screen.getByTestId("tabs").parentElement!
    fireEvent.keyDown(surface(), { key: "k", metaKey: true })
    fireEvent.keyDown(surface(), { key: "v" })
    const group2 = screen.getByTestId("editor-group-1")
    expect(group2.getAttribute("data-focused")).toBe("true")
    expect(group2.querySelector("[data-testid=editor-preview-overlay]")).not.toBeNull()
  })

  it("clears an armed mod+K chord when the next key is not V", () => {
    openMarkdown()
    render(<Harness />)
    const surface = () => screen.getByTestId("tabs").parentElement!
    fireEvent.keyDown(surface(), { key: "k", metaKey: true })
    fireEvent.keyDown(surface(), { key: "x" })
    expect(screen.queryByTestId("editor-group-1")).toBeNull()
    expect(screen.queryByTestId("editor-preview-overlay")).toBeNull()
  })
})

describe("word wrap and font zoom", () => {
  const surface = () => screen.getByTestId("tabs").parentElement!
  const lastMonacoProps = () =>
    monacoProps.mock.calls.at(-1)![0] as { wordWrap?: boolean; fontSize?: number }

  it("toggles word wrap per file on alt+Z (event.code survives the ⌥ glyph)", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    // macOS reports key "Ω" for ⌥Z — the chord matches on event.code.
    fireEvent.keyDown(surface(), { key: "Ω", code: "KeyZ", altKey: true })
    expect(lastMonacoProps().wordWrap).toBe(true)
    fireEvent.keyDown(surface(), { key: "Ω", code: "KeyZ", altKey: true })
    expect(lastMonacoProps().wordWrap).toBe(false)
  })

  it("zooms the editor font on mod+= / mod+- and resets on mod+0", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    expect(lastMonacoProps().fontSize).toBe(13)
    expect(fireEvent.keyDown(surface(), { key: "=", metaKey: true })).toBe(false)
    expect(lastMonacoProps().fontSize).toBe(14)
    // Shifted glyph reaches the same key.
    fireEvent.keyDown(surface(), { key: "+", metaKey: true, shiftKey: true })
    expect(lastMonacoProps().fontSize).toBe(15)
    fireEvent.keyDown(surface(), { key: "-", metaKey: true })
    expect(lastMonacoProps().fontSize).toBe(14)
    fireEvent.keyDown(surface(), { key: "0", metaKey: true })
    expect(lastMonacoProps().fontSize).toBe(13)
  })

  it("exposes the commands in the palette only when they apply", () => {
    render(<Harness />)
    const commandIds = () =>
      (quickOpenProps.mock.calls.at(-1)![0] as { commands: Array<{ id: string }> }).commands.map(
        (c) => c.id
      )
    // .ts active — preview commands hidden, wrap/zoom always present.
    expect(commandIds()).not.toContain("editor.togglePreview")
    expect(commandIds()).toContain("editor.toggleWordWrap")
    expect(commandIds()).toContain("editor.fontZoomIn")

    editor.activePath = "src/doc.md"
    editor.activeFile = { relPath: "src/doc.md", draftContent: "# x", savedContent: "# x" }
    editor.openFiles = [{ relPath: "src/doc.md" }]
    render(<Harness />)
    expect(commandIds()).toContain("editor.togglePreview")
    expect(commandIds()).toContain("editor.previewToSide")
  })
})

describe("zen mode and go to symbol", () => {
  // Monaco persists through zen while the tab strip unmounts — it is the
  // stable keydown surface inside the workbench's onKeyDown div.
  const zenChord = () => {
    const monaco = screen.getByTestId("monaco")
    fireEvent.keyDown(monaco, { key: "k", metaKey: true })
    fireEvent.keyDown(monaco, { key: "z" })
  }

  it("⌘K Z hides rail/sidebar/tabs/status-bar but keeps the editors", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    expect(screen.getByTestId("project-editor-activity-rail")).toBeInTheDocument()

    zenChord()
    expect(screen.queryByTestId("project-editor-activity-rail")).toBeNull()
    expect(screen.queryByTestId("project-editor-sidebar-content")).toBeNull()
    expect(screen.queryByTestId("tabs")).toBeNull()
    expect(screen.queryByTestId("status-bar")).toBeNull()
    expect(screen.queryByTestId("project-context-workbench")).toBeNull()
    expect(screen.getByTestId("monaco")).toBeInTheDocument()
    expect(screen.getByTestId("editor-group-0")).toBeInTheDocument()

    zenChord()
    expect(screen.getByTestId("project-editor-activity-rail")).toBeInTheDocument()
    expect(screen.getByTestId("tabs")).toBeInTheDocument()
    expect(screen.getByTestId("status-bar")).toBeInTheDocument()
  })

  it("exits zen on Esc Esc while a lone Escape stays untouched", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    zenChord()
    expect(screen.queryByTestId("project-editor-activity-rail")).toBeNull()

    // One Escape belongs to Monaco (find widget, suggestions) — never
    // swallowed, zen stays.
    const monaco = screen.getByTestId("monaco")
    expect(fireEvent.keyDown(monaco, { key: "Escape" })).toBe(true)
    expect(screen.queryByTestId("project-editor-activity-rail")).toBeNull()

    // The second tap inside 500ms is the exit gesture.
    fireEvent.keyDown(monaco, { key: "Escape" })
    expect(screen.getByTestId("project-editor-activity-rail")).toBeInTheDocument()
  })

  it("a non-Z key after ⌘K clears the chord without entering zen", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    const monaco = screen.getByTestId("monaco")
    fireEvent.keyDown(monaco, { key: "k", metaKey: true })
    fireEvent.keyDown(monaco, { key: "x" })
    expect(screen.getByTestId("project-editor-activity-rail")).toBeInTheDocument()
  })

  it("⌘⇧O opens quick open seeded with '@' and the live draft document", () => {
    editor.activeFile = {
      relPath: "src/a.ts",
      absolutePath: "/repo/src/a.ts",
      monacoLanguage: "typescript",
      savedContent: "old",
      draftContent: "export const draft = 1",
      draftVersion: 2,
    }
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId("monaco"), {
      key: "o",
      metaKey: true,
      shiftKey: true,
    })
    expect(quickOpenProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        seedQuery: { text: "@" },
        activeDocument: expect.objectContaining({
          relPath: "src/a.ts",
          language: "typescript",
          content: "export const draft = 1",
        }),
      })
    )
  })

  it("registers zen and symbol commands in the palette", () => {
    render(<Harness />)
    const commands = quickOpenProps.mock.calls.at(-1)?.[0]?.commands as
      Array<{ id: string; hint?: string }> | undefined
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "workbench.zenMode", hint: "⌘K Z" }),
        expect.objectContaining({ id: "editor.goToSymbol", hint: "⇧⌘O" }),
      ])
    )
  })

  it("leaves the mobile layout untouched: no zen command, and ⌘K Z is inert", () => {
    render(<MobileHarness />)
    const commands = quickOpenProps.mock.calls.at(-1)?.[0]?.commands as
      Array<{ id: string; run: () => void }> | undefined
    // Zen is a desktop-only chrome toggle — mobile keeps its own panes.
    expect(commands!.map((c) => c.id)).not.toContain("workbench.zenMode")
    const root = screen.getByTestId("project-editor-mobile-layout")
    fireEvent.keyDown(root, { key: "k", metaKey: true })
    fireEvent.keyDown(root, { key: "z" })
    expect(screen.getByTestId("project-editor-mobile-layout")).toBeInTheDocument()
    expect(screen.getByTestId("project-editor-mobile-nav")).toBeInTheDocument()
  })
})

describe("problems panel", () => {
  it("⌘⇧M toggles the panel; Esc-less close via the X button", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId("monaco"), { key: "m", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("problems-panel")).toBeInTheDocument()
    // No Monaco handles mounted → empty workspace state (i18n mock → key).
    expect(screen.getByText("problems.empty")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("problems-close"))
    expect(screen.queryByTestId("problems-panel")).toBeNull()
  })

  it("lists workspace markers and navigates on row click", async () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    fireEvent.click(screen.getByTestId("mount-monaco"))
    fireEvent.keyDown(screen.getByTestId("monaco"), { key: "m", metaKey: true, shiftKey: true })

    // monacoNs reports one error marker at file:///repo/src/a.ts line 3.
    const row = await screen.findByTestId("problems-marker-src/a.ts-3-5")
    expect(row).toHaveTextContent("boom")
    fireEvent.click(row)
    // gotoLine opens the file (pinned) before jumping — the mock records it.
    await waitFor(() => expect(editor.openFile).toHaveBeenCalledWith("src/a.ts"))
  })

  it("the status-bar counts chip opens the panel", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    const props = statusBarProps.mock.calls.at(-1)?.[0] as { onProblemsClick?: () => void }
    act(() => props.onProblemsClick?.())
    expect(screen.getByTestId("problems-panel")).toBeInTheDocument()
  })

  it("zen mode hides the panel and registers the palette command", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    const monaco = screen.getByTestId("monaco")
    fireEvent.keyDown(monaco, { key: "m", metaKey: true, shiftKey: true })
    expect(screen.getByTestId("problems-panel")).toBeInTheDocument()

    fireEvent.keyDown(monaco, { key: "k", metaKey: true })
    fireEvent.keyDown(monaco, { key: "z" })
    expect(screen.queryByTestId("problems-panel")).toBeNull()

    const commands = quickOpenProps.mock.calls.at(-1)?.[0]?.commands as
      Array<{ id: string; hint?: string }> | undefined
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "workbench.toggleProblems", hint: "⇧⌘M" }),
      ])
    )
  })
})

describe("context-menu agent linkage", () => {
  const lastTreeProps = () =>
    fileTreeProps.mock.calls.at(-1)?.[0] as Record<
      string,
      ((...args: unknown[]) => void) | undefined
    >
  const lastTabsProps = () =>
    editorTabsProps.mock.calls.at(-1)?.[0] as Record<
      string,
      ((...args: unknown[]) => void) | undefined
    >

  it("wires open-to-side/find-in-folder/add-to-chat onto the tree; no system reveal in the browser", () => {
    render(<Harness />)
    const props = lastTreeProps()
    expect(props.onOpenToSide).toEqual(expect.any(Function))
    expect(props.onAddToChat).toEqual(expect.any(Function))
    expect(props.onFindInFolder).toEqual(expect.any(Function))
    // The OS file manager exists only under Tauri — the browser passes no
    // handler so the row hides the entry instead of offering a dead click.
    expect(props.onRevealInSystem).toBeUndefined()
  })

  it("open-to-side opens the file pinned and marks group-two membership", async () => {
    render(<Harness />)
    await act(async () => {
      lastTreeProps().onOpenToSide?.("src/tree.ts")
    })
    expect(editor.openFile).toHaveBeenCalledWith("src/tree.ts", { mode: "pinned" })
  })

  it("find-in-folder scopes the search panel to the directory", async () => {
    render(<Harness />)
    await act(async () => {
      lastTreeProps().onFindInFolder?.("src")
    })
    const props = searchPanelProps.mock.calls.at(-1)?.[0] as {
      scopeRelPath?: string
      onClearScope?: () => void
    }
    expect(props.scopeRelPath).toBe("src")
    // Clearing the chip unscopes the panel again.
    await act(async () => props.onClearScope?.())
    expect(
      (searchPanelProps.mock.calls.at(-1)?.[0] as { scopeRelPath?: string }).scopeRelPath
    ).toBeNull()
  })

  it("tree add-to-chat stages a FileSelectionRef with the live draft", async () => {
    const onSendToChat = jest.fn()
    editor.openFiles = [
      { relPath: "src/a.ts", draftContent: "unsaved draft\n", savedContent: "old" },
    ]
    render(<Harness workbenchProps={{ onSendToChat }} />)
    await act(async () => {
      lastTreeProps().onAddToChat?.("src/a.ts", false)
    })
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1))
    expect(onSendToChat.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        kind: "file",
        relPath: "src/a.ts",
        snapshot: "unsaved draft\n",
      })
    )
    editor.openFiles = []
  })

  it("a folder stages a directory listing, not a file body", async () => {
    const onSendToChat = jest.fn()
    ;(editor.deps.listDir as jest.Mock).mockResolvedValue([
      { relPath: "src/a.ts", isDir: false },
      { relPath: "src/nested", isDir: true },
    ])
    render(<Harness workbenchProps={{ onSendToChat }} />)
    await act(async () => {
      lastTreeProps().onAddToChat?.("src", true)
    })
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1))
    const sel = onSendToChat.mock.calls[0][0]
    expect(sel).toEqual(expect.objectContaining({ kind: "file", relPath: "src" }))
    expect(sel.snapshot).toContain("src/ (2 items)")
    expect(sel.snapshot).toContain("nested/")
  })

  it("tab add-to-chat stages the clicked tab's file, not the active one", async () => {
    const onSendToChat = jest.fn()
    render(<Harness workbenchProps={{ onSendToChat }} />)
    await act(async () => {
      lastTabsProps().onAddToChat?.("src/b.ts")
    })
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1))
    expect(onSendToChat.mock.calls[0][0].relPath).toBe("src/b.ts")
  })

  it("tab reveal-in-explorer hands the tree a reveal request", async () => {
    render(<Harness />)
    await act(async () => {
      lastTabsProps().onRevealInExplorer?.("src/b.ts")
    })
    const props = fileTreeProps.mock.calls.at(-1)?.[0] as {
      revealRequest?: { path: string }
    }
    expect(props.revealRequest?.path).toBe("src/b.ts")
  })

  it("the editor's Add File to Chat action stages the active file", async () => {
    const onSendToChat = jest.fn()
    render(<Harness workbenchProps={{ onSendToChat }} />)
    fireEvent.click(screen.getByTestId("workbench.addFileToChat"))
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1))
    expect(onSendToChat.mock.calls[0][0]).toEqual(
      expect.objectContaining({ kind: "file", relPath: "src/a.ts" })
    )
  })

  it("without a chat sink the default channel is the chat store", async () => {
    const { useChatStore } = await import("@/stores/chat")
    useChatStore.setState({ contextSelections: [] })
    render(<Harness />)
    await act(async () => {
      lastTabsProps().onAddToChat?.("src/b.ts")
    })
    await waitFor(() =>
      expect(
        useChatStore
          .getState()
          .contextSelections.some((s) => s.kind === "file" && s.relPath === "src/b.ts")
      ).toBe(true)
    )
    useChatStore.setState({ contextSelections: [] })
  })

  it("a problems marker stages with its line range", async () => {
    const onSendToChat = jest.fn()
    render(<Harness workbenchProps={{ onSendToChat }} />)
    fireEvent.click(screen.getByTestId("mount-monaco"))
    fireEvent.keyDown(screen.getByTestId("tabs").parentElement!, {
      key: "m",
      metaKey: true,
      shiftKey: true,
    })
    const markerRow = await screen.findByTestId("problems-marker-src/a.ts-3-5")
    fireEvent.contextMenu(markerRow)
    const menu = await screen.findByTestId("problems-marker-menu-src/a.ts-3")
    fireEvent.click(await within(menu).findByText("action.addToChat"))
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1))
    expect(onSendToChat.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        kind: "file",
        relPath: "src/a.ts",
        title: "a.ts:3",
        range: { startLine: 3, endLine: 3 },
      })
    )
  })
})

describe("mobile layout parity", () => {
  const commandIdsFor = () =>
    ((quickOpenProps.mock.calls.at(-1)?.[0]?.commands ?? []) as Array<{ id: string }>).map(
      (c) => c.id
    )

  it("lists only the commands a phone can run", () => {
    render(<MobileHarness />)
    const ids = commandIdsFor()
    for (const desktopOnly of [
      "workbench.toggleSidebar",
      "workbench.zenMode",
      "workbench.toggleProblems",
      "editor.nextProblem",
      "workbench.toggleMinimap",
      "editor.splitRight",
      "workbench.focusSecondGroup",
      "editor.format",
    ]) {
      expect(ids).not.toContain(desktopOnly)
    }
    for (const shared of [
      "file.save",
      "workbench.goToFile",
      "editor.goToSymbol",
      "editor.toggleWordWrap",
      "editor.fontZoomIn",
      "search.project",
    ]) {
      expect(ids).toContain(shared)
    }
  })

  it("renders a touch tab strip over the editor with the whole open set", () => {
    editor.openFiles = [
      { relPath: "src/a.ts", absolutePath: "/repo/src/a.ts", draftContent: "a", savedContent: "a" },
      { relPath: "src/b.ts", absolutePath: "/repo/src/b.ts", draftContent: "b", savedContent: "b" },
    ]
    editor.activeFile = editor.openFiles[0]
    render(<MobileHarness />)

    const props = editorTabsProps.mock.calls.at(-1)?.[0] as {
      density: string
      files: Array<{ relPath: string }>
      onCloseOthers: (relPath: string) => void
      onMoveToOtherGroup?: unknown
    }
    expect(props.density).toBe("touch")
    expect(props.files.map((f) => f.relPath)).toEqual(["src/a.ts", "src/b.ts"])
    expect(props.onMoveToOtherGroup).toBeUndefined()
    props.onCloseOthers("src/a.ts")
    expect(editor.closeFiles).toHaveBeenCalledWith(new Set(["src/b.ts"]))
  })

  it("keeps Open to the Side out of the phone's tree menu", () => {
    render(<MobileHarness />)
    expect(fileTreeProps.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ onOpenToSide: undefined })
    )
  })

  it("offers Go to File and the command palette from the pane headers", () => {
    render(<MobileHarness />)
    fireEvent.click(screen.getAllByTestId("project-editor-mobile-quick-open")[0])
    expect(quickOpenProps.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ open: true, seedQuery: { text: "" } })
    )
    fireEvent.click(screen.getAllByTestId("project-editor-mobile-palette")[0])
    expect(quickOpenProps.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ open: true, seedQuery: { text: ">" } })
    )
  })

  it("hides the sidebar shortcut from the empty state", () => {
    editor.activeFile = null
    editor.activePath = null
    render(<MobileHarness />)
    expect(screen.getByTestId("editor-empty-quick-open")).toBeInTheDocument()
    expect(screen.queryByTestId("editor-empty-sidebar")).toBeNull()
  })
})

describe("chord ownership", () => {
  it("stops a handled chord from reaching the app-wide dispatcher on window", () => {
    const windowListener = jest.fn()
    window.addEventListener("keydown", windowListener)
    try {
      render(<Harness />)
      fireEvent.keyDown(screen.getByTestId("tree"), { key: "p", metaKey: true })
      expect(screen.getByTestId("quick-open")).toBeInTheDocument()
      expect(windowListener).not.toHaveBeenCalled()
      // An unhandled chord still bubbles on.
      fireEvent.keyDown(screen.getByTestId("tree"), { key: "j", metaKey: true })
      expect(windowListener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener("keydown", windowListener)
    }
  })

  it("⌘2 creates the second group when there is none, like VS Code", () => {
    editor.openFiles = [{ relPath: "src/a.ts" }]
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId("tree"), { key: "2", metaKey: true })
    expect(screen.getByTestId("editor-group-1")).toBeInTheDocument()
  })

  it("registers ⌘K V, ⌘K Z and ⇧⌘O inside Monaco, where Monaco would swallow them", () => {
    render(<Harness />)
    const props = monacoProps.mock.calls.at(-1)?.[0] as { bindings: Record<string, string> }
    expect(props.bindings).toEqual(
      expect.objectContaining({
        "workbench.goToSymbol": "Ctrl+Shift+O",
        "workbench.previewToSide": "Ctrl+K V",
        "workbench.zenMode": "Ctrl+K Z",
      })
    )
    fireEvent.click(screen.getByTestId("workbench.goToSymbol"))
    expect(quickOpenProps.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ open: true, seedQuery: { text: "@" } })
    )
  })

  it("opens the workbench palette from the editor's Command Palette menu item", () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId("workbench.commandPalette"))
    expect(quickOpenProps.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ open: true, seedQuery: { text: ">" } })
    )
  })
})

describe("problems panel monaco source", () => {
  it("reads the global marker store even before any editor mounted", async () => {
    const { loadConfiguredMonaco } = jest.requireMock("@/lib/canvas/monaco-loader") as {
      loadConfiguredMonaco: jest.Mock
    }
    loadConfiguredMonaco.mockResolvedValue(monacoNs)
    editor.activeFile = null
    editor.activePath = null
    render(<Harness />)
    fireEvent.keyDown(screen.getByTestId("tree"), { key: "m", metaKey: true, shiftKey: true })
    expect(await screen.findByTestId("problems-file-src/a.ts")).toBeInTheDocument()
    loadConfiguredMonaco.mockResolvedValue(null)
  })
})
