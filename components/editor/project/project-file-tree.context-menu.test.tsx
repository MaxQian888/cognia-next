/**
 * @jest-environment jsdom
 */
/**
 * `ProjectFileTree`'s inline fields opened from its real (Radix) context
 * menus. The main suite flattens the menu to plain buttons, which hides the
 * menu's focus handling: an item that opened its field while the menu was
 * still closing lost the field's focus to the menu handing focus back, and
 * the field's blur submitted the untouched value (a rename to the same name,
 * or a dropped create) before anything could be typed.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/transport-instance", () => ({
  onTransportChange: () => () => {},
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => false,
  subscribeActiveRemoteTransport: () => () => {},
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/lib/plugin/bridge/icons-bridge", () => ({
  getActiveIconTheme: () => null,
  resolveFileIcon: () => null,
  subscribeIconThemes: () => () => {},
}))
jest.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}))

import { ProjectFileTree, type ProjectFileTreeDeps } from "./project-file-tree"
import type { WorkspaceEntry } from "@/lib/files/types"

function entry(relPath: string, isDir: boolean): WorkspaceEntry {
  return { relPath, absolutePath: `/repo/${relPath}`, isDir, size: 0, mtimeMs: null }
}

function makeDeps(): ProjectFileTreeDeps {
  const fs: Record<string, WorkspaceEntry[]> = {
    "": [entry("src", true), entry("readme.md", false)],
    src: [entry("src/a.ts", false)],
  }
  return {
    listDir: jest.fn(async (_root: string, rel?: string) => fs[rel ?? ""] ?? []),
    createDir: jest.fn(async () => {}),
    writeFile: jest.fn(async () => {}),
    deleteEntry: jest.fn(async () => {}),
    renameEntry: jest.fn(async () => {}),
  }
}

async function renderTree() {
  const deps = makeDeps()
  const user = userEvent.setup()
  render(<ProjectFileTree rootPath="/repo" activePath={null} onOpenFile={jest.fn()} deps={deps} />)
  await waitFor(() => expect(screen.getByTestId("tree-row-readme.md")).toBeInTheDocument())
  return { deps, user }
}

async function pick(user: ReturnType<typeof userEvent.setup>, target: Element, item: string) {
  await user.pointer({ keys: "[MouseRight]", target })
  const menu = await screen.findByRole("menu")
  await user.click(within(menu).getByRole("menuitem", { name: item }))
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
}

describe("ProjectFileTree context-menu fields", () => {
  it("keeps the rename field open after Rename and renames to the typed name", async () => {
    const { deps, user } = await renderTree()
    await pick(user, screen.getByTestId("tree-row-readme.md"), "rename")
    const input = screen.getByLabelText("rename")
    expect(input).toHaveFocus()
    expect(deps.renameEntry).not.toHaveBeenCalled()
    await user.clear(input)
    await user.type(input, "README2.md{Enter}")
    await waitFor(() =>
      expect(deps.renameEntry).toHaveBeenCalledWith("/repo", "readme.md", "README2.md")
    )
    expect(deps.renameEntry).toHaveBeenCalledTimes(1)
  })

  it("keeps a folder's New File field open and creates the typed file", async () => {
    const { deps, user } = await renderTree()
    await pick(user, screen.getByTestId("tree-row-src"), "newFile")
    const input = await screen.findByPlaceholderText("newFile")
    expect(input).toHaveFocus()
    await user.type(input, "child.ts{Enter}")
    await waitFor(() => expect(deps.writeFile).toHaveBeenCalledWith("/repo", "src/child.ts", ""))
  })

  it("keeps a folder's New Folder field open and creates the typed folder", async () => {
    const { deps, user } = await renderTree()
    await pick(user, screen.getByTestId("tree-row-src"), "newFolder")
    const input = await screen.findByPlaceholderText("newFolder")
    expect(input).toHaveFocus()
    await user.type(input, "lib{Enter}")
    await waitFor(() => expect(deps.createDir).toHaveBeenCalledWith("/repo", "src/lib"))
  })

  it("keeps the workspace root's New File field open and creates the typed file", async () => {
    const { deps, user } = await renderTree()
    await pick(user, screen.getByTestId("project-file-tree-scroll"), "newFile")
    const input = await screen.findByPlaceholderText("newFile")
    expect(input).toHaveFocus()
    await user.type(input, "notes.md{Enter}")
    await waitFor(() => expect(deps.writeFile).toHaveBeenCalledWith("/repo", "notes.md", ""))
  })
})
