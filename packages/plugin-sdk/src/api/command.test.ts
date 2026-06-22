import * as sdk from "./command"
import type {
  CommandHandler,
  CommandRegistration,
  CommandRegistryEvent,
  CommandRegistryListener,
  PluginCommand,
  PluginManifestCommandDef,
} from "./command"

describe("plugin-sdk api/command", () => {
  it("exposes the command authoring helper and runtime command registry", async () => {
    expect(typeof sdk.defineCommand).toBe("function")
    expect(typeof sdk.registerCommand).toBe("function")
    expect(typeof sdk.unregisterCommand).toBe("function")
    expect(typeof sdk.unregisterCommandsByPlugin).toBe("function")
    expect(typeof sdk.getCommand).toBe("function")
    expect(typeof sdk.getCommands).toBe("function")
    expect(typeof sdk.listCommandsByPlugin).toBe("function")
    expect(typeof sdk.executeCommand).toBe("function")
    expect(typeof sdk.subscribeCommandRegistry).toBe("function")
    expect(typeof sdk.CommandNotFoundError).toBe("function")

    const dispose = sdk.registerCommand({
      id: "plugin-sdk.test.command",
      title: "SDK Test Command",
      pluginId: "plugin-sdk-test",
      handler: () => "ok",
    })
    try {
      expect(sdk.getCommands()).toContain("plugin-sdk.test.command")
      await expect(sdk.executeCommand("plugin-sdk.test.command")).resolves.toBe("ok")
    } finally {
      dispose()
    }
  })

  it("defineCommand is a typesafe identity function", () => {
    const def = sdk.defineCommand({
      id: "example.sayHello",
      name: "Say Hello",
      aliases: ["hello"],
    })

    expect(def.id).toBe("example.sayHello")
    expect(def.aliases).toEqual(["hello"])
  })

  it("re-exports command manifest and registry types", () => {
    const assertTypes = <
      _T extends
        | PluginManifestCommandDef
        | PluginCommand
        | CommandHandler
        | CommandRegistration
        | CommandRegistryEvent
        | CommandRegistryListener,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
