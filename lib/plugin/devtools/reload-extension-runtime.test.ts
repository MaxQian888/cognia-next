import type { Plugin, PluginStatus } from "@/types/plugin"
import { reloadExtensionRuntime } from "./reload-extension-runtime"

function createPlugin(status: PluginStatus = "enabled"): Plugin {
  return {
    manifest: {
      id: "plugin-a",
      name: "Plugin A",
      version: "1.0.0",
      description: "Plugin A",
      type: "frontend",
      capabilities: ["tools"],
      main: "index.js",
    },
    status,
    source: "dev",
    path: "/plugins/plugin-a",
    config: {},
  }
}

describe("reloadExtensionRuntime", () => {
  it("disables then enables already enabled plugins", async () => {
    const manager = {
      disablePlugin: jest.fn().mockResolvedValue(undefined),
      enablePlugin: jest.fn().mockResolvedValue(undefined),
    }

    await reloadExtensionRuntime(manager as never, createPlugin("enabled"))

    expect(manager.disablePlugin).toHaveBeenCalledWith("plugin-a", "dev-reload")
    expect(manager.enablePlugin).toHaveBeenCalledWith("plugin-a", "dev-reload")
  })

  it("enables disabled plugins without calling disable first", async () => {
    const manager = {
      disablePlugin: jest.fn().mockResolvedValue(undefined),
      enablePlugin: jest.fn().mockResolvedValue(undefined),
    }

    await reloadExtensionRuntime(manager as never, createPlugin("disabled"))

    expect(manager.disablePlugin).not.toHaveBeenCalled()
    expect(manager.enablePlugin).toHaveBeenCalledWith("plugin-a", "dev-reload")
  })
})
