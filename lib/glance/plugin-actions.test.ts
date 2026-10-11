/** @jest-environment jsdom */

const pluginCommand = { execute: jest.fn() }
let managerCommands: Record<string, typeof pluginCommand> = {}
let managerThrows = false
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => {
    if (managerThrows) throw new Error("Plugin manager not initialized")
    return { getRegistry: () => ({ getCommand: (id: string) => managerCommands[id] }) }
  },
}))
const busCommands = new Set<string>()
const executeCommand = jest.fn()
jest.mock("@/lib/plugin/commands/registry", () => ({
  getCommand: (id: string) => (busCommands.has(id) ? { id } : undefined),
  executeCommand: (id: string) => executeCommand(id),
}))

import { runGlancePluginAction, runPluginCommand } from "./plugin-actions"
import { GlancePluginModuleRegistry } from "./plugin-registry"

beforeEach(() => {
  pluginCommand.execute.mockReset()
  executeCommand.mockReset()
  managerCommands = {}
  managerThrows = false
  busCommands.clear()
})

describe("runPluginCommand", () => {
  it("runs a manifest command from the plugin manager's registry first", async () => {
    managerCommands["com.ci.open"] = pluginCommand
    busCommands.add("com.ci.open")
    await expect(runPluginCommand("com.ci.open")).resolves.toBe(true)
    expect(pluginCommand.execute).toHaveBeenCalled()
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it("falls back to the command bus", async () => {
    busCommands.add("com.ci.open")
    await expect(runPluginCommand("com.ci.open")).resolves.toBe(true)
    expect(executeCommand).toHaveBeenCalledWith("com.ci.open")
  })

  it("still tries the bus when there is no plugin manager", async () => {
    managerThrows = true
    busCommands.add("com.ci.open")
    await expect(runPluginCommand("com.ci.open")).resolves.toBe(true)
  })

  it("is false for a command that exists nowhere", async () => {
    await expect(runPluginCommand("com.ci.ghost")).resolves.toBe(false)
  })
})

describe("runGlancePluginAction", () => {
  let registry: GlancePluginModuleRegistry
  const runCommand = jest.fn()

  beforeEach(() => {
    registry = new GlancePluginModuleRegistry()
    registry.register("com.ci", { id: "status", title: "CI" })
    registry.update("com.ci", "status", {
      actions: [{ id: "open", label: "Open", command: "open-ci" }],
    })
    runCommand.mockReset()
    runCommand.mockResolvedValue(true)
  })

  it("runs the plugin's own command the action names", async () => {
    await expect(
      runGlancePluginAction("plugin:com.ci:status", "open", { registry, runCommand })
    ).resolves.toBeNull()
    expect(runCommand).toHaveBeenCalledWith("com.ci.open-ci")
  })

  it("refuses an action the plugin did not publish", async () => {
    await expect(
      runGlancePluginAction("plugin:com.ci:status", "delete-everything", { registry, runCommand })
    ).resolves.toBe("errors.commandUnavailable")
    expect(runCommand).not.toHaveBeenCalled()
  })

  it("says the module is gone when its plugin is", async () => {
    registry.unregisterAllByPlugin("com.ci")
    await expect(
      runGlancePluginAction("plugin:com.ci:status", "open", { registry, runCommand })
    ).resolves.toBe("errors.pluginUnavailable")
  })

  it("says the command is unavailable when nothing answers to it", async () => {
    runCommand.mockResolvedValue(false)
    await expect(
      runGlancePluginAction("plugin:com.ci:status", "open", { registry, runCommand })
    ).resolves.toBe("errors.commandUnavailable")
  })

  it("reports a command that throws as a failed request", async () => {
    runCommand.mockRejectedValue(new Error("boom"))
    await expect(
      runGlancePluginAction("plugin:com.ci:status", "open", { registry, runCommand })
    ).resolves.toBe("errors.requestFailed")
  })

  it("uses the shared registry and the real dispatcher by default", async () => {
    await expect(runGlancePluginAction("plugin:nobody:x", "open")).resolves.toBe(
      "errors.pluginUnavailable"
    )
  })
})
