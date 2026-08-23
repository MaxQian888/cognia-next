/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { error?: string }) =>
    values?.error ? `${key}:${values.error}` : key,
}))

const listMock = jest.fn()
const pinMock = jest.fn()
const archiveMock = jest.fn()
const restoreMock = jest.fn()
const permanentMock = jest.fn()
const adoptMock = jest.fn()
const deleteMock = jest.fn()
const reconcileMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  listManagedWorkspaces: (...args: unknown[]) => listMock(...args),
  pinManagedWorkspace: (...args: unknown[]) => pinMock(...args),
  archiveManagedWorkspace: (...args: unknown[]) => archiveMock(...args),
  restoreManagedWorkspace: (...args: unknown[]) => restoreMock(...args),
  makeManagedWorkspacePermanent: (...args: unknown[]) => permanentMock(...args),
  adoptManagedWorkspace: (...args: unknown[]) => adoptMock(...args),
  deleteManagedWorkspace: (...args: unknown[]) => deleteMock(...args),
  reconcileManagedWorkspaces: (...args: unknown[]) => reconcileMock(...args),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { WorkspaceEnvironmentList } from "./workspace-environment-list"

const managed = {
  workspaceId: "ws-1",
  environmentKind: "managed",
  ownerType: "session",
  ownerRef: "session-1",
  state: "active",
  sourceRoot: "/repo",
  gitCommonDir: "/repo/.git",
  base: { kind: "workingState" },
  head: null,
  branch: null,
  isolationKind: "gitWorktree",
  executionRoot: "/managed/ws-1",
  snapshotTaskId: null,
  sizeBytes: null,
  lastUsedAt: 1,
  lockedBy: "cognia:ws-1",
  pinned: false,
  createdAt: 1,
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([managed])
  pinMock.mockReset().mockResolvedValue({ ...managed, pinned: true })
  archiveMock.mockReset().mockResolvedValue({ ...managed, state: "archived" })
  restoreMock.mockReset().mockResolvedValue({ ...managed, state: "active" })
  permanentMock.mockReset().mockResolvedValue({ ...managed, environmentKind: "permanent" })
  adoptMock.mockReset().mockResolvedValue({ ...managed, ownerType: "user", ownerRef: null })
  deleteMock.mockReset().mockResolvedValue(undefined)
  reconcileMock.mockReset().mockResolvedValue({ reclaimed: [], orphaned: [], imported: [] })
})

it("lists Registry environments and pins a managed row", async () => {
  render(<WorkspaceEnvironmentList />)
  expect(await screen.findByTestId("workspace-environment-ws-1")).toHaveTextContent("/managed/ws-1")
  expect(screen.getByText("kinds.managed")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "pin" }))
  await waitFor(() => expect(pinMock).toHaveBeenCalledWith("ws-1", true))
  expect(await screen.findByRole("button", { name: "unpin" })).toBeInTheDocument()
})

it("renders an actionable load error", async () => {
  listMock.mockRejectedValueOnce(new Error("host unavailable"))
  render(<WorkspaceEnvironmentList />)
  expect(await screen.findByRole("alert")).toHaveTextContent("loadError:host unavailable")
})

it("archives and restores a managed environment", async () => {
  render(<WorkspaceEnvironmentList />)
  await screen.findByTestId("workspace-environment-ws-1")

  fireEvent.click(screen.getByRole("button", { name: "archive" }))
  await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("ws-1"))
  fireEvent.click(await screen.findByRole("button", { name: "restore" }))
  await waitFor(() => expect(restoreMock).toHaveBeenCalledWith("ws-1"))
})

it("requires confirmation before deleting an archived environment", async () => {
  listMock.mockResolvedValueOnce([{ ...managed, state: "archived" }])
  render(<WorkspaceEnvironmentList />)
  fireEvent.click(await screen.findByRole("button", { name: "delete" }))
  expect(screen.getByRole("alertdialog")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "confirmDelete" }))
  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("ws-1"))
  await waitFor(() =>
    expect(screen.queryByTestId("workspace-environment-ws-1")).not.toBeInTheDocument()
  )
})

it("requires an explicit Adopt action before an imported environment becomes managed", async () => {
  listMock.mockResolvedValueOnce([
    {
      ...managed,
      environmentKind: "imported",
      ownerType: "imported",
      ownerRef: null,
      lockedBy: null,
    },
  ])
  render(<WorkspaceEnvironmentList />)

  fireEvent.click(await screen.findByRole("button", { name: "adopt" }))

  await waitFor(() => expect(adoptMock).toHaveBeenCalledWith("ws-1"))
  expect(await screen.findByText("kinds.managed")).toBeInTheDocument()
})
