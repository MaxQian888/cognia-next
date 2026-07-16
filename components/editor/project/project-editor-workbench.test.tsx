/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }))
const disposeOpener = jest.fn()
const registerOpener = jest.fn((_args: unknown) => disposeOpener)
jest.mock("@/lib/files/project-editor-bridge", () => ({
  registerProjectEditorOpener: (args: unknown) => registerOpener(args),
}))
jest.mock("@/stores/canvas/keybinding-store", () => ({
  useKeybindingStore: (selector: (state: { bindings: Record<string, string> }) => unknown) =>
    selector({ bindings: {} }),
}))

const editor = {
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
}

jest.mock("./use-project-editor", () => ({
  useProjectEditor: jest.fn(() => editor),
}))
jest.mock("./project-editor-tabs", () => ({
  ProjectEditorTabs: () => <div data-testid="tabs" />,
}))
jest.mock("./project-file-tree", () => ({
  ProjectFileTree: ({ onOpenFile }: { onOpenFile: (path: string) => void }) => (
    <button data-testid="tree" onClick={() => onOpenFile("src/tree.ts")} />
  ),
}))
jest.mock("./project-search-panel", () => ({
  ProjectSearchPanel: ({ onOpenMatch }: { onOpenMatch: (path: string) => void }) => (
    <button data-testid="search" onClick={() => onOpenMatch("src/search.ts")} />
  ),
}))
jest.mock("./project-monaco", () => ({
  ProjectMonaco: ({ actions }: { actions: Array<{ id: string; run?: () => void }> }) => (
    <div data-testid="monaco">
      {actions.map((action) => (
        <button key={action.id} data-testid={action.id} onClick={action.run} />
      ))}
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

function Harness({
  beforeOpen,
  sidebarPosition = "right",
}: {
  beforeOpen?: () => void
  sidebarPosition?: "left" | "right"
}) {
  const workbench = useProjectEditorWorkbench({
    scopeKey: "session:s1",
    workingDir: "/repo",
    beforeOpen,
  })
  return (
    <div onKeyDown={workbench.onKeyDown}>
      <ProjectEditorFileWorkbench
        workbench={workbench}
        sidebarPosition={sidebarPosition}
        showTabs
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
  editor.activePath = "src/a.ts"
  editor.activeFile = {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    savedContent: "old",
    draftContent: "old",
  }
})

it("shares file navigation, search actions, and keyboard saves", () => {
  const beforeOpen = jest.fn()
  render(<Harness beforeOpen={beforeOpen} />)

  fireEvent.click(screen.getByTestId("tree"))
  expect(beforeOpen).toHaveBeenCalled()
  expect(editor.openFile).toHaveBeenCalledWith("src/tree.ts")

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

it("supports the shared left-sidebar composition used by Agent Team", () => {
  render(<Harness sidebarPosition="left" />)

  expect(screen.getByTestId("tree")).toBeInTheDocument()
  expect(screen.getByTestId("monaco")).toBeInTheDocument()
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
  fireEvent.click(screen.getByTestId("tree"))
  expect(editor.openFile).toHaveBeenCalledWith("src/tree.ts")
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
