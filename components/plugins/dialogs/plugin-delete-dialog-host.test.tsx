/**
 * @jest-environment jsdom
 */

const unregisterMock = jest.fn(async (_id: string) => {})
const deletePluginMock = jest.fn(async (_id: string) => {})
const permissionsDeleteMock = jest.fn(async () => 0)
const analyticsDeleteMock = jest.fn(async () => 0)

jest.mock("@/lib/plugin/bridge/scheduled-task-bridge", () => ({
  unregisterScheduledTasksForPlugin: (id: string) => unregisterMock(id),
}))
jest.mock("@/lib/db/plugins", () => ({
  deletePlugin: (id: string) => deletePluginMock(id),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginPermissions: { where: () => ({ equals: () => ({ delete: permissionsDeleteMock }) }) },
    pluginAnalytics: { where: () => ({ equals: () => ({ delete: analyticsDeleteMock }) }) },
  }),
}))

// The dialog's own copy and confirm UI are covered by its suite. This one is
// about the side effects the host owns, which is the part a second copy of
// this component would get wrong.
jest.mock("./plugin-delete-dialog", () => ({
  PluginDeleteDialog: ({
    open,
    pluginName,
    onCancel,
    onConfirm,
  }: {
    open: boolean
    pluginName: string
    onCancel: () => void
    onConfirm: (opts: { cascade: boolean }) => Promise<void>
  }) =>
    open ? (
      <div data-testid="delete-dialog" data-plugin-name={pluginName}>
        <button type="button" onClick={onCancel}>
          cancel
        </button>
        <button type="button" onClick={() => void onConfirm({ cascade: false })}>
          confirm
        </button>
        <button type="button" onClick={() => void onConfirm({ cascade: true })}>
          confirm-cascade
        </button>
      </div>
    ) : null,
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { usePluginsStore } from "@/stores/plugins"

import { PluginDeleteDialogHost } from "./plugin-delete-dialog-host"

beforeEach(() => {
  jest.clearAllMocks()
  usePluginsStore.setState({ deleteTarget: null, deleteQueue: [] })
})

describe("PluginDeleteDialogHost", () => {
  it("stays closed until the store names a target", () => {
    render(<PluginDeleteDialogHost />)
    expect(screen.queryByTestId("delete-dialog")).toBeNull()
  })

  it("tears down scheduled tasks before deleting the row", async () => {
    const order: string[] = []
    unregisterMock.mockImplementation(async () => {
      order.push("unregister")
    })
    deletePluginMock.mockImplementation(async () => {
      order.push("delete")
    })
    usePluginsStore.setState({ deleteTarget: { pluginId: "p1", name: "Web Tools" } })
    render(<PluginDeleteDialogHost />)
    await userEvent.click(screen.getByRole("button", { name: "confirm" }))
    await waitFor(() => expect(deletePluginMock).toHaveBeenCalledWith("p1"))
    expect(order).toEqual(["unregister", "delete"])
  })

  it("leaves permissions and analytics alone without cascade", async () => {
    usePluginsStore.setState({ deleteTarget: { pluginId: "p1", name: "Web Tools" } })
    render(<PluginDeleteDialogHost />)
    await userEvent.click(screen.getByRole("button", { name: "confirm" }))
    await waitFor(() => expect(deletePluginMock).toHaveBeenCalled())
    expect(permissionsDeleteMock).not.toHaveBeenCalled()
    expect(analyticsDeleteMock).not.toHaveBeenCalled()
  })

  it("drops the plugin's permissions and analytics when cascade is chosen", async () => {
    usePluginsStore.setState({ deleteTarget: { pluginId: "p1", name: "Web Tools" } })
    render(<PluginDeleteDialogHost />)
    await userEvent.click(screen.getByRole("button", { name: "confirm-cascade" }))
    await waitFor(() => expect(permissionsDeleteMock).toHaveBeenCalled())
    expect(analyticsDeleteMock).toHaveBeenCalled()
  })

  // A batch uninstall queues the rest of the selection behind the first
  // target, so confirming has to walk the queue instead of closing.
  it("advances the delete queue instead of closing when more targets are queued", async () => {
    usePluginsStore.setState({
      deleteTarget: { pluginId: "p1", name: "Web Tools" },
      deleteQueue: [{ pluginId: "p2", name: "Screenshot" }],
    })
    render(<PluginDeleteDialogHost />)
    await userEvent.click(screen.getByRole("button", { name: "confirm" }))
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget?.pluginId).toBe("p2"))
  })

  it("closes on cancel when nothing is queued", async () => {
    usePluginsStore.setState({ deleteTarget: { pluginId: "p1", name: "Web Tools" } })
    render(<PluginDeleteDialogHost />)
    await userEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(usePluginsStore.getState().deleteTarget).toBeNull()
  })
})
