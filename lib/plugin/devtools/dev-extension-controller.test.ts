import { DevExtensionController } from "./dev-extension-controller"
import type { PluginBuildResult } from "./dev-server"

describe("DevExtensionController", () => {
  it("registers a dev extension and starts watching in desktop environments", async () => {
    const watchPlugin = jest.fn().mockResolvedValue(undefined)
    const controller = new DevExtensionController({
      isDesktop: true,
      devServer: {
        watchPlugin,
        unwatchPlugin: jest.fn(),
        onBuild: jest.fn(() => () => {}),
      },
      hotReload: {
        reloadPlugin: jest.fn(),
        onReload: jest.fn(() => () => {}),
        onError: jest.fn(() => () => {}),
      },
    })

    const record = await controller.registerExtension("plugin-a", "/dev/plugin-a")

    expect(watchPlugin).toHaveBeenCalledWith("plugin-a", "/dev/plugin-a")
    expect(record.status).toBe("watching")
    expect(record.sourcePath).toBe("/dev/plugin-a")
  })

  it("records unsupported_env when registering outside desktop environments", async () => {
    const controller = new DevExtensionController({
      isDesktop: false,
    })

    const record = await controller.registerExtension("plugin-a", "/dev/plugin-a")

    expect(record.status).toBe("unsupported_env")
    expect(record.lastError).toMatch(/unsupported_env/i)
  })

  it("records build success and triggers a reload for registered extensions", async () => {
    let buildListener: ((result: PluginBuildResult) => void) | undefined
    const reloadPlugin = jest.fn().mockResolvedValue({
      success: true,
      pluginId: "plugin-a",
      duration: 12,
    })

    const controller = new DevExtensionController({
      isDesktop: true,
      devServer: {
        watchPlugin: jest.fn().mockResolvedValue(undefined),
        unwatchPlugin: jest.fn(),
        onBuild: jest.fn((listener) => {
          buildListener = listener as (result: PluginBuildResult) => void
          return () => {}
        }),
      },
      hotReload: {
        reloadPlugin,
        onReload: jest.fn(() => () => {}),
        onError: jest.fn(() => () => {}),
      },
    })

    await controller.registerExtension("plugin-a", "/dev/plugin-a")
    expect(buildListener).toBeDefined()
    const buildListenerHandler = buildListener as (result: PluginBuildResult) => void
    buildListenerHandler({
      success: true,
      pluginId: "plugin-a",
      outputPath: "/dist/plugin-a",
      duration: 50,
      warnings: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reloadPlugin).toHaveBeenCalledWith("plugin-a")
    expect(controller.getRecord("plugin-a")).toEqual(
      expect.objectContaining({
        status: "reload_success",
        lastBuild: expect.objectContaining({ success: true }),
        lastReload: expect.objectContaining({ success: true }),
        lastResult: expect.objectContaining({
          stage: "reload",
          success: true,
          mode: "hot-reload",
        }),
        lastKnownGoodResult: expect.objectContaining({
          stage: "reload",
          success: true,
        }),
      })
    )
  })

  it("records build failure diagnostics without triggering reload", async () => {
    let buildListener: ((result: PluginBuildResult) => void) | undefined
    const reloadPlugin = jest.fn()

    const controller = new DevExtensionController({
      isDesktop: true,
      devServer: {
        watchPlugin: jest.fn().mockResolvedValue(undefined),
        unwatchPlugin: jest.fn(),
        onBuild: jest.fn((listener) => {
          buildListener = listener as (result: PluginBuildResult) => void
          return () => {}
        }),
      },
      hotReload: {
        reloadPlugin,
        onReload: jest.fn(() => () => {}),
        onError: jest.fn(() => () => {}),
      },
    })

    await controller.registerExtension("plugin-a", "/dev/plugin-a")
    expect(buildListener).toBeDefined()
    const buildListenerHandler = buildListener as (result: PluginBuildResult) => void
    buildListenerHandler({
      success: false,
      pluginId: "plugin-a",
      duration: 50,
      errors: ["build exploded"],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reloadPlugin).not.toHaveBeenCalled()
    expect(controller.getRecord("plugin-a")).toEqual(
      expect.objectContaining({
        status: "build_failed",
        lastError: "build exploded",
        lastResult: expect.objectContaining({
          stage: "build",
          success: false,
          error: "build exploded",
        }),
      })
    )
  })

  it("falls back to a re-enable handler when hot reload fails", async () => {
    let buildListener: ((result: PluginBuildResult) => void) | undefined
    const fallbackReload = jest.fn().mockResolvedValue(undefined)

    const controller = new DevExtensionController({
      isDesktop: true,
      reloadHandler: fallbackReload,
      devServer: {
        watchPlugin: jest.fn().mockResolvedValue(undefined),
        unwatchPlugin: jest.fn(),
        onBuild: jest.fn((listener) => {
          buildListener = listener as (result: PluginBuildResult) => void
          return () => {}
        }),
      },
      hotReload: {
        reloadPlugin: jest.fn().mockResolvedValue({
          success: false,
          pluginId: "plugin-a",
          duration: 8,
          error: "reload exploded",
        }),
        onReload: jest.fn(() => () => {}),
        onError: jest.fn(() => () => {}),
      },
    })

    await controller.registerExtension("plugin-a", "/dev/plugin-a")
    expect(buildListener).toBeDefined()
    const buildListenerHandler = buildListener as (result: PluginBuildResult) => void
    buildListenerHandler({
      success: true,
      pluginId: "plugin-a",
      outputPath: "/dist/plugin-a",
      duration: 40,
      warnings: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fallbackReload).toHaveBeenCalledWith("plugin-a")
    expect(controller.getRecord("plugin-a")).toEqual(
      expect.objectContaining({
        status: "reload_success",
        fallbackMode: "re-enable",
        lastResult: expect.objectContaining({
          stage: "rollback",
          success: true,
          mode: "re-enable",
        }),
        lastKnownGoodResult: expect.objectContaining({
          stage: "rollback",
          success: true,
        }),
      })
    )
  })
})
