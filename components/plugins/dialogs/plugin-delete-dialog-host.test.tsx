/**
 * @jest-environment jsdom
 */

// The REAL dialog is rendered here on purpose. The queue defect this host
// guards against came from Radix itself (Action and Cancel both close the
// dialog through `onOpenChange(false)`), so a hand-rolled dialog mock would
// pass while the real one double-advanced.

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/plugins/use-plugin-uninstall", () => ({
  usePluginUninstall: jest.fn(),
}))

import { usePluginUninstall } from "@/hooks/plugins/use-plugin-uninstall"
import { usePluginsStore } from "@/stores/plugins"

import { PluginDeleteDialogHost } from "./plugin-delete-dialog-host"

const uninstallMock = jest.fn<Promise<boolean>, [{ pluginId: string; name: string }, unknown]>()

beforeEach(() => {
  jest.clearAllMocks()
  uninstallMock.mockResolvedValue(true)
  ;(usePluginUninstall as jest.Mock).mockReturnValue(uninstallMock)
  usePluginsStore.setState({ deleteTarget: null, deleteQueue: [] })
})

function queue(...ids: string[]) {
  usePluginsStore
    .getState()
    .enqueueDeleteTargets(ids.map((id) => ({ pluginId: id, name: `Plugin ${id}` })))
}

describe("PluginDeleteDialogHost", () => {
  it("stays closed until the store names a target", () => {
    render(<PluginDeleteDialogHost />)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("uninstalls through the shared hook with the cascade choice", async () => {
    const user = userEvent.setup()
    queue("p1")
    render(<PluginDeleteDialogHost />)
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Uninstall" }))
    await waitFor(() =>
      expect(uninstallMock).toHaveBeenCalledWith(
        { pluginId: "p1", name: "Plugin p1" },
        { cascade: true }
      )
    )
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget).toBeNull())
  })

  it("advances a batch queue exactly once per confirm", async () => {
    const user = userEvent.setup()
    queue("p1", "p2", "p3")
    render(<PluginDeleteDialogHost />)

    await user.click(screen.getByRole("button", { name: "Uninstall" }))
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget?.pluginId).toBe("p2"))
    expect(usePluginsStore.getState().deleteQueue.map((t) => t.pluginId)).toEqual(["p3"])
    expect(uninstallMock).toHaveBeenCalledTimes(1)
    // The dialog now names the second plugin — it was not skipped.
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Plugin p2")
  })

  it("advances a batch queue exactly once per cancel", async () => {
    const user = userEvent.setup()
    queue("p1", "p2", "p3")
    render(<PluginDeleteDialogHost />)

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget?.pluginId).toBe("p2"))
    expect(usePluginsStore.getState().deleteQueue.map((t) => t.pluginId)).toEqual(["p3"])
    expect(uninstallMock).not.toHaveBeenCalled()
  })

  it("walks the whole selection: confirm, cancel, Escape", async () => {
    const user = userEvent.setup()
    queue("p1", "p2", "p3")
    render(<PluginDeleteDialogHost />)

    await user.click(screen.getByRole("button", { name: "Uninstall" }))
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget?.pluginId).toBe("p2"))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget?.pluginId).toBe("p3"))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget).toBeNull())

    expect(uninstallMock).toHaveBeenCalledTimes(1)
    expect(uninstallMock.mock.calls[0]?.[0].pluginId).toBe("p1")
  })

  it("still advances when an uninstall fails (the hook reports the failure)", async () => {
    const user = userEvent.setup()
    uninstallMock.mockResolvedValueOnce(false)
    queue("p1", "p2")
    render(<PluginDeleteDialogHost />)
    await user.click(screen.getByRole("button", { name: "Uninstall" }))
    await waitFor(() => expect(usePluginsStore.getState().deleteTarget?.pluginId).toBe("p2"))
  })

  it("closes on cancel when nothing is queued", async () => {
    const user = userEvent.setup()
    queue("p1")
    render(<PluginDeleteDialogHost />)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(usePluginsStore.getState().deleteTarget).toBeNull()
  })
})
