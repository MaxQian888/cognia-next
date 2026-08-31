/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  // Values are folded into the key so two rows built from the same message
  // (every folder shares `openFolder`) stay distinguishable in queries.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

jest.mock("@/lib/claude/ipc", () => ({ defaultExportDir: jest.fn() }))
jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceDir: jest.fn(),
  listWorkspaceRoots: jest.fn(),
}))

import { WorkspaceFolderPicker } from "./workspace-folder-picker"

const defaultExportDirMock = (
  jest.requireMock("@/lib/claude/ipc") as { defaultExportDir: jest.Mock }
).defaultExportDir
const workspaceFs = jest.requireMock("@/lib/files/workspace-fs") as {
  listWorkspaceDir: jest.Mock
  listWorkspaceRoots: jest.Mock
}
const listWorkspaceDirMock = workspaceFs.listWorkspaceDir
const listWorkspaceRootsMock = workspaceFs.listWorkspaceRoots

const HEADLESS_ROOT = { path: "/srv/workspaces", source: "headless-workspaces-dir" as const }

function dir(relPath: string, absolutePath: string) {
  return { relPath, absolutePath, isDir: true, size: 0, mtimeMs: null }
}

function file(relPath: string, absolutePath: string) {
  return { relPath, absolutePath, isDir: false, size: 12, mtimeMs: null }
}

beforeEach(() => {
  defaultExportDirMock.mockReset().mockResolvedValue("/srv")
  listWorkspaceDirMock.mockReset().mockResolvedValue([])
  listWorkspaceRootsMock.mockReset().mockResolvedValue([])
})

it("starts inside a root the Host declared instead of guessing a local path", async () => {
  // The old picker opened on `defaultExportDir()`, which on a headless Host is
  // outside the workspaces root, so the dialog's first frame was a refusal.
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  listWorkspaceDirMock.mockResolvedValue([
    dir("projects", "/srv/workspaces/projects"),
    file("readme.txt", "/srv/workspaces/readme.txt"),
  ])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  await waitFor(() =>
    expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/workspaces", undefined)
  )
  expect(defaultExportDirMock).not.toHaveBeenCalled()
  expect(await screen.findByText("workspaces")).toBeInTheDocument()
  expect(screen.getByText("projects")).toBeInTheDocument()
  expect(screen.queryByText("readme.txt")).not.toBeInTheDocument()
})

it("expands a folder lazily and returns the absolute path the Host gave for it", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  listWorkspaceDirMock.mockImplementation(async (_root: string, rel?: string) => {
    if (!rel) return [dir("projects", "/srv/workspaces/projects")]
    if (rel === "projects") return [dir("projects/api", "/srv/workspaces/projects/api")]
    return []
  })
  const onSelect = jest.fn()
  const onOpenChange = jest.fn()

  render(<WorkspaceFolderPicker open onOpenChange={onOpenChange} onSelect={onSelect} />)

  fireEvent.click(await screen.findByRole("button", { name: "projects" }))

  // Selecting drills in: the child listing is only requested once the row is
  // opened, so a deep tree never costs a recursive walk up front.
  await waitFor(() =>
    expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/workspaces", "projects")
  )
  expect(await screen.findByRole("button", { name: "api" })).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "chooseCurrent" }))
  expect(onSelect).toHaveBeenCalledWith("/srv/workspaces/projects")
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("re-roots and reveals a typed path that sits inside a declared root", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  listWorkspaceDirMock.mockImplementation(async (_root: string, rel?: string) => {
    if (!rel) return [dir("projects", "/srv/workspaces/projects")]
    if (rel === "projects") return [dir("projects/api", "/srv/workspaces/projects/api")]
    return []
  })

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  await screen.findByText("workspaces")

  fireEvent.change(screen.getByLabelText("pathLabel"), {
    target: { value: "/srv/workspaces/projects/api" },
  })
  fireEvent.click(screen.getByRole("button", { name: "go" }))

  // The whole ancestor chain is loaded so the pasted path lands expanded and
  // selected rather than collapsing back to the root.
  await waitFor(() =>
    expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/workspaces", "projects/api")
  )
  await waitFor(() =>
    expect(screen.getByLabelText("pathLabel")).toHaveValue("/srv/workspaces/projects/api")
  )
})

it("falls back to the default export dir when the Host reports no roots", async () => {
  // An older Host has no roots command. Empty means "it did not say", so the
  // previous starting point must still be used instead of a dead dialog.
  listWorkspaceRootsMock.mockResolvedValue([])
  listWorkspaceDirMock.mockResolvedValue([dir("projects", "/srv/projects")])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  await waitFor(() => expect(defaultExportDirMock).toHaveBeenCalled())
  expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv", undefined)
  expect(await screen.findByText("projects")).toBeInTheDocument()
})

it("says the Host refused the path, quotes it, and offers the roots it does allow", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  const refusal = Object.assign(
    new Error(
      'workspace root denied: cwd "/Users/me/code" escapes the workspaces root "/srv/workspaces"'
    ),
    { code: "remote_control_forbidden", retryable: false }
  )
  listWorkspaceDirMock.mockRejectedValue(refusal)

  render(
    <WorkspaceFolderPicker
      open
      initialPath="/Users/me/code"
      onOpenChange={jest.fn()}
      onSelect={jest.fn()}
    />
  )

  expect(await screen.findByText("loadRefused")).toBeInTheDocument()
  expect(screen.getByText(/escapes the workspaces root/)).toBeInTheDocument()
  expect(screen.queryByText("loadError")).not.toBeInTheDocument()
  // The recovery is one click, not a path the user has to reconstruct from the
  // error text.
  expect(screen.getAllByText("/srv/workspaces").length).toBeGreaterThan(0)
})

it("keeps the generic message for a retryable transport failure", async () => {
  const blip = Object.assign(new Error("network"), { code: "network", retryable: true })
  listWorkspaceDirMock.mockRejectedValue(blip)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByText("loadError")).toBeInTheDocument()
  expect(screen.queryByText("loadRefused")).not.toBeInTheDocument()
})

it("reports a refusal raised while resolving the fallback starting path", async () => {
  defaultExportDirMock.mockRejectedValue(
    Object.assign(new Error("no default directory on this host"), {
      code: "unknown_command",
      retryable: false,
    })
  )

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByText("loadRefused")).toBeInTheDocument()
})

it("disables the parent button at a declared root rather than hiding it", async () => {
  // Hiding it would merge "there is nothing above this" with "this control does
  // not exist here". The Host's confinement is a fact the user should see.
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  listWorkspaceDirMock.mockResolvedValue([])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  const up = await screen.findByRole("button", { name: "up" })
  await waitFor(() => expect(up).toBeDisabled())
  expect(up).toHaveAttribute("title", "upConfined")
})
