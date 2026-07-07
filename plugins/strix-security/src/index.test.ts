jest.mock("@/lib/plugin/registries/tree-view-registry", () => ({
  registerView: jest.fn(),
  unregisterViewsByPlugin: jest.fn(),
}))
jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))
const mockSetSelectedGuild = jest.fn()
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => ({ setSelectedGuild: mockSetSelectedGuild }) },
}))
jest.mock("./StrixPanel", () => ({ StrixPanel: () => null }))
jest.mock("./runtime", () => ({ setStrixRuntime: jest.fn(), clearStrixRuntime: jest.fn() }))

import definition from "./index"
import { registerView, unregisterViewsByPlugin } from "@/lib/plugin/registries/tree-view-registry"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { clearStrixRuntime, setStrixRuntime } from "./runtime"
import type { PluginContext } from "@/types/plugin"

function fakeCtx(over: Partial<PluginContext> = {}): PluginContext {
  return {
    pluginId: "strix-security",
    dexie: {} as never,
    terminal: {} as never,
    logger: { info: jest.fn(), error: jest.fn() },
    ...over,
  } as unknown as PluginContext
}

beforeEach(() => jest.clearAllMocks())

describe("strix-security plugin lifecycle", () => {
  it("wires the runtime, view, and slash command on activate", async () => {
    await definition.activate(fakeCtx())

    expect(setStrixRuntime).toHaveBeenCalledTimes(1)
    expect(registerView).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "react",
        pluginId: "strix-security",
        viewId: "strix-panel",
        containerId: "strix-security:security",
      })
    )
    expect(registerSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "/security", pluginId: "strix-security", source: "plugin" })
    )
  })

  it("opens the panel when the slash command handler runs", async () => {
    await definition.activate(fakeCtx())
    const def = (registerSlashCommand as jest.Mock).mock.calls[0][0]
    def.handler("")
    expect(mockSetSelectedGuild).toHaveBeenCalledWith({
      kind: "plugin-view",
      containerId: "strix-security:security",
    })
  })

  it("still registers the view but logs when dexie is unavailable", async () => {
    const logger = { info: jest.fn(), error: jest.fn() }
    await definition.activate(fakeCtx({ dexie: undefined, logger } as never))
    expect(setStrixRuntime).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
    expect(registerView).toHaveBeenCalled()
  })

  it("tears everything down on deactivate", async () => {
    await definition.deactivate?.(fakeCtx())
    expect(unregisterViewsByPlugin).toHaveBeenCalledWith("strix-security")
    expect(unregisterCommandsByPlugin).toHaveBeenCalledWith("strix-security")
    expect(clearStrixRuntime).toHaveBeenCalledTimes(1)
  })
})
