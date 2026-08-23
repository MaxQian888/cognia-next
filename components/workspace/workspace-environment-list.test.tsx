/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { error?: string }) =>
    values?.error ? `${key}:${values.error}` : key,
}))

const listMock = jest.fn()
const pinMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  listManagedWorkspaces: (...args: unknown[]) => listMock(...args),
  pinManagedWorkspace: (...args: unknown[]) => pinMock(...args),
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
