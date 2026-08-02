/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }))
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

const editor = {
  scopeKey: "session:s1",
  deps: {},
  roots: [{ key: "/repo", label: "main", path: "/repo", isMain: true }],
  rootKey: "/repo",
  rootPath: "/repo",
  openFiles: [] as Array<Record<string, unknown>>,
  activePath: "src/a.ts" as string | null,
  activeFile: {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    savedContent: "old",
    draftContent: "old",
    draftVersion: 1,
  } as Record<string, unknown> | null,
  dirtyCount: 0,
  treeRefreshToken: 0,
  selectRoot: jest.fn(),
  openFile: jest.fn().mockResolvedValue(undefined),
  closeFile: jest.fn(),
  setActivePath: jest.fn(),
  setDraft: jest.fn(),
  saveFile: jest.fn().mockResolvedValue(undefined),
  saveAll: jest.fn().mockResolvedValue(undefined),
  renameOpenFile: jest.fn().mockResolvedValue(undefined),
}

jest.mock("./use-project-editor", () => ({
  useProjectEditor: jest.fn(() => editor),
}))
jest.mock("./project-editor-tabs", () => ({
  ProjectEditorTabs: () => <div data-testid="tabs" />,
}))
jest.mock("./project-file-tree", () => ({
  ProjectFileTree: ({
    onOpenFile,
  }: {
    onOpenFile: (path: string, options?: { mode?: string }) => void
  }) => (
    <button data-testid="tree" onClick={() => onOpenFile("src/tree.ts", { mode: "preview" })} />
  ),
}))
jest.mock("./project-search-panel", () => ({
  ProjectSearchPanel: ({ onOpenMatch }: { onOpenMatch: (path: string) => void }) => (
    <button data-testid="search" onClick={() => onOpenMatch("src/search.ts")} />
  ),
}))
// `mount-monaco` stands in for ProjectMonaco's real `onMount`, which is the
// only place the live monaco/editor instances surface.
jest.mock("./project-monaco", () => ({
  ProjectMonaco: ({
    actions,
    onDiagnosticsReady,
    onSelectionChange,
  }: {
    actions: Array<{ id: string; run?: () => void }>
    onDiagnosticsReady?: (relPath: string, next: unknown) => void
    onSelectionChange?: (selection: unknown) => void
  }) => (
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
            monaco: {
              editor: {
                getModelMarkers: () => [
                  {
                    severity: 8,
                    message: "boom",
                    startLineNumber: 3,
                    startColumn: 5,
                    endLineNumber: 3,
                    endColumn: 9,
                  },
                ],
                onDidChangeMarkers: () => ({ dispose: () => {} }),
              },
            },
            editor: {
              getSelection: () => ({
                startLineNumber: 2,
                startColumn: 1,
                endLineNumber: 2,
                endColumn: 6,
              }),
              getModel: () => ({ uri: "file:///repo/src/a.ts", getValueInRange: () => "const" }),
            },
          })
        }
      />
    </div>
  ),
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
jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      data-testid="light-editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

import { ProjectEditorFileWorkbench, useProjectEditorWorkbench } from "./project-editor-workbench"
import { PROJECT_EDITOR_GOTO_EVENT } from "./editor-events"

function Harness({
  beforeOpen,
  registerProjectOpener,
  sidebarPosition = "right",
  showContextWorkbench = true,
}: {
  beforeOpen?: () => void
  registerProjectOpener?: boolean
  sidebarPosition?: "left" | "right"
  showContextWorkbench?: boolean
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
        sidebarPosition={sidebarPosition}
        showTabs
        showContextWorkbench={showContextWorkbench}
        panelIdPrefix="test"
      />
    </div>
  )
}

function MobileHarness() {
  const workbench = useProjectEditorWorkbench({ scopeKey: "session:s1", workingDir: "/repo" })
  return (
    <ProjectEditorFileWorkbench
      workbench={workbench}
      sidebarPosition="right"
      panelIdPrefix="mobile-test"
      layout="mobile"
    />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  registerOpener.mockReturnValue(disposeOpener)
  projectContextWorkbenchProps.mockClear()
  editor.activePath = "src/a.ts"
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

it("supports the shared left-sidebar composition used by Agent Team", () => {
  render(<Harness sidebarPosition="left" />)

  expect(screen.getByTestId("tree")).toBeInTheDocument()
  expect(screen.getByTestId("monaco")).toBeInTheDocument()
})

it("mounts a resource-scoped Context Workbench for the active project file", () => {
  render(<Harness />)

  expect(screen.getByTestId("project-context-workbench")).toBeInTheDocument()
  expect(projectContextWorkbenchProps).toHaveBeenCalledWith(
    expect.objectContaining({
      scopeKey: "session:s1",
      rootPath: "/repo",
      file: expect.objectContaining({ relPath: "src/a.ts" }),
    })
  )
})

it("can omit the nested Context Workbench in a constrained embedded layout", () => {
  render(<Harness showContextWorkbench={false} />)

  expect(screen.getByTestId("monaco")).toBeInTheDocument()
  expect(screen.queryByTestId("project-context-workbench")).not.toBeInTheDocument()
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
