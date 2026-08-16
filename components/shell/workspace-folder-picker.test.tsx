/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/claude/ipc", () => ({ defaultExportDir: jest.fn() }))
jest.mock("@/lib/files/workspace-fs", () => ({ listWorkspaceDir: jest.fn() }))

import { WorkspaceFolderPicker } from "./workspace-folder-picker"

const defaultExportDirMock = (
  jest.requireMock("@/lib/claude/ipc") as { defaultExportDir: jest.Mock }
).defaultExportDir
const listWorkspaceDirMock = (
  jest.requireMock("@/lib/files/workspace-fs") as { listWorkspaceDir: jest.Mock }
).listWorkspaceDir

beforeEach(() => {
  defaultExportDirMock.mockReset().mockResolvedValue("/srv")
  listWorkspaceDirMock.mockReset()
})

it("browses directories on the paired host and returns the chosen absolute path", async () => {
  listWorkspaceDirMock
    .mockResolvedValueOnce([
      {
        relPath: "projects",
        absolutePath: "/srv/projects",
        isDir: true,
        size: 0,
        mtimeMs: null,
      },
      {
        relPath: "readme.txt",
        absolutePath: "/srv/readme.txt",
        isDir: false,
        size: 12,
        mtimeMs: null,
      },
    ])
    .mockResolvedValueOnce([])
  const onSelect = jest.fn()
  const onOpenChange = jest.fn()

  render(<WorkspaceFolderPicker open onOpenChange={onOpenChange} onSelect={onSelect} />)

  await waitFor(() => expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv"))
  expect(screen.queryByText("readme.txt")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "openFolder" }))
  await waitFor(() => expect(screen.getByLabelText("pathLabel")).toHaveValue("/srv/projects"))
  fireEvent.click(screen.getByRole("button", { name: "chooseCurrent" }))

  expect(onSelect).toHaveBeenCalledWith("/srv/projects")
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("shows an actionable error when the host cannot list a path", async () => {
  listWorkspaceDirMock.mockRejectedValue(new Error("offline"))

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByText("loadError")).toBeInTheDocument()
})
