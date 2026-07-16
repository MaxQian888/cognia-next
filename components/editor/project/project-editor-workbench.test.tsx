/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
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

import { ProjectEditorFileWorkbench, useProjectEditorWorkbench } from "./project-editor-workbench"

function Harness({ beforeOpen }: { beforeOpen?: () => void }) {
  const workbench = useProjectEditorWorkbench({
    scopeKey: "session:s1",
    workingDir: "/repo",
    beforeOpen,
  })
  return (
    <div onKeyDown={workbench.onKeyDown}>
      <ProjectEditorFileWorkbench
        workbench={workbench}
        sidebarPosition="right"
        showTabs
        panelIdPrefix="test"
      />
    </div>
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
  render(<Harness />)
  expect(screen.getByTestId("editor-empty")).toHaveTextContent("emptyEditor")
})
