import { createTrayAPI } from "./tray-api"
import { __resetTrayRegistryForTesting, listTrayItems } from "@/lib/tray/registry"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordSilentFailure } = require("../contracts/diagnostics-store") as {
  recordSilentFailure: jest.Mock
}

afterEach(() => {
  invoke.mockReset()
  recordSilentFailure.mockReset()
  __resetTrayRegistryForTesting()
})

describe("createTrayAPI", () => {
  it("returns a no-op API when the plugin lacks the 'tray' capability", () => {
    const api = createTrayAPI({ pluginId: "p", capabilities: ["commands"] })
    const dispose = api.register({
      id: "x",
      label: "X",
      onClick: () => {},
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(listTrayItems()).toHaveLength(0)
    dispose() // disposing a no-op is a no-op
  })

  it("namespaces the item id and writes to the renderer registry", () => {
    invoke.mockResolvedValue(undefined)
    const api = createTrayAPI({ pluginId: "shot", capabilities: ["tray"] })
    api.register({
      id: "capture",
      label: "Capture",
      category: "screenshot",
      onClick: () => {},
    })
    expect(invoke).toHaveBeenCalledWith(
      "plugin_tray_item_register",
      expect.objectContaining({
        pluginId: "shot",
        item: expect.objectContaining({ id: "shot:capture", label: "Capture" }),
      })
    )
    const items = listTrayItems()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("shot:capture")
    expect(items[0].pluginId).toBe("shot")
  })

  it("disposer unregisters on both sides and removes the DOM listener", () => {
    invoke.mockResolvedValue(undefined)
    const api = createTrayAPI({ pluginId: "shot", capabilities: ["tray"] })
    const dispose = api.register({
      id: "capture",
      label: "Capture",
      onClick: () => {},
    })
    expect(listTrayItems()).toHaveLength(1)
    invoke.mockClear()
    invoke.mockResolvedValue(undefined)
    dispose()
    expect(invoke).toHaveBeenCalledWith("plugin_tray_item_unregister", {
      pluginId: "shot",
      itemId: "shot:capture",
    })
    expect(listTrayItems()).toHaveLength(0)
  })

  it("clicking the matching window event invokes onClick", () => {
    invoke.mockResolvedValue(undefined)
    const api = createTrayAPI({ pluginId: "shot", capabilities: ["tray"] })
    const onClick = jest.fn()
    api.register({ id: "capture", label: "Capture", onClick })
    window.dispatchEvent(new CustomEvent("plugin-tray-item:shot:capture"))
    expect(onClick).toHaveBeenCalled()
  })

  it("registerMany returns one disposer that cleans up every entry", () => {
    invoke.mockResolvedValue(undefined)
    const api = createTrayAPI({ pluginId: "shot", capabilities: ["tray"] })
    const dispose = api.registerMany([
      { id: "a", label: "A", onClick: () => {} },
      { id: "b", label: "B", onClick: () => {} },
    ])
    expect(listTrayItems()).toHaveLength(2)
    dispose()
    expect(listTrayItems()).toHaveLength(0)
  })

  it("routes register failures through recordSilentFailure (handler registered → expected:false)", async () => {
    invoke.mockImplementationOnce(() => Promise.reject(new Error("backend down")))
    const api = createTrayAPI({ pluginId: "shot", capabilities: ["tray"] })
    api.register({ id: "capture", label: "Capture", onClick: () => {} })
    await Promise.resolve()
    await Promise.resolve()
    expect(recordSilentFailure).toHaveBeenCalledWith(
      "shot",
      expect.objectContaining({
        site: "tray.register",
        message: expect.stringContaining("shot:capture"),
        expected: false,
      }),
      expect.any(Error)
    )
  })

  it("routes unregister failures through recordSilentFailure", async () => {
    invoke.mockResolvedValue(undefined)
    const api = createTrayAPI({ pluginId: "shot", capabilities: ["tray"] })
    const dispose = api.register({ id: "capture", label: "Capture", onClick: () => {} })
    invoke.mockClear()
    invoke.mockImplementationOnce(() => Promise.reject(new Error("nope")))
    dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(recordSilentFailure).toHaveBeenCalledWith(
      "shot",
      expect.objectContaining({ site: "tray.unregister", expected: false }),
      expect.any(Error)
    )
  })
})
