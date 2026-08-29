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

it("says the Host refused the path, and quotes it, instead of blaming the connection", async () => {
  // A headless Host confines browsing to `COGNIA_WORKSPACES_DIR`, so anything
  // outside it comes back as a non-retryable refusal whose message names the
  // allowed root. Rendering "check the path and server connection" for that
  // sends the user to debug a connection that is working, and throws away the
  // one fact that resolves it.
  const refusal = Object.assign(
    new Error(
      'workspace root denied: cwd "/Users/me/code" escapes the workspaces root "/srv/workspaces"'
    ),
    { code: "remote_control_forbidden", retryable: false }
  )
  listWorkspaceDirMock.mockRejectedValue(refusal)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByText("loadRefused")).toBeInTheDocument()
  expect(screen.getByText(/escapes the workspaces root/)).toBeInTheDocument()
  expect(screen.queryByText("loadError")).not.toBeInTheDocument()
})

it("keeps the generic message for a retryable transport failure", async () => {
  const blip = Object.assign(new Error("network"), { code: "network", retryable: true })
  listWorkspaceDirMock.mockRejectedValue(blip)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByText("loadError")).toBeInTheDocument()
  expect(screen.queryByText("loadRefused")).not.toBeInTheDocument()
})

it("reports a refusal raised while resolving the starting path", async () => {
  defaultExportDirMock.mockRejectedValue(
    Object.assign(new Error("no default directory on this host"), {
      code: "unknown_command",
      retryable: false,
    })
  )

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByText("loadRefused")).toBeInTheDocument()
})
