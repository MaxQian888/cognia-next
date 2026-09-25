/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: jest.fn(),
}))
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  isMirroredPluginClient: jest.fn(() => false),
}))
jest.mock("@/lib/plugin/bridge/scheduled-task-bridge", () => ({
  unregisterScheduledTasksForPlugin: jest.fn(async () => {}),
}))
jest.mock("@/lib/db/plugins", () => ({
  deletePlugin: jest.fn(async () => {}),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: { getState: jest.fn() },
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { toast } from "sonner"
import { deletePlugin } from "@/lib/db/plugins"
import { getDb } from "@/lib/db/schema"
import { unregisterScheduledTasksForPlugin } from "@/lib/plugin/bridge/scheduled-task-bridge"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { isMirroredPluginClient } from "@/lib/plugin/core/set-plugin-enabled-for-host"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { usePluginsStore } from "@/stores/plugins"

import {
  PluginUninstallBlockedError,
  pluginUninstallBlockReason,
  uninstallPluginForHost,
  usePluginUninstall,
} from "./use-plugin-uninstall"

const uninstallPlugin = jest.fn(async (_id: string, _opts?: { purgeData?: boolean }) => {})
const permissionsDelete = jest.fn(async () => 0)
const analyticsDelete = jest.fn(async () => 0)

function setRuntime(ids: string[]) {
  ;(usePluginStore.getState as jest.Mock).mockReturnValue({
    plugins: Object.fromEntries(ids.map((id) => [id, { id }])),
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(isMirroredPluginClient as jest.Mock).mockReturnValue(false)
  ;(getPluginManager as jest.Mock).mockReturnValue({ uninstallPlugin })
  ;(getDb as jest.Mock).mockReturnValue({
    pluginPermissions: { where: () => ({ equals: () => ({ delete: permissionsDelete }) }) },
    pluginAnalytics: { where: () => ({ equals: () => ({ delete: analyticsDelete }) }) },
  })
  setRuntime(["p1"])
  usePluginsStore.setState({ detailPluginId: null, selection: new Set() })
})

describe("uninstallPluginForHost", () => {
  it("tears the runtime down through the manager before removing the row", async () => {
    const order: string[] = []
    uninstallPlugin.mockImplementationOnce(async () => {
      order.push("manager")
    })
    ;(unregisterScheduledTasksForPlugin as jest.Mock).mockImplementationOnce(async () => {
      order.push("scheduled")
    })
    ;(deletePlugin as jest.Mock).mockImplementationOnce(async () => {
      order.push("row")
    })
    await uninstallPluginForHost("p1")
    expect(uninstallPlugin).toHaveBeenCalledWith("p1", { purgeData: false })
    expect(order).toEqual(["manager", "scheduled", "row"])
    expect(permissionsDelete).not.toHaveBeenCalled()
  })

  it("purges plugin data and cascades the host rows when asked", async () => {
    await uninstallPluginForHost("p1", { cascade: true })
    expect(uninstallPlugin).toHaveBeenCalledWith("p1", { purgeData: true })
    expect(permissionsDelete).toHaveBeenCalled()
    expect(analyticsDelete).toHaveBeenCalled()
  })

  it("keeps the row when the manager refuses", async () => {
    uninstallPlugin.mockRejectedValueOnce(new Error('Cannot stop plugin "p1": required by "p2"'))
    await expect(uninstallPluginForHost("p1")).rejects.toThrow(/required by/)
    expect(deletePlugin).not.toHaveBeenCalled()
  })

  it("removes a row the runtime never loaded without asking the manager", async () => {
    setRuntime([])
    await uninstallPluginForHost("draft")
    expect(uninstallPlugin).not.toHaveBeenCalled()
    expect(deletePlugin).toHaveBeenCalledWith("draft")
  })

  it("refuses on a mirrored client", async () => {
    ;(isMirroredPluginClient as jest.Mock).mockReturnValue(true)
    await expect(uninstallPluginForHost("p1")).rejects.toBeInstanceOf(PluginUninstallBlockedError)
    expect(uninstallPlugin).not.toHaveBeenCalled()
    expect(deletePlugin).not.toHaveBeenCalled()
  })
})

describe("pluginUninstallBlockReason", () => {
  it("blocks built-ins and mirrored clients, allows the rest", () => {
    expect(pluginUninstallBlockReason({ source: "marketplace" })).toBeNull()
    expect(pluginUninstallBlockReason({ source: "builtin" })).toBe("builtin")
    ;(isMirroredPluginClient as jest.Mock).mockReturnValue(true)
    expect(pluginUninstallBlockReason({ source: "marketplace" })).toBe("mirrored")
  })
})

describe("usePluginUninstall", () => {
  it("closes the open detail and drops the plugin from the selection on success", async () => {
    usePluginsStore.setState({ detailPluginId: "p1", selection: new Set(["p1", "p2"]) })
    const { result } = renderHook(() => usePluginUninstall())
    let ok = false
    await act(async () => {
      ok = await result.current({ pluginId: "p1", name: "Web Tools" })
    })
    expect(ok).toBe(true)
    expect(usePluginsStore.getState().detailPluginId).toBeNull()
    expect([...usePluginsStore.getState().selection]).toEqual(["p2"])
    expect(toast.success).toHaveBeenCalledWith("Web Tools uninstalled")
  })

  it("toasts a localized reason with a View details action on failure", async () => {
    usePluginsStore.setState({ detailPluginId: "p1", selection: new Set(["p1"]) })
    uninstallPlugin.mockRejectedValueOnce(new Error('Cannot stop plugin "p1": required by "p2"'))
    const { result } = renderHook(() => usePluginUninstall())
    let ok = true
    await act(async () => {
      ok = await result.current({ pluginId: "p1", name: "Web Tools" })
    })
    expect(ok).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't uninstall Web Tools",
      expect.objectContaining({
        description: "Other plugins depend on it: p2. Disable or uninstall them first.",
        action: expect.objectContaining({ label: "View details" }),
      })
    )
    // Nothing was removed, so nothing that points at it is cleared.
    expect(usePluginsStore.getState().detailPluginId).toBe("p1")
    expect(usePluginsStore.getState().selection.has("p1")).toBe(true)
  })
})
