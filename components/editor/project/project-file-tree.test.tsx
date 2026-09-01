/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function mockIconThemeSubscribers(): Array<() => void> {
  const state = globalThis as typeof globalThis & {
    __projectIconThemeSubscribers?: Array<() => void>
  }
  return (state.__projectIconThemeSubscribers ??= [])
}
let mockActiveIconTheme: {
  id: string
  baseDir: string
  jsonPath: string
} | null = null
const mockResolveFileIcon = jest.fn((_id: string, _filename: string) => ({
  iconPath: "icons/typescript.svg",
}))
const mockConvertFileSrc = jest.fn((path: string) => `asset://${path}`)

jest.mock("@/lib/plugin/bridge/icons-bridge", () => ({
  getActiveIconTheme: () => mockActiveIconTheme,
  resolveFileIcon: (id: string, filename: string) => mockResolveFileIcon(id, filename),
  subscribeIconThemes: (callback: () => void) => {
    mockIconThemeSubscribers().push(callback)
    return jest.fn()
  },
}))

jest.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
}))

// Flatten Radix ContextMenu: trigger renders its child; content + items render
// inline so tests can click them without a real pointer-driven menu.
jest.mock("@/components/ui/context-menu", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    ContextMenuItem: ({
      children,
      onSelect,
    }: {
      children: React.ReactNode
      onSelect?: () => void
    }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    ),
    ContextMenuSeparator: () => null,
  }
})

// Flatten AlertDialog to render children when open.
jest.mock("@/components/ui/alert-dialog", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
    AlertDialogAction: ({
      children,
      onClick,
    }: {
      children: React.ReactNode
      onClick?: () => void
    }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  }
})

import { ProjectFileTree, type ProjectFileTreeDeps } from "./project-file-tree"
import type { WorkspaceEntry } from "@/lib/files/types"

function entry(relPath: string, isDir: boolean): WorkspaceEntry {
  return { relPath, absolutePath: `/repo/${relPath}`, isDir, size: 0, mtimeMs: null }
}

function makeDeps(): ProjectFileTreeDeps & { fs: Record<string, WorkspaceEntry[]> } {
  const fs: Record<string, WorkspaceEntry[]> = {
    "": [entry("src", true), entry("readme.md", false)],
    src: [entry("src/a.ts", false)],
  }
  return {
    fs,
    listDir: jest.fn(async (_root: string, rel?: string) => fs[rel ?? ""] ?? []),
    createDir: jest.fn(async () => {}),
    writeFile: jest.fn(async () => {}),
    deleteEntry: jest.fn(async () => {}),
    renameEntry: jest.fn(async () => {}),
  }
}

