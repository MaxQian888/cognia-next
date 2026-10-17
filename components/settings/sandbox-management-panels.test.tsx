import { render, screen, waitFor } from "@testing-library/react"
import { SandboxManagementPanels } from "./sandbox-management-panels"
import { sandboxPreviewContext } from "@/lib/sandbox/previews"
import { listWorkspaceEnvironments } from "@/lib/task-workspace/client"
import { isTauri } from "@/lib/tauri"
import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"
import en from "@/i18n/messages/en/sandboxManagement.json"

jest.mock("@/lib/sandbox/previews", () => ({ sandboxPreviewContext: jest.fn() }))
jest.mock("@/lib/task-workspace/client", () => ({ listWorkspaceEnvironments: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/tauri/transport-routing", () => ({ getActiveRemoteEndpoint: jest.fn() }))
const snapshots = jest.fn()
jest.mock("./sandbox-snapshots-panel", () => ({
  SandboxSnapshotsPanel: (props: unknown) => {
    snapshots(props)
    return <div>snapshots-child</div>
  },
}))
jest.mock("./sandbox-preview-links-panel", () => ({
  SandboxPreviewLinksPanel: () => <div>previews-child</div>,
}))
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(getActiveRemoteEndpoint).mockReturnValue(null)
  jest
    .mocked(sandboxPreviewContext)
    .mockResolvedValue({ targets: [], snapshotUsageBytes: 1200, sandboxSnapshotBudgetBytes: 2000 })
  jest.mocked(listWorkspaceEnvironments).mockResolvedValue([
    { projectId: "p", workspaceId: "w" },
    { projectId: "other", workspaceId: "elsewhere" },
  ] as never)
})

it("mounts both panels with Host inventory and only the current project's restore targets", async () => {
  render(<SandboxManagementPanels projectId="p" />)
  expect(await screen.findByText("snapshots-child")).toBeInTheDocument()
  expect(screen.getByText("previews-child")).toBeInTheDocument()
  expect(snapshots).toHaveBeenLastCalledWith(
    expect.objectContaining({
      workspaces: [{ projectId: "p", workspaceId: "w" }],
      context: expect.objectContaining({ snapshotUsageBytes: 1200 }),
    })
  )
})

it("does not expose local-owner commands to a remote endpoint", () => {
  jest.mocked(getActiveRemoteEndpoint).mockReturnValue({ id: "remote" } as never)
  render(<SandboxManagementPanels projectId="p" />)
  expect(screen.getByText(en.localRequired)).toBeInTheDocument()
  expect(sandboxPreviewContext).not.toHaveBeenCalled()
})

it("fails closed when the Host inventory cannot be read", async () => {
  jest.mocked(sandboxPreviewContext).mockRejectedValue(new Error("private diagnostic"))
  render(<SandboxManagementPanels projectId="p" />)
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(en.contextError))
  expect(screen.queryByText("snapshots-child")).not.toBeInTheDocument()
})