describe("ProjectFileTree", () => {
  it("uses touch-sized rows and toolbar actions in touch density", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        density="touch"
      />
    )

    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toHaveClass("min-h-11"))
    expect(screen.getByLabelText("newFile")).toHaveClass("size-11")
  })

  it("lazily lists the root and opens a file on click", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-readme.md"))
    expect(onOpenFile).toHaveBeenCalledWith("readme.md", { mode: "preview" })
  })

  it("double-clicking a file asks for a pinned tab", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByTestId("tree-row-readme.md"))
    expect(onOpenFile).toHaveBeenLastCalledWith("readme.md", { mode: "pinned" })
  })

  it("double-clicking a directory toggles it instead of opening a tab", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.doubleClick(screen.getByTestId("tree-row-src"))
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it("expands a directory to lazily load its children", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
    expect(deps.listDir).toHaveBeenCalledWith("/repo", "src")
  })

  it("creates a new file from the toolbar and opens it", async () => {
    const deps = makeDeps()
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFile"))
    const input = await screen.findByPlaceholderText("newFile")
    fireEvent.change(input, { target: { value: "new.ts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.writeFile).toHaveBeenCalledWith("/repo", "new.ts", ""))
    expect(onOpenFile).toHaveBeenCalledWith("new.ts")
  })

  it("creates a new folder from the toolbar", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFolder"))
    const input = await screen.findByPlaceholderText("newFolder")
    fireEvent.change(input, { target: { value: "lib" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.createDir).toHaveBeenCalledWith("/repo", "lib"))
  })

  it("renames an entry via its context menu", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    // The flattened context menu renders a "rename" button per row.
    fireEvent.click(screen.getAllByText("rename")[1]) // readme.md's rename (src has one too)
    const input = await screen.findByLabelText("rename")
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: "README2.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(deps.renameEntry).toHaveBeenCalledWith("/repo", "readme.md", "README2.md")
    )
  })

  it("deletes an entry through the confirm dialog", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("delete")[1])
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "delete" }))
    await waitFor(() => expect(deps.deleteEntry).toHaveBeenCalledWith("/repo", "readme.md", false))
  })

  it("shows the empty state and tolerates a list error", async () => {
    const deps = makeDeps()
    ;(deps.listDir as jest.Mock).mockImplementation(async (_r: string, rel?: string) =>
      rel ? [] : Promise.reject(new Error("boom"))
    )
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByText("treeEmpty")).toBeInTheDocument())
  })

  it("cancels a create on Escape and ignores an empty name", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFile"))
    const input = await screen.findByPlaceholderText("newFile")
    // Empty name + blur → no write.
    fireEvent.blur(input)
    expect(deps.writeFile).not.toHaveBeenCalled()
    // Reopen and cancel with Escape.
    fireEvent.click(screen.getByLabelText("newFile"))
    const input2 = await screen.findByPlaceholderText("newFile")
    fireEvent.keyDown(input2, { key: "Escape" })
    expect(screen.queryByPlaceholderText("newFile")).toBeNull()
  })

  it("cancels a rename on Escape without renaming", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("rename")[1])
    const input = await screen.findByLabelText("rename")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(deps.renameEntry).not.toHaveBeenCalled()
  })

  it("creates a file inside a directory via its context menu", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    // The src row's context menu offers New File / New Folder.
    fireEvent.click(screen.getAllByText("newFile")[0]) // first match is src's menu item
    const input = await screen.findByPlaceholderText("newFile")
    fireEvent.change(input, { target: { value: "child.ts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/child.ts", ""))
  })

  it("creates a folder inside a directory via its context menu", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("newFolder")[0]) // src's context menu New Folder
    const input = await screen.findByPlaceholderText("newFolder")
    fireEvent.change(input, { target: { value: "sub" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(deps.createDir).toHaveBeenCalledWith("/repo", "src/sub"))
  })

  it("closes the confirm dialog after a delete fails", async () => {
    const deps = makeDeps()
    ;(deps.deleteEntry as jest.Mock).mockRejectedValue(new Error("EPERM"))
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("delete")[1])
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "delete" }))
    await waitFor(() => expect(deps.deleteEntry).toHaveBeenCalled())
    // Tree still rendered (no crash).
    expect(screen.getByTestId("project-file-tree")).toBeInTheDocument()
  })

  it("collapses an expanded directory on a second click", async () => {
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.getByTestId("tree-row-src/a.ts")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("tree-row-src"))
    await waitFor(() => expect(screen.queryByTestId("tree-row-src/a.ts")).toBeNull())
  })

  it("reloads expanded dirs when refreshToken bumps", async () => {
    const deps = makeDeps()
    const { rerender } = render(
      <ProjectFileTree
        rootPath="/repo"
        refreshToken={0}
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
      />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    const before = (deps.listDir as jest.Mock).mock.calls.length
    rerender(
      <ProjectFileTree
        rootPath="/repo"
        refreshToken={1}
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
      />
    )
    await waitFor(() =>
      expect((deps.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(before)
    )

    const beforeManualRefresh = (deps.listDir as jest.Mock).mock.calls.length
    fireEvent.click(screen.getByLabelText("refresh"))
    await waitFor(() =>
      expect((deps.listDir as jest.Mock).mock.calls.length).toBeGreaterThan(beforeManualRefresh)
    )
  })

  it("uses a contributed file icon and reacts to icon theme changes", async () => {
    mockActiveIconTheme = {
      id: "theme",
      baseDir: "/plugins/theme",
      jsonPath: "icons/theme.json",
    }
    const deps = makeDeps()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )

    await waitFor(() => expect(document.querySelector("img")).not.toBeNull())
    const icon = document.querySelector("img")
    expect(icon).toHaveAttribute("src", "asset:///plugins/theme/icons/icons/typescript.svg")
    expect(mockResolveFileIcon).toHaveBeenCalledWith("theme", "readme.md")

    act(() => mockIconThemeSubscribers().forEach((notify) => notify()))
    expect(mockConvertFileSrc).toHaveBeenCalled()
    mockActiveIconTheme = null
  })
  it("swallows a create error without leaving the inline input stuck", async () => {
    const deps = makeDeps()
    ;(deps.writeFile as jest.Mock).mockRejectedValue(new Error("EACCES"))
    const onOpenFile = jest.fn()
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={onOpenFile} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-src")).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText("newFile"))
    const input = await screen.findByPlaceholderText("newFile")
    fireEvent.change(input, { target: { value: "new.ts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.queryByPlaceholderText("newFile")).toBeNull())
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(screen.getByTestId("project-file-tree")).toBeInTheDocument()
  })

  /**
   * Retitled. This used to assert the swallow itself, which is the behaviour
   * that made a remote backend unusable. What it should pin is the part that
   * was always right: a failed rename must not strand the row in edit mode.
   * That the failure is now reported is pinned in "failures reach the user".
   */
  it("leaves no row in edit mode after a rename fails", async () => {
    const deps = makeDeps()
    ;(deps.renameEntry as jest.Mock).mockRejectedValue(new Error("EPERM"))
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
    fireEvent.click(screen.getAllByText("rename")[1])
    const input = await screen.findByLabelText("rename")
    fireEvent.change(input, { target: { value: "README2.md" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.queryByLabelText("rename")).toBeNull())
    expect(screen.getByTestId("project-file-tree")).toBeInTheDocument()
  })
})

/**
 * Every one of these failed silently before. The listing path was the worst:
 * it wrote an empty array, so a directory the caller may not read rendered
 * identically to one that genuinely has nothing in it.
 */
describe("failures reach the user", () => {
  function renderTree(deps: ProjectFileTreeDeps, onFailure = jest.fn()) {
    render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={deps}
        onFailure={onFailure}
      />
    )
    return onFailure
  }

  it("shows why a directory could not be read, instead of calling it empty", async () => {
    const deps = makeDeps()
    deps.listDir = jest.fn(async () => {
      throw new Error("EACCES: permission denied")
    })
    const onFailure = renderTree(deps)

    const row = await screen.findByTestId("file-tree-failure-root")
    expect(row).toHaveAttribute("data-failure", "denied")
    expect(row.textContent).toContain("treeFailure.denied")
    expect(screen.queryByText("treeEmpty")).toBeNull()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: "denied" }), "list", "")
  })

  /**
   * Retry is offered only for the one kind that could succeed unchanged.
   * A permission denial with a retry button trains people to click it.
   */
  it("offers a retry for an unreachable host and not for a denial", async () => {
    const unreachable = makeDeps()
    unreachable.listDir = jest.fn(async () => {
      throw new Error("host is offline")
    })
    const { unmount } = render(
      <ProjectFileTree
        rootPath="/repo"
        activePath={null}
        onOpenFile={jest.fn()}
        deps={unreachable}
      />
    )
    const first = await screen.findByTestId("file-tree-failure-root")
    expect(within(first).queryByLabelText("refresh")).not.toBeNull()
    unmount()

    const denied = makeDeps()
    denied.listDir = jest.fn(async () => {
      throw new Error("EACCES: permission denied")
    })
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={denied} />
    )
    const second = await screen.findByTestId("file-tree-failure-root")
    expect(within(second).queryByLabelText("refresh")).toBeNull()
  })

  it("clears the failure once the directory reads", async () => {
    const deps = makeDeps()
    let fail = true
    const listDir = jest.fn(async (_root: string, rel?: string) => {
      if (fail) throw new Error("host is offline")
      return deps.fs[rel ?? ""] ?? []
    })
    deps.listDir = listDir as unknown as ProjectFileTreeDeps["listDir"]
    render(
      <ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />
    )
    const row = await screen.findByTestId("file-tree-failure-root")
    fail = false
    fireEvent.click(within(row).getByLabelText("refresh"))

    await waitFor(() => expect(screen.queryByTestId("file-tree-failure-root")).toBeNull())
    expect(await screen.findByTestId("tree-row-readme.md")).toBeInTheDocument()
  })

  it("reports a failed delete rather than closing the dialog as if it worked", async () => {
    const deps = makeDeps()
    deps.deleteEntry = jest.fn(async () => {
      throw new Error("EROFS: read-only file system")
    })
    const onFailure = renderTree(deps)

    await screen.findByTestId("tree-row-readme.md")
    fireEvent.click(screen.getAllByText("delete")[1])
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "delete" }))

    await waitFor(() =>
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "denied" }),
        "delete",
        "readme.md"
      )
    )
  })

  it("reports a failed rename", async () => {
    const deps = makeDeps()
    deps.renameEntry = jest.fn(async () => {
      throw new Error("EEXIST: file already exists")
    })
    const onFailure = renderTree(deps)

    await screen.findByTestId("tree-row-readme.md")
    fireEvent.click(screen.getAllByText("rename")[1])
    const input = await screen.findByLabelText("rename")
    fireEvent.change(input, { target: { value: "taken.md" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() =>
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "conflict" }),
        "rename",
        "readme.md"
      )
    )
  })
})
